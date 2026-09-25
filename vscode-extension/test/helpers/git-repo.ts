/**
 * Throw-away git repositories for real-git tests.
 *
 * Every repo lives under os.tmpdir(), has a local identity and no remote,
 * and git (both the test's own calls and the code under test, which
 * inherits process.env) never reads the developer's global or system
 * config. HOME points at a temp dir while isolated, so nothing can reach
 * the real ~/.claude/.
 *
 * Framework-free on purpose: the mocha integration runner loads test/suite
 * files too, so this must not import vitest.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

/**
 * Variables that point git at a particular repository or config. Git sets
 * several of them while it runs hooks, so a test started from a hook would
 * otherwise act on the developer's repository.
 */
const REPO_SELECTING_VARS = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
];

let isolated = false;

/** Isolate git from the developer's config. Returns a restore function. */
export function isolateGitEnv(): () => void {
    const keys = [
        ...REPO_SELECTING_VARS,
        "GIT_CEILING_DIRECTORIES",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "XDG_CONFIG_HOME",
    ];
    const saved = new Map(keys.map((k) => [k, process.env[k]]));
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grove-home-")));
    for (const key of REPO_SELECTING_VARS) delete process.env[key];
    // Never discover a repository above the temp dir.
    process.env.GIT_CEILING_DIRECTORIES = fs.realpathSync(os.tmpdir());
    process.env.GIT_CONFIG_GLOBAL = os.devNull;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_TERMINAL_PROMPT = "0";
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    isolated = true;
    return () => {
        isolated = false;
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(home, { recursive: true, force: true });
    };
}

/** Run git and return stdout without trailing whitespace. */
export function runGit(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
}

export interface TempRepo {
    root: string;
    git(...args: string[]): string;
    write(rel: string, content: string): string;
    read(rel: string): string;
    exists(rel: string): boolean;
    /** Write the given files, stage everything and commit. Returns the new HEAD. */
    commit(message: string, files?: Record<string, string>): string;
    head(): string;
    cleanup(): void;
}

/** Create a repo on branch `main` with one commit (README.md) by default. */
export function createTempRepo(
    options: { prefix?: string; initialCommit?: boolean } = {}
): TempRepo {
    if (!isolated) {
        throw new Error("Call isolateGitEnv() before createTempRepo()");
    }
    const { prefix = "grove-repo-", initialCommit = true } = options;
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    runGit(root, ["init", "--quiet", "--initial-branch", "main"]);
    runGit(root, ["config", "user.name", "Grove Test"]);
    runGit(root, ["config", "user.email", "grove-test@example.invalid"]);
    runGit(root, ["config", "commit.gpgsign", "false"]);
    runGit(root, ["config", "core.hooksPath", os.devNull]);

    const repo: TempRepo = {
        root,
        git: (...args) => runGit(root, args),
        write(rel, content) {
            const p = path.join(root, rel);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, content);
            return p;
        },
        read: (rel) => fs.readFileSync(path.join(root, rel), "utf-8"),
        exists: (rel) => fs.existsSync(path.join(root, rel)),
        commit(message, files = {}) {
            for (const [rel, content] of Object.entries(files)) repo.write(rel, content);
            runGit(root, ["add", "-A"]);
            runGit(root, ["commit", "--quiet", "--allow-empty", "-m", message]);
            return runGit(root, ["rev-parse", "HEAD"]);
        },
        head: () => runGit(root, ["rev-parse", "HEAD"]),
        cleanup() {
            try {
                runGit(root, ["worktree", "prune"]);
            } catch {
                // Not a repo any more
            }
            fs.rmSync(root, { recursive: true, force: true });
        },
    };

    if (initialCommit) repo.commit("Initial commit", { "README.md": "# Test\n" });
    return repo;
}

/** Run git in any directory (for example a linked worktree). */
export function gitIn(cwd: string, ...args: string[]): string {
    return runGit(cwd, args);
}
