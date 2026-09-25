/**
 * Real-git tests of pre-merge conflict prediction (predictMergeSequence and
 * the merge report built on it).
 *
 * The case that matters most: two agents change the same line and the base
 * branch has not moved. Each branch merges cleanly into the base on its own,
 * so a check of each branch against the base alone predicts nothing; the
 * conflict only appears when the second branch is merged after the first.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import {
    autoCommitWorktree,
    executeMergeStep,
    formatMergeReportMarkdown,
    generateMergeReport,
    predictMergeSequence,
} from "../../src/core/merge-sequencer";
import { createWorktree } from "../../src/core/worktree-manager";
import { execFileSync } from "child_process";
import { git, GitError } from "../../src/utils/git";
import { createTempRepo, isolateGitEnv, type TempRepo } from "../helpers/git-repo";

describe("merge prediction (real git)", () => {
    let restoreEnv: () => void;
    let repo: TempRepo;

    beforeEach(() => {
        restoreEnv = isolateGitEnv();
        repo = createTempRepo();
        repo.commit("project files", {
            "src/app.ts": "export const app = 1;\nexport const other = 1;\n",
            "src/b.ts": "export const b = 1;\n",
        });
    });

    afterEach(() => {
        repo.cleanup();
        restoreEnv();
    });

    /** Create `branch` from main with the given file contents, without a worktree. */
    function branchWith(branch: string, files: Record<string, string>): void {
        repo.git("checkout", "-q", "-b", branch, "main");
        repo.commit(`${branch} work`, files);
        repo.git("checkout", "-q", "main");
    }

    const sameLine = (value: string): Record<string, string> => ({
        "src/app.ts": `export const app = ${value};\nexport const other = 1;\n`,
    });

    it("finds two branches that change the same line while main has not moved", async () => {
        branchWith("agent-a", sameLine("'a'"));
        branchWith("agent-b", sameLine("'b'"));

        // Each branch on its own merges cleanly into main.
        assert.deepStrictEqual(await predictMergeSequence(repo.root, ["agent-a"], "main"), [
            { branch: "agent-a", conflictFiles: [], conflictsWith: [] },
        ]);
        assert.deepStrictEqual(await predictMergeSequence(repo.root, ["agent-b"], "main"), [
            { branch: "agent-b", conflictFiles: [], conflictsWith: [] },
        ]);

        // Merged one after the other, the second conflicts with the first.
        assert.deepStrictEqual(await predictMergeSequence(repo.root, ["agent-a", "agent-b"], "main"), [
            { branch: "agent-a", conflictFiles: [], conflictsWith: [] },
            { branch: "agent-b", conflictFiles: ["src/app.ts"], conflictsWith: ["agent-a"] },
        ]);
    });

    it("finds a branch that conflicts with changes made on main since it branched", async () => {
        branchWith("agent-a", sameLine("'a'"));
        repo.commit("main moves", sameLine("'main'"));

        assert.deepStrictEqual(await predictMergeSequence(repo.root, ["agent-a"], "main"), [
            { branch: "agent-a", conflictFiles: ["src/app.ts"], conflictsWith: ["main"] },
        ]);
    });

    it("predicts nothing when the branches change different files", async () => {
        branchWith("agent-a", sameLine("'a'"));
        branchWith("agent-b", { "src/b.ts": "export const b = 2;\n" });

        const prediction = await predictMergeSequence(repo.root, ["agent-a", "agent-b"], "main");

        assert.deepStrictEqual(prediction?.map((p) => p.conflictFiles), [[], []]);
    });

    it("leaves a branch predicted to conflict out of the simulated result", async () => {
        branchWith("agent-a", sameLine("'a'"));
        repo.commit("main moves", sameLine("'main'"));
        // agent-b starts from the moved main and changes the next line.
        branchWith("agent-b", { "src/app.ts": "export const app = 'main';\nexport const other = 2;\n" });

        const prediction = await predictMergeSequence(repo.root, ["agent-a", "agent-b"], "main");

        // agent-a conflicts with main; agent-b is checked against main without
        // agent-a's unresolved result, and merges cleanly.
        assert.deepStrictEqual(prediction, [
            { branch: "agent-a", conflictFiles: ["src/app.ts"], conflictsWith: ["main"] },
            { branch: "agent-b", conflictFiles: [], conflictsWith: [] },
        ]);

        // Keeping agent-a's conflicted tree instead would have flagged agent-b.
        let conflictedTree = "";
        try {
            repo.git("merge-tree", "--write-tree", "main", "agent-a");
        } catch (err) {
            conflictedTree = String((err as { stdout?: string }).stdout).split("\n")[0];
        }
        assert.ok(conflictedTree, "main and agent-a should conflict");
        const kept = repo.git("commit-tree", conflictedTree, "-p", "main", "-p", "agent-a", "-m", "kept");
        assert.throws(() => repo.git("merge-tree", "--write-tree", kept, "agent-b"));
    });

    it("changes no ref, the index or any file", async () => {
        branchWith("agent-a", sameLine("'a'"));
        branchWith("agent-b", sameLine("'b'"));
        // A staged change, a different unstaged change and an untracked file.
        repo.write("src/b.ts", "export const b = 'staged';\n");
        repo.git("add", "src/b.ts");
        repo.write("src/b.ts", "export const b = 'unstaged';\n");
        repo.write("scratch.txt", "untracked\n");
        const before = {
            refs: repo.git("for-each-ref"),
            head: repo.head(),
            staged: repo.git("diff", "--cached"),
            unstaged: repo.git("diff"),
            status: repo.git("status", "--porcelain"),
            app: repo.read("src/app.ts"),
        };

        await predictMergeSequence(repo.root, ["agent-a", "agent-b"], "main");

        assert.deepStrictEqual({
            refs: repo.git("for-each-ref"),
            head: repo.head(),
            staged: repo.git("diff", "--cached"),
            unstaged: repo.git("diff"),
            status: repo.git("status", "--porcelain"),
            app: repo.read("src/app.ts"),
        }, before);
        assert.strictEqual(repo.exists(".git/MERGE_HEAD"), false);
    });

    it("matches what the real merges then do", async () => {
        branchWith("agent-a", sameLine("'a'"));
        branchWith("agent-b", sameLine("'b'"));
        branchWith("agent-c", { "src/b.ts": "export const b = 3;\n" });
        const order = ["agent-a", "agent-b", "agent-c"];
        const prediction = await predictMergeSequence(repo.root, order, "main");

        const first = await executeMergeStep(repo.root, "agent-a", "main");
        assert.strictEqual(first.status, "success");
        const second = await executeMergeStep(repo.root, "agent-b", "main");
        assert.strictEqual(second.status, "conflict");
        assert.deepStrictEqual(second.conflictFiles, prediction?.[1].conflictFiles);

        // The user skips agent-b, as the prediction assumed for later steps.
        repo.git("merge", "--abort");
        const third = await executeMergeStep(repo.root, "agent-c", "main");
        assert.strictEqual(third.status, "success");
        assert.deepStrictEqual(prediction?.[2].conflictFiles, []);
    });

    it("reports paths with spaces and non-ASCII characters exactly", async () => {
        const name = "docs/résumé notes.md";
        repo.commit("notes", { [name]: "one\n" });
        branchWith("agent-a", { [name]: "a\n" });
        branchWith("agent-b", { [name]: "b\n" });

        const prediction = await predictMergeSequence(repo.root, ["agent-a", "agent-b"], "main");

        assert.deepStrictEqual(prediction?.[1].conflictFiles, [name]);
    });

    it("marks a branch git cannot check and still checks the others", async () => {
        repo.git("checkout", "-q", "--orphan", "unrelated");
        repo.git("rm", "-q", "-r", "-f", ".");
        repo.commit("unrelated root", { "x.txt": "x\n" });
        repo.git("checkout", "-q", "main");
        branchWith("agent-a", sameLine("'a'"));
        branchWith("agent-b", sameLine("'b'"));

        const prediction = await predictMergeSequence(
            repo.root, ["unrelated", "no-such-branch", "agent-a", "agent-b"], "main"
        );

        assert.match(prediction?.[0].checkFailed ?? "", /unrelated histories/);
        assert.strictEqual(prediction?.[1].checkFailed, "branch not found");
        assert.deepStrictEqual(prediction?.slice(2), [
            { branch: "agent-a", conflictFiles: [], conflictsWith: [] },
            { branch: "agent-b", conflictFiles: ["src/app.ts"], conflictsWith: ["agent-a"] },
        ]);
        assert.strictEqual(await predictMergeSequence(repo.root, ["agent-a"], "no-such-base"), undefined);
    });

    it("counts a conflict git reports without a conflicted path", async () => {
        repo.commit("dir", { "a/1": "1\n", "a/2": "2\n" });
        repo.git("checkout", "-q", "-b", "x", "main");
        repo.git("mv", "a/1", "b");
        repo.git("mv", "a/2", "c");
        repo.commit("split the directory");
        repo.git("checkout", "-q", "main");
        branchWith("y", { "a/3": "3\n" });

        const prediction = await predictMergeSequence(repo.root, ["x", "y"], "main");

        assert.deepStrictEqual(prediction?.[0].conflictFiles, []);
        assert.ok((prediction?.[1].conflictFiles.length ?? 0) > 0, "the split directory rename is a conflict");
    });

    it("names who else changed a file this branch renamed", async () => {
        repo.commit("util", { "src/util.ts": "export const u = 1;\nexport const v = 1;\n" });
        branchWith("agent-a", { "src/util.ts": "export const u = 'a';\nexport const v = 1;\n" });
        repo.git("checkout", "-q", "-b", "agent-b", "main");
        repo.git("mv", "src/util.ts", "src/lib-util.ts");
        repo.commit("move and edit", { "src/lib-util.ts": "export const u = 'b';\nexport const v = 1;\n" });
        repo.git("checkout", "-q", "main");

        const prediction = await predictMergeSequence(repo.root, ["agent-a", "agent-b"], "main");

        assert.deepStrictEqual(prediction?.[1].conflictsWith, ["agent-a"]);
    });

    it("names a branch whose name is also a top-level directory", async () => {
        repo.commit("docs dir", { "docs/readme.md": "docs\n" });
        branchWith("docs", sameLine("'docs'"));
        branchWith("agent-b", sameLine("'b'"));

        const prediction = await predictMergeSequence(repo.root, ["docs", "agent-b"], "main");

        assert.deepStrictEqual(prediction?.[1].conflictsWith, ["docs"]);
    });

    it("names only branches that changed the conflicting files", async () => {
        branchWith("agent-a", { "src/b.ts": "export const b = 'a';\n" });
        branchWith("agent-b", sameLine("'b'"));
        branchWith("agent-c", sameLine("'c'"));

        const prediction = await predictMergeSequence(repo.root, ["agent-a", "agent-b", "agent-c"], "main");

        assert.deepStrictEqual(prediction?.[2].conflictsWith, ["agent-b"]);
    });

    it("names file/directory conflicts the way the real merge does", async () => {
        branchWith("adds-file", { "d": "file\n" });
        branchWith("adds-dir", { "d/f": "nested\n" });

        const prediction = await predictMergeSequence(repo.root, ["adds-file", "adds-dir"], "main");
        await executeMergeStep(repo.root, "adds-file", "main");
        const real = await executeMergeStep(repo.root, "adds-dir", "main");

        assert.strictEqual(real.status, "conflict");
        assert.deepStrictEqual([...(prediction?.[1].conflictFiles ?? [])].sort(), [...(real.conflictFiles ?? [])].sort());
    });

    it("keeps git's stdout and exit code on a failed command", async () => {
        branchWith("agent-a", sameLine("'a'"));
        branchWith("agent-b", sameLine("'b'"));
        try {
            await git(["merge-tree", "--write-tree", "--name-only", "agent-a", "agent-b"], repo.root);
            assert.fail("merge-tree should exit 1 for a conflict");
        } catch (err) {
            assert.ok(err instanceof GitError);
            assert.strictEqual(err.exitCode, 1);
            assert.ok(err.stdout.includes("src/app.ts"));
        }
    });

    async function worktreeWith(branch: string, files: Record<string, string>): Promise<string> {
        const wt = (await createWorktree(repo.root, branch, { autoGitignore: true, startPoint: "main" })).path;
        for (const [rel, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
            fs.writeFileSync(path.join(wt, rel), content);
        }
        await autoCommitWorktree(wt, Object.keys(files));
        return wt;
    }

    it("the merge report follows the recommended order, not the selection order", async () => {
        // agent-ui touches a UI file, agent-types a types file: types merge first.
        const wtUi = await worktreeWith("agent-ui", { ...sameLine("'ui'"), "src/ui/list.tsx": "export {};\n" });
        const wtTypes = await worktreeWith("agent-types", { ...sameLine("'types'"), "src/types/todo.ts": "export {};\n" });

        const report = await generateMergeReport([wtUi, wtTypes], "main", repo.root);

        assert.deepStrictEqual(report.mergeOrder.map((e) => e.branch), ["agent-types", "agent-ui"]);
        assert.strictEqual(report.conflictCheck, "merge-tree");
        assert.deepStrictEqual(report.conflictPredictions.map((p) => ({
            branch: p.branch,
            conflictFiles: p.conflictFiles,
            conflictsWith: p.conflictsWith,
            method: p.method,
        })), [
            { branch: "agent-ui", conflictFiles: ["src/app.ts"], conflictsWith: ["agent-types"], method: "merge-tree" },
        ]);
        const markdown = formatMergeReportMarkdown(report);
        assert.ok(markdown.includes("Predicted Merge Conflicts"));
        assert.ok(markdown.includes("(also changed by agent-types)"));
    });

    it("the merge report uses the main checkout's merge attributes", async () => {
        const wtA = await worktreeWith("agent-a", { "CHANGELOG.md": "- a\n" });
        const wtB = await worktreeWith("agent-b", { "CHANGELOG.md": "- b\n" });
        // After the worktrees exist, main tells git to union-merge the changelog.
        repo.commit("union merge", { ".gitattributes": "CHANGELOG.md merge=union\n" });

        for (const mainCheckout of [repo.root, undefined]) {
            const report = await generateMergeReport([wtA, wtB], "main", mainCheckout);
            assert.deepStrictEqual(report.conflictPredictions.filter((p) => p.conflictFiles.length > 0), []);
        }
        assert.strictEqual((await executeMergeStep(repo.root, "agent-a", "main")).status, "success");
        assert.strictEqual((await executeMergeStep(repo.root, "agent-b", "main")).status, "success");
    });

    it("says so when git merge-tree cannot run", async () => {
        const wtA = await worktreeWith("agent-a", sameLine("'a'"));
        const wtB = await worktreeWith("agent-b", sameLine("'b'"));
        // A git that rejects `merge-tree --write-tree`, as Git older than 2.38 does.
        const shimDir = fs.mkdtempSync(path.join(repo.root, "..", "grove-oldgit-"));
        const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
        fs.writeFileSync(
            path.join(shimDir, "git"),
            `#!/bin/sh\nfor a in "$@"; do [ "$a" = "merge-tree" ] && { echo "usage: git merge-tree" >&2; exit 129; }; done\nexec "${realGit}" "$@"\n`
        );
        fs.chmodSync(path.join(shimDir, "git"), 0o755);
        const savedPath = process.env.PATH;
        process.env.PATH = `${shimDir}${path.delimiter}${savedPath}`;
        try {
            const report = await generateMergeReport([wtA, wtB], "main", repo.root);
            assert.strictEqual(report.conflictCheck, "unavailable");
            assert.ok(formatMergeReportMarkdown(report).includes("could not run"));
        } finally {
            process.env.PATH = savedPath;
            fs.rmSync(shimDir, { recursive: true, force: true });
        }
    });
});
