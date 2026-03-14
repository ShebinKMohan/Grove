/**
 * CLAUDE.md Generator — creates per-agent CLAUDE.md files
 * for worktrees during team launch.
 *
 * Each agent gets a CLAUDE.md with:
 * - Role and responsibilities
 * - File ownership boundaries
 * - Shared files protocol
 * - Project conventions (from main repo's CLAUDE.md if it exists)
 * - User's task description
 * - Handoff protocol for out-of-scope changes
 */

import * as fs from "fs";
import * as path from "path";
import type { AgentRole, TeamTemplate } from "./template-manager";
import type { ProjectConfig } from "./config-manager";

export interface ClaudeMdOptions {
    /** The agent role configuration */
    agent: AgentRole;
    /** The full team template (for cross-reference) */
    template: TeamTemplate;
    /** The user's task description */
    taskDescription: string;
    /** The team name (used for cross-agent references) */
    teamName: string;
    /** The repo root (to find existing CLAUDE.md) */
    repoRoot: string;
    /** The worktree path where CLAUDE.md will be written */
    worktreePath: string;
    /** Project config if available */
    projectConfig?: ProjectConfig;
    /** Shared files that multiple agents might need to touch */
    sharedFiles?: string[];
}

/**
 * Generate and write a CLAUDE.md file for an agent's worktree.
 */
export function generateClaudeMd(options: ClaudeMdOptions): void {
    const content = buildClaudeMdContent(options);
    const filePath = path.join(options.worktreePath, "CLAUDE.md");
    fs.writeFileSync(filePath, content);
}

/**
 * Build the CLAUDE.md content string (without writing to disk).
 * Exported for testing and preview.
 */
export function buildClaudeMdContent(options: ClaudeMdOptions): string {
    const {
        agent,
        template,
        taskDescription,
        teamName,
        repoRoot,
        projectConfig,
        sharedFiles = [],
    } = options;

    const sections: string[] = [];

    // ── Header ──────────────────────────────────────
    sections.push(`# ${agent.displayName} — Grove Agent`);
    sections.push("");
    sections.push(`> **Team:** ${template.name} | **Role:** ${agent.role} | **Session:** ${teamName}`);
    sections.push("");
    sections.push(
        "**IMPORTANT: These agent-specific instructions take priority over any " +
        "project-level CLAUDE.md instructions regarding file ownership and boundaries. " +
        "YOU MUST respect the file ownership rules below — do not modify files " +
        "outside your assigned ownership patterns.**"
    );
    sections.push("");

    // ── Task Description ────────────────────────────
    if (taskDescription) {
        sections.push("## Task");
        sections.push("");
        sections.push(taskDescription);
        sections.push("");
    }

    // ── Role & Responsibilities ─────────────────────
    sections.push("## Your Role");
    sections.push("");
    sections.push(agent.prompt);
    sections.push("");

    if (agent.readOnly) {
        sections.push(
            "**IMPORTANT: You are in READ-ONLY review mode.** " +
            "Do NOT modify any source files. Instead, write your findings to `REVIEW.md` " +
            "in the root of this worktree."
        );
        sections.push("");
    }

    // ── File Ownership ──────────────────────────────
    sections.push("## File Ownership");
    sections.push("");

    if (agent.ownership.length > 0) {
        sections.push("**YOU MUST** focus your work on these file patterns — they are yours:");
        sections.push("");
        for (const pattern of agent.ownership) {
            sections.push(`- \`${pattern}\``);
        }
        sections.push("");
    }

    // List other agents' ownership for reference
    const otherAgents = template.agents.filter((a) => a.role !== agent.role);
    const otherOwnedAgents = otherAgents.filter((a) => a.ownership.length > 0);
    if (otherOwnedAgents.length > 0) {
        sections.push(
            "**IMPORTANT: YOU MUST NOT modify** files owned by other agents. " +
            "If you need changes in these files, use the Handoff Protocol below instead:"
        );
        sections.push("");
        for (const other of otherOwnedAgents) {
            const patterns = other.ownership.map((p) => `\`${p}\``).join(", ");
            sections.push(`- **${other.displayName}** (${other.role}): ${patterns}`);
        }
        sections.push("");
    }

    // ── Shared Files Protocol ───────────────────────
    if (sharedFiles.length > 0) {
        sections.push("## Shared Files Protocol");
        sections.push("");
        sections.push(
            "**IMPORTANT:** The following files may be needed by multiple agents. " +
            "**YOU MUST NOT modify these directly.** Instead, document your required " +
            "changes in `SHARED-CHANGES.md` in the root of this worktree."
        );
        sections.push("");
        for (const file of sharedFiles) {
            sections.push(`- \`${file}\``);
        }
        sections.push("");
        sections.push("Format for `SHARED-CHANGES.md`:");
        sections.push("");
        sections.push("```markdown");
        sections.push(`## Changes needed by ${agent.displayName}`);
        sections.push("");
        sections.push("### <filename>");
        sections.push("- What to add/change and why");
        sections.push("```");
        sections.push("");
    }

    // ── Handoff Protocol ────────────────────────────
    if (!agent.readOnly) {
        sections.push("## Handoff Protocol");
        sections.push("");
        sections.push(
            "If you need changes in files you don't own, create a `HANDOFF.md` " +
            "file in the root of this worktree with the following format:"
        );
        sections.push("");
        sections.push("```markdown");
        sections.push(`## Handoff from ${agent.displayName}`);
        sections.push("");
        sections.push("### For: <target agent role>");
        sections.push("- File: <path>");
        sections.push("- Change needed: <description>");
        sections.push("- Why: <reasoning>");
        sections.push("```");
        sections.push("");
    }

    // ── Project Conventions ─────────────────────────
    if (projectConfig?.conventions) {
        const conv = projectConfig.conventions;
        sections.push("## Project Conventions");
        sections.push("");
        if (conv.framework) sections.push(`- **Framework:** ${conv.framework}`);
        if (conv.testFramework) sections.push(`- **Testing:** ${conv.testFramework}`);
        if (conv.linter) sections.push(`- **Linting:** ${conv.linter}`);
        sections.push("");
    }

    // ── Extra Instructions ──────────────────────────
    if (agent.claudeMdExtra) {
        sections.push("## Additional Instructions");
        sections.push("");
        sections.push(agent.claudeMdExtra);
        sections.push("");
    }

    // ── Existing CLAUDE.md from main repo ───────────
    const existingClaudeMd = readExistingClaudeMd(repoRoot);
    if (existingClaudeMd) {
        sections.push("## Project-Level Instructions (from main repo)");
        sections.push("");
        sections.push(existingClaudeMd);
        sections.push("");
    }

    // ── Footer ──────────────────────────────────────
    sections.push("---");
    sections.push(
        `*Generated by Grove at ${new Date().toISOString()}*`
    );
    sections.push("");

    return sections.join("\n");
}

/**
 * Read the existing CLAUDE.md from the main repo root, if it exists.
 * Returns the content or undefined.
 */
function readExistingClaudeMd(repoRoot: string): string | undefined {
    const claudeMdPath = path.join(repoRoot, "CLAUDE.md");
    try {
        if (fs.existsSync(claudeMdPath)) {
            return fs.readFileSync(claudeMdPath, "utf-8").trim();
        }
    } catch {
        // Ignore read errors
    }
    return undefined;
}
