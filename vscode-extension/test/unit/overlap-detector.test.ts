/**
 * Unit tests for the real OverlapDetector class.
 *
 * The `vscode` module is replaced by the framework-free fake in
 * test/helpers/vscode-stub.ts, so the class can be constructed and driven
 * directly: file watcher events are fired at the handlers it registers,
 * debouncing runs on fake timers, and `scanExistingChanges` runs real git
 * against throw-away repositories under os.tmpdir().
 *
 * This directory is run by vitest only; the mocha integration runner
 * (test/suite/index.ts) never loads it.
 */

import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import * as vscode from "vscode";
import type { VscodeStub } from "../helpers/vscode-stub";
import { OverlapDetector } from "../../src/core/overlap-detector";
import type { FileOverlap } from "../../src/core/overlap-detector";
import { log } from "../../src/utils/logger";

vi.mock("vscode", async () => {
    const { createVscodeStub } = await import("../helpers/vscode-stub");
    return createVscodeStub();
});

vi.mock("../../src/utils/logger", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/utils/logger")>()),
    log: vi.fn(),
}));

const stub = (vscode as unknown as VscodeStub).__stub;

const DEBOUNCE_MS = 500;

/** Let promise callbacks (e.g. a notification's `.then`) run. */
async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
    }
}

function sortedBranches(overlap: FileOverlap): string[] {
    return overlap.worktrees.map((w) => w.branch).sort();
}

function sortedPaths(overlap: FileOverlap): string[] {
    return overlap.worktrees.map((w) => w.path).sort();
}

// ────────────────────────────────────────────
// Real-time detection through the file watchers
// ────────────────────────────────────────────

describe("OverlapDetector (real class, stubbed vscode)", () => {
    let root: string;
    let wtA: string;
    let wtB: string;
    let wtC: string;
    let detector: OverlapDetector;
    let detected: FileOverlap[];
    let changeEvents: number;

    const worktreeA = () => ({ path: wtA, branch: "feature/a" });
    const worktreeB = () => ({ path: wtB, branch: "feature/b" });
    const worktreeC = () => ({ path: wtC, branch: "feature/c" });

    /** Fire a watcher event for `relPath` inside `worktree`. Returns handlers invoked. */
    function touch(
        worktree: string,
        relPath: string,
        kind: "create" | "change" | "delete" = "change"
    ): number {
        return stub.fireFileEvent(kind, path.join(worktree, relPath));
    }

    /** Touch the same file in worktrees A and B and let the debounce elapse. */
    function overlapFor(relPath: string): FileOverlap | undefined {
        touch(wtA, relPath);
        touch(wtB, relPath);
        vi.advanceTimersByTime(DEBOUNCE_MS);
        return detector.getOverlaps().find((o) => o.filePath === relPath);
    }

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "grove-overlap-unit-"));
        wtA = path.join(root, "wt-a");
        wtB = path.join(root, "wt-b");
        wtC = path.join(root, "wt-c");
        for (const dir of [wtA, wtB, wtC]) fs.mkdirSync(dir);
    });

    afterAll(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        stub.reset();
        vi.mocked(log).mockClear();

        detector = new OverlapDetector(DEBOUNCE_MS);
        detected = [];
        changeEvents = 0;
        detector.onDidDetectOverlap((o) => detected.push(o));
        detector.onDidChangeOverlaps(() => changeEvents++);
    });

    afterEach(() => {
        detector.dispose();
        vi.useRealTimers();
    });

    describe("watchWorktrees", () => {
        it("creates one watcher per existing worktree folder and skips folders that do not exist", () => {
            detector.watchWorktrees([
                worktreeA(),
                worktreeB(),
                { path: path.join(root, "missing"), branch: "feature/missing" },
            ]);

            expect(stub.watchers).toHaveLength(2);
            expect(stub.watchers.map((w) => w.base)).toEqual([wtA, wtB]);
            for (const watcher of stub.watchers) {
                expect(watcher.ignoreCreateEvents).toBe(false);
                expect(watcher.ignoreChangeEvents).toBe(false);
                expect(watcher.ignoreDeleteEvents).toBe(false);
                expect(watcher.handlers.create).toHaveLength(1);
                expect(watcher.handlers.change).toHaveLength(1);
                expect(watcher.handlers.delete).toHaveLength(1);
            }
        });

        it("disposes the previous watchers before creating new ones", () => {
            detector.watchWorktrees([worktreeA(), worktreeB()]);
            const first = [...stub.watchers];

            detector.watchWorktrees([worktreeA(), worktreeB()]);

            expect(stub.watchers).toHaveLength(4);
            expect(first.every((w) => w.disposed)).toBe(true);
            expect(stub.activeWatchers()).toHaveLength(2);
        });

        it("drops an overlap when a worktree that caused it is no longer watched", () => {
            detector.watchWorktrees([worktreeA(), worktreeB(), worktreeC()]);
            expect(overlapFor("src/api/auth.ts")).toBeDefined();

            detector.watchWorktrees([worktreeA(), worktreeC()]);

            expect(detector.getOverlaps()).toEqual([]);
            expect(detector.activeOverlapCount).toBe(0);
        });

        it("keeps an overlap whose worktrees are all still watched", () => {
            detector.watchWorktrees([worktreeA(), worktreeB()]);
            overlapFor("src/api/auth.ts");

            detector.watchWorktrees([worktreeA(), worktreeB(), worktreeC()]);

            expect(detector.getOverlaps().map((o) => o.filePath)).toEqual(["src/api/auth.ts"]);
        });

        // CURRENT BEHAVIOUR, arguably a bug: pruning updates the internal
        // file map but not the stored overlap, so a worktree that is no
        // longer watched is still listed on a surviving overlap
        // (overlap-detector.ts:128-139 never calls createOverlap again).
        it("still lists an unwatched worktree on an overlap that survives pruning (documents current behaviour)", () => {
            detector.watchWorktrees([worktreeA(), worktreeB(), worktreeC()]);
            touch(wtA, "src/api/auth.ts");
            touch(wtB, "src/api/auth.ts");
            touch(wtC, "src/api/auth.ts");
            vi.advanceTimersByTime(DEBOUNCE_MS);

            detector.watchWorktrees([worktreeA(), worktreeB()]);

            const [overlap] = detector.getOverlaps();
            expect(overlap.filePath).toBe("src/api/auth.ts");
            expect(sortedPaths(overlap)).toEqual([wtA, wtB, wtC].sort());
        });

        // CURRENT BEHAVIOUR, arguably a bug: removing overlaps by pruning
        // does not fire onDidChangeOverlaps, so listeners such as the
        // dashboard are not told (overlap-detector.ts:107-175 never fires).
        it("does not fire onDidChangeOverlaps when pruning removes an overlap (documents current behaviour)", () => {
            detector.watchWorktrees([worktreeA(), worktreeB()]);
            overlapFor("src/api/auth.ts");
            const before = changeEvents;

            detector.watchWorktrees([worktreeA(), worktreeC()]);

            expect(detector.getOverlaps()).toEqual([]);
            expect(changeEvents).toBe(before);
        });

        // CURRENT BEHAVIOUR: re-watching clears the debounce timers, so an
        // edit still inside its debounce window is never recorded
        // (disposeWatchers, overlap-detector.ts:399-402).
        it("drops edits still waiting in the debounce window when it re-watches (documents current behaviour)", () => {
            detector.watchWorktrees([worktreeA(), worktreeB()]);
            touch(wtA, "src/api/auth.ts");
            touch(wtB, "src/api/auth.ts");

            detector.watchWorktrees([worktreeA(), worktreeB()]);
            vi.advanceTimersByTime(DEBOUNCE_MS * 2);

            expect(detector.getOverlaps()).toEqual([]);
        });
    });

    describe("detecting overlaps from watcher events", () => {
        beforeEach(() => {
            detector.watchWorktrees([worktreeA(), worktreeB(), worktreeC()]);
        });

        it("reports exactly one overlap, naming both worktrees and branches, when two worktrees modify the same file", () => {
            expect(touch(wtA, "src/api/auth.ts")).toBe(1);
            expect(touch(wtB, "src/api/auth.ts")).toBe(1);
            vi.advanceTimersByTime(DEBOUNCE_MS);

            const overlaps = detector.getOverlaps();
            expect(overlaps).toHaveLength(1);
            expect(overlaps[0].filePath).toBe("src/api/auth.ts");
            expect(overlaps[0].worktrees).toEqual([
                { path: wtA, branch: "feature/a" },
                { path: wtB, branch: "feature/b" },
            ]);
            expect(overlaps[0].dismissed).toBe(false);
            expect(overlaps[0].detectedAt).toBe("2026-01-01T00:00:00.500Z");

            expect(detected).toHaveLength(1);
            expect(detected[0].filePath).toBe("src/api/auth.ts");
            expect(detector.activeOverlapCount).toBe(1);
            expect(detector.getOverlapAlerts()).toEqual([
                {
                    filePath: "src/api/auth.ts",
                    severity: "conflict",
                    branches: ["feature/a", "feature/b"],
                    detectedAt: "2026-01-01T00:00:00.500Z",
                    dismissed: false,
                },
            ]);
        });

        it("reports no overlap for a file modified in only one worktree, however often", () => {
            touch(wtA, "src/api/auth.ts");
            vi.advanceTimersByTime(DEBOUNCE_MS);
            touch(wtA, "src/api/auth.ts");
            touch(wtA, "src/api/auth.ts", "delete");
            vi.advanceTimersByTime(DEBOUNCE_MS);
            touch(wtB, "src/ui/header.tsx");
            vi.advanceTimersByTime(DEBOUNCE_MS);

            expect(detector.getOverlaps()).toEqual([]);
            expect(detector.activeOverlapCount).toBe(0);
            expect(detected).toEqual([]);
            expect(changeEvents).toBe(0);
            expect(stub.messages).toEqual([]);
        });

        it("counts create and delete events as modifications", () => {
            touch(wtA, "src/api/new-endpoint.ts", "create");
            touch(wtB, "src/api/new-endpoint.ts", "delete");
            vi.advanceTimersByTime(DEBOUNCE_MS);

            expect(detector.getOverlaps().map((o) => o.filePath)).toEqual(["src/api/new-endpoint.ts"]);
        });

        it("fires onDidDetectOverlap once per file; a third worktree joining updates the overlap and fires onDidChangeOverlaps", () => {
            touch(wtA, "src/api/auth.ts");
            touch(wtB, "src/api/auth.ts");
            vi.advanceTimersByTime(DEBOUNCE_MS);
            expect(detected).toHaveLength(1);
            expect(changeEvents).toBe(1);

            touch(wtC, "src/api/auth.ts");
            vi.advanceTimersByTime(DEBOUNCE_MS);

            expect(detected).toHaveLength(1);
            expect(changeEvents).toBe(2);
            const overlaps = detector.getOverlaps();
            expect(overlaps).toHaveLength(1);
            expect(sortedBranches(overlaps[0])).toEqual(["feature/a", "feature/b", "feature/c"]);
            // The first detection time is kept.
            expect(overlaps[0].detectedAt).toBe("2026-01-01T00:00:00.500Z");
        });

        it("shows a warning notification naming the file and branches for a new overlap", () => {
            touch(wtA, "src/api/auth.ts");
            touch(wtB, "src/api/auth.ts");
            vi.advanceTimersByTime(DEBOUNCE_MS);

            expect(stub.messages).toEqual([
                {
                    level: "warning",
                    message: "File overlap detected: src/api/auth.ts modified in feature/a, feature/b",
                    items: ["View Overlaps", "Dismiss"],
                },
            ]);
        });

        it("does not notify again when the same overlap is touched again", () => {
            overlapFor("src/api/auth.ts");
            overlapFor("src/api/auth.ts");

            expect(stub.messages).toHaveLength(1);
        });

        it("dismisses the overlap when the notification's Dismiss button is chosen", async () => {
            stub.messageResponses.push("Dismiss");
            touch(wtA, "src/api/auth.ts");
            touch(wtB, "src/api/auth.ts");
            vi.advanceTimersByTime(DEBOUNCE_MS);
            await flushMicrotasks();

            expect(detector.getOverlaps()[0].dismissed).toBe(true);
            expect(detector.activeOverlapCount).toBe(0);
            expect(stub.executedCommands).toEqual([]);
        });

        it("opens the dashboard when the notification's View Overlaps button is chosen", async () => {
            stub.messageResponses.push("View Overlaps");
            touch(wtA, "src/api/auth.ts");
            touch(wtB, "src/api/auth.ts");
            vi.advanceTimersByTime(DEBOUNCE_MS);
            await flushMicrotasks();

            expect(stub.executedCommands).toEqual([{ command: "grove.openDashboard", args: [] }]);
            expect(detector.getOverlaps()[0].dismissed).toBe(false);
        });

        it("leaves the overlap alone when the notification is closed without a choice", async () => {
            touch(wtA, "src/api/auth.ts");
            touch(wtB, "src/api/auth.ts");
            vi.advanceTimersByTime(DEBOUNCE_MS);
            await flushMicrotasks();

            expect(detector.activeOverlapCount).toBe(1);
            expect(stub.executedCommands).toEqual([]);
        });
    });

    describe("severity comes from the file path, not from comparing the changes", () => {
        beforeEach(() => {
            detector.watchWorktrees([worktreeA(), worktreeB()]);
        });

        it.each([
            "package.json",
            "package-lock.json",
            "tsconfig.json",
            "Dockerfile",
            ".env.local",
            "config/tsconfig.json",
        ])("rates the shared config file %s as info, by base name", (file) => {
            expect(overlapFor(file)?.severity).toBe("info");
        });

        it.each([
            "src/types/user.ts",
            "src/index.ts",
            "lib/index.js",
            "src/global.d.ts",
        ])("rates the types/index/declaration file %s as warning", (file) => {
            expect(overlapFor(file)?.severity).toBe("warning");
        });

        it.each([
            "src/api/auth.ts",
            "src/components/Header.tsx",
            "test/auth.test.ts",
            "README.md",
        ])("rates the ordinary file %s as conflict", (file) => {
            expect(overlapFor(file)?.severity).toBe("conflict");
        });

        // CURRENT BEHAVIOUR: the warning rule is a plain substring test
        // (overlap-detector.ts:368-372), so any path that merely contains
        // "types" or "index." is rated warning rather than conflict.
        it.each([
            "src/prototypes/carousel.ts",
            "src/search/reindex.ts",
        ])("rates %s as warning because of a substring match (documents current behaviour)", (file) => {
            expect(overlapFor(file)?.severity).toBe("warning");
        });

        it("does not raise a notification for an info overlap", () => {
            overlapFor("package.json");

            expect(detector.getOverlaps()).toHaveLength(1);
            expect(detected).toHaveLength(1);
            expect(stub.messages).toEqual([]);
        });

        it("raises a notification for warning and conflict overlaps", () => {
            overlapFor("src/types/user.ts");
            overlapFor("src/api/auth.ts");

            expect(stub.messages.map((m) => m.message)).toEqual([
                "File overlap detected: src/types/user.ts modified in feature/a, feature/b",
                "File overlap detected: src/api/auth.ts modified in feature/a, feature/b",
            ]);
        });

        it("orders overlaps conflict, then warning, then info, newest first within a severity", () => {
            overlapFor("package.json");
            vi.advanceTimersByTime(1000);
            overlapFor("src/old.ts");
            vi.advanceTimersByTime(1000);
            overlapFor("src/types/user.ts");
            vi.advanceTimersByTime(1000);
            overlapFor("src/new.ts");

            expect(detector.getOverlaps().map((o) => [o.severity, o.filePath])).toEqual([
                ["conflict", "src/new.ts"],
                ["conflict", "src/old.ts"],
                ["warning", "src/types/user.ts"],
                ["info", "package.json"],
            ]);
        });
    });

    describe("noise filtering", () => {
        beforeEach(() => {
            detector.watchWorktrees([worktreeA(), worktreeB()]);
        });

        it.each([
            ".git/index",
            ".git/refs/heads/main",
            "node_modules/lodash/index.js",
            "src/node_modules/local-dep/index.js",
            "src/__pycache__/module.cpython-312.pyc",
        ])("ignores %s before debouncing", (file) => {
            expect(touch(wtA, file)).toBe(1);
            expect(touch(wtB, file)).toBe(1);
            expect(vi.getTimerCount()).toBe(0);

            vi.advanceTimersByTime(DEBOUNCE_MS);
            expect(detector.getOverlaps()).toEqual([]);
        });

        // CURRENT BEHAVIOUR, arguably a bug: the noise check is
        // `relativePath.startsWith(".git")` (overlap-detector.ts:293), which
        // also swallows .gitignore (listed in SHARED_CONFIG_FILES) and
        // anything under .github/, so the watchers never report them.
        it.each([
            ".gitignore",
            ".gitattributes",
            ".github/workflows/ci.yml",
        ])("also ignores %s because of the '.git' prefix check (documents current behaviour)", (file) => {
            touch(wtA, file);
            touch(wtB, file);
            vi.advanceTimersByTime(DEBOUNCE_MS);

            expect(detector.getOverlaps()).toEqual([]);
        });
    });

    describe("debouncing", () => {
        beforeEach(() => {
            detector.watchWorktrees([worktreeA(), worktreeB()]);
        });

        it("does not record a change until the debounce interval has passed", () => {
            touch(wtA, "src/api/auth.ts");
            touch(wtB, "src/api/auth.ts");

            vi.advanceTimersByTime(DEBOUNCE_MS - 1);
            expect(detector.getOverlaps()).toEqual([]);
            expect(detected).toEqual([]);

            vi.advanceTimersByTime(1);
            expect(detector.getOverlaps()).toHaveLength(1);
        });

        it("restarts the window on each event for the same file in the same worktree", () => {
            touch(wtA, "src/api/auth.ts"); // A due at 500
            touch(wtB, "src/api/auth.ts"); // B due at 500
            vi.advanceTimersByTime(400);
            touch(wtA, "src/api/auth.ts"); // A pushed back to 900

            vi.advanceTimersByTime(100); // t = 500: only B recorded
            expect(detector.getOverlaps()).toEqual([]);

            vi.advanceTimersByTime(399); // t = 899
            expect(detector.getOverlaps()).toEqual([]);

            vi.advanceTimersByTime(1); // t = 900: A recorded too
            expect(detector.getOverlaps()).toHaveLength(1);
        });

        it("keeps a separate timer per file per worktree", () => {
            touch(wtA, "src/a.ts");
            touch(wtA, "src/b.ts");
            touch(wtB, "src/a.ts");
            touch(wtB, "src/b.ts");

            expect(vi.getTimerCount()).toBe(4);
            vi.advanceTimersByTime(DEBOUNCE_MS);
            expect(detector.getOverlaps().map((o) => o.filePath).sort()).toEqual(["src/a.ts", "src/b.ts"]);
        });

        it("uses the interval passed to the constructor", () => {
            const fast = new OverlapDetector(50);
            try {
                fast.watchWorktrees([worktreeA(), worktreeB()]);
                touch(wtA, "src/api/auth.ts");
                touch(wtB, "src/api/auth.ts");

                vi.advanceTimersByTime(49);
                expect(fast.getOverlaps()).toEqual([]);
                vi.advanceTimersByTime(1);
                expect(fast.getOverlaps()).toHaveLength(1);
            } finally {
                fast.dispose();
            }
        });

        it("defaults to a 500 ms interval", () => {
            const byDefault = new OverlapDetector();
            try {
                byDefault.watchWorktrees([worktreeA(), worktreeB()]);
                touch(wtA, "src/api/auth.ts");
                touch(wtB, "src/api/auth.ts");

                vi.advanceTimersByTime(499);
                expect(byDefault.getOverlaps()).toEqual([]);
                vi.advanceTimersByTime(1);
                expect(byDefault.getOverlaps()).toHaveLength(1);
            } finally {
                byDefault.dispose();
            }
        });
    });

    describe("dismissing and resetting", () => {
        beforeEach(() => {
            detector.watchWorktrees([worktreeA(), worktreeB(), worktreeC()]);
            overlapFor("src/api/auth.ts");
            overlapFor("src/ui/header.tsx");
            changeEvents = 0;
        });

        it("dismissOverlap marks only that overlap dismissed and fires onDidChangeOverlaps", () => {
            detector.dismissOverlap("src/api/auth.ts");

            const byPath = new Map(detector.getOverlaps().map((o) => [o.filePath, o]));
            expect(byPath.get("src/api/auth.ts")?.dismissed).toBe(true);
            expect(byPath.get("src/ui/header.tsx")?.dismissed).toBe(false);
            expect(detector.activeOverlapCount).toBe(1);
            expect(detector.getOverlaps()).toHaveLength(2);
            expect(changeEvents).toBe(1);
        });

        it("dismissOverlap on an unknown path changes nothing and fires nothing", () => {
            detector.dismissOverlap("src/not-overlapping.ts");

            expect(detector.activeOverlapCount).toBe(2);
            expect(changeEvents).toBe(0);
        });

        it("dismissAll dismisses every overlap and fires onDidChangeOverlaps once", () => {
            detector.dismissAll();

            expect(detector.activeOverlapCount).toBe(0);
            expect(detector.getOverlapAlerts().every((a) => a.dismissed)).toBe(true);
            expect(changeEvents).toBe(1);
        });

        it("keeps a dismissed overlap dismissed when another worktree touches the file", () => {
            detector.dismissOverlap("src/api/auth.ts");

            touch(wtC, "src/api/auth.ts");
            vi.advanceTimersByTime(DEBOUNCE_MS);

            const overlap = detector.getOverlaps().find((o) => o.filePath === "src/api/auth.ts");
            expect(overlap?.dismissed).toBe(true);
            expect(overlap && sortedBranches(overlap)).toEqual(["feature/a", "feature/b", "feature/c"]);
            expect(detector.activeOverlapCount).toBe(1);
        });

        it("reset clears all overlaps, disposes the watchers and fires onDidChangeOverlaps", () => {
            detector.reset();

            expect(detector.getOverlaps()).toEqual([]);
            expect(detector.activeOverlapCount).toBe(0);
            expect(stub.activeWatchers()).toEqual([]);
            expect(changeEvents).toBe(1);
        });

        it("forgets earlier modifications after reset, so one new edit does not recreate an overlap", () => {
            detector.reset();
            detector.watchWorktrees([worktreeA(), worktreeB()]);

            touch(wtA, "src/api/auth.ts");
            vi.advanceTimersByTime(DEBOUNCE_MS);

            expect(detector.getOverlaps()).toEqual([]);
        });
    });

    describe("dispose", () => {
        it("disposes every watcher it created", () => {
            detector.watchWorktrees([worktreeA(), worktreeB(), worktreeC()]);
            expect(stub.activeWatchers()).toHaveLength(3);

            detector.dispose();

            expect(stub.watchers).toHaveLength(3);
            expect(stub.watchers.every((w) => w.disposed)).toBe(true);
        });

        it("cancels changes still waiting in the debounce window", () => {
            detector.watchWorktrees([worktreeA(), worktreeB()]);
            touch(wtA, "src/api/auth.ts");
            touch(wtB, "src/api/auth.ts");
            expect(vi.getTimerCount()).toBe(2);

            detector.dispose();

            expect(vi.getTimerCount()).toBe(0);
            vi.advanceTimersByTime(DEBOUNCE_MS);
            expect(detector.getOverlaps()).toEqual([]);
            expect(detected).toEqual([]);
        });

        it("disposes both of its event emitters", () => {
            const emittersBefore = stub.emitters.length;
            const fresh = new OverlapDetector();
            const own = stub.emitters.slice(emittersBefore);
            expect(own).toHaveLength(2);
            expect(own.some((e) => e.disposed)).toBe(false);

            fresh.dispose();

            expect(own.every((e) => e.disposed)).toBe(true);
        });
    });
});

// ────────────────────────────────────────────
// scanExistingChanges against real git worktrees
// ────────────────────────────────────────────

describe("OverlapDetector.scanExistingChanges (real git worktrees)", () => {
    const ISOLATED_ENV: Record<string, string> = {
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        // Stop repository discovery at the temp dir, so the "not a repo"
        // folder cannot pick up some repository further up the tree.
        GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()),
    };
    // Also unset anything that would point git at another repository.
    const UNSET_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"];
    const savedEnv = new Map<string, string | undefined>();

    let root: string;
    let repo: string;
    let wtA: string;
    let wtB: string;
    let notARepo: string;
    let detector: OverlapDetector;

    function run(cwd: string, ...args: string[]): string {
        return execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
    }

    function write(dir: string, relPath: string, content: string): void {
        const full = path.join(dir, relPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }

    function commitAll(dir: string, message: string): void {
        run(dir, "add", "-A");
        run(dir, "commit", "-q", "-m", message);
    }

    beforeAll(() => {
        for (const key of [...Object.keys(ISOLATED_ENV), ...UNSET_ENV]) {
            savedEnv.set(key, process.env[key]);
        }
        for (const [key, value] of Object.entries(ISOLATED_ENV)) process.env[key] = value;
        for (const key of UNSET_ENV) delete process.env[key];

        root = fs.mkdtempSync(path.join(os.tmpdir(), "grove-overlap-git-"));
        repo = path.join(root, "repo");
        wtA = path.join(root, "wt-a");
        wtB = path.join(root, "wt-b");
        notARepo = path.join(root, "not-a-repo");
        fs.mkdirSync(repo);
        fs.mkdirSync(notARepo);

        run(repo, "init", "-q", "-b", "main");
        run(repo, "config", "user.name", "Grove Test");
        run(repo, "config", "user.email", "grove-test@example.invalid");
        run(repo, "config", "commit.gpgsign", "false");

        write(repo, "package.json", '{ "name": "fixture" }\n');
        write(repo, "README.md", "# fixture\n");
        write(repo, "src/shared.ts", "export const shared = 1;\n");
        write(repo, "src/untouched.ts", "export const untouched = 1;\n");
        commitAll(repo, "base");

        run(repo, "worktree", "add", "-q", "-b", "feature/a", wtA, "main");
        run(repo, "worktree", "add", "-q", "-b", "feature/b", wtB, "main");

        write(wtA, "package.json", '{ "name": "fixture", "version": "1.0.0-a" }\n');
        write(wtA, "src/shared.ts", "export const shared = 'a';\n");
        write(wtA, "src/only-a.ts", "export const a = 1;\n");
        commitAll(wtA, "work on a");

        write(wtB, "package.json", '{ "name": "fixture", "version": "1.0.0-b" }\n');
        write(wtB, "src/shared.ts", "export const shared = 'b';\n");
        write(wtB, "src/only-b.ts", "export const b = 1;\n");
        commitAll(wtB, "work on b");

        // Uncommitted edits to the same file in both worktrees.
        write(wtA, "README.md", "# edited in a\n");
        write(wtB, "README.md", "# edited in b\n");
    }, 60_000);

    afterAll(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
        for (const [key, value] of savedEnv) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    beforeEach(() => {
        stub.reset();
        vi.mocked(log).mockClear();
        detector = new OverlapDetector();
    });

    afterEach(() => {
        detector.dispose();
        vi.useRealTimers();
    });

    const worktrees = () => [
        { path: wtA, branch: "feature/a" },
        { path: wtB, branch: "feature/b" },
    ];

    it("reports files committed on both branches, and not files changed on one branch only", async () => {
        detector.watchWorktrees(worktrees());

        await detector.scanExistingChanges(worktrees(), "main");

        const overlaps = detector.getOverlaps();
        expect(overlaps.map((o) => [o.severity, o.filePath])).toEqual([
            ["conflict", "src/shared.ts"],
            ["info", "package.json"],
        ]);
        for (const overlap of overlaps) {
            expect(sortedBranches(overlap)).toEqual(["feature/a", "feature/b"]);
            expect(sortedPaths(overlap)).toEqual([wtA, wtB].sort());
        }
    });

    it("does not see uncommitted edits, because it diffs base...HEAD", async () => {
        await detector.scanExistingChanges(worktrees(), "main");

        expect(detector.getOverlaps().map((o) => o.filePath)).not.toContain("README.md");
    });

    it("announces results through onDidChangeOverlaps only, with no onDidDetectOverlap event or notification", async () => {
        let changes = 0;
        const detected: FileOverlap[] = [];
        detector.onDidChangeOverlaps(() => changes++);
        detector.onDidDetectOverlap((o) => detected.push(o));

        await detector.scanExistingChanges(worktrees(), "main");

        expect(changes).toBe(1);
        expect(detected).toEqual([]);
        expect(stub.messages).toEqual([]);
    });

    // CURRENT BEHAVIOUR, arguably a bug: createOverlap looks branch names up
    // in the map that only watchWorktrees fills (overlap-detector.ts:359),
    // so the `branch` values passed to scanExistingChanges are ignored and
    // the worktree folder name is shown instead.
    it("labels worktrees by folder name, not the branch it was given, unless watchWorktrees ran first (documents current behaviour)", async () => {
        await detector.scanExistingChanges(worktrees(), "main");

        const shared = detector.getOverlaps().find((o) => o.filePath === "src/shared.ts");
        expect(shared && sortedBranches(shared)).toEqual(["wt-a", "wt-b"]);
    });

    it("merges with changes the file watcher has already recorded", async () => {
        vi.useFakeTimers();
        detector.watchWorktrees(worktrees());
        // Only feature/b commits src/only-b.ts; worktree A edits it live.
        stub.fireFileEvent("change", path.join(wtA, "src/only-b.ts"));
        vi.advanceTimersByTime(500);
        vi.useRealTimers();
        expect(detector.getOverlaps()).toEqual([]);

        await detector.scanExistingChanges(worktrees(), "main");

        const onlyB = detector.getOverlaps().find((o) => o.filePath === "src/only-b.ts");
        expect(onlyB).toBeDefined();
        expect(onlyB && sortedBranches(onlyB)).toEqual(["feature/a", "feature/b"]);
    });

    it("logs and skips a worktree whose git diff fails, and still scans the rest", async () => {
        const worktreesWithBadOne = [
            ...worktrees(),
            { path: notARepo, branch: "feature/broken" },
        ];
        // notARepo sits outside any repository, so git diff fails there.
        await expect(
            detector.scanExistingChanges(worktreesWithBadOne, "main")
        ).resolves.toBeUndefined();

        expect(detector.getOverlaps().map((o) => o.filePath).sort()).toEqual(["package.json", "src/shared.ts"]);
        const messages = vi.mocked(log).mock.calls.map(([m]) => m);
        expect(messages.some((m) => m.startsWith(`Overlap scan skipped for ${notARepo}:`))).toBe(true);
    });

    it("finds nothing and fires nothing when the base branch does not exist", async () => {
        let changes = 0;
        detector.onDidChangeOverlaps(() => changes++);

        await detector.scanExistingChanges(worktrees(), "no-such-branch");

        expect(detector.getOverlaps()).toEqual([]);
        expect(changes).toBe(0);
        expect(vi.mocked(log)).toHaveBeenCalledTimes(2);
    });
});
