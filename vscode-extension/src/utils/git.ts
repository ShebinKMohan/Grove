/**
 * Git command execution wrapper.
 * All git interactions go through this module using child_process.execFile.
 * No git libraries — just direct CLI calls with proper error handling.
 *
 * Write operations are serialized via a queue to prevent git lock conflicts.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

/**
 * Simple mutex queue for serializing git write operations.
 * Prevents concurrent git commands from conflicting on lock files.
 */
class GitMutex {
    private queue: Array<{
        fn: () => Promise<unknown>;
        resolve: (value: unknown) => void;
        reject: (reason: unknown) => void;
    }> = [];
    private running = false;

    async run<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({
                fn: fn as () => Promise<unknown>,
                resolve: resolve as (value: unknown) => void,
                reject,
            });
            void this.drain();
        });
    }

    private async drain(): Promise<void> {
        if (this.running) return;
        this.running = true;
        while (this.queue.length > 0) {
            const task = this.queue.shift()!;
            try {
                const result = await task.fn();
                task.resolve(result);
            } catch (err) {
                task.reject(err);
            }
        }
        this.running = false;
    }
}

const writeMutex = new GitMutex();

/**
 * Execute a git command and return stdout.
 * Uses execFile (no shell) to avoid injection risks.
 */
export async function git(args: string[], cwd: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync("git", args, {
            cwd,
            maxBuffer: MAX_BUFFER,
        });
        return stdout.trim();
    } catch (err) {
        const error = err as { stderr?: string; message?: string };
        let message = error.stderr?.trim() || error.message || String(err);
        // Strip "fatal: " and "error: " prefixes that git adds — they're
        // unhelpful noise when the message is embedded in our own UI.
        message = message.replace(/^(fatal|error): /i, "");
        throw new GitError(message, args);
    }
}

/**
 * Execute a git write operation through the mutex queue.
 * Use this for commands that modify state: worktree add/remove, branch delete, merge, etc.
 */
export async function gitWrite(args: string[], cwd: string): Promise<string> {
    return writeMutex.run(() => git(args, cwd));
}

/**
 * Sanitize a git ref name for safe interpolation into shell commands.
 * Rejects anything that isn't a plausible branch/tag name.
 */
export function sanitizeRefName(name: string): string {
    // Allow only characters valid in git ref names
    if (!/^[a-zA-Z0-9_./-]+$/.test(name)) {
        return "HEAD";
    }
    return name;
}

/**
 * Get the repository root directory.
 */
export async function getRepoRoot(cwd: string): Promise<string> {
    return git(["rev-parse", "--show-toplevel"], cwd);
}

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
    try {
        return await git(["symbolic-ref", "--short", "HEAD"], cwd);
    } catch {
        // Detached HEAD — return short commit hash
        return git(["rev-parse", "--short", "HEAD"], cwd);
    }
}

/**
 * Check if a branch exists in local refs.
 */
export async function branchExistsLocally(
    cwd: string,
    branch: string
): Promise<boolean> {
    try {
        await git(["rev-parse", "--verify", `refs/heads/${branch}`], cwd);
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if a branch exists on the remote.
 */
export async function branchExistsOnRemote(
    cwd: string,
    branch: string
): Promise<boolean> {
    try {
        await git(
            ["rev-parse", "--verify", `refs/remotes/origin/${branch}`],
            cwd
        );
        return true;
    } catch {
        return false;
    }
}

/**
 * List all local branch names, sorted by most recent commit first.
 */
export async function listLocalBranches(cwd: string): Promise<string[]> {
    try {
        const raw = await git(
            ["branch", "--sort=-committerdate", "--format=%(refname:short)"],
            cwd
        );
        if (!raw) return [];
        return raw.split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * Structured error for git command failures.
 */
export class GitError extends Error {
    public readonly args: string[];

    constructor(message: string, args: string[]) {
        super(message);
        this.name = "GitError";
        this.args = args;
    }
}
