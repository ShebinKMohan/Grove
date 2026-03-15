/**
 * Auto-manage .gitignore entries for worktree directories.
 * Gitignore utilities for Grove worktree management.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * Ensure a worktree path is in .gitignore.
 * Returns true if the entry was added, false if already present.
 */
export function ensureGitignored(
    repoRoot: string,
    worktreePath: string
): boolean {
    const gitignorePath = path.join(repoRoot, ".gitignore");

    // Compute relative pattern
    const resolved = path.resolve(worktreePath);
    const resolvedRoot = path.resolve(repoRoot);

    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
        // Worktree is outside the repo — nothing to gitignore
        return false;
    }

    const relative = path.relative(resolvedRoot, resolved).replace(/\\/g, "/");
    const pattern = `/${relative}/`;

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
        fs.writeFileSync(
            gitignorePath,
            `# Grove managed worktrees\n${pattern}\n`
        );
    }

    return true;
}
