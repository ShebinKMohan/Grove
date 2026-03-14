/**
 * Terminal creation and management utilities.
 * Handles launching terminals in worktree directories and Claude Code sessions.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { log } from "./logger";

/** Cached absolute path to the claude binary. */
let cachedClaudePath: string | undefined;

function resolveClaudePath(): string {
    if (!cachedClaudePath) {
        try {
            const cmd = process.platform === "win32" ? "where" : "which";
            cachedClaudePath = execFileSync(cmd, ["claude"], {
                encoding: "utf-8",
                timeout: 5000,
            }).trim().split("\n")[0]; // `where` on Windows can return multiple lines
        } catch {
            cachedClaudePath = "claude";
        }
    }
    return cachedClaudePath;
}

/**
 * Open a plain terminal in the given directory.
 */
export function openTerminal(name: string, cwd: string): vscode.Terminal {
    const terminal = vscode.window.createTerminal({ name, cwd });
    terminal.show();
    return terminal;
}

/**
 * Open a folder in a new VS Code window.
 */
export async function openInNewWindow(folderPath: string): Promise<void> {
    await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(folderPath),
        true
    );
}

/**
 * Check if a Claude session exists for the given directory.
 * Claude stores sessions in ~/.claude/projects/<slug>/ where slug is
 * the absolute path with /, _, and . replaced by -.
 */
export function hasExistingClaudeSession(cwd: string): boolean {
    try {
        const claudeDir = path.join(os.homedir(), ".claude", "projects");
        if (!fs.existsSync(claudeDir)) return false;

        const projectSlug = cwd.replace(/[/_.]/g, "-");
        const projectDir = path.join(claudeDir, projectSlug);

        if (!fs.existsSync(projectDir)) return false;

        const files = fs.readdirSync(projectDir);
        return files.some((f) => f.endsWith(".jsonl"));
    } catch {
        return false;
    }
}

/**
 * Launch Claude Code in a terminal at the given path.
 * Prompts for session continuation if an existing session is found.
 *
 * Uses clean zsh (--no-rcs) to avoid shell profile pollution,
 * drains any IDE-injected stdin, then exec's Claude with a real PTY.
 */
export async function launchClaude(
    branchName: string,
    cwd: string,
    options?: { skipSessionPrompt?: boolean }
): Promise<vscode.Terminal | undefined> {
    const claudePath = resolveClaudePath();
    let claudeArgs: string[] = [];

    log(`Launch Claude: branch="${branchName}" cwd="${cwd}"`);

    if (!options?.skipSessionPrompt && hasExistingClaudeSession(cwd)) {
        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: "$(history) Continue last session",
                    description: "Resume where you left off",
                    value: "continue",
                },
                {
                    label: "$(list-tree) Pick a session",
                    description: "Choose from recent conversations",
                    value: "resume",
                },
                {
                    label: "$(add) New session",
                    description: "Start a fresh conversation",
                    value: "new",
                },
            ],
            {
                placeHolder: "Existing Claude session found in this worktree",
                title: "WorkTree Pilot: Launch Claude",
            }
        );

        if (!choice) return undefined;

        if (choice.value === "continue") {
            claudeArgs = ["--continue"];
        } else if (choice.value === "resume") {
            claudeArgs = ["--resume"];
        }
    }

    const quotedPath = claudePath.includes(" ")
        ? `"${claudePath}"`
        : claudePath;
    const execCmd = [quotedPath, ...claudeArgs].join(" ");

    let terminalOptions: vscode.TerminalOptions;

    if (process.platform === "win32") {
        // Windows: use PowerShell, run claude directly
        terminalOptions = {
            name: `Claude: ${branchName}`,
            cwd,
            shellPath: "powershell.exe",
            shellArgs: ["-NoProfile", "-Command", `& ${execCmd}`],
        };
    } else {
        // macOS/Linux: clean shell → drain IDE injections → exec claude
        const shellPath = fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
        const shellFlags = shellPath.endsWith("zsh")
            ? ["--no-rcs", "--no-globalrcs"]
            : ["--norc", "--noprofile"];
        const drainCmd = shellPath.endsWith("zsh")
            ? "while read -t 0.5 -k 1 c 2>/dev/null; do :; done"
            : "read -t 0.5 -n 10000 discard 2>/dev/null || true";
        const shellCmd = [
            "sleep 2",
            drainCmd,
            `exec ${execCmd}`,
        ].join("; ");

        terminalOptions = {
            name: `Claude: ${branchName}`,
            cwd,
            shellPath,
            shellArgs: [...shellFlags, "-c", shellCmd],
            // Do NOT use strictEnv — it strips critical env vars like
            // ANTHROPIC_API_KEY, SSH_AUTH_SOCK, proxy settings, etc.
            env: {
                TERM: "xterm-256color",
            },
        };
    }

    const terminal = vscode.window.createTerminal(terminalOptions);
    terminal.show();
    return terminal;
}
