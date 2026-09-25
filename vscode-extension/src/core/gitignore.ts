/**
 * Local-only ignore rules for worktree directories and the .grove/
 * local state directory.
 *
 * Rules are written to the repository's `info/exclude` file, which git
 * reads like a .gitignore but never tracks. Grove therefore never edits
 * or commits the user's .gitignore, and never touches their index. The
 * file lives in the common git directory, so one rule covers every
 * worktree of the repository.
 *
 * Grove 0.6.0 and earlier committed these rules to .gitignore. Those
 * lines are left in place: a stale ignore line is harmless, and removing
 * it would mean editing or committing a tracked file.
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

const GROVE_DIR_PATTERN = "/.grove/";
const EXCLUDE_HEADER = "# Grove: local ignore rules (this file is never committed)";

/**
 * Resolve the absolute path of the repository's `info/exclude` file.
 * Works from the main worktree and from linked worktrees.
 * Returns undefined when `repoRoot` is not inside a git repository.
 */
export function resolveExcludePath(repoRoot: string): string | undefined {
    try {
        const out = execFileSync(
            "git",
            ["rev-parse", "--git-path", "info/exclude"],
            {
                cwd: repoRoot,
                encoding: "utf-8",
                timeout: 5000,
                stdio: ["ignore", "pipe", "ignore"],
            }
        ).trim();
        return out ? path.resolve(repoRoot, out) : undefined;
    } catch {
        return undefined;
    }
}

/** Escape characters that gitignore treats as glob syntax. */
function escapePattern(pattern: string): string {
    return pattern.replace(/[\\*?[\]]/g, "\\$&").replace(/ $/, "\\ ");
}

/**
 * Build the anchored ignore pattern for a worktree directory, or
 * undefined if the directory is not inside the repository.
 */
function worktreePattern(repoRoot: string, worktreePath: string): string | undefined {
    const resolved = path.resolve(worktreePath);
    const resolvedRoot = path.resolve(repoRoot);

    if (!resolved.startsWith(resolvedRoot + path.sep)) {
        // Worktree is outside the repo — nothing to ignore
        return undefined;
    }

    const relative = path.relative(resolvedRoot, resolved).replace(/\\/g, "/");
    return `/${escapePattern(relative)}/`;
}

/**
 * Append a pattern to info/exclude.
 * Returns true if the pattern was added, false if it was already present
 * or the exclude file could not be found.
 */
function addExcludePattern(repoRoot: string, pattern: string): boolean {
    const excludePath = resolveExcludePath(repoRoot);
    if (!excludePath) return false;

    let content = fs.existsSync(excludePath)
        ? fs.readFileSync(excludePath, "utf-8")
        : "";
    const lines = content.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(pattern)) {
        return false;
    }

    if (content.length > 0 && !content.endsWith("\n")) {
        content += "\n";
    }
    if (!lines.includes(EXCLUDE_HEADER)) {
        content += `${EXCLUDE_HEADER}\n`;
    }
    content += `${pattern}\n`;

    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.writeFileSync(excludePath, content);
    return true;
}

/**
 * Remove a pattern from info/exclude.
 * Returns true if the pattern was removed, false if it was not found.
 */
function removeExcludePattern(repoRoot: string, pattern: string): boolean {
    const excludePath = resolveExcludePath(repoRoot);
    if (!excludePath || !fs.existsSync(excludePath)) return false;

    const content = fs.readFileSync(excludePath, "utf-8");
    const lines = content.split("\n");
    const kept = lines.filter((line) => line.trim() !== pattern);
    if (kept.length === lines.length) return false;

    fs.writeFileSync(excludePath, kept.join("\n"));
    return true;
}

/**
 * Keep a worktree directory out of `git status` in the main worktree.
 * Returns true if a rule was added, false if it was already present or
 * the worktree is outside the repository.
 */
export function excludeWorktreePath(
    repoRoot: string,
    worktreePath: string
): boolean {
    const pattern = worktreePattern(repoRoot, worktreePath);
    return pattern ? addExcludePattern(repoRoot, pattern) : false;
}

/**
 * Remove the ignore rule for a worktree directory.
 * Returns true if a rule was removed, false if none was found.
 */
export function removeWorktreeExclusion(
    repoRoot: string,
    worktreePath: string
): boolean {
    const pattern = worktreePattern(repoRoot, worktreePath);
    return pattern ? removeExcludePattern(repoRoot, pattern) : false;
}

/** Repos whose .grove/ rule was already checked in this process. */
const groveDirChecked = new Set<string>();

/**
 * Keep .grove/ (local state directory) out of `git status`.
 * Called every time Grove writes sessions, teams or agent instructions
 * there; the exclude file is read once per repository per process.
 * Returns true if a rule was added, false if it was already present.
 */
export function excludeGroveDir(repoRoot: string): boolean {
    const key = path.resolve(repoRoot);
    if (groveDirChecked.has(key)) return false;
    const added = addExcludePattern(repoRoot, GROVE_DIR_PATTERN);
    if (resolveExcludePath(repoRoot)) groveDirChecked.add(key);
    return added;
}
