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
        repo.write("scratch.txt", "untracked\n");
        repo.git("add", "src/b.ts");
        const refs = repo.git("for-each-ref");
        const head = repo.head();
        const status = repo.git("status", "--porcelain");
        const app = repo.read("src/app.ts");

        await predictMergeSequence(repo.root, ["agent-a", "agent-b"], "main");

        assert.strictEqual(repo.git("for-each-ref"), refs);
        assert.strictEqual(repo.head(), head);
        assert.strictEqual(repo.git("status", "--porcelain"), status);
        assert.strictEqual(repo.read("src/app.ts"), app);
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

    it("returns undefined when git cannot merge the histories", async () => {
        repo.git("checkout", "-q", "--orphan", "unrelated");
        repo.git("rm", "-q", "-r", "-f", ".");
        repo.commit("unrelated root", { "x.txt": "x\n" });
        repo.git("checkout", "-q", "main");

        assert.strictEqual(await predictMergeSequence(repo.root, ["unrelated"], "main"), undefined);
        assert.strictEqual(await predictMergeSequence(repo.root, ["no-such-branch"], "main"), undefined);
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

    it("the merge report lists the conflict along the recommended order", async () => {
        const wtA = (await createWorktree(repo.root, "agent-a", { autoGitignore: true, startPoint: "main" })).path;
        const wtB = (await createWorktree(repo.root, "agent-b", { autoGitignore: true, startPoint: "main" })).path;
        fs.writeFileSync(path.join(wtA, "src", "app.ts"), sameLine("'a'")["src/app.ts"]);
        fs.writeFileSync(path.join(wtB, "src", "app.ts"), sameLine("'b'")["src/app.ts"]);
        await autoCommitWorktree(wtA, []);
        await autoCommitWorktree(wtB, []);

        const report = await generateMergeReport([wtA, wtB], "main");

        const [first, second] = report.mergeOrder.map((entry) => entry.branch);
        assert.deepStrictEqual(report.conflictPredictions.map((p) => ({
            branch: p.branch,
            conflictFiles: p.conflictFiles,
            conflictsWith: p.conflictsWith,
            method: p.method,
        })), [
            { branch: second, conflictFiles: ["src/app.ts"], conflictsWith: [first], method: "merge-tree" },
        ]);
        const markdown = formatMergeReportMarkdown(report);
        assert.ok(markdown.includes("Predicted Merge Conflicts"));
        assert.ok(markdown.includes(`(with ${first})`));
    });
});
