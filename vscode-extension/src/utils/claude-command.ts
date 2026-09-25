/**
 * Builds the command line that starts Claude Code in a Grove terminal.
 * Kept free of the vscode API so it can be tested against a real shell.
 */

/**
 * Words that need no quoting in sh, bash or zsh. A leading `=` is excluded
 * because zsh expands `=cmd` to a command path.
 */
const POSIX_SAFE = /^[\w@%+:,./-][\w@%+=:,./-]*$/;

/** Words that need no quoting in PowerShell (no `@`, `,`, `$` or quotes). */
const POWERSHELL_SAFE = /^[\w./\\:-]+$/;

/** Quote a value as one POSIX shell word. */
export function quotePosix(value: string): string {
    if (value && POSIX_SAFE.test(value)) return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a value as one PowerShell argument. PowerShell also treats the
 * typographic single quotes U+2018 to U+201B as quote characters, so they
 * are doubled like `'`.
 */
export function quotePowerShell(value: string): string {
    if (value && POWERSHELL_SAFE.test(value)) return value;
    return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

/**
 * Pick the claude binary from `which claude` / `where claude` output.
 * `where` prints CRLF-separated lines and can list several matches. On
 * Windows a native claude.exe is preferred; a .cmd shim is not, because
 * cmd.exe would re-parse the arguments (splitting at `&`, expanding `%`).
 */
export function firstCommandPath(output: string, platform: NodeJS.Platform = process.platform): string | undefined {
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (platform === "win32") {
        const executable = lines.find((line) => /\.exe$/i.test(line));
        if (executable) return executable;
    }
    return lines[0];
}

export interface ClaudeCommandOptions {
    /** Path to the claude binary (or the bare name `claude`). */
    claudePath: string;
    /** Extra flags, e.g. ["--continue"]. */
    args?: string[];
    /** Agent instructions to append to Claude Code's system prompt. */
    appendSystemPromptFile?: string;
    /**
     * Have Claude Code read the file itself (`--append-system-prompt-file`)
     * instead of passing its text as one argument. Needed for large files:
     * Linux limits a single argument to 128 KiB.
     */
    readFileInClaude?: boolean;
}

/** Instructions larger than this are read by Claude Code, not the shell. */
export const INLINE_PROMPT_LIMIT_BYTES = 96 * 1024;

/**
 * Command for sh, bash or zsh.
 *
 * The instructions file is read by the shell at launch and passed with
 * `--append-system-prompt`, which works in interactive sessions on every
 * Claude Code version that has the flag. The text never passes through
 * Grove's own quoting, and the output of `$(...)` inside double quotes is
 * not expanded again, so quotes, `$` and backticks in it arrive verbatim.
 */
export function buildPosixClaudeCommand(options: ClaudeCommandOptions): string {
    const parts = [quotePosix(options.claudePath), ...(options.args ?? []).map(quotePosix)];
    if (options.appendSystemPromptFile && options.readFileInClaude) {
        parts.push("--append-system-prompt-file", quotePosix(options.appendSystemPromptFile));
    } else if (options.appendSystemPromptFile) {
        parts.push(
            "--append-system-prompt",
            `"$(cat -- ${quotePosix(options.appendSystemPromptFile)})"`
        );
    }
    return parts.join(" ");
}

/**
 * Command for PowerShell (Windows).
 *
 * Windows PowerShell does not escape embedded double quotes when it passes
 * a string to a native program, so the text is not passed inline. Claude
 * Code reads the file itself through `--append-system-prompt-file`.
 */
export function buildPowerShellClaudeCommand(options: ClaudeCommandOptions): string {
    const parts = [
        "&",
        quotePowerShell(options.claudePath),
        ...(options.args ?? []).map(quotePowerShell),
    ];
    if (options.appendSystemPromptFile) {
        parts.push("--append-system-prompt-file", quotePowerShell(options.appendSystemPromptFile));
    }
    return parts.join(" ");
}
