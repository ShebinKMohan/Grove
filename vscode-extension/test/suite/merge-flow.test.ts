/**
 * Real-git tests of the merge sequence's git steps: the pre-merge
 * auto-commit, the merge itself, conflict resolution and post-merge cleanup.
 *
 * Regression tests for 0.6.0 bugs, reproduced before the fix: in Grove 0.6.0 the
 * project's CLAUDE.md on main became an agent role file, and a new file the
 * agent never committed was skipped by `git add -u` and then deleted by the
 * forced cleanup.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import {
    autoCommitWorktree,
    defaultExclusionReason,
    executeMergeStep,
    findBranchesWithGeneratedClaudeMd,
    findConflictMarkers,
    listUnmergedFiles,
    postMergeCleanup,
    stageResolvedConflicts,
} from "../../src/core/merge-sequencer";
import { createWorktree, listUncommittedChanges } from "../../src/core/worktree-manager";
import {
    buildAgentInstructions,
    writeAgentInstructions,
} from "../../src/core/claude-md-generator";
import type { AgentRole, TeamTemplate } from "../../src/core/template-manager";
import { createTempRepo, gitIn, isolateGitEnv, type TempRepo } from "../helpers/git-repo";

const backend: AgentRole = {
    role: "backend",
    displayName: "Backend Architect",
    ownership: ["src/api/**"],
    prompt: "Build the API.",
    readOnly: false,
};
const template: TeamTemplate = {
    name: "Full-Stack",
    description: "test",
    agents: [backend],
    mergeOrder: ["backend"],
    estimatedTokens: "unknown",
};
const PROJECT_RULES = "# Project rules\n\nUse tabs.\n";

describe("merge flow (real git)", () => {
    let restoreEnv: () => void;
    let repo: TempRepo;

    beforeEach(() => {
        restoreEnv = isolateGitEnv();
        repo = createTempRepo();
        repo.commit("project files", {
            "CLAUDE.md": PROJECT_RULES,
            "src/app.ts": "export const app = 1;\n",
        });
    });

    afterEach(() => {
        repo.cleanup();
        restoreEnv();
    });

    async function agentWorktree(branch: string): Promise<string> {
        const { path: wt } = await createWorktree(repo.root, branch, {
            autoGitignore: true,
            startPoint: "main",
        });
        return wt;
    }

    it("merges the agent's work, including a new file, and leaves main's CLAUDE.md alone", async () => {
        const wt = await agentWorktree("worktree-t-backend");
        writeAgentInstructions({
            agent: backend,
            template,
            taskDescription: "Add due dates",
            teamName: "t",
            repoRoot: repo.root,
            worktreePath: wt,
        });
        // The agent edits a tracked file, creates a new one, and leaves a note.
        fs.writeFileSync(path.join(wt, "src", "app.ts"), "export const app = 2;\n");
        fs.mkdirSync(path.join(wt, "src", "api"));
        fs.writeFileSync(path.join(wt, "src", "api", "todo.ts"), "export const todo = 1;\n");
        fs.writeFileSync(path.join(wt, "HANDOFF.md"), "## Handoff\n");

        const { untracked } = await listUncommittedChanges(wt);
        assert.deepStrictEqual([...untracked].sort(), ["HANDOFF.md", "src/api/todo.ts"]);
        // What the merge dialog pre-selects: the new source file, not the note.
        const chosen = untracked.filter((f) => !defaultExclusionReason(f));
        assert.deepStrictEqual(chosen, ["src/api/todo.ts"]);

        const commit = await autoCommitWorktree(wt, chosen);
        assert.strictEqual(commit.committed, true);
        assert.deepStrictEqual([...commit.files].sort(), ["src/api/todo.ts", "src/app.ts"]);

        const step = await executeMergeStep(repo.root, "worktree-t-backend", "main");
        assert.strictEqual(step.status, "success");

        assert.strictEqual(repo.git("show", "main:CLAUDE.md") + "\n", PROJECT_RULES);
        assert.strictEqual(repo.git("show", "main:src/api/todo.ts"), "export const todo = 1;");
        assert.strictEqual(repo.git("show", "main:src/app.ts"), "export const app = 2;");
        assert.throws(() => repo.git("show", "main:HANDOFF.md"));
        assert.strictEqual(repo.git("status", "--porcelain"), "");
    });

    it("never merges a CLAUDE.md that Grove 0.6.0 wrote into the worktree", async () => {
        const wt = await agentWorktree("worktree-t-backend");
        // What 0.6.0 did: overwrite the tracked CLAUDE.md with the role file.
        fs.writeFileSync(
            path.join(wt, "CLAUDE.md"),
            buildAgentInstructions({
                agent: backend,
                template,
                taskDescription: "x",
                teamName: "t",
                repoRoot: repo.root,
                worktreePath: wt,
            })
        );
        fs.writeFileSync(path.join(wt, "src", "app.ts"), "export const app = 3;\n");

        const commit = await autoCommitWorktree(wt, []);
        assert.deepStrictEqual(commit.files, ["src/app.ts"]);
        assert.strictEqual(fs.readFileSync(path.join(wt, "CLAUDE.md"), "utf-8"), PROJECT_RULES);

        const step = await executeMergeStep(repo.root, "worktree-t-backend", "main");
        assert.strictEqual(step.status, "success");
        assert.strictEqual(repo.git("show", "main:CLAUDE.md") + "\n", PROJECT_RULES);
    });

    it("flags a branch that already committed a Grove-generated CLAUDE.md", async () => {
        const wt = await agentWorktree("legacy");
        fs.writeFileSync(
            path.join(wt, "CLAUDE.md"),
            buildAgentInstructions({
                agent: backend,
                template,
                taskDescription: "x",
                teamName: "t",
                repoRoot: repo.root,
                worktreePath: wt,
            })
        );
        gitIn(wt, "commit", "-q", "-am", "agent committed everything");
        await agentWorktree("clean");

        assert.deepStrictEqual(
            await findBranchesWithGeneratedClaudeMd(repo.root, ["legacy", "clean"], "main"),
            { branches: ["legacy"], baseHasClaudeMd: true }
        );
    });

    it("reports when the base branch has no CLAUDE.md for the legacy branch to replace", async () => {
        repo.git("rm", "-q", "CLAUDE.md");
        repo.commit("drop CLAUDE.md");
        const wt = await agentWorktree("legacy");
        fs.writeFileSync(
            path.join(wt, "CLAUDE.md"),
            buildAgentInstructions({
                agent: backend,
                template,
                taskDescription: "x",
                teamName: "t",
                repoRoot: repo.root,
                worktreePath: wt,
            })
        );
        gitIn(wt, "add", "CLAUDE.md");
        gitIn(wt, "commit", "-q", "-m", "agent added CLAUDE.md");

        assert.deepStrictEqual(
            await findBranchesWithGeneratedClaudeMd(repo.root, ["legacy"], "main"),
            { branches: ["legacy"], baseHasClaudeMd: false }
        );
    });

    it("flags a legacy role file committed through a CLAUDE.md symlink", async () => {
        repo.git("rm", "-q", "CLAUDE.md");
        repo.write("AGENTS.md", PROJECT_RULES);
        fs.symlinkSync("AGENTS.md", path.join(repo.root, "CLAUDE.md"));
        repo.commit("CLAUDE.md is a link to AGENTS.md");
        const wt = await agentWorktree("linked");
        fs.writeFileSync(
            path.join(wt, "CLAUDE.md"),
            buildAgentInstructions({
                agent: backend,
                template,
                taskDescription: "x",
                teamName: "t",
                repoRoot: repo.root,
                worktreePath: wt,
            })
        );
        gitIn(wt, "commit", "-q", "-am", "agent committed everything");

        assert.deepStrictEqual(
            await findBranchesWithGeneratedClaudeMd(repo.root, ["linked"], "main"),
            { branches: ["linked"], baseHasClaudeMd: true }
        );
    });

    it("never stages a nested git repository, even if it is chosen", async () => {
        const wt = await agentWorktree("nested");
        const nested = path.join(wt, "vendor", "ref");
        fs.mkdirSync(nested, { recursive: true });
        gitIn(nested, "init", "-q");
        fs.writeFileSync(path.join(nested, "lib.ts"), "export {};\n");
        fs.writeFileSync(path.join(wt, "src", "app.ts"), "export const app = 5;\n");

        const { untracked } = await listUncommittedChanges(wt);
        assert.deepStrictEqual(untracked, ["vendor/ref/"]);
        assert.ok(defaultExclusionReason("vendor/ref/"));

        const commit = await autoCommitWorktree(wt, untracked);
        assert.deepStrictEqual(commit.files, ["src/app.ts"]);
        assert.strictEqual(gitIn(wt, "ls-tree", "-r", "HEAD", "--", "vendor"), "");
    });

    it("stages exactly the chosen new files, even with glob characters in their names", async () => {
        const wt = await agentWorktree("next-app");
        fs.mkdirSync(path.join(wt, "app", "[id]"), { recursive: true });
        fs.mkdirSync(path.join(wt, "app", "i"), { recursive: true });
        fs.writeFileSync(path.join(wt, "app", "[id]", "page.tsx"), "export {};\n");
        fs.writeFileSync(path.join(wt, "app", "i", "page.tsx"), "export {};\n");

        const commit = await autoCommitWorktree(wt, ["app/[id]/page.tsx"]);

        assert.deepStrictEqual(commit.files, ["app/[id]/page.tsx"]);
        assert.deepStrictEqual((await listUncommittedChanges(wt)).untracked, ["app/i/page.tsx"]);
    });

    it("an auto-commit with nothing to commit makes no commit", async () => {
        const wt = await agentWorktree("idle");
        const head = gitIn(wt, "rev-parse", "HEAD");
        const commit = await autoCommitWorktree(wt, []);
        assert.strictEqual(commit.committed, false);
        assert.strictEqual(gitIn(wt, "rev-parse", "HEAD"), head);
    });

    it("an auto-commit failure is reported, not swallowed", async () => {
        const wt = await agentWorktree("hooked");
        const hooks = path.join(repo.root, "hooks");
        fs.mkdirSync(hooks);
        fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
        fs.chmodSync(path.join(hooks, "pre-commit"), 0o755);
        repo.git("config", "core.hooksPath", hooks);
        fs.writeFileSync(path.join(wt, "src", "app.ts"), "export const app = 4;\n");

        await assert.rejects(autoCommitWorktree(wt, []));
    });

    describe("conflicts", () => {
        async function conflictingBranches(): Promise<void> {
            const a = await agentWorktree("agent-a");
            const b = await agentWorktree("agent-b");
            fs.writeFileSync(path.join(a, "src", "app.ts"), "export const app = 'a';\n");
            fs.writeFileSync(path.join(b, "src", "app.ts"), "export const app = 'b';\n");
            await autoCommitWorktree(a, []);
            await autoCommitWorktree(b, []);
        }

        it("reports the conflicted file and stages only the resolution", async () => {
            await conflictingBranches();
            assert.strictEqual((await executeMergeStep(repo.root, "agent-a", "main")).status, "success");

            const step = await executeMergeStep(repo.root, "agent-b", "main");
            assert.strictEqual(step.status, "conflict");
            assert.deepStrictEqual(step.conflictFiles, ["src/app.ts"]);
            assert.deepStrictEqual(findConflictMarkers(repo.root, ["src/app.ts"]), ["src/app.ts"]);

            // The user resolves the file; an editor leaves a backup file behind.
            repo.write("src/app.ts", "export const app = 'ab';\n");
            repo.write("src/app.ts.orig", "backup\n");
            assert.deepStrictEqual(findConflictMarkers(repo.root, ["src/app.ts"]), []);

            assert.deepStrictEqual(await stageResolvedConflicts(repo.root, ["src/app.ts"]), []);
            repo.git("commit", "--no-edit", "-q");

            assert.strictEqual(repo.git("show", "main:src/app.ts"), "export const app = 'ab';");
            assert.throws(() => repo.git("show", "main:src/app.ts.orig"));
            assert.strictEqual(repo.git("status", "--porcelain"), "?? src/app.ts.orig");
        });

        it("accepts a modify/delete conflict the user resolved with git rm", async () => {
            const a = await agentWorktree("deleter");
            fs.rmSync(path.join(a, "src", "app.ts"));
            await autoCommitWorktree(a, []);
            repo.commit("main edits app.ts", { "src/app.ts": "export const app = 'main';\n" });

            const step = await executeMergeStep(repo.root, "deleter", "main");
            assert.strictEqual(step.status, "conflict");
            assert.deepStrictEqual(step.conflictFiles, ["src/app.ts"]);

            repo.git("rm", "-q", "src/app.ts");
            assert.deepStrictEqual(await stageResolvedConflicts(repo.root, step.conflictFiles ?? []), []);
            repo.git("commit", "--no-edit", "-q");
            assert.throws(() => repo.git("show", "main:src/app.ts"));
        });

        it("listUnmergedFiles is empty outside a merge", async () => {
            assert.deepStrictEqual(await listUnmergedFiles(repo.root), []);
        });
    });

    describe("postMergeCleanup()", () => {
        async function mergedWorktree(branch: string): Promise<string> {
            const wt = await agentWorktree(branch);
            fs.writeFileSync(path.join(wt, "src", "app.ts"), `export const app = '${branch}';\n`);
            await autoCommitWorktree(wt, []);
            assert.strictEqual((await executeMergeStep(repo.root, branch, "main")).status, "success");
            return wt;
        }

        it("removes a clean merged worktree and its branch", async () => {
            const wt = await mergedWorktree("done");
            const result = await postMergeCleanup(repo.root, [{ path: wt, branch: "done" }]);
            assert.deepStrictEqual(result, { removed: 1, kept: [], errors: [] });
            assert.strictEqual(fs.existsSync(wt), false);
            assert.strictEqual(repo.git("branch", "--list", "done"), "");
        });

        it("keeps a worktree with unmerged files when nobody confirms", async () => {
            const wt = await mergedWorktree("leftover");
            fs.writeFileSync(path.join(wt, "notes.md"), "not merged\n");

            const result = await postMergeCleanup(repo.root, [{ path: wt, branch: "leftover" }]);

            assert.deepStrictEqual(result, { removed: 0, kept: ["leftover"], errors: [] });
            assert.strictEqual(fs.readFileSync(path.join(wt, "notes.md"), "utf-8"), "not merged\n");
        });

        it("asks with the file list, and keeps the worktree on no", async () => {
            const wt = await mergedWorktree("leftover");
            fs.writeFileSync(path.join(wt, "notes.md"), "not merged\n");
            const asked: string[][] = [];

            const result = await postMergeCleanup(repo.root, [{ path: wt, branch: "leftover" }], {
                confirmDiscard: async (_wt, files) => {
                    asked.push(files);
                    return false;
                },
            });

            assert.deepStrictEqual(asked, [["notes.md"]]);
            assert.deepStrictEqual(result.kept, ["leftover"]);
            assert.ok(fs.existsSync(path.join(wt, "notes.md")));
        });

        it("keeps a branch that gained commits after the merge", async () => {
            const wt = await mergedWorktree("late");
            fs.writeFileSync(path.join(wt, "later.ts"), "export {};\n");
            await autoCommitWorktree(wt, ["later.ts"]);

            const result = await postMergeCleanup(repo.root, [{ path: wt, branch: "late" }]);

            // The worktree is clean, so it is removed, but `git branch -d`
            // refuses to delete the unmerged commit.
            assert.strictEqual(result.removed, 1);
            assert.strictEqual(repo.git("branch", "--list", "late").trim(), "late");
        });

        it("removes it when the user confirms", async () => {
            const wt = await mergedWorktree("leftover");
            fs.writeFileSync(path.join(wt, "notes.md"), "not merged\n");

            const result = await postMergeCleanup(repo.root, [{ path: wt, branch: "leftover" }], {
                confirmDiscard: async () => true,
            });

            assert.strictEqual(result.removed, 1);
            assert.strictEqual(fs.existsSync(wt), false);
        });

        it("does not count a Grove 0.6.0 CLAUDE.md as unmerged work", async () => {
            const wt = await mergedWorktree("legacy-clean");
            fs.writeFileSync(
                path.join(wt, "CLAUDE.md"),
                buildAgentInstructions({
                    agent: backend,
                    template,
                    taskDescription: "x",
                    teamName: "t",
                    repoRoot: repo.root,
                    worktreePath: wt,
                })
            );

            const result = await postMergeCleanup(repo.root, [{ path: wt, branch: "legacy-clean" }]);

            assert.strictEqual(result.removed, 1);
            assert.strictEqual(repo.git("show", "main:CLAUDE.md") + "\n", PROJECT_RULES);
        });
    });
});
