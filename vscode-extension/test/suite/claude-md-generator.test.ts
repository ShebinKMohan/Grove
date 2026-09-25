import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import {
    buildAgentInstructions,
    writeAgentInstructions,
    agentInstructionsPath,
    isGroveGeneratedInstructions,
    discardLegacyGeneratedClaudeMd,
} from "../../src/core/claude-md-generator";
import { createWorktree } from "../../src/core/worktree-manager";
import type { TeamTemplate, AgentRole } from "../../src/core/template-manager";
import { createTempRepo, gitIn, isolateGitEnv, type TempRepo } from "../helpers/git-repo";

describe("claude-md-generator", () => {
    const backendAgent: AgentRole = {
        role: "backend",
        displayName: "Backend Architect",
        ownership: ["src/api/**", "src/models/**"],
        prompt: "You are the backend architect. Build APIs.",
        claudeMdExtra: "Use REST patterns.",
        readOnly: false,
    };

    const frontendAgent: AgentRole = {
        role: "frontend",
        displayName: "Frontend Engineer",
        ownership: ["src/components/**", "src/pages/**"],
        prompt: "You are the frontend engineer. Build UI.",
        readOnly: false,
    };

    const reviewerAgent: AgentRole = {
        role: "reviewer",
        displayName: "Code Reviewer",
        ownership: [],
        prompt: "Review the code for quality.",
        readOnly: true,
    };

    const template: TeamTemplate = {
        name: "Test Team",
        description: "A test team",
        agents: [backendAgent, frontendAgent, reviewerAgent],
        mergeOrder: ["backend", "frontend"],
        estimatedTokens: "100K",
    };

    describe("buildAgentInstructions()", () => {
        it("includes agent display name in header", () => {
            const content = buildAgentInstructions({
                agent: backendAgent,
                template,
                taskDescription: "Build user auth",
                teamName: "auth-team",
                repoRoot: "/tmp/fake",
                worktreePath: "/tmp/fake/wt",
            });
            assert.ok(content.includes("# Backend Architect"));
        });

        it("includes task description", () => {
            const content = buildAgentInstructions({
                agent: backendAgent,
                template,
                taskDescription: "Build user auth",
                teamName: "auth-team",
                repoRoot: "/tmp/fake",
                worktreePath: "/tmp/fake/wt",
            });
            assert.ok(content.includes("Build user auth"));
        });

        it("includes agent prompt", () => {
            const content = buildAgentInstructions({
                agent: backendAgent,
                template,
                taskDescription: "",
                teamName: "test",
                repoRoot: "/tmp/fake",
                worktreePath: "/tmp/fake/wt",
            });
            assert.ok(content.includes("You are the backend architect"));
        });

        it("lists ownership patterns", () => {
            const content = buildAgentInstructions({
                agent: backendAgent,
                template,
                taskDescription: "",
                teamName: "test",
                repoRoot: "/tmp/fake",
                worktreePath: "/tmp/fake/wt",
            });
            assert.ok(content.includes("`src/api/**`"));
            assert.ok(content.includes("`src/models/**`"));
        });

        it("lists other agents as do-not-modify", () => {
            const content = buildAgentInstructions({
                agent: backendAgent,
                template,
                taskDescription: "",
                teamName: "test",
                repoRoot: "/tmp/fake",
                worktreePath: "/tmp/fake/wt",
            });
            assert.ok(content.includes("Frontend Engineer"));
            assert.ok(content.includes("`src/components/**`"));
        });

        it("includes read-only warning for reviewer agents", () => {
            const content = buildAgentInstructions({
                agent: reviewerAgent,
                template,
                taskDescription: "",
                teamName: "test",
                repoRoot: "/tmp/fake",
                worktreePath: "/tmp/fake/wt",
            });
            assert.ok(content.includes("READ-ONLY"));
            assert.ok(content.includes("REVIEW.md"));
        });

        it("includes shared files protocol when provided", () => {
            const content = buildAgentInstructions({
                agent: backendAgent,
                template,
                taskDescription: "",
                teamName: "test",
                repoRoot: "/tmp/fake",
                worktreePath: "/tmp/fake/wt",
                sharedFiles: ["package.json", "tsconfig.json"],
            });
            assert.ok(content.includes("Shared Files Protocol"));
            assert.ok(content.includes("`package.json`"));
            assert.ok(content.includes("SHARED-CHANGES.md"));
        });

        it("includes handoff protocol for non-readonly agents", () => {
            const content = buildAgentInstructions({
                agent: backendAgent,
                template,
                taskDescription: "",
                teamName: "test",
                repoRoot: "/tmp/fake",
                worktreePath: "/tmp/fake/wt",
            });
            assert.ok(content.includes("HANDOFF.md"));
        });

        it("does not include handoff protocol for readonly agents", () => {
            const content = buildAgentInstructions({
                agent: reviewerAgent,
                template,
                taskDescription: "",
                teamName: "test",
                repoRoot: "/tmp/fake",
                worktreePath: "/tmp/fake/wt",
            });
            assert.ok(!content.includes("HANDOFF.md"));
        });

        it("includes claudeMdExtra when provided", () => {
            const content = buildAgentInstructions({
                agent: backendAgent,
                template,
                taskDescription: "",
                teamName: "test",
                repoRoot: "/tmp/fake",
                worktreePath: "/tmp/fake/wt",
            });
            assert.ok(content.includes("Use REST patterns."));
        });

        it("includes project conventions when provided", () => {
            const content = buildAgentInstructions({
                agent: backendAgent,
                template,
                taskDescription: "",
                teamName: "test",
                repoRoot: "/tmp/fake",
                worktreePath: "/tmp/fake/wt",
                projectConfig: {
                    conventions: {
                        framework: "FastAPI + React",
                        testFramework: "pytest",
                        linter: "ruff",
                    },
                },
            });
            assert.ok(content.includes("FastAPI + React"));
            assert.ok(content.includes("pytest"));
        });

        it("includes team and session metadata", () => {
            const content = buildAgentInstructions({
                agent: backendAgent,
                template,
                taskDescription: "",
                teamName: "auth-team",
                repoRoot: "/tmp/fake",
                worktreePath: "/tmp/fake/wt",
            });
            assert.ok(content.includes("Test Team"));
            assert.ok(content.includes("auth-team"));
        });
    });

    // Regression tests for a 0.6.0 bug, reproduced before the fix: Grove wrote the
    // agent's instructions over a tracked CLAUDE.md inside the worktree, and
    // the auto-commit and merge carried it to the base branch.
    describe("writeAgentInstructions() on a real repo", () => {
        let restoreEnv: () => void;
        let repo: TempRepo;
        const PROJECT_RULES = "# Project rules\n\nUse tabs.\n";

        beforeEach(() => {
            restoreEnv = isolateGitEnv();
            repo = createTempRepo();
            repo.commit("project CLAUDE.md", { "CLAUDE.md": PROJECT_RULES });
        });

        afterEach(() => {
            repo.cleanup();
            restoreEnv();
        });

        async function makeWorktree(branch: string): Promise<string> {
            const result = await createWorktree(repo.root, branch, { autoGitignore: true });
            return result.path;
        }

        const optionsFor = (worktreePath: string) => ({
            agent: backendAgent,
            template,
            taskDescription: "Build user auth",
            teamName: "auth-team",
            repoRoot: repo.root,
            worktreePath,
        });

        it("writes under .grove/agents and leaves the worktree's CLAUDE.md untouched", async () => {
            const wt = await makeWorktree("worktree-auth-team-backend");
            const file = writeAgentInstructions(optionsFor(wt));

            assert.strictEqual(path.dirname(file), path.join(repo.root, ".grove", "agents"));
            assert.ok(fs.readFileSync(file, "utf-8").startsWith("# Backend Architect \u2014 Grove Agent"));
            assert.strictEqual(fs.readFileSync(path.join(wt, "CLAUDE.md"), "utf-8"), PROJECT_RULES);
            // Nothing for git to see in either checkout, so nothing can be committed or merged.
            assert.strictEqual(gitIn(wt, "status", "--porcelain"), "");
            assert.strictEqual(repo.git("status", "--porcelain"), "");
            assert.strictEqual(repo.exists(".gitignore"), false);
        });

        it("keys the path on the worktree's real path", async () => {
            const wt = await makeWorktree("feat-a");
            // The same worktree reached through a symlink (like macOS /var and /private/var).
            const link = path.join(repo.root, ".grove-link");
            fs.symlinkSync(path.dirname(wt), link);
            const viaLink = path.join(link, path.basename(wt));
            assert.notStrictEqual(path.resolve(viaLink), path.resolve(wt));
            assert.strictEqual(agentInstructionsPath(repo.root, viaLink), agentInstructionsPath(repo.root, wt));
            const other = await makeWorktree("feat-b");
            assert.notStrictEqual(agentInstructionsPath(repo.root, other), agentInstructionsPath(repo.root, wt));
        });

        it("does not inline the project CLAUDE.md when the worktree has its own copy", async () => {
            const wt = await makeWorktree("feat-a");
            const content = buildAgentInstructions(optionsFor(wt));
            assert.ok(!content.includes("Use tabs."));
        });

        it("inlines the main checkout's CLAUDE.md when it is untracked", async () => {
            fs.writeFileSync(path.join(repo.root, ".git", "info", "exclude"), "CLAUDE.md\n");
            repo.git("rm", "-q", "--cached", "CLAUDE.md");
            repo.commit("untrack CLAUDE.md");
            const wt = await makeWorktree("feat-a");
            assert.strictEqual(fs.existsSync(path.join(wt, "CLAUDE.md")), false);
            const content = buildAgentInstructions(optionsFor(wt));
            assert.ok(content.includes("## Project-Level Instructions (from main repo)"));
            assert.ok(content.includes("Use tabs."));
        });

        it("recognises its own output and not a user's CLAUDE.md", async () => {
            const wt = await makeWorktree("feat-a");
            assert.strictEqual(isGroveGeneratedInstructions(buildAgentInstructions(optionsFor(wt))), true);
            assert.strictEqual(isGroveGeneratedInstructions(PROJECT_RULES), false);
            assert.strictEqual(
                isGroveGeneratedInstructions("# Notes \u2014 Grove Agent\n\nhand written, no footer\n"),
                false
            );
        });

        it("discardLegacyGeneratedClaudeMd restores a tracked CLAUDE.md that 0.6.0 overwrote", async () => {
            const wt = await makeWorktree("feat-a");
            fs.writeFileSync(path.join(wt, "CLAUDE.md"), buildAgentInstructions(optionsFor(wt)));
            gitIn(wt, "add", "CLAUDE.md");

            assert.strictEqual(await discardLegacyGeneratedClaudeMd(wt), true);
            assert.strictEqual(fs.readFileSync(path.join(wt, "CLAUDE.md"), "utf-8"), PROJECT_RULES);
            assert.strictEqual(gitIn(wt, "status", "--porcelain"), "");
        });

        it("discardLegacyGeneratedClaudeMd keeps a 0.6.0 agent's instructions for relaunch", async () => {
            const wt = await makeWorktree("feat-a");
            const legacy = buildAgentInstructions(optionsFor(wt));
            fs.writeFileSync(path.join(wt, "CLAUDE.md"), legacy);
            const saved = agentInstructionsPath(repo.root, wt);
            assert.strictEqual(fs.existsSync(saved), false);

            await discardLegacyGeneratedClaudeMd(wt);

            assert.strictEqual(fs.readFileSync(saved, "utf-8"), legacy);
            assert.strictEqual(repo.git("status", "--porcelain"), "");
        });

        it("discardLegacyGeneratedClaudeMd does not overwrite existing instructions", async () => {
            const wt = await makeWorktree("feat-a");
            const current = writeAgentInstructions(optionsFor(wt));
            const before = fs.readFileSync(current, "utf-8");
            fs.writeFileSync(path.join(wt, "CLAUDE.md"), buildAgentInstructions({ ...optionsFor(wt), taskDescription: "old task" }));

            await discardLegacyGeneratedClaudeMd(wt);

            assert.strictEqual(fs.readFileSync(current, "utf-8"), before);
        });

        it("discardLegacyGeneratedClaudeMd removes an untracked generated CLAUDE.md", async () => {
            repo.git("rm", "-q", "CLAUDE.md");
            repo.commit("no CLAUDE.md");
            const wt = await makeWorktree("feat-a");
            fs.writeFileSync(path.join(wt, "CLAUDE.md"), buildAgentInstructions(optionsFor(wt)));
            gitIn(wt, "add", "CLAUDE.md");

            assert.strictEqual(await discardLegacyGeneratedClaudeMd(wt), true);
            assert.strictEqual(fs.existsSync(path.join(wt, "CLAUDE.md")), false);
            assert.strictEqual(gitIn(wt, "status", "--porcelain"), "");
        });

        it("discardLegacyGeneratedClaudeMd restores the file a CLAUDE.md symlink points to", async () => {
            repo.git("rm", "-q", "CLAUDE.md");
            repo.write("AGENTS.md", PROJECT_RULES);
            fs.symlinkSync("AGENTS.md", path.join(repo.root, "CLAUDE.md"));
            repo.commit("CLAUDE.md is a link to AGENTS.md");
            const wt = await makeWorktree("feat-a");
            // 0.6.0 wrote through the link, overwriting AGENTS.md.
            fs.writeFileSync(path.join(wt, "CLAUDE.md"), buildAgentInstructions(optionsFor(wt)));
            assert.notStrictEqual(fs.readFileSync(path.join(wt, "AGENTS.md"), "utf-8"), PROJECT_RULES);

            assert.strictEqual(await discardLegacyGeneratedClaudeMd(wt), true);
            assert.strictEqual(fs.readFileSync(path.join(wt, "AGENTS.md"), "utf-8"), PROJECT_RULES);
            assert.strictEqual(gitIn(wt, "status", "--porcelain"), "");
        });

        it("discardLegacyGeneratedClaudeMd restores a tracked lowercase claude.md on a case-insensitive disk", async function () {
            const probe = path.join(repo.root, "Case-Probe");
            fs.writeFileSync(probe, "");
            const caseInsensitive = fs.existsSync(path.join(repo.root, "case-probe"));
            fs.rmSync(probe);
            if (!caseInsensitive) return; // Nothing to test on a case-sensitive disk

            repo.git("mv", "CLAUDE.md", "claude.md");
            repo.commit("lowercase name");
            const wt = await makeWorktree("feat-a");
            fs.writeFileSync(path.join(wt, "CLAUDE.md"), buildAgentInstructions(optionsFor(wt)));

            assert.strictEqual(await discardLegacyGeneratedClaudeMd(wt), true);
            assert.strictEqual(fs.readFileSync(path.join(wt, "claude.md"), "utf-8"), PROJECT_RULES);
            assert.strictEqual(gitIn(wt, "status", "--porcelain"), "");
        });

        it("discardLegacyGeneratedClaudeMd keeps edits when HEAD's CLAUDE.md is itself generated", async () => {
            const wt = await makeWorktree("feat-a");
            const generated = buildAgentInstructions(optionsFor(wt));
            fs.writeFileSync(path.join(wt, "CLAUDE.md"), generated);
            gitIn(wt, "commit", "-q", "-am", "generated file already committed");
            fs.writeFileSync(path.join(wt, "CLAUDE.md"), generated.replace("## Your Role", "## Your Role\n\nNew convention."));

            assert.strictEqual(await discardLegacyGeneratedClaudeMd(wt), false);
            assert.ok(fs.readFileSync(path.join(wt, "CLAUDE.md"), "utf-8").includes("New convention."));
        });

        it("discardLegacyGeneratedClaudeMd leaves a user-edited CLAUDE.md alone", async () => {
            const wt = await makeWorktree("feat-a");
            fs.writeFileSync(path.join(wt, "CLAUDE.md"), PROJECT_RULES + "\nNew rule.\n");

            assert.strictEqual(await discardLegacyGeneratedClaudeMd(wt), false);
            assert.ok(fs.readFileSync(path.join(wt, "CLAUDE.md"), "utf-8").includes("New rule."));
        });
    });
});
