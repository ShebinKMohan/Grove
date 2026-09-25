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
    createWorktree,
    removeWorktree,
    listUncommittedChanges,
} from "../../src/core/worktree-manager";
import { agentInstructionsPath } from "../../src/core/claude-md-generator";
import { createTempRepo, gitIn, isolateGitEnv, type TempRepo } from "../helpers/git-repo";

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

// Regression tests for a 0.6.0 bug, reproduced before the fix: Grove committed
// .gitignore with no pathspec, sweeping the user's staged files into its
// commit on whatever branch the main worktree had checked out.
describe("worktree-manager: create/remove never commit or touch the index", () => {
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

    const commitCount = (): number => Number(repo.git("rev-list", "--count", "--all"));
    const staged = (): string[] => repo.git("diff", "--cached", "--name-only").split("\n").filter(Boolean);

    it("createWorktree leaves the user's staged file staged and makes no commit", async () => {
        repo.write("user-wip.txt", "work in progress\n");
        repo.git("add", "user-wip.txt");
        const headBefore = repo.head();
        const countBefore = commitCount();

        const result = await createWorktree(repo.root, "feat-x", { autoGitignore: true });

        assert.strictEqual(repo.head(), headBefore);
        assert.strictEqual(commitCount(), countBefore);
        assert.deepStrictEqual(staged(), ["user-wip.txt"]);
        assert.strictEqual(repo.exists(".gitignore"), false);
        // The new worktree directory is ignored locally, so only the user's file shows.
        assert.strictEqual(repo.git("status", "--porcelain"), "A  user-wip.txt");
        assert.ok(repo.read(".git/info/exclude").includes("/.claude/worktrees/feat-x/"));
        assert.ok(fs.existsSync(result.path));
    });

    it("removeWorktree leaves the user's staged file staged and makes no commit", async () => {
        const result = await createWorktree(repo.root, "feat-x", { autoGitignore: true });
        repo.write("user-wip.txt", "work in progress\n");
        repo.git("add", "user-wip.txt");
        const headBefore = repo.head();
        const countBefore = commitCount();

        await removeWorktree(repo.root, result.path, { deleteBranch: true });

        assert.strictEqual(repo.head(), headBefore);
        assert.strictEqual(commitCount(), countBefore);
        assert.deepStrictEqual(staged(), ["user-wip.txt"]);
        assert.ok(!repo.read(".git/info/exclude").includes("/.claude/worktrees/feat-x/"));
        assert.strictEqual(fs.existsSync(result.path), false);
        assert.strictEqual(repo.git("branch", "--list", "feat-x"), "");
    });

    async function resolvedMergeInProgress(): Promise<string> {
        repo.git("checkout", "-q", "-b", "side");
        repo.commit("side edit", { "a.txt": "side\n" });
        repo.git("checkout", "-q", "main");
        repo.commit("main edit", { "a.txt": "main\n" });
        try {
            repo.git("merge", "side");
        } catch {
            // Expected conflict
        }
        // The user resolves and stages the merge but has not committed it yet.
        repo.write("a.txt", "resolved\n");
        repo.git("add", "a.txt");
        return repo.head();
    }

    it("createWorktree does not conclude a merge the user has resolved but not committed", async () => {
        const headBefore = await resolvedMergeInProgress();

        await createWorktree(repo.root, "feat-y", { autoGitignore: true });

        assert.strictEqual(repo.head(), headBefore);
        assert.ok(repo.exists(".git/MERGE_HEAD"), "the user's merge must still be in progress");
    });

    it("removeWorktree does not conclude a merge the user has resolved but not committed", async () => {
        const result = await createWorktree(repo.root, "feat-y", { autoGitignore: true });
        const headBefore = await resolvedMergeInProgress();

        await removeWorktree(repo.root, result.path, {});

        assert.strictEqual(repo.head(), headBefore);
        assert.ok(repo.exists(".git/MERGE_HEAD"), "the user's merge must still be in progress");
    });

    it("leaves a .gitignore line written by Grove 0.6.0 alone on removal", async () => {
        const legacy = "# Grove managed worktrees\n/.claude/worktrees/feat-x/\n";
        repo.commit("0.6.0 ignore", { ".gitignore": legacy });
        const result = await createWorktree(repo.root, "feat-x", { autoGitignore: true });
        const headBefore = repo.head();

        await removeWorktree(repo.root, result.path, { deleteBranch: true });

        assert.strictEqual(repo.read(".gitignore"), legacy);
        assert.strictEqual(repo.head(), headBefore);
        assert.strictEqual(repo.git("status", "--porcelain"), "");
    });

    it("removeWorktree deletes the worktree's agent instructions file", async () => {
        const result = await createWorktree(repo.root, "feat-x", { autoGitignore: true });
        const instructions = agentInstructionsPath(repo.root, result.path);
        fs.mkdirSync(path.dirname(instructions), { recursive: true });
        fs.writeFileSync(instructions, "# role\n");

        await removeWorktree(repo.root, result.path, {});

        assert.strictEqual(fs.existsSync(instructions), false);
    });

    it("without force, removeWorktree refuses a worktree with untracked files", async () => {
        const result = await createWorktree(repo.root, "feat-x", { autoGitignore: true });
        fs.writeFileSync(path.join(result.path, "new.ts"), "export {};\n");

        await assert.rejects(removeWorktree(repo.root, result.path, { deleteBranch: true }));
        assert.ok(fs.existsSync(path.join(result.path, "new.ts")));
    });

    it("without force, removeWorktree refuses untracked files even with status.showUntrackedFiles=no", async () => {
        repo.git("config", "status.showUntrackedFiles", "no");
        const result = await createWorktree(repo.root, "feat-x", { autoGitignore: true });
        fs.writeFileSync(path.join(result.path, "new.ts"), "export {};\n");
        // Plain git status would call this worktree clean.
        assert.strictEqual(gitIn(result.path, "status", "--porcelain"), "");

        await assert.rejects(removeWorktree(repo.root, result.path, {}));
        assert.ok(fs.existsSync(path.join(result.path, "new.ts")));
        assert.strictEqual((await getWorktreeStatus(result.path)).untracked, 1);
    });

    it("listUncommittedChanges counts a staged change even when the file matches HEAD again", async () => {
        const result = await createWorktree(repo.root, "feat-x", { autoGitignore: true });
        fs.writeFileSync(path.join(result.path, "README.md"), "staged\n");
        gitIn(result.path, "add", "README.md");
        fs.writeFileSync(path.join(result.path, "README.md"), "# Test\n");

        assert.deepStrictEqual((await listUncommittedChanges(result.path)).tracked, ["README.md"]);
    });

    it("removeWorktree removes a clean worktree with no commits yet", async () => {
        const wt = path.join(repo.root, ".claude", "worktrees", "orphan");
        repo.git("worktree", "add", "-q", "--orphan", "-b", "orphan", wt);
        assert.deepStrictEqual(await listUncommittedChanges(wt), { tracked: [], untracked: [] });

        await removeWorktree(repo.root, wt, {});
        assert.strictEqual(fs.existsSync(wt), false);
    });

    it("listUncommittedChanges reports tracked changes and each untracked file", async () => {
        const result = await createWorktree(repo.root, "feat-x", { autoGitignore: true });
        const wt = result.path;
        fs.writeFileSync(path.join(wt, "README.md"), "changed\n");
        fs.mkdirSync(path.join(wt, "src", "api"), { recursive: true });
        fs.writeFileSync(path.join(wt, "src", "api", "todo.ts"), "export {};\n");
        fs.writeFileSync(path.join(wt, " leading space.txt"), "x\n");
        fs.writeFileSync(path.join(wt, "caf\u00e9.md"), "x\n");
        fs.writeFileSync(path.join(wt, ".gitignore"), "ignored.log\n");
        fs.writeFileSync(path.join(wt, "ignored.log"), "x\n");

        const changes = await listUncommittedChanges(wt);

        assert.deepStrictEqual(changes.tracked, ["README.md"]);
        assert.deepStrictEqual(
            [...changes.untracked].sort(),
            [" leading space.txt", ".gitignore", "caf\u00e9.md", "src/api/todo.ts"].sort()
        );
        assert.strictEqual(gitIn(wt, "rev-parse", "--abbrev-ref", "HEAD"), "feat-x");
    });
});
