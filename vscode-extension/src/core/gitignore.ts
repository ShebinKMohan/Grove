/**
 * Auto-manage .gitignore entries for worktree directories
 * and the .grove/ local state directory.
 */

import * as fs from "fs";
import * as path from "path";

const GROVE_DIR_PATTERN = "/.grove/";

/**
 * Add a pattern to .gitignore. Creates the file if it doesn't exist.
 * Returns true if the entry was added, false if already present.
 */
function addToGitignore(
    gitignorePath: string,
    pattern: string,
    header: string
): boolean {
    if (fs.existsSync(gitignorePath)) {
        let content = fs.readFileSync(gitignorePath, "utf-8");
        if (content.includes(pattern)) {
            return false;
        }
        if (!content.endsWith("\n")) {
            content += "\n";
        }
        content += `${pattern}\n`;
        fs.writeFileSync(gitignorePath, content);
    } else {
        fs.writeFileSync(gitignorePath, `${header}\n${pattern}\n`);
    }
    return true;
}

/**
 * Ensure a worktree path is in .gitignore.
 * Returns true if the entry was added, false if already present.
 */
export function ensureGitignored(
    repoRoot: string,
    worktreePath: string
): boolean {
    const resolved = path.resolve(worktreePath);
    const resolvedRoot = path.resolve(repoRoot);

    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
        // Worktree is outside the repo — nothing to gitignore
        return false;
    }

    const relative = path.relative(resolvedRoot, resolved).replace(/\\/g, "/");
    const pattern = `/${relative}/`;
    const gitignorePath = path.join(repoRoot, ".gitignore");

    return addToGitignore(gitignorePath, pattern, "# Grove managed worktrees");
}

/**
 * Remove a worktree path from .gitignore.
 * Returns true if the entry was removed, false if not found.
 */
export function removeFromGitignore(
    repoRoot: string,
    worktreePath: string
): boolean {
    const resolved = path.resolve(worktreePath);
    const resolvedRoot = path.resolve(repoRoot);

    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
        return false;
    }

    const relative = path.relative(resolvedRoot, resolved).replace(/\\/g, "/");
    const pattern = `/${relative}/`;
    const gitignorePath = path.join(repoRoot, ".gitignore");

    if (!fs.existsSync(gitignorePath)) return false;

    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (!content.includes(pattern)) return false;

    // Remove the pattern line
    const lines = content.split("\n");
    const filtered = lines.filter((line) => line.trim() !== pattern.trim());

    // Clean up empty "# Grove managed worktrees" headers with no entries after them
    const cleaned: string[] = [];
    for (let i = 0; i < filtered.length; i++) {
        const line = filtered[i];
        if (line.trim() === "# Grove managed worktrees") {
            // Skip header if the next non-empty line is not a Grove pattern
            const next = filtered.slice(i + 1).find((l) => l.trim() !== "");
            if (!next || !next.startsWith("/.claude/")) {
                continue;
            }
        }
        cleaned.push(line);
    }

    fs.writeFileSync(gitignorePath, cleaned.join("\n"));
    return true;
}

/**
 * Ensure .grove/ (local state directory) is in .gitignore.
 * Called when .grove/ is first created to persist sessions or teams.
 * Returns true if the entry was added, false if already present.
 */
export function ensureGroveDirIgnored(repoRoot: string): boolean {
    const gitignorePath = path.join(repoRoot, ".gitignore");
    return addToGitignore(gitignorePath, GROVE_DIR_PATTERN, "# Grove local state");
}
