/**
 * Tests for core/worktree-manager.ts — worktree CRUD operations.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import {
    validateBranchName,
    resolveBranchStrategy,
    listWorktrees,
    getWorktreeStatus,
    listAllWorktrees,
    PROTECTED_BRANCHES,
} from "../../src/core/worktree-manager";

describe("worktree-manager", () => {
    let tmpDir: string;

    beforeEach(() => {
        // Use realpath to resolve macOS /var -> /private/var symlinks
        tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-mgr-test-")));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function initRepo(): string {
        execFileSync("git", ["init", tmpDir]);
        execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@test.com"]);
        execFileSync("git", ["-C", tmpDir, "config", "user.name", "Test"]);
        fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test\n");
        execFileSync("git", ["-C", tmpDir, "add", "."]);
        execFileSync("git", ["-C", tmpDir, "commit", "-m", "Initial commit"]);
        return tmpDir;
    }

    describe("validateBranchName()", () => {
        it("returns null for valid branch names", () => {
            assert.strictEqual(validateBranchName("feature/auth"), null);
            assert.strictEqual(validateBranchName("fix/bug-123"), null);
            assert.strictEqual(validateBranchName("simple"), null);
        });

        it("rejects empty names", () => {
            assert.ok(validateBranchName("") !== null);
        });

        it("rejects names starting with /", () => {
            assert.ok(validateBranchName("/bad") !== null);
        });

        it("rejects names ending with /", () => {
            assert.ok(validateBranchName("bad/") !== null);
        });

        it("rejects names with ..", () => {
            assert.ok(validateBranchName("a..b") !== null);
        });

        it("rejects names ending with .lock", () => {
            assert.ok(validateBranchName("branch.lock") !== null);
        });

        it("rejects names with spaces", () => {
            assert.ok(validateBranchName("has space") !== null);
        });

        it("rejects names with special chars", () => {
            assert.ok(validateBranchName("has~tilde") !== null);
            assert.ok(validateBranchName("has^caret") !== null);
            assert.ok(validateBranchName("has:colon") !== null);
            assert.ok(validateBranchName("has?question") !== null);
            assert.ok(validateBranchName("has*star") !== null);
        });
    });

    describe("PROTECTED_BRANCHES", () => {
        it("includes main and master", () => {
            assert.ok(PROTECTED_BRANCHES.has("main"));
            assert.ok(PROTECTED_BRANCHES.has("master"));
        });
    });

    describe("resolveBranchStrategy()", () => {
        it("creates new branch from HEAD when branch doesn't exist", async () => {
            initRepo();
            const strategy = await resolveBranchStrategy(
                tmpDir,
                "feature/new"
            );
            assert.strictEqual(strategy.branch, "feature/new");
            assert.strictEqual(strategy.newBranch, true);
            assert.strictEqual(strategy.startPoint, "HEAD");
        });

        it("uses existing local branch when it exists", async () => {
            initRepo();
            execFileSync("git", ["-C", tmpDir, "branch", "feature/existing"]);

            const strategy = await resolveBranchStrategy(
                tmpDir,
                "feature/existing"
            );
            assert.strictEqual(strategy.branch, "feature/existing");
            assert.strictEqual(strategy.newBranch, false);
        });
    });

    describe("listWorktrees()", () => {
        it("returns at least the main worktree", async () => {
            initRepo();
            const worktrees = await listWorktrees(tmpDir);
            assert.ok(worktrees.length >= 1);
            assert.strictEqual(worktrees[0].isMain, true);
        });

        it("includes path and branch info", async () => {
            initRepo();
            const worktrees = await listWorktrees(tmpDir);
            assert.ok(worktrees[0].path.length > 0);
            assert.ok(worktrees[0].branch.length > 0);
        });
    });

    describe("getWorktreeStatus()", () => {
        it("returns clean status for clean repo", async () => {
            initRepo();
            const status = await getWorktreeStatus(tmpDir);
            assert.strictEqual(status.modified, 0);
            assert.strictEqual(status.staged, 0);
            assert.strictEqual(status.untracked, 0);
            assert.strictEqual(status.conflicts, 0);
        });

        it("detects working tree changes (modified or staged)", async () => {
            initRepo();
            fs.writeFileSync(path.join(tmpDir, "README.md"), "Modified content\n");
            const status = await getWorktreeStatus(tmpDir);
            // git may report as modified or staged depending on stat cache timing
            assert.ok(
                status.modified > 0 || status.staged > 0,
                `Expected changes, got: ${JSON.stringify(status)}`
            );
        });

        it("detects untracked files", async () => {
            initRepo();
            fs.writeFileSync(path.join(tmpDir, "new-file.txt"), "New\n");
            const status = await getWorktreeStatus(tmpDir);
            assert.ok(status.untracked > 0);
        });

        it("detects staged files", async () => {
            initRepo();
            fs.writeFileSync(path.join(tmpDir, "README.md"), "Modified\n");
            execFileSync("git", ["-C", tmpDir, "add", "README.md"]);
            const status = await getWorktreeStatus(tmpDir);
            assert.ok(status.staged > 0);
        });
    });

    describe("listAllWorktrees()", () => {
        it("returns worktrees with status summaries", async () => {
            initRepo();
            const worktrees = await listAllWorktrees(tmpDir);
            assert.ok(worktrees.length >= 1);
            assert.ok(typeof worktrees[0].statusSummary === "string");
        });

        it("shows clean for unmodified repo", async () => {
            initRepo();
            const worktrees = await listAllWorktrees(tmpDir);
            assert.strictEqual(worktrees[0].statusSummary, "clean");
        });
    });
});
