/**
 * Tests for utils/claude-command.ts — the command line Grove terminals run.
 * The POSIX command is executed by real zsh and bash against a stub
 * `claude` that prints its arguments, so quoting is proven, not assumed.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
    quotePosix,
    quotePowerShell,
    buildPosixClaudeCommand,
    buildPowerShellClaudeCommand,
    firstCommandPath,
} from "../../src/utils/claude-command";

describe("claude-command", () => {
    describe("quoting", () => {
        it("leaves plain words unquoted", () => {
            assert.strictEqual(quotePosix("--continue"), "--continue");
            assert.strictEqual(quotePosix("/usr/local/bin/claude"), "/usr/local/bin/claude");
            assert.strictEqual(quotePowerShell("claude"), "claude");
        });

        it("single-quotes anything else and escapes quotes", () => {
            assert.strictEqual(quotePosix("/Volumes/Green's T7/x"), `'/Volumes/Green'\\''s T7/x'`);
            assert.strictEqual(quotePosix(""), "''");
            assert.strictEqual(quotePowerShell("C:\\Users\\O'Neil\\claude.exe"), `'C:\\Users\\O''Neil\\claude.exe'`);
        });

        it("quotes words zsh or PowerShell would expand", () => {
            assert.strictEqual(quotePosix("=claude"), "'=claude'");
            assert.strictEqual(quotePowerShell("@args"), "'@args'");
            assert.strictEqual(quotePowerShell("a,b"), "'a,b'");
            assert.strictEqual(quotePowerShell("C:\\repo\\a.md"), "C:\\repo\\a.md");
        });

        it("doubles typographic single quotes for PowerShell", () => {
            assert.strictEqual(quotePowerShell("C:\\O\u2019Neil\\a.md"), "'C:\\O\u2019\u2019Neil\\a.md'");
        });
    });

    describe("buildPosixClaudeCommand()", () => {
        it("adds nothing when there are no instructions", () => {
            assert.strictEqual(
                buildPosixClaudeCommand({ claudePath: "claude", args: ["--continue"] }),
                "claude --continue"
            );
        });

        const shells: Array<[string, string[]]> = [
            ["/bin/zsh", ["--no-rcs", "--no-globalrcs", "-c"]],
            ["/bin/bash", ["--norc", "--noprofile", "-c"]],
        ];

        it("lets Claude Code read a large file itself", () => {
            assert.strictEqual(
                buildPosixClaudeCommand({
                    claudePath: "claude",
                    appendSystemPromptFile: "/repo/.grove/agents/a.md",
                    readFileInClaude: true,
                }),
                "claude --append-system-prompt-file /repo/.grove/agents/a.md"
            );
        });

        for (const [shell, flags] of shells) {
            // Reported as skipped, not passed, on machines without this shell.
            const shellIt = fs.existsSync(shell) ? it : it.skip;
            shellIt(`passes the instructions verbatim through ${path.basename(shell)}`, () => {

                const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grove-cmd-")));
                try {
                    // Same shape as the owner's volume name: an apostrophe and a space.
                    const binDir = path.join(base, "Green's T7", "bin dir");
                    fs.mkdirSync(binDir, { recursive: true });
                    const stub = path.join(binDir, "claude");
                    fs.writeFileSync(stub, "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\0' \"$a\"; done\n");
                    fs.chmodSync(stub, 0o755);

                    const agentsDir = path.join(base, "repo's copy", ".grove", "agents");
                    fs.mkdirSync(agentsDir, { recursive: true });
                    const file = path.join(agentsDir, "backend-1234abcd.md");
                    const text =
                        "# Backend Architect \u2014 Grove Agent\n\n" +
                        "Don't touch `src/ui/**`. Use \"double\" and 'single' quotes.\n" +
                        "Literal: $HOME $(echo nope) `echo nope` \\n * ? [a]\n";
                    fs.writeFileSync(file, text + "\n");

                    const cmd = buildPosixClaudeCommand({
                        claudePath: stub,
                        args: ["--continue"],
                        appendSystemPromptFile: file,
                    });
                    const out = execFileSync(shell, [...flags, `exec ${cmd}`], {
                        encoding: "utf-8",
                        env: { PATH: "/usr/bin:/bin", HOME: base },
                    });
                    const args = out.split("\0").slice(0, -1);

                    // $(...) drops trailing newlines; nothing else changes.
                    assert.deepStrictEqual(args, ["--continue", "--append-system-prompt", text.replace(/\n+$/, "")]);

                    // Large-file mode: the path arrives as one argument.
                    const fileCmd = buildPosixClaudeCommand({
                        claudePath: stub,
                        appendSystemPromptFile: file,
                        readFileInClaude: true,
                    });
                    const fileOut = execFileSync(shell, [...flags, `exec ${fileCmd}`], {
                        encoding: "utf-8",
                        env: { PATH: "/usr/bin:/bin", HOME: base },
                    });
                    assert.deepStrictEqual(fileOut.split("\0").slice(0, -1), ["--append-system-prompt-file", file]);
                } finally {
                    fs.rmSync(base, { recursive: true, force: true });
                }
            });
        }
    });

    describe("firstCommandPath()", () => {
        it("strips the CR from `where` output and prefers claude.exe, not a .cmd shim", () => {
            const npm = "C:\\Users\\me\\AppData\\Roaming\\npm\\claude\r\nC:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\r\n";
            assert.strictEqual(firstCommandPath(npm, "win32"), "C:\\Users\\me\\AppData\\Roaming\\npm\\claude");
            const both = "C:\\npm\\claude.cmd\r\nC:\\Users\\me\\.local\\bin\\claude.exe\r\n";
            assert.strictEqual(firstCommandPath(both, "win32"), "C:\\Users\\me\\.local\\bin\\claude.exe");
        });

        it("takes the first line of `which` output", () => {
            assert.strictEqual(firstCommandPath("/usr/local/bin/claude\n", "darwin"), "/usr/local/bin/claude");
            assert.strictEqual(firstCommandPath("", "linux"), undefined);
        });
    });

    describe("buildPowerShellClaudeCommand()", () => {
        it("passes the file path to --append-system-prompt-file", () => {
            assert.strictEqual(
                buildPowerShellClaudeCommand({
                    claudePath: "C:\\Program Files\\claude\\claude.exe",
                    args: ["--resume"],
                    appendSystemPromptFile: "C:\\repo\\O'Neil\\.grove\\agents\\a.md",
                }),
                `& 'C:\\Program Files\\claude\\claude.exe' --resume --append-system-prompt-file 'C:\\repo\\O''Neil\\.grove\\agents\\a.md'`
            );
        });

        it("adds nothing when there are no instructions", () => {
            assert.strictEqual(buildPowerShellClaudeCommand({ claudePath: "claude" }), "& claude");
        });
    });
});
