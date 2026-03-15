/**
 * Custom error types with fix suggestions.
 * Every error shown to users includes a fix command so the user
 * always knows what went wrong AND what to do about it.
 */

export class GroveError extends Error {
    public readonly fix: string;
    public readonly originalError?: Error;

    constructor(message: string, fix: string, originalError?: Error) {
        super(message);
        this.name = "GroveError";
        this.fix = fix;
        this.originalError = originalError;
    }
}

export class BranchAlreadyCheckedOutError extends GroveError {
    constructor(branch: string) {
        super(
            `Branch '${branch}' is already checked out in another worktree.`,
            "Use a different branch name, or remove the other worktree first."
        );
        this.name = "BranchAlreadyCheckedOutError";
    }
}

export class WorktreePathExistsError extends GroveError {
    constructor(path: string) {
        super(
            `Worktree path '${path}' already exists.`,
            "Choose a different branch name, or run Cleanup to remove stale worktrees."
        );
        this.name = "WorktreePathExistsError";
    }
}

export class GitLockError extends GroveError {
    constructor(operation: string) {
        super(
            `Git is locked — another git operation may be in progress.`,
            `Wait a moment and try again. If the problem persists, delete the lock file:\n  rm -f .git/index.lock\n\nOperation: ${operation}`
        );
        this.name = "GitLockError";
    }
}

/**
 * Format any error into a user-friendly message with context.
 * Adds actionable hints for common git/system errors.
 */
export function formatErrorForUser(err: unknown, context: string): string {
    if (err instanceof GroveError) {
        return `${err.message}\n\nFix: ${err.fix}`;
    }

    let raw = err instanceof Error ? err.message : String(err);
    // Strip git's "fatal: " / "error: " prefixes — unhelpful noise in our UI
    raw = raw.replace(/^(fatal|error): /i, "");

    // Detect common error patterns and add helpful context
    if (raw.includes("ENOENT") && raw.includes("git")) {
        return `${context}: git is not installed or not in your PATH.\n\nFix: Install git and reload the window.`;
    }
    if (raw.includes("ENOENT") && raw.includes("claude")) {
        return `${context}: Claude Code CLI is not installed.\n\nFix: Run 'npm install -g @anthropic-ai/claude-code' and reload the window.`;
    }
    if (raw.includes("index.lock") || (raw.includes("Unable to create") && raw.includes(".lock"))) {
        return `${context}: Git is locked by another process.\n\nFix: Wait a moment and retry. If stuck, run: rm -f .git/index.lock`;
    }
    if (raw.includes("EACCES") || raw.includes("permission denied")) {
        return `${context}: Permission denied.\n\nFix: Check file permissions for this directory.`;
    }
    if (raw.includes("ENOSPC") || raw.includes("no space")) {
        return `${context}: Disk is full.\n\nFix: Free up disk space and try again.`;
    }
    if (raw.includes("not a git repository")) {
        return `${context}: This folder is not a git repository.\n\nFix: Run 'git init' or open a git project.`;
    }
    if (raw.includes("already checked out")) {
        return `${context}: This branch is already checked out in another worktree.\n\nFix: Use a different branch name, or remove the other worktree first.`;
    }
    if (raw.includes("already exists")) {
        return `${context}: A worktree or branch with this name already exists.\n\nFix: Choose a different name, or run Cleanup to remove stale worktrees.`;
    }
    if (raw.includes("unrelated histories")) {
        return `${context}: The branches have unrelated histories and cannot be merged automatically.\n\nFix: Use 'git merge --allow-unrelated-histories' in a terminal if intentional.`;
    }
    if (raw.includes("not something we can merge")) {
        return `${context}: The branch could not be found.\n\nFix: Make sure the branch name is correct and exists locally.`;
    }
    if (raw.includes("overwritten by merge")) {
        return `${context}: Local changes would be overwritten.\n\nFix: Commit or stash your changes first.`;
    }
    if (raw.includes("ETIMEDOUT") || raw.includes("timed out")) {
        return `${context}: The operation timed out.\n\nFix: Check your network connection and try again.`;
    }

    return `${context}: ${raw}`;
}
