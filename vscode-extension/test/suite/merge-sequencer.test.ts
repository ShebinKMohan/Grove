import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
    recommendMergeOrder,
    formatMergeReportMarkdown,
    detectTestCommand,
    type WorktreeMergeInfo,
    type MergeReport,
} from "../../src/core/merge-sequencer";

describe("merge-sequencer", () => {
    describe("recommendMergeOrder()", () => {
        function makeWorktree(
            branch: string,
            changedFiles: string[]
        ): WorktreeMergeInfo {
            return {
                path: `/tmp/wt/${branch}`,
                branch,
                changedFiles,
                linesAdded: 10,
                linesRemoved: 5,
                newFiles: [],
                diffStat: "",
                hasUncommittedChanges: false,
            };
        }

        it("puts types/models before features", () => {
            const worktrees = [
                makeWorktree("feature/ui", ["src/components/Header.tsx"]),
                makeWorktree("feature/types", ["src/types/user.ts"]),
            ];
            const order = recommendMergeOrder(worktrees);
            assert.strictEqual(order[0].branch, "feature/types");
            assert.strictEqual(order[1].branch, "feature/ui");
        });

        it("puts tests after source code", () => {
            const worktrees = [
                makeWorktree("feature/tests", ["test/auth.test.ts"]),
                makeWorktree("feature/api", ["src/api/auth.ts"]),
            ];
            const order = recommendMergeOrder(worktrees);
            assert.strictEqual(order[0].branch, "feature/api");
            assert.strictEqual(order[1].branch, "feature/tests");
        });

        it("puts core/lib before UI", () => {
            const worktrees = [
                makeWorktree("feature/ui", ["src/pages/Home.tsx"]),
                makeWorktree("feature/core", ["src/core/engine.ts"]),
            ];
            const order = recommendMergeOrder(worktrees);
            assert.strictEqual(order[0].branch, "feature/core");
        });

        it("uses template order when provided", () => {
            const worktrees = [
                makeWorktree("b", ["src/b.ts"]),
                makeWorktree("a", ["src/a.ts"]),
                makeWorktree("c", ["src/c.ts"]),
            ];
            const order = recommendMergeOrder(worktrees, ["c", "a", "b"]);
            assert.strictEqual(order[0].branch, "c");
            assert.strictEqual(order[1].branch, "a");
            assert.strictEqual(order[2].branch, "b");
        });

        it("puts empty worktrees last", () => {
            const worktrees = [
                makeWorktree("feature/review", []),
                makeWorktree("feature/code", ["src/app.ts"]),
            ];
            const order = recommendMergeOrder(worktrees);
            assert.strictEqual(order[0].branch, "feature/code");
            assert.strictEqual(order[1].branch, "feature/review");
        });

        it("handles single worktree", () => {
            const worktrees = [makeWorktree("feature/solo", ["src/solo.ts"])];
            const order = recommendMergeOrder(worktrees);
            assert.strictEqual(order.length, 1);
            assert.strictEqual(order[0].branch, "feature/solo");
        });
    });

    describe("formatMergeReportMarkdown()", () => {
        const report: MergeReport = {
            generatedAt: "2026-03-14T10:00:00.000Z",
            baseBranch: "main",
            worktrees: [
                {
                    path: "/tmp/wt/api",
                    branch: "feature/api",
                    changedFiles: ["src/api/routes.ts", "src/api/auth.ts"],
                    linesAdded: 150,
                    linesRemoved: 20,
                    newFiles: ["src/api/auth.ts"],
                    diffStat: " 2 files changed, 150 insertions(+), 20 deletions(-)",
                    hasUncommittedChanges: false,
                },
                {
                    path: "/tmp/wt/ui",
                    branch: "feature/ui",
                    changedFiles: ["src/components/Login.tsx"],
                    linesAdded: 80,
                    linesRemoved: 5,
                    newFiles: ["src/components/Login.tsx"],
                    diffStat: " 1 file changed, 80 insertions(+), 5 deletions(-)",
                    reviewFindings: "Looks good, minor style issues.",
                    hasUncommittedChanges: true,
                },
            ],
            overlaps: [
                {
                    filePath: "package.json",
                    branches: ["feature/api", "feature/ui"],
                    likelyAutoResolvable: true,
                },
            ],
            mergeOrder: [
                {
                    branch: "feature/api",
                    worktreePath: "/tmp/wt/api",
                    reason: "Contains API/service code",
                },
                {
                    branch: "feature/ui",
                    worktreePath: "/tmp/wt/ui",
                    reason: "Contains UI components",
                },
            ],
            totalFilesChanged: 3,
            totalLinesAdded: 230,
            totalLinesRemoved: 25,
            conflictPredictions: [],
            conflictCheck: "merge-tree",
        };

        it("includes the report header", () => {
            const md = formatMergeReportMarkdown(report);
            assert.ok(md.includes("# Merge Readiness Report"));
        });

        it("includes summary table", () => {
            const md = formatMergeReportMarkdown(report);
            assert.ok(md.includes("| Total files changed | 3 |"));
            assert.ok(md.includes("| Lines added | +230 |"));
        });

        it("includes overlaps section", () => {
            const md = formatMergeReportMarkdown(report);
            assert.ok(md.includes("## Worktree-to-Worktree File Overlaps"));
            assert.ok(md.includes("package.json"));
            assert.ok(md.includes("likely auto-resolvable"));
        });

        it("includes merge order", () => {
            const md = formatMergeReportMarkdown(report);
            assert.ok(md.includes("## Recommended Merge Order"));
            assert.ok(md.includes("1. `feature/api`"));
            assert.ok(md.includes("2. `feature/ui`"));
        });

        it("includes per-worktree details", () => {
            const md = formatMergeReportMarkdown(report);
            assert.ok(md.includes("### feature/api"));
            assert.ok(md.includes("### feature/ui"));
        });

        it("shows uncommitted changes warning", () => {
            const md = formatMergeReportMarkdown(report);
            assert.ok(md.includes("WARNING"));
            assert.ok(md.includes("uncommitted"));
        });

        it("includes reviewer findings when present", () => {
            const md = formatMergeReportMarkdown(report);
            assert.ok(md.includes("Reviewer Findings"));
            assert.ok(md.includes("minor style issues"));
        });

        it("includes new files listing", () => {
            const md = formatMergeReportMarkdown(report);
            assert.ok(md.includes("`src/api/auth.ts`"));
        });
    });

    describe("detectTestCommand()", () => {
        it("detects npm test from package.json", () => {
            const tmpDir = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), "wtp-test-"))
            );
            try {
                fs.writeFileSync(
                    path.join(tmpDir, "package.json"),
                    JSON.stringify({
                        scripts: { test: "vitest run" },
                    })
                );
                const cmd = detectTestCommand(tmpDir);
                assert.strictEqual(cmd, "npm test");
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it("ignores default npm test placeholder", () => {
            const tmpDir = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), "wtp-test-"))
            );
            try {
                fs.writeFileSync(
                    path.join(tmpDir, "package.json"),
                    JSON.stringify({
                        scripts: {
                            test: 'echo "Error: no test specified" && exit 1',
                        },
                    })
                );
                const cmd = detectTestCommand(tmpDir);
                assert.strictEqual(cmd, undefined);
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it("detects go test from go.mod", () => {
            const tmpDir = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), "wtp-test-"))
            );
            try {
                fs.writeFileSync(
                    path.join(tmpDir, "go.mod"),
                    "module example.com/mymod\n"
                );
                const cmd = detectTestCommand(tmpDir);
                assert.strictEqual(cmd, "go test ./...");
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it("detects cargo test from Cargo.toml", () => {
            const tmpDir = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), "wtp-test-"))
            );
            try {
                fs.writeFileSync(
                    path.join(tmpDir, "Cargo.toml"),
                    "[package]\nname = \"test\"\n"
                );
                const cmd = detectTestCommand(tmpDir);
                assert.strictEqual(cmd, "cargo test");
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it("returns undefined when no test framework detected", () => {
            const tmpDir = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), "wtp-test-"))
            );
            try {
                const cmd = detectTestCommand(tmpDir);
                assert.strictEqual(cmd, undefined);
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });
    });
});
