/**
 * Overlap Detector — real-time cross-worktree file conflict detection.
 *
 * Watches all active worktree directories and maintains a map of
 * which files have been modified in which worktrees. When a file
 * is modified in more than one worktree, it fires an overlap alert.
 *
 * This is the key differentiator — nobody else has this.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { git } from "../utils/git";
import { log } from "../utils/logger";

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

type OverlapSeverity = "conflict" | "warning" | "info";

export interface FileOverlap {
    /** Relative file path (relative to repo root) */
    filePath: string;
    /** Worktrees that modified this file */
    worktrees: Array<{
        path: string;
        branch: string;
    }>;
    /** Severity: conflict (different changes), warning (same file), info (shared config) */
    severity: OverlapSeverity;
    /** When the overlap was first detected */
    detectedAt: string;
    /** Whether user has dismissed this overlap */
    dismissed: boolean;
}

/** Serializable overlap data for the WebView */
export interface OverlapAlert {
    filePath: string;
    severity: OverlapSeverity;
    branches: string[];
    detectedAt: string;
    dismissed: boolean;
}

// Common shared/config files that are expected to be touched by multiple agents
const SHARED_CONFIG_FILES = new Set([
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "tsconfig.build.json",
    ".env",
    ".env.example",
    ".env.local",
    ".gitignore",
    "Makefile",
    "Dockerfile",
    "docker-compose.yml",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "go.sum",
    "Cargo.toml",
    "Cargo.lock",
]);

// ────────────────────────────────────────────
// Overlap Detector
// ────────────────────────────────────────────

export class OverlapDetector implements vscode.Disposable {
    /** Map: relative file path → Set of worktree paths that modified it */
    private modifiedFiles = new Map<string, Set<string>>();

    /** Map: worktree path → branch name */
    private worktreeBranches = new Map<string, string>();

    /** Current overlap alerts */
    private overlaps = new Map<string, FileOverlap>();

    /** File watchers per worktree */
    private watchers: vscode.FileSystemWatcher[] = [];

    /** Debounce timers per file */
    private debounceTimers = new Map<string, NodeJS.Timeout>();

    private _onDidDetectOverlap = new vscode.EventEmitter<FileOverlap>();
    readonly onDidDetectOverlap = this._onDidDetectOverlap.event;

    private _onDidChangeOverlaps = new vscode.EventEmitter<void>();
    readonly onDidChangeOverlaps = this._onDidChangeOverlaps.event;

    constructor(
        _repoRoot: string,
        private readonly debounceMs: number = 500
    ) {}

    // ── Public API ───────────────────────────────────────────

    /**
     * Start watching a set of worktree directories.
     * Call this when sessions change.
     */
    watchWorktrees(
        worktrees: Array<{ path: string; branch: string }>
    ): void {
        // Dispose old watchers
        this.disposeWatchers();

        // Prune stale tracking data: remove entries for worktrees no longer in the set,
        // but preserve overlap data for worktrees that are still active.
        const activeWorktreePaths = new Set(worktrees.map((wt) => wt.path));

        for (const [filePath, wtPaths] of this.modifiedFiles) {
            for (const p of wtPaths) {
                if (!activeWorktreePaths.has(p)) {
                    wtPaths.delete(p);
                }
            }
            if (wtPaths.size === 0) {
                this.modifiedFiles.delete(filePath);
            }
        }

        // Rebuild overlaps from pruned data
        const prunedOverlapFiles = new Set<string>();
        for (const [filePath, wtPaths] of this.modifiedFiles) {
            if (wtPaths.size > 1) {
                prunedOverlapFiles.add(filePath);
            }
        }
        for (const filePath of this.overlaps.keys()) {
            if (!prunedOverlapFiles.has(filePath)) {
                this.overlaps.delete(filePath);
            }
        }

        // Update branch map
        this.worktreeBranches.clear();
        for (const wt of worktrees) {
            this.worktreeBranches.set(wt.path, wt.branch);
        }

        // Create watchers
        for (const wt of worktrees) {
            if (!fs.existsSync(wt.path)) continue;

            // Watch both root-level files and common source directories
            const pattern = new vscode.RelativePattern(
                wt.path,
                "{*,src/**/*,lib/**/*,app/**/*,test/**/*,tests/**/*,pkg/**/*,cmd/**/*,internal/**/*,config/**/*,public/**/*,assets/**/*,scripts/**/*}"
            );

            const watcher = vscode.workspace.createFileSystemWatcher(
                pattern,
                false,
                false,
                false
            );

            const handleChange = (uri: vscode.Uri): void => {
                this.onFileChange(uri, wt.path);
            };

            watcher.onDidCreate(handleChange);
            watcher.onDidChange(handleChange);
            // Deletions also matter for overlap detection
            watcher.onDidDelete(handleChange);

            this.watchers.push(watcher);
        }
    }

    /**
     * Scan all active worktrees for existing file overlaps
     * using `git diff` against the base branch.
     */
    async scanExistingChanges(
        worktrees: Array<{ path: string; branch: string }>,
        baseBranch: string = "main"
    ): Promise<void> {
        // Merge scan results into existing data instead of clearing,
        // so real-time watcher detections are preserved.
        for (const wt of worktrees) {
            try {
                const diffOutput = await git(
                    ["diff", "--name-only", `${baseBranch}...HEAD`],
                    wt.path
                );
                if (!diffOutput.trim()) continue;

                const files = diffOutput.trim().split("\n");
                for (const file of files) {
                    const existing = this.modifiedFiles.get(file) ?? new Set();
                    existing.add(wt.path);
                    this.modifiedFiles.set(file, existing);
                }
            } catch (err) {
                // Non-critical but worth logging — overlap detection may be incomplete
                const msg = err instanceof Error ? err.message : String(err);
                log(`Overlap scan skipped for ${wt.path}: ${msg}`);
            }
        }

        // Detect overlaps from scan
        for (const [filePath, wtPaths] of this.modifiedFiles) {
            if (wtPaths.size > 1) {
                this.createOverlap(filePath, wtPaths);
            }
        }

        if (this.overlaps.size > 0) {
            this._onDidChangeOverlaps.fire();
        }
    }

    /**
     * Get all current overlap alerts.
     */
    getOverlaps(): FileOverlap[] {
        return [...this.overlaps.values()].sort((a, b) => {
            // Sort by severity (conflict > warning > info), then by time
            const severityOrder = { conflict: 0, warning: 1, info: 2 };
            const sev = severityOrder[a.severity] - severityOrder[b.severity];
            if (sev !== 0) return sev;
            return new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime();
        });
    }

    /**
     * Get overlap alerts as serializable data for the WebView.
     */
    getOverlapAlerts(): OverlapAlert[] {
        return this.getOverlaps().map((o) => ({
            filePath: o.filePath,
            severity: o.severity,
            branches: o.worktrees.map((w) => w.branch),
            detectedAt: o.detectedAt,
            dismissed: o.dismissed,
        }));
    }

    /**
     * Get the count of active (non-dismissed) overlaps.
     */
    get activeOverlapCount(): number {
        return [...this.overlaps.values()].filter((o) => !o.dismissed).length;
    }

    /**
     * Dismiss an overlap alert.
     */
    dismissOverlap(filePath: string): void {
        const overlap = this.overlaps.get(filePath);
        if (overlap) {
            overlap.dismissed = true;
            this._onDidChangeOverlaps.fire();
        }
    }

    /**
     * Dismiss all overlap alerts.
     */
    dismissAll(): void {
        for (const overlap of this.overlaps.values()) {
            overlap.dismissed = true;
        }
        this._onDidChangeOverlaps.fire();
    }

    /**
     * Clear all overlap data and stop watching.
     */
    reset(): void {
        this.modifiedFiles.clear();
        this.overlaps.clear();
        this.worktreeBranches.clear();
        this.disposeWatchers();
        this._onDidChangeOverlaps.fire();
    }

    // ── Private ──────────────────────────────────────────────

    private onFileChange(uri: vscode.Uri, worktreePath: string): void {
        // Normalize to forward slashes for consistent cross-platform comparison
        const relativePath = path.relative(worktreePath, uri.fsPath).replace(/\\/g, "/");

        // Skip noise
        if (
            relativePath.startsWith(".git") ||
            relativePath.includes("node_modules") ||
            relativePath.includes("__pycache__")
        ) {
            return;
        }

        // Debounce per file per worktree
        const key = `${worktreePath}:${relativePath}`;
        const existing = this.debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
            key,
            setTimeout(() => {
                this.debounceTimers.delete(key);
                this.recordFileChange(relativePath, worktreePath);
            }, this.debounceMs)
        );
    }

    private recordFileChange(
        relativePath: string,
        worktreePath: string
    ): void {
        const existing = this.modifiedFiles.get(relativePath) ?? new Set();
        existing.add(worktreePath);
        this.modifiedFiles.set(relativePath, existing);

        // Check for overlap
        if (existing.size > 1) {
            const isNew = !this.overlaps.has(relativePath);
            const overlap = this.createOverlap(relativePath, existing);

            if (isNew) {
                this._onDidDetectOverlap.fire(overlap);

                // Show VS Code notification for non-dismissed, non-info overlaps
                if (overlap.severity !== "info") {
                    const branches = overlap.worktrees
                        .map((w) => w.branch)
                        .join(", ");
                    void vscode.window.showWarningMessage(
                        `File overlap detected: ${relativePath} modified in ${branches}`,
                        "View Overlaps",
                        "Dismiss"
                    ).then((action) => {
                        if (action === "View Overlaps") {
                            void vscode.commands.executeCommand("grove.openDashboard");
                        } else if (action === "Dismiss") {
                            this.dismissOverlap(relativePath);
                        }
                    });
                }
            }

            this._onDidChangeOverlaps.fire();
        }
    }

    private createOverlap(
        filePath: string,
        worktreePaths: Set<string>
    ): FileOverlap {
        const worktrees = [...worktreePaths].map((wtPath) => ({
            path: wtPath,
            branch: this.worktreeBranches.get(wtPath) ?? path.basename(wtPath),
        }));

        // Determine severity
        const fileName = path.basename(filePath);
        let severity: OverlapSeverity;

        if (SHARED_CONFIG_FILES.has(fileName)) {
            severity = "info";
        } else if (
            filePath.includes("types") ||
            filePath.includes("index.") ||
            filePath.endsWith(".d.ts")
        ) {
            severity = "warning";
        } else {
            severity = "conflict";
        }

        const existing = this.overlaps.get(filePath);
        const overlap: FileOverlap = {
            filePath,
            worktrees,
            severity,
            detectedAt: existing?.detectedAt ?? new Date().toISOString(),
            dismissed: existing?.dismissed ?? false,
        };

        this.overlaps.set(filePath, overlap);
        return overlap;
    }

    // ── Disposal ─────────────────────────────────────────────

    private disposeWatchers(): void {
        for (const watcher of this.watchers) {
            watcher.dispose();
        }
        this.watchers = [];

        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
    }

    dispose(): void {
        this.disposeWatchers();
        this._onDidDetectOverlap.dispose();
        this._onDidChangeOverlaps.dispose();
    }
}
