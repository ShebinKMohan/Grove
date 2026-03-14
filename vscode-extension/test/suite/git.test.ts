/**
 * Tests for utils/git.ts — git command execution wrapper.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
    git,
    gitWrite,
    getRepoRoot,
    getCurrentBranch,
    branchExistsLocally,
    branchExistsOnRemote,
    GitError,
} from "../../src/utils/git";

describe("utils/git", () => {
    let tmpDir: string;

    beforeEach(() => {
        // Use realpath to resolve macOS /var -> /private/var symlinks
        tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-git-test-")));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function initRepo(): string {
        const { execFileSync } = require("child_process");
        execFileSync("git", ["init", tmpDir]);
        execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@test.com"]);
        execFileSync("git", ["-C", tmpDir, "config", "user.name", "Test"]);
        // Create initial commit
        fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test\n");
        execFileSync("git", ["-C", tmpDir, "add", "."]);
        execFileSync("git", ["-C", tmpDir, "commit", "-m", "Initial commit"]);
        return tmpDir;
    }

    describe("git()", () => {
        it("executes a git command and returns stdout", async () => {
            initRepo();
            const result = await git(["rev-parse", "--show-toplevel"], tmpDir);
            // macOS resolves /var -> /private/var, so compare real paths
            assert.strictEqual(fs.realpathSync(result), fs.realpathSync(tmpDir));
        });

        it("throws GitError on failure", async () => {
            try {
                await git(["log"], tmpDir); // not a repo
                assert.fail("Should have thrown");
            } catch (err) {
                assert.ok(err instanceof GitError);
            }
        });
    });

    describe("gitWrite()", () => {
        it("serializes write operations", async () => {
            initRepo();
            // Create a branch through the write queue
            await gitWrite(["branch", "test-branch"], tmpDir);
            const exists = await branchExistsLocally(tmpDir, "test-branch");
            assert.strictEqual(exists, true);
        });
    });

    describe("getRepoRoot()", () => {
        it("returns the repo root path", async () => {
            initRepo();
            const root = await getRepoRoot(tmpDir);
            assert.strictEqual(fs.realpathSync(root), fs.realpathSync(tmpDir));
        });
    });

    describe("getCurrentBranch()", () => {
        it("returns the current branch name", async () => {
            initRepo();
            const branch = await getCurrentBranch(tmpDir);
            // Usually 'main' or 'master' depending on git config
            assert.ok(typeof branch === "string" && branch.length > 0);
        });
    });

    describe("branchExistsLocally()", () => {
        it("returns true for existing branch", async () => {
            initRepo();
            const branch = await getCurrentBranch(tmpDir);
            assert.strictEqual(
                await branchExistsLocally(tmpDir, branch),
                true
            );
        });

        it("returns false for non-existing branch", async () => {
            initRepo();
            assert.strictEqual(
                await branchExistsLocally(tmpDir, "nonexistent-branch"),
                false
            );
        });
    });

    describe("branchExistsOnRemote()", () => {
        it("returns false when no remotes configured", async () => {
            initRepo();
            assert.strictEqual(
                await branchExistsOnRemote(tmpDir, "main"),
                false
            );
        });
    });

    describe("GitError", () => {
        it("stores the git args", () => {
            const err = new GitError("failed", ["status"]);
            assert.deepStrictEqual(err.args, ["status"]);
            assert.strictEqual(err.name, "GitError");
        });
    });
});
