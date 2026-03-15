/**
 * Merge Sequencer — handles end-of-workflow merge process.
 *
 * Provides:
 * - Merge readiness report generation
 * - Merge order recommendation
 * - Sequential merge execution with test running
 * - Post-merge cleanup
 *
 * No VS Code dependency in the core logic — only the execution
 * flow uses vscode for terminal/notification integration.
 */

import * as fs from "fs";
import * as path from "path";
import { git, gitWrite, getCurrentBranch } from "../utils/git";
import {
    getChangedFiles,
    getDiffStats,
    removeWorktree,
} from "./worktree-manager";
import { logError } from "../utils/logger";
import { GroveError } from "../utils/errors";

/**
 * Turn a raw git error message into something a user can understand.
 */
function humanizeMergeError(raw: string, branch: string): string {
    if (raw.includes("unrelated histories")) {
        return `Branch '${branch}' has unrelated history. It may have been created from a different repository or orphan branch.`;
    }
    if (raw.includes("not something we can merge")) {
        return `Branch '${branch}' could not be found. Make sure the branch name is correct and exists locally.`;
    }
    if (raw.includes("index.lock") || raw.includes("Unable to create") && raw.includes(".lock")) {
        return `Git is locked by another process. Wait a moment and try again, or delete the lock file: rm -f .git/index.lock`;
    }
    if (raw.includes("CONFLICT") || raw.includes("conflict")) {
        return `Merge conflict while merging '${branch}'.`;
    }
    if (raw.includes("not possible because you have unmerged files")) {
        return `There are unresolved conflicts from a previous merge. Resolve them first or run 'git merge --abort'.`;
    }
    if (raw.includes("overwritten by merge")) {
        return `Local changes would be overwritten by merge. Commit or stash your changes first.`;
    }
    if (raw.includes("permission denied") || raw.includes("EACCES")) {
        return `Permission denied. Check file permissions in the repository.`;
    }
    return `Failed to merge '${branch}': ${raw}`;
}

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

export interface WorktreeMergeInfo {
    /** Worktree path */
    path: string;
    /** Branch name */
    branch: string;
    /** Files changed vs base branch */
    changedFiles: string[];
    /** Lines added */
    linesAdded: number;
    /** Lines removed */
    linesRemoved: number;
    /** New files created */
    newFiles: string[];
    /** Diff stat summary */
    diffStat: string;
    /** Reviewer findings (from REVIEW.md if it exists) */
    reviewFindings?: string;
    /** Handoff notes (from HANDOFF.md if it exists) */
    handoffNotes?: string;
    /** Whether the worktree has uncommitted changes */
    hasUncommittedChanges: boolean;
}

interface FileOverlapInfo {
    /** Relative file path */
    filePath: string;
    /** Branches that modified this file */
    branches: string[];
    /** Whether this is likely auto-resolvable */
    likelyAutoResolvable: boolean;
}

export interface MergeReport {
    /** Timestamp of report generation */
    generatedAt: string;
    /** Base branch to merge into */
    baseBranch: string;
    /** Per-worktree merge info */
    worktrees: WorktreeMergeInfo[];
    /** Files modified in multiple worktrees */
    overlaps: FileOverlapInfo[];
    /** Recommended merge order */
    mergeOrder: MergeOrderEntry[];
    /** Total files changed across all worktrees */
    totalFilesChanged: number;
    /** Total lines added across all worktrees */
    totalLinesAdded: number;
    /** Total lines removed across all worktrees */
    totalLinesRemoved: number;
}

interface MergeOrderEntry {
    branch: string;
    worktreePath: string;
    reason: string;
}

type MergeStepStatus =
    | "pending"
    | "merging"
    | "testing"
    | "success"
    | "conflict"
    | "test-failed"
    | "skipped"
    | "error";

interface MergeStep {
    branch: string;
    worktreePath: string;
    status: MergeStepStatus;
    message?: string;
    conflictFiles?: string[];
}

// ────────────────────────────────────────────
// Merge Report Generation
// ────────────────────────────────────────────

/**
 * Generate a merge readiness report for a set of worktrees.
 */
export async function generateMergeReport(
    worktreePaths: string[],
    baseBranch: string = "main"
): Promise<MergeReport> {
    const worktreeInfos: WorktreeMergeInfo[] = [];
    const allChangedFiles = new Map<string, string[]>(); // file → branches

    for (const wtPath of worktreePaths) {
        const info = await gatherWorktreeMergeInfo(wtPath, baseBranch);
        worktreeInfos.push(info);

        // Track files for overlap detection
        for (const file of info.changedFiles) {
            const branches = allChangedFiles.get(file) ?? [];
            branches.push(info.branch);
            allChangedFiles.set(file, branches);
        }
    }

    // Detect overlaps
    const overlaps: FileOverlapInfo[] = [];
    for (const [filePath, branches] of allChangedFiles) {
        if (branches.length > 1) {
            overlaps.push({
                filePath,
                branches,
                likelyAutoResolvable: isLikelyAutoResolvable(filePath),
            });
        }
    }

    // Compute merge order
    const mergeOrder = recommendMergeOrder(worktreeInfos, undefined);

    // Compute totals
    const totalFilesChanged = new Set(
        worktreeInfos.flatMap((w) => w.changedFiles)
    ).size;
    const totalLinesAdded = worktreeInfos.reduce(
        (sum, w) => sum + w.linesAdded,
        0
    );
    const totalLinesRemoved = worktreeInfos.reduce(
        (sum, w) => sum + w.linesRemoved,
        0
    );

    return {
        generatedAt: new Date().toISOString(),
        baseBranch,
        worktrees: worktreeInfos,
        overlaps,
        mergeOrder,
        totalFilesChanged,
        totalLinesAdded,
        totalLinesRemoved,
    };
}

// ────────────────────────────────────────────
// Sequential Merge Execution
// ────────────────────────────────────────────

/**
 * Execute a sequential merge. Each step:
 * 1. Checkout base branch
 * 2. Merge worktree branch
 * 3. If conflict → pause
 * 4. If clean → optionally run tests
 * 5. If tests pass → continue
 *
 * Returns a MergeResult with the status of each step.
 * The caller (extension.ts) handles UI, conflict resolution, and test interaction.
 */
export async function executeMergeStep(
    repoRoot: string,
    branch: string,
    baseBranch: string = "main"
): Promise<MergeStep> {
    const step: MergeStep = {
        branch,
        worktreePath: "",
        status: "merging",
    };

    try {
        // Ensure we're on the base branch
        const currentBranch = await getCurrentBranch(repoRoot);
        if (currentBranch !== baseBranch) {
            await gitWrite(["checkout", baseBranch], repoRoot);
        }

        // Attempt merge
        try {
            const result = await gitWrite(
                ["merge", branch, "--no-edit"],
                repoRoot
            );
            step.status = "success";
            step.message = result || `Merged ${branch} successfully`;
        } catch (err) {
            // Check if it's a merge conflict
            const statusOutput = await git(["status", "--porcelain"], repoRoot);
            const conflictPrefixes = ["UU", "AA", "DD", "DU", "UD", "AU", "UA"];
            const conflictFiles = statusOutput
                .split("\n")
                .filter((line) => conflictPrefixes.some((p) => line.startsWith(p)))
                .map((line) => line.slice(3).trim());

            if (conflictFiles.length > 0) {
                step.status = "conflict";
                step.conflictFiles = conflictFiles;
                step.message = `Merge conflict in ${conflictFiles.length} file(s)`;
            } else {
                step.status = "error";
                const raw = err instanceof Error ? err.message : String(err);
                step.message = humanizeMergeError(raw, branch);
            }
        }
    } catch (err) {
        step.status = "error";
        const raw = err instanceof Error ? err.message : String(err);
        step.message = humanizeMergeError(raw, branch);
    }

    return step;
}

/**
 * Check if the repository is in a clean state (no in-progress merge/rebase).
 * Call this before starting a merge sequence.
 */
export async function checkRepoState(repoRoot: string): Promise<{ clean: boolean; reason?: string }> {
    try {
        const status = await git(["status", "--porcelain"], repoRoot);
        const conflictPrefixes = ["UU", "AA", "DD", "DU", "UD", "AU", "UA"];
        const hasConflicts = status.split("\n").some(
            (line) => conflictPrefixes.some((p) => line.startsWith(p))
        );
        if (hasConflicts) {
            return { clean: false, reason: "Repository has unresolved merge conflicts." };
        }

        // Check for uncommitted changes that could be destroyed by checkout/merge
        if (status.trim().length > 0) {
            return { clean: false, reason: "Working tree has uncommitted changes. Commit or stash them first." };
        }

        // Check for MERGE_HEAD (in-progress merge)
        // Resolve against repoRoot since git-dir may be relative
        const gitDir = path.resolve(repoRoot, (await git(["rev-parse", "--git-dir"], repoRoot)).trim());
        if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
            return { clean: false, reason: "A merge is already in progress. Resolve or abort it first." };
        }
        if (fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"))) {
            return { clean: false, reason: "A rebase is in progress. Complete or abort it first." };
        }
    } catch {
        // If we can't check, assume clean and let git fail naturally
    }
    return { clean: true };
}

/**
 * Abort an in-progress merge and verify it was successful.
 */
export async function abortMerge(repoRoot: string): Promise<void> {
    await gitWrite(["merge", "--abort"], repoRoot);

    // Verify merge state is actually cleared
    // Resolve against repoRoot since git-dir may be relative
    const gitDir = path.resolve(repoRoot, (await git(["rev-parse", "--git-dir"], repoRoot)).trim());
    if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
        throw new GroveError(
            "Could not abort the merge — merge state is still present.",
            "Open a terminal and run 'git merge --abort' manually. If that doesn't work, try 'git reset --hard HEAD'."
        );
    }
}

/**
 * Run a test command in the repo root.
 * Returns true if tests pass, false otherwise.
 */
export async function runTests(
    repoRoot: string,
    testCommand: string
): Promise<{ passed: boolean; output: string }> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    try {
        // Run the command through the shell to support complex commands
        // (e.g. "npm test && npm run lint")
        const { stdout, stderr } = await execFileAsync(
            process.platform === "win32" ? "cmd" : "sh",
            process.platform === "win32" ? ["/c", testCommand] : ["-c", testCommand],
            {
                cwd: repoRoot,
                maxBuffer: 10 * 1024 * 1024,
                timeout: 5 * 60 * 1000, // 5 minute timeout
            },
        );

        return {
            passed: true,
            output: stdout + (stderr ? `\n${stderr}` : ""),
        };
    } catch (err) {
        const error = err as { stdout?: string; stderr?: string; message?: string };
        return {
            passed: false,
            output:
                (error.stdout ?? "") +
                (error.stderr ? `\n${error.stderr}` : "") +
                (error.message ? `\n${error.message}` : ""),
        };
    }
}

/**
 * Auto-detect the test command from the project.
 */
export function detectTestCommand(repoRoot: string): string | undefined {
    // Check package.json
    const pkgPath = path.join(repoRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
                scripts?: Record<string, string>;
            };
            if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
                return "npm test";
            }
        } catch {
            // Ignore
        }
    }

    // Check for pytest — only trust pytest.ini as a definitive indicator.
    // pyproject.toml and setup.cfg are general Python config files and
    // do not imply pytest is the test runner.
    if (fs.existsSync(path.join(repoRoot, "pytest.ini"))) {
        return "pytest";
    }
    // Check pyproject.toml for [tool.pytest] section
    if (fs.existsSync(path.join(repoRoot, "pyproject.toml"))) {
        try {
            const content = fs.readFileSync(path.join(repoRoot, "pyproject.toml"), "utf-8");
            if (content.includes("[tool.pytest")) {
                return "pytest";
            }
        } catch {
            // Ignore
        }
    }

    // Check for go tests
    if (fs.existsSync(path.join(repoRoot, "go.mod"))) {
        return "go test ./...";
    }

    // Check for cargo tests
    if (fs.existsSync(path.join(repoRoot, "Cargo.toml"))) {
        return "cargo test";
    }

    return undefined;
}

// ────────────────────────────────────────────
// Post-Merge Cleanup
// ────────────────────────────────────────────

/**
 * Clean up worktrees after a successful merge.
 * Removes worktrees and optionally deletes branches.
 */
export async function postMergeCleanup(
    repoRoot: string,
    worktrees: Array<{ path: string; branch: string }>,
    options: {
        deleteBranches?: boolean;
        removeClaudeMd?: boolean;
        protectedBranches?: string[];
    } = {}
): Promise<{ removed: number; errors: string[] }> {
    const { deleteBranches = true, removeClaudeMd = true, protectedBranches } = options;
    let removed = 0;
    const errors: string[] = [];

    for (const wt of worktrees) {
        try {
            // Remove generated CLAUDE.md (best-effort, don't block worktree removal)
            if (removeClaudeMd) {
                try {
                    const claudeMdPath = path.join(wt.path, "CLAUDE.md");
                    if (fs.existsSync(claudeMdPath)) {
                        fs.unlinkSync(claudeMdPath);
                    }
                } catch {
                    // File locked or permission denied — proceed with worktree removal
                }
            }

            await removeWorktree(repoRoot, wt.path, {
                deleteBranch: deleteBranches,
                force: true,
                ...(protectedBranches ? { protectedBranches } : {}),
            });
            removed++;
        } catch (err) {
            logError(`Post-merge cleanup failed for ${wt.branch}`, err);
            if (err instanceof GroveError) {
                errors.push(`${wt.branch}: ${err.message}`);
            } else {
                const raw = err instanceof Error ? err.message : String(err);
                if (raw.includes("EACCES") || raw.includes("permission denied")) {
                    errors.push(`${wt.branch}: Permission denied. Close any editors or terminals using this worktree and try again.`);
                } else if (raw.includes("index.lock") || raw.includes(".lock")) {
                    errors.push(`${wt.branch}: Git is locked by another process. Wait a moment and try again.`);
                } else {
                    errors.push(`${wt.branch}: Could not remove worktree. Check the Grove output channel for details.`);
                }
            }
        }
    }

    return { removed, errors };
}

// ────────────────────────────────────────────
// Merge Order Recommendation
// ────────────────────────────────────────────

/**
 * Recommend a merge order based on file dependencies.
 */
export function recommendMergeOrder(
    worktrees: WorktreeMergeInfo[],
    templateOrder?: string[]
): MergeOrderEntry[] {
    // If template defines an order, use it (but also include worktrees not in the template)
    // Template mergeOrder contains role names (e.g. "backend", "frontend"),
    // while branches are named "worktree-<team>-<role>". Match by suffix.
    if (templateOrder && templateOrder.length > 0) {
        const branchMap = new Map(worktrees.map((w) => [w.branch, w]));

        // Build a role-to-worktree map: try exact branch match first,
        // then fall back to matching branches that end with the role name
        const findWorktreeForRole = (role: string): WorktreeMergeInfo | undefined => {
            // Exact match (branch name IS the role)
            if (branchMap.has(role)) return branchMap.get(role);
            // Suffix match (branch ends with -<role>)
            for (const wt of worktrees) {
                if (wt.branch.endsWith(`-${role}`)) return wt;
            }
            return undefined;
        };

        const ordered: MergeOrderEntry[] = [];
        const matchedBranches = new Set<string>();

        for (const role of templateOrder) {
            const wt = findWorktreeForRole(role);
            if (wt) {
                ordered.push({
                    branch: wt.branch,
                    worktreePath: wt.path,
                    reason: "Template-defined order",
                });
                matchedBranches.add(wt.branch);
            }
        }

        // Append any worktrees not matched by the template order
        for (const wt of worktrees) {
            if (!matchedBranches.has(wt.branch)) {
                ordered.push({
                    branch: wt.branch,
                    worktreePath: wt.path,
                    reason: "Not in template order — appended",
                });
            }
        }

        return ordered;
    }

    // Analyze dependencies: if worktree B changes files that import
    // from files created by worktree A, A should merge first.
    // Simpler heuristic: sort by "infrastructure first" —
    // types/models/utils before features before tests.

    const scored = worktrees.map((wt) => {
        let score = 50; // default middle
        let reason = "Default order";

        const files = wt.changedFiles;

        // Types/interfaces/models → merge first
        const hasTypes = files.some(
            (f) =>
                f.includes("/types") ||
                f.includes("/interfaces") ||
                f.includes("/models") ||
                f.endsWith(".d.ts")
        );
        if (hasTypes) {
            score = 10;
            reason = "Contains type/model definitions (merge first)";
        }

        // Core/lib/utils → merge early
        const hasCore = files.some(
            (f) =>
                f.includes("/core/") ||
                f.includes("/lib/") ||
                f.includes("/utils/") ||
                f.includes("/shared/")
        );
        if (hasCore && !hasTypes) {
            score = 20;
            reason = "Contains core/library code";
        }

        // API/services → merge middle
        const hasApi = files.some(
            (f) =>
                f.includes("/api/") ||
                f.includes("/services/") ||
                f.includes("/middleware/")
        );
        if (hasApi && score === 50) {
            score = 30;
            reason = "Contains API/service code";
        }

        // UI/components/pages → merge after backend
        const hasUi = files.some(
            (f) =>
                f.includes("/components/") ||
                f.includes("/pages/") ||
                f.includes("/views/")
        );
        if (hasUi && score === 50) {
            score = 40;
            reason = "Contains UI components";
        }

        // Tests → merge last
        const hasTests = files.some(
            (f) =>
                f.includes("/test") ||
                f.includes(".test.") ||
                f.includes(".spec.")
        );
        if (hasTests && score === 50) {
            score = 80;
            reason = "Contains tests (merge last)";
        }

        // Review-only (no code changes) → skip or merge last
        if (files.length === 0) {
            score = 100;
            reason = "No file changes";
        }

        return { wt, score, reason };
    });

    scored.sort((a, b) => a.score - b.score);

    return scored.map((s) => ({
        branch: s.wt.branch,
        worktreePath: s.wt.path,
        reason: s.reason,
    }));
}

// ────────────────────────────────────────────
// Report Formatting
// ────────────────────────────────────────────

/**
 * Format a merge report as markdown for display.
 */
export function formatMergeReportMarkdown(report: MergeReport): string {
    const lines: string[] = [];

    lines.push("# Merge Readiness Report");
    lines.push("");
    lines.push(
        `Generated: ${new Date(report.generatedAt).toLocaleString()}`
    );
    lines.push(`Base branch: \`${report.baseBranch}\``);
    lines.push("");

    // Summary
    lines.push("## Summary");
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Worktrees | ${report.worktrees.length} |`);
    lines.push(`| Total files changed | ${report.totalFilesChanged} |`);
    lines.push(`| Lines added | +${report.totalLinesAdded} |`);
    lines.push(`| Lines removed | -${report.totalLinesRemoved} |`);
    lines.push(`| File overlaps | ${report.overlaps.length} |`);
    lines.push("");

    // Overlaps
    if (report.overlaps.length > 0) {
        lines.push("## File Overlaps");
        lines.push("");
        lines.push(
            "These files were modified in multiple worktrees and may cause merge conflicts:"
        );
        lines.push("");

        for (const overlap of report.overlaps) {
            const icon = overlap.likelyAutoResolvable ? "~" : "!!";
            const resolvability = overlap.likelyAutoResolvable
                ? "likely auto-resolvable"
                : "manual merge needed";
            lines.push(
                `- ${icon} \`${overlap.filePath}\` — ${overlap.branches.join(", ")} (${resolvability})`
            );
        }
        lines.push("");
    }

    // Merge Order
    lines.push("## Recommended Merge Order");
    lines.push("");
    for (let i = 0; i < report.mergeOrder.length; i++) {
        const entry = report.mergeOrder[i];
        lines.push(`${i + 1}. \`${entry.branch}\` — ${entry.reason}`);
    }
    lines.push("");

    // Per-worktree details
    lines.push("## Worktree Details");
    lines.push("");

    for (const wt of report.worktrees) {
        lines.push(`### ${wt.branch}`);
        lines.push("");
        lines.push(
            `- **${wt.changedFiles.length}** files changed | **+${wt.linesAdded}** / **-${wt.linesRemoved}** lines`
        );

        if (wt.hasUncommittedChanges) {
            lines.push("- **WARNING:** Has uncommitted changes");
        }

        if (wt.newFiles.length > 0) {
            lines.push(`- New files: ${wt.newFiles.map((f) => `\`${f}\``).join(", ")}`);
        }

        if (wt.reviewFindings) {
            lines.push("");
            lines.push("**Reviewer Findings:**");
            lines.push("");
            lines.push(wt.reviewFindings);
        }

        if (wt.handoffNotes) {
            lines.push("");
            lines.push("**Handoff Notes:**");
            lines.push("");
            lines.push(wt.handoffNotes);
        }

        lines.push("");

        if (wt.diffStat) {
            lines.push("```");
            lines.push(wt.diffStat);
            lines.push("```");
            lines.push("");
        }
    }

    return lines.join("\n");
}

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────

async function gatherWorktreeMergeInfo(
    worktreePath: string,
    baseBranch: string
): Promise<WorktreeMergeInfo> {
    const branch = await getCurrentBranch(worktreePath);
    const changedFiles = await getChangedFiles(worktreePath, baseBranch);
    const diffStat = await getDiffStats(worktreePath, baseBranch);

    // Parse lines added/removed from numstat
    let linesAdded = 0;
    let linesRemoved = 0;
    try {
        const numstat = await git(
            ["diff", "--numstat", `${baseBranch}...HEAD`],
            worktreePath
        );
        for (const line of numstat.split("\n")) {
            const [added, removed] = line.split("\t");
            if (added && removed && added !== "-") {
                linesAdded += parseInt(added, 10) || 0;
                linesRemoved += parseInt(removed, 10) || 0;
            }
        }
    } catch {
        // Ignore
    }

    // Detect new files
    let newFiles: string[] = [];
    try {
        const newFilesOutput = await git(
            ["diff", "--name-only", "--diff-filter=A", `${baseBranch}...HEAD`],
            worktreePath
        );
        newFiles = newFilesOutput.split("\n").filter(Boolean);
    } catch {
        // Ignore
    }

    // Check for uncommitted changes and include them in the report
    let hasUncommittedChanges = false;
    let uncommittedFiles: string[] = [];
    let uncommittedLinesAdded = 0;
    let uncommittedLinesRemoved = 0;
    try {
        const status = await git(["status", "--porcelain"], worktreePath);
        if (status.trim().length > 0) {
            hasUncommittedChanges = true;
            // Extract file paths from porcelain output
            uncommittedFiles = status
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                    // Porcelain format: XY filename  or  XY orig -> renamed
                    const filePart = line.slice(3);
                    // Handle renames (old -> new)
                    const arrowIdx = filePart.indexOf(" -> ");
                    return arrowIdx >= 0 ? filePart.slice(arrowIdx + 4) : filePart;
                })
                .filter(Boolean);

            // Get lines added/removed for all uncommitted changes (staged + unstaged)
            // `git diff HEAD` covers both staged and unstaged in one pass
            try {
                const uncommittedNumstat = await git(
                    ["diff", "--numstat", "HEAD"],
                    worktreePath
                );
                for (const line of uncommittedNumstat.split("\n")) {
                    const [added, removed] = line.split("\t");
                    if (added && removed && added !== "-") {
                        uncommittedLinesAdded += parseInt(added, 10) || 0;
                        uncommittedLinesRemoved += parseInt(removed, 10) || 0;
                    }
                }
            } catch {
                // Ignore — may fail if no HEAD commit
            }
        }
    } catch {
        // Ignore
    }

    // Merge committed and uncommitted changed files (deduplicated)
    const allChangedFiles = [...new Set([...changedFiles, ...uncommittedFiles])];

    // Identify truly new uncommitted files (untracked or added but not in committed changes).
    // Only files NOT already tracked by `git diff baseBranch...HEAD` are considered new.
    const allNewFiles = [...new Set([
        ...newFiles,
        ...uncommittedFiles.filter(
            (f) => !changedFiles.includes(f) && !newFiles.includes(f)
        ),
    ])];

    // Read REVIEW.md if exists
    let reviewFindings: string | undefined;
    const reviewPath = path.join(worktreePath, "REVIEW.md");
    if (fs.existsSync(reviewPath)) {
        try {
            reviewFindings = fs.readFileSync(reviewPath, "utf-8").trim();
        } catch {
            // Ignore
        }
    }

    // Read HANDOFF.md if exists
    let handoffNotes: string | undefined;
    const handoffPath = path.join(worktreePath, "HANDOFF.md");
    if (fs.existsSync(handoffPath)) {
        try {
            handoffNotes = fs.readFileSync(handoffPath, "utf-8").trim();
        } catch {
            // Ignore
        }
    }

    return {
        path: worktreePath,
        branch,
        changedFiles: allChangedFiles,
        linesAdded: linesAdded + uncommittedLinesAdded,
        linesRemoved: linesRemoved + uncommittedLinesRemoved,
        newFiles: allNewFiles,
        diffStat,
        reviewFindings,
        handoffNotes,
        hasUncommittedChanges,
    };
}

/**
 * Heuristic: is this file overlap likely auto-resolvable?
 * Config/lock files with additive changes (e.g., package.json deps)
 * are often auto-resolvable. Same-function edits are not.
 */
function isLikelyAutoResolvable(filePath: string): boolean {
    const autoResolvablePatterns = [
        "package.json",
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "go.sum",
        "Cargo.lock",
        "requirements.txt",
        ".gitignore",
    ];
    const fileName = path.basename(filePath);
    return autoResolvablePatterns.includes(fileName);
}
