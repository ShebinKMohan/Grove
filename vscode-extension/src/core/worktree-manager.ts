/**
 * Worktree Manager — all git worktree CRUD operations.
 * Handles creation, listing, deletion, status, branch strategy, and cleanup.
 *
 * Uses direct git CLI calls via src/utils/git.ts (no git libraries).
 */

import * as fs from "fs";
import * as path from "path";
import {
    git,
    gitWrite,
    branchExistsLocally,
    branchExistsOnRemote,
} from "../utils/git";
import { ensureGitignored, removeFromGitignore } from "./gitignore";
import { installDependencies, type PackageManager } from "../utils/package-manager";
import { log } from "../utils/logger";
import {
    GroveError,
    BranchAlreadyCheckedOutError,
    WorktreePathExistsError,
    GitLockError,
} from "../utils/errors";

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

export interface WorktreeInfo {
    path: string;
    branch: string;
    commit: string;
    isMain: boolean;
    isBare: boolean;
    status: WorktreeStatus;
    statusSummary: string;
    /** Commits ahead of the remote tracking branch. */
    ahead: number;
    /** Commits behind the remote tracking branch. */
    behind: number;
}

interface WorktreeStatus {
    modified: number;
    staged: number;
    untracked: number;
    conflicts: number;
}

interface BranchStrategy {
    branch: string;
    newBranch: boolean;
    startPoint: string;
    description: string;
}

export interface CreationResult {
    path: string;
    branch: string;
    description: string;
}

interface CleanupResult {
    path: string;
    removed: boolean;
    branchDeleted?: string | "failed";
}

// ────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────

const DEFAULT_WORKTREE_DIR = ".claude/worktrees";

export const PROTECTED_BRANCHES = new Set([
    "main",
    "master",
    "develop",
    "production",
]);

// ────────────────────────────────────────────
// Branch helpers
// ────────────────────────────────────────────

/**
 * Validate a git branch name.
 * Returns null if valid, or an error message string.
 */
export function validateBranchName(name: string): string | null {
    if (!name) return "Branch name cannot be empty.";
    if (name.startsWith("/") || name.endsWith("/"))
        return "Branch name cannot start or end with '/'.";
    if (name.startsWith(".") || name.includes("/."))
        return "Branch name components cannot start with '.'.";
    if (name.includes("..")) return "Branch name cannot contain '..'.";
    if (name.endsWith(".lock")) return "Branch name cannot end with '.lock'.";
    if (/[\s~^:?*]/.test(name))
        return "Branch name contains invalid characters (spaces, ~, ^, :, ?, *).";
    if (!/^[\w./-]+$/.test(name))
        return "Branch name contains invalid characters.";
    return null;
}

/**
 * Determine how to set up a worktree for the given branch.
 * Implements the -b flag decision tree:
 *   local exists → use as-is
 *   remote exists → create tracking branch
 *   neither → create new branch from HEAD
 */
export async function resolveBranchStrategy(
    repoRoot: string,
    branchName: string
): Promise<BranchStrategy> {
    const [existsLocal, existsRemote] = await Promise.all([
        branchExistsLocally(repoRoot, branchName),
        branchExistsOnRemote(repoRoot, branchName),
    ]);

    if (existsLocal) {
        return {
            branch: branchName,
            newBranch: false,
            startPoint: "",
            description: `Using existing local branch '${branchName}'`,
        };
    }

    if (existsRemote) {
        return {
            branch: branchName,
            newBranch: true,
            startPoint: `origin/${branchName}`,
            description: `Creating local branch '${branchName}' tracking 'origin/${branchName}'`,
        };
    }

    return {
        branch: branchName,
        newBranch: true,
        startPoint: "HEAD",
        description: `Creating new branch '${branchName}' from current HEAD`,
    };
}

/**
 * Compute the absolute path for a new worktree.
 * Places worktrees in: <repo-root>/<worktreeDir>/<branch-slug>
 */
function computeWorktreePath(
    repoRoot: string,
    branchName: string,
    worktreeDir: string = DEFAULT_WORKTREE_DIR
): string {
    const slug = branchName.replace(/\//g, "-");
    return path.resolve(repoRoot, worktreeDir, slug);
}

// ────────────────────────────────────────────
// Worktree CRUD
// ────────────────────────────────────────────

/**
 * Parse `git worktree list --porcelain` output into WorktreeInfo array.
 */
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
    const raw = await git(["worktree", "list", "--porcelain"], repoRoot);
    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of raw.split("\n")) {
        if (line.startsWith("worktree ")) {
            if (current.path) {
                worktrees.push(finalizeWorktree(current));
            }
            current = { path: line.slice(9) };
        } else if (line.startsWith("HEAD ")) {
            current.commit = line.slice(5);
        } else if (line.startsWith("branch ")) {
            current.branch = line.slice(7).replace("refs/heads/", "");
        } else if (line === "bare") {
            current.isBare = true;
        } else if (line === "detached") {
            current.branch = "(detached HEAD)";
        }
    }
    if (current.path) {
        worktrees.push(finalizeWorktree(current));
    }

    // Mark the first worktree as main
    if (worktrees.length > 0) {
        worktrees[0].isMain = true;
    }

    return worktrees;
}

function finalizeWorktree(partial: Partial<WorktreeInfo>): WorktreeInfo {
    return {
        path: partial.path ?? "",
        branch: partial.branch ?? "unknown",
        commit: partial.commit ?? "",
        isMain: partial.isMain ?? false,
        isBare: partial.isBare ?? false,
        status: { modified: 0, staged: 0, untracked: 0, conflicts: 0 },
        statusSummary: "",
        ahead: 0,
        behind: 0,
    };
}

/**
 * Get the working tree status for a worktree directory.
 * Parses `git status --porcelain` output.
 */
export async function getWorktreeStatus(
    worktreePath: string
): Promise<WorktreeStatus> {
    try {
        const raw = await git(["status", "--porcelain"], worktreePath);
        const status: WorktreeStatus = {
            modified: 0,
            staged: 0,
            untracked: 0,
            conflicts: 0,
        };

        if (!raw) return status;

        for (const line of raw.split("\n")) {
            if (!line || line.length < 2) continue;
            const x = line[0];
            const y = line[1];

            // Conflict markers
            if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
                status.conflicts++;
            } else if (x === "?" && y === "?") {
                status.untracked++;
            } else {
                if (x !== " " && x !== "?") status.staged++;
                if (y !== " " && y !== "?") status.modified++;
            }
        }

        return status;
    } catch {
        // Return -1 to signal that status could not be determined
        // (corrupted index, broken .git file, locked repo, etc.)
        return { modified: -1, staged: 0, untracked: 0, conflicts: 0 };
    }
}

/**
 * Get ahead/behind counts relative to the remote tracking branch.
 * Returns { ahead: 0, behind: 0 } if no tracking branch is set.
 */
async function getAheadBehind(
    worktreePath: string,
    branch: string
): Promise<{ ahead: number; behind: number }> {
    try {
        // Check if a remote tracking branch exists
        const tracking = (
            await git(
                ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`],
                worktreePath
            )
        ).trim();
        if (!tracking) return { ahead: 0, behind: 0 };

        const output = (
            await git(
                ["rev-list", "--left-right", "--count", `${branch}...${tracking}`],
                worktreePath
            )
        ).trim();
        const [aheadStr, behindStr] = output.split(/\s+/);
        return {
            ahead: parseInt(aheadStr, 10) || 0,
            behind: parseInt(behindStr, 10) || 0,
        };
    } catch {
        // No tracking branch or other git error
        return { ahead: 0, behind: 0 };
    }
}

/**
 * Fetch the latest remote refs for all worktrees.
 * Uses `git fetch --all` so ahead/behind counts are up to date.
 */
export async function fetchRemote(repoRoot: string): Promise<void> {
    await gitWrite(["fetch", "--all", "--prune"], repoRoot);
}

/**
 * Pull remote changes into a specific worktree using rebase.
 */
export async function syncWorktree(worktreePath: string): Promise<string> {
    const output = await gitWrite(["pull", "--rebase", "--autostash"], worktreePath);
    return output;
}

/**
 * List all worktrees with status info populated.
 */
export async function listAllWorktrees(
    repoRoot: string
): Promise<WorktreeInfo[]> {
    const worktrees = await listWorktrees(repoRoot);

    for (const wt of worktrees) {
        if (fs.existsSync(wt.path)) {
            const status = await getWorktreeStatus(wt.path);
            wt.status = status;
            if (status.modified === -1) {
                // git status failed — worktree is broken
                wt.statusSummary = "error";
                wt.status = { modified: 0, staged: 0, untracked: 0, conflicts: 0 };
            } else {
                const changes: string[] = [];
                if (status.modified) changes.push(`${status.modified}M`);
                if (status.staged) changes.push(`${status.staged}S`);
                if (status.untracked) changes.push(`${status.untracked}?`);
                if (status.conflicts) changes.push(`${status.conflicts}!`);
                wt.statusSummary =
                    changes.length > 0 ? changes.join(" ") : "clean";
            }

            // Get ahead/behind from remote
            const ab = await getAheadBehind(wt.path, wt.branch);
            wt.ahead = ab.ahead;
            wt.behind = ab.behind;
        } else {
            wt.statusSummary = "missing";
        }
    }

    return worktrees;
}

/**
 * Create a new worktree with proper branch handling.
 * Optionally installs dependencies after creation.
 */
export async function createWorktree(
    repoRoot: string,
    branchName: string,
    options: {
        customPath?: string;
        startPoint?: string;
        worktreeDir?: string;
        autoGitignore?: boolean;
        autoInstallDeps?: boolean;
        packageManager?: PackageManager;
    } = {}
): Promise<CreationResult> {
    const strategy = await resolveBranchStrategy(repoRoot, branchName);
    const wtPath =
        options.customPath ||
        computeWorktreePath(repoRoot, branchName, options.worktreeDir);

    // Build git worktree add args
    const args = ["worktree", "add"];
    if (strategy.newBranch) {
        args.push("-b", strategy.branch, wtPath);
        const startPoint = options.startPoint || strategy.startPoint;
        if (startPoint) {
            args.push(startPoint);
        }
    } else {
        args.push(wtPath, strategy.branch);
    }

    try {
        await gitWrite(args, repoRoot);
    } catch (err) {
        throwFriendlyWorktreeError(err, strategy.branch, wtPath);
    }

    // Auto-gitignore — commit immediately so the base branch stays clean
    // and doesn't block future merges with uncommitted changes.
    if (options.autoGitignore !== false) {
        if (ensureGitignored(repoRoot, wtPath)) {
            try {
                await gitWrite(["add", ".gitignore"], repoRoot);
                await gitWrite(
                    ["commit", "-m", `chore: gitignore worktree path for ${branchName}`],
                    repoRoot
                );
                log("Committed .gitignore update for worktree path");
            } catch {
                log("Could not auto-commit .gitignore (may already be committed)");
            }
        }
    }

    // Auto-install dependencies
    if (options.autoInstallDeps) {
        await installDependencies(wtPath, options.packageManager);
    }

    const desc =
        options.startPoint && strategy.newBranch
            ? `Creating new branch '${branchName}' from '${options.startPoint}'`
            : strategy.description;

    return { path: wtPath, branch: strategy.branch, description: desc };
}

/**
 * Remove a worktree and optionally delete its branch.
 */
export async function removeWorktree(
    repoRoot: string,
    wtPath: string,
    options: {
        deleteBranch?: boolean;
        force?: boolean;
        protectedBranches?: string[];
    } = {}
): Promise<CleanupResult> {
    // Find branch name before removing
    // Normalize both sides: git may return canonical paths (e.g. /private/var on macOS)
    // while the caller passes the symlinked path (e.g. /var)
    const worktrees = await listWorktrees(repoRoot);
    let resolvedWtPath: string;
    try {
        resolvedWtPath = fs.realpathSync(wtPath);
    } catch {
        resolvedWtPath = path.resolve(wtPath);
    }
    const wt = worktrees.find((w) => {
        let resolvedW: string;
        try {
            resolvedW = fs.realpathSync(w.path);
        } catch {
            resolvedW = path.resolve(w.path);
        }
        return resolvedW === resolvedWtPath;
    });
    const branchName = wt?.branch;

    // Remove worktree
    const args = ["worktree", "remove"];
    if (options.force) args.push("--force");
    args.push(wtPath);

    try {
        await gitWrite(args, repoRoot);
    } catch (err) {
        throw new GroveError(
            `Failed to remove worktree at ${wtPath}.`,
            "If it has uncommitted changes, use force removal.",
            err instanceof Error ? err : undefined
        );
    }

    const result: CleanupResult = { path: wtPath, removed: true };

    // Remove the .gitignore entry and commit the change so the
    // base branch stays clean and doesn't block future merges.
    if (removeFromGitignore(repoRoot, wtPath)) {
        try {
            await gitWrite(["add", ".gitignore"], repoRoot);
            await gitWrite(
                ["commit", "-m", `chore: remove gitignore entry for deleted worktree`],
                repoRoot
            );
            log("Committed .gitignore cleanup after worktree removal");
        } catch {
            log("Could not auto-commit .gitignore cleanup");
        }
    }

    // Optionally delete branch
    if (
        options.deleteBranch &&
        branchName &&
        branchName !== "(detached HEAD)" &&
        !(options.protectedBranches
            ? new Set(options.protectedBranches).has(branchName)
            : PROTECTED_BRANCHES.has(branchName))
    ) {
        try {
            const delArgs = ["branch", options.force ? "-D" : "-d", branchName];
            await gitWrite(delArgs, repoRoot);
            result.branchDeleted = branchName;
        } catch (err) {
            log(`Could not delete branch '${branchName}': ${err instanceof Error ? err.message : String(err)}`);
            result.branchDeleted = "failed";
        }
    }

    return result;
}

/**
 * Get files changed in a worktree relative to a base branch.
 */
export async function getChangedFiles(
    worktreePath: string,
    baseBranch: string = "main"
): Promise<string[]> {
    try {
        const raw = await git(
            ["diff", "--name-only", `${baseBranch}...HEAD`],
            worktreePath
        );
        if (!raw) return [];
        return raw.split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

export interface ChangedFile {
    /** Relative file path within the worktree */
    filePath: string;
    /** Change type */
    status: "added" | "modified" | "deleted" | "renamed";
}

/**
 * Get files changed in a worktree with their status (added/modified/deleted).
 * Uses `git diff --name-status` against the base branch.
 * Falls back to `git status --porcelain` for uncommitted changes.
 */
/** Directories that should never appear in changed file lists. */
const NOISE_DIRS = [
    "node_modules/",
    ".git/",
    "dist/",
    ".vite/",
    "__pycache__/",
    ".next/",
    ".nuxt/",
    "coverage/",
    ".cache/",
];

function isNoisePath(filePath: string): boolean {
    return NOISE_DIRS.some((dir) => filePath.startsWith(dir) || filePath.includes(`/${dir}`));
}

export async function getChangedFilesWithStatus(
    worktreePath: string,
    baseBranch: string = "main"
): Promise<ChangedFile[]> {
    const files: ChangedFile[] = [];
    const seen = new Set<string>();

    // 1. Committed changes vs base branch
    try {
        const raw = await git(
            ["diff", "--name-status", `${baseBranch}...HEAD`],
            worktreePath
        );
        if (raw) {
            for (const line of raw.split("\n")) {
                if (!line) continue;
                const tab = line.indexOf("\t");
                if (tab === -1) continue;
                const code = line.slice(0, tab).trim();
                const filePath = line.slice(tab + 1).trim();
                if (!filePath || isNoisePath(filePath)) continue;
                const status = parseGitStatusCode(code);
                files.push({ filePath, status });
                seen.add(filePath);
            }
        }
    } catch {
        // Base branch may not exist — fall through to status check
    }

    // 2. Uncommitted changes (working tree + index)
    try {
        const raw = await git(["status", "--porcelain"], worktreePath);
        if (raw) {
            for (const line of raw.split("\n")) {
                if (!line || line.length < 3) continue;
                const filePath = line.slice(3).trim();
                if (!filePath || seen.has(filePath) || isNoisePath(filePath)) continue;
                const x = line[0];
                const y = line[1];
                let status: ChangedFile["status"] = "modified";
                if (x === "?" && y === "?") status = "added";
                else if (x === "A" || y === "A") status = "added";
                else if (x === "D" || y === "D") status = "deleted";
                else if (x === "R" || y === "R") status = "renamed";
                files.push({ filePath, status });
            }
        }
    } catch {
        // Ignore
    }

    return files;
}

function parseGitStatusCode(code: string): ChangedFile["status"] {
    if (code.startsWith("A")) return "added";
    if (code.startsWith("D")) return "deleted";
    if (code.startsWith("R")) return "renamed";
    return "modified";
}

/**
 * Get diff stats for a worktree relative to base branch.
 */
export async function getDiffStats(
    worktreePath: string,
    baseBranch: string = "main"
): Promise<string> {
    try {
        return await git(
            ["diff", "--stat", `${baseBranch}...HEAD`],
            worktreePath
        );
    } catch {
        return "";
    }
}

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────

function throwFriendlyWorktreeError(
    err: unknown,
    branch: string,
    wtPath: string
): never {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes("already checked out")) {
        throw new BranchAlreadyCheckedOutError(branch);
    }
    if (msg.includes("already exists")) {
        throw new WorktreePathExistsError(wtPath);
    }
    if (msg.includes("index.lock") || (msg.includes("Unable to create") && msg.includes(".lock"))) {
        throw new GitLockError("git worktree add");
    }
    if (msg.includes("not a valid object name") || msg.includes("invalid reference") || msg.includes("bad revision")) {
        throw new GroveError(
            `The base branch or starting point for '${branch}' does not exist.`,
            "Make sure the base branch exists locally. Run 'git fetch --all' to update remote refs, or choose a different base branch.",
            err instanceof Error ? err : undefined
        );
    }
    if (msg.includes("EACCES") || msg.includes("permission denied")) {
        throw new GroveError(
            `Permission denied when creating worktree for '${branch}'.`,
            "Check file permissions for the target directory.",
            err instanceof Error ? err : undefined
        );
    }
    if (msg.includes("ENOSPC") || msg.includes("no space")) {
        throw new GroveError(
            `Disk is full — cannot create worktree for '${branch}'.`,
            "Free up disk space and try again.",
            err instanceof Error ? err : undefined
        );
    }
    throw new GroveError(
        `Failed to create worktree for branch '${branch}'.`,
        "Check the Grove output channel for details.",
        err instanceof Error ? err : undefined
    );
}
