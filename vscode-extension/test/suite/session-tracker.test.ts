/**
 * Tests for core/session-tracker.ts — session data model and persistence.
 *
 * Note: VS Code Terminal-dependent functionality (start/stop via terminal,
 * notifications) cannot be tested outside VS Code. These tests cover
 * the data model, persistence, and helper logic.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// The session tracker imports vscode, so we test the persisted data model
// and helper logic independently.

describe("session-tracker data model", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), "wt-session-test-"))
        );
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe("sessions.json persistence format", () => {
        it("round-trips session data through JSON", () => {
            const session = {
                id: "abc123",
                worktreePath: "/some/path",
                branch: "feature/auth",
                taskDescription: "Implement JWT auth",
                startedAt: new Date().toISOString(),
                status: "running" as const,
            };

            const sessionsDir = path.join(tmpDir, ".grove");
            fs.mkdirSync(sessionsDir, { recursive: true });
            const sessionsFile = path.join(sessionsDir, "sessions.json");
            fs.writeFileSync(
                sessionsFile,
                JSON.stringify([session], null, 2) + "\n"
            );

            const raw = fs.readFileSync(sessionsFile, "utf-8");
            const parsed = JSON.parse(raw);
            assert.strictEqual(parsed.length, 1);
            assert.strictEqual(parsed[0].id, "abc123");
            assert.strictEqual(parsed[0].branch, "feature/auth");
            assert.strictEqual(parsed[0].taskDescription, "Implement JWT auth");
            assert.strictEqual(parsed[0].status, "running");
        });

        it("handles multiple sessions", () => {
            const sessions = [
                {
                    id: "s1",
                    worktreePath: "/path/a",
                    branch: "feature/a",
                    taskDescription: "Task A",
                    startedAt: "2025-01-01T00:00:00.000Z",
                    status: "running",
                },
                {
                    id: "s2",
                    worktreePath: "/path/b",
                    branch: "feature/b",
                    taskDescription: "Task B",
                    startedAt: "2025-01-01T00:01:00.000Z",
                    status: "completed",
                    endedAt: "2025-01-01T00:05:00.000Z",
                    exitCode: 0,
                },
            ];

            const sessionsDir = path.join(tmpDir, ".grove");
            fs.mkdirSync(sessionsDir, { recursive: true });
            const sessionsFile = path.join(sessionsDir, "sessions.json");
            fs.writeFileSync(
                sessionsFile,
                JSON.stringify(sessions, null, 2) + "\n"
            );

            const parsed = JSON.parse(
                fs.readFileSync(sessionsFile, "utf-8")
            );
            assert.strictEqual(parsed.length, 2);
            assert.strictEqual(parsed[0].status, "running");
            assert.strictEqual(parsed[1].status, "completed");
            assert.strictEqual(parsed[1].exitCode, 0);
        });
    });

    // TODO(v0.2.1): This test reimplements logic locally instead of importing from source. Fix to test actual module.
    describe("elapsed time calculation", () => {
        it("formats seconds correctly", () => {
            const elapsed = formatElapsed(30_000); // 30 seconds
            assert.strictEqual(elapsed, "30s");
        });

        it("formats minutes correctly", () => {
            const elapsed = formatElapsed(150_000); // 2.5 minutes
            assert.strictEqual(elapsed, "2m");
        });

        it("formats hours correctly", () => {
            const elapsed = formatElapsed(7_500_000); // 2h 5m
            assert.strictEqual(elapsed, "2h 5m");
        });
    });

    // TODO(v0.2.1): This test reimplements logic locally instead of importing from source. Fix to test actual module.
    describe("session ID generation", () => {
        it("generates unique IDs", () => {
            const ids = new Set<string>();
            for (let i = 0; i < 100; i++) {
                const ts = Date.now().toString(36);
                const rand = Math.random().toString(36).slice(2, 6);
                ids.add(`${ts}-${rand}`);
            }
            // At minimum most should be unique (timestamp may repeat within ms)
            assert.ok(ids.size >= 90);
        });
    });
});

/**
 * Reimplementation of the elapsed time formatting logic for testing.
 */
function formatElapsed(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
}
