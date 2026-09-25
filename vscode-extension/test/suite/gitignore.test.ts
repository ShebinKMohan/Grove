/**
 * Tests for core/gitignore.ts — local-only ignore rules in .git/info/exclude.
 * Real git repos: Grove must never create, edit or commit the user's .gitignore.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    excludeWorktreePath,
    removeWorktreeExclusion,
    excludeGroveDir,
    resolveExcludePath,
} from "../../src/core/gitignore";
import { createTempRepo, gitIn, isolateGitEnv, type TempRepo } from "../helpers/git-repo";

describe("gitignore (info/exclude)", () => {
    let restoreEnv: () => void;
    let repo: TempRepo;

    beforeEach(() => {
        restoreEnv = isolateGitEnv();
        repo = createTempRepo();
    });

    afterEach(() => {
        repo.cleanup();
        restoreEnv();
    });

    const excludeLines = (): string[] =>
        fs.readFileSync(path.join(repo.root, ".git", "info", "exclude"), "utf-8").split("\n");

    describe("resolveExcludePath()", () => {
        it("points at .git/info/exclude in the main worktree", () => {
            assert.strictEqual(
                resolveExcludePath(repo.root),
                path.join(repo.root, ".git", "info", "exclude")
            );
        });

        it("points at the shared exclude file from a linked worktree", () => {
            const wt = path.join(repo.root, ".claude", "worktrees", "a");
            repo.git("worktree", "add", "-q", "-b", "a", wt);
            assert.strictEqual(
                resolveExcludePath(wt),
                path.join(repo.root, ".git", "info", "exclude")
            );
        });

        it("returns undefined outside a git repository", () => {
            const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grove-nogit-")));
            try {
                assert.strictEqual(resolveExcludePath(dir), undefined);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe("excludeWorktreePath()", () => {
        it("adds an anchored rule to info/exclude and creates no .gitignore", () => {
            const wt = path.join(repo.root, ".claude", "worktrees", "feat-x");
            assert.strictEqual(excludeWorktreePath(repo.root, wt), true);
            assert.ok(excludeLines().includes("/.claude/worktrees/feat-x/"));
            assert.strictEqual(repo.exists(".gitignore"), false);
        });

        it("leaves a tracked .gitignore byte-for-byte unchanged", () => {
            repo.commit("add gitignore", { ".gitignore": "node_modules/\n" });
            excludeWorktreePath(repo.root, path.join(repo.root, ".claude", "worktrees", "feat-x"));
            assert.strictEqual(repo.read(".gitignore"), "node_modules/\n");
            assert.strictEqual(repo.git("status", "--porcelain"), "");
        });

        it("hides the worktree directory from git status in the main worktree", () => {
            const wt = path.join(repo.root, ".claude", "worktrees", "feat-x");
            repo.git("worktree", "add", "-q", "-b", "feat-x", wt);
            assert.ok(repo.git("status", "--porcelain").includes(".claude/"));
            excludeWorktreePath(repo.root, wt);
            assert.strictEqual(repo.git("status", "--porcelain"), "");
        });

        it("does not duplicate an existing rule", () => {
            const wt = path.join(repo.root, ".claude", "worktrees", "feat-x");
            excludeWorktreePath(repo.root, wt);
            assert.strictEqual(excludeWorktreePath(repo.root, wt), false);
            const hits = excludeLines().filter((l) => l === "/.claude/worktrees/feat-x/");
            assert.strictEqual(hits.length, 1);
        });

        it("keeps the user's own exclude lines", () => {
            const excludePath = path.join(repo.root, ".git", "info", "exclude");
            fs.writeFileSync(excludePath, "my-local-notes.txt");
            excludeWorktreePath(repo.root, path.join(repo.root, "wt"));
            const lines = excludeLines();
            assert.ok(lines.includes("my-local-notes.txt"));
            assert.ok(lines.includes("/wt/"));
        });

        it("escapes glob characters in the directory name", () => {
            excludeWorktreePath(repo.root, path.join(repo.root, "wt[1]*"));
            assert.ok(excludeLines().includes("/wt\\[1\\]\\*/"));
        });

        it("returns false for paths outside the repo", () => {
            assert.strictEqual(excludeWorktreePath(repo.root, path.join(os.tmpdir(), "elsewhere")), false);
        });
    });

    describe("removeWorktreeExclusion()", () => {
        it("removes only that worktree's rule", () => {
            const a = path.join(repo.root, ".claude", "worktrees", "a");
            const b = path.join(repo.root, ".claude", "worktrees", "b");
            excludeWorktreePath(repo.root, a);
            excludeWorktreePath(repo.root, b);
            assert.strictEqual(removeWorktreeExclusion(repo.root, a), true);
            const lines = excludeLines();
            assert.ok(!lines.includes("/.claude/worktrees/a/"));
            assert.ok(lines.includes("/.claude/worktrees/b/"));
        });

        it("returns false when there is no rule", () => {
            assert.strictEqual(removeWorktreeExclusion(repo.root, path.join(repo.root, "none")), false);
        });

        it("never touches a .gitignore line written by an earlier Grove version", () => {
            repo.commit("legacy", { ".gitignore": "# Grove managed worktrees\n/.claude/worktrees/old/\n" });
            removeWorktreeExclusion(repo.root, path.join(repo.root, ".claude", "worktrees", "old"));
            assert.strictEqual(repo.read(".gitignore"), "# Grove managed worktrees\n/.claude/worktrees/old/\n");
        });
    });

    describe("excludeGroveDir()", () => {
        it("adds /.grove/ once and keeps Grove state out of git status", () => {
            assert.strictEqual(excludeGroveDir(repo.root), true);
            assert.strictEqual(excludeGroveDir(repo.root), false);
            repo.write(".grove/sessions.json", "[]\n");
            repo.write(".grove/agents/a.md", "# instructions\n");
            assert.strictEqual(repo.git("status", "--porcelain"), "");
            assert.strictEqual(repo.exists(".gitignore"), false);
        });

        it("covers linked worktrees too", () => {
            excludeGroveDir(repo.root);
            const wt = path.join(os.tmpdir(), `grove-wt-${process.pid}-${Date.now()}`);
            repo.git("worktree", "add", "-q", "-b", "side", wt);
            try {
                fs.mkdirSync(path.join(wt, ".grove"));
                fs.writeFileSync(path.join(wt, ".grove", "x.json"), "{}\n");
                assert.strictEqual(gitIn(wt, "status", "--porcelain"), "");
            } finally {
                repo.git("worktree", "remove", "--force", wt);
            }
        });
    });
});
