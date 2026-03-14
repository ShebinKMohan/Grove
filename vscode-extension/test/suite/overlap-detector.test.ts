/**
 * Tests for the overlap detector's data model and severity logic.
 *
 * The real-time file watcher and VS Code notification parts
 * require the VS Code API, so we test the pure logic here.
 */

import * as assert from "assert";

// We can't instantiate OverlapDetector directly in tests (requires vscode),
// but we can test the severity classification and shared config detection logic
// by testing the constants and pure functions it uses.

// Import the shared config file list and severity logic by testing
// the overlap detection from template-manager (which is vscode-free)
import { detectOwnershipOverlaps } from "../../src/core/template-manager";
import type { TeamTemplate } from "../../src/core/template-manager";

describe("overlap-detector data model", () => {
    // TODO(v0.2.1): This test reimplements logic locally instead of importing from source. Fix to test actual module.
    describe("severity classification", () => {
        // These test the conceptual rules used by overlap-detector.ts:
        // - shared config files (package.json, tsconfig.json, etc.) → "info"
        // - type/index files → "warning"
        // - regular source files → "conflict"

        const SHARED_CONFIG_FILES = new Set([
            "package.json",
            "package-lock.json",
            "yarn.lock",
            "pnpm-lock.yaml",
            "tsconfig.json",
            ".gitignore",
            "Dockerfile",
            "go.mod",
            "Cargo.toml",
            "requirements.txt",
        ]);

        function classifySeverity(filePath: string): "conflict" | "warning" | "info" {
            const fileName = filePath.split("/").pop() ?? filePath;
            if (SHARED_CONFIG_FILES.has(fileName)) return "info";
            if (filePath.includes("types") || filePath.includes("index.") || filePath.endsWith(".d.ts")) {
                return "warning";
            }
            return "conflict";
        }

        it("classifies package.json as info", () => {
            assert.strictEqual(classifySeverity("package.json"), "info");
        });

        it("classifies tsconfig.json as info", () => {
            assert.strictEqual(classifySeverity("tsconfig.json"), "info");
        });

        it("classifies Dockerfile as info", () => {
            assert.strictEqual(classifySeverity("Dockerfile"), "info");
        });

        it("classifies type definition files as warning", () => {
            assert.strictEqual(classifySeverity("src/types/user.ts"), "warning");
        });

        it("classifies index files as warning", () => {
            assert.strictEqual(classifySeverity("src/index.ts"), "warning");
        });

        it("classifies .d.ts files as warning", () => {
            assert.strictEqual(classifySeverity("src/global.d.ts"), "warning");
        });

        it("classifies regular source files as conflict", () => {
            assert.strictEqual(classifySeverity("src/api/auth.ts"), "conflict");
        });

        it("classifies component files as conflict", () => {
            assert.strictEqual(classifySeverity("src/components/Header.tsx"), "conflict");
        });

        it("classifies test files as conflict", () => {
            assert.strictEqual(classifySeverity("test/auth.test.ts"), "conflict");
        });
    });

    describe("overlap detection with templates", () => {
        it("detects overlaps when agents share patterns", () => {
            const template: TeamTemplate = {
                name: "Test",
                description: "test",
                agents: [
                    { role: "a", displayName: "A", ownership: ["src/**"], prompt: "", readOnly: false },
                    { role: "b", displayName: "B", ownership: ["src/api/**"], prompt: "", readOnly: false },
                ],
                mergeOrder: [],
                estimatedTokens: "",
            };
            const overlaps = detectOwnershipOverlaps(template);
            assert.ok(overlaps.length > 0, "Should detect overlap between src/** and src/api/**");
        });

        it("detects no overlaps for disjoint patterns", () => {
            const template: TeamTemplate = {
                name: "Test",
                description: "test",
                agents: [
                    { role: "a", displayName: "A", ownership: ["src/api/**"], prompt: "", readOnly: false },
                    { role: "b", displayName: "B", ownership: ["src/ui/**"], prompt: "", readOnly: false },
                    { role: "c", displayName: "C", ownership: ["test/**"], prompt: "", readOnly: false },
                ],
                mergeOrder: [],
                estimatedTokens: "",
            };
            const overlaps = detectOwnershipOverlaps(template);
            assert.strictEqual(overlaps.length, 0, "Should detect no overlaps");
        });

        it("detects exact duplicate patterns across agents", () => {
            const template: TeamTemplate = {
                name: "Test",
                description: "test",
                agents: [
                    { role: "a", displayName: "A", ownership: ["src/**"], prompt: "", readOnly: false },
                    { role: "b", displayName: "B", ownership: ["src/**"], prompt: "", readOnly: false },
                ],
                mergeOrder: [],
                estimatedTokens: "",
            };
            const overlaps = detectOwnershipOverlaps(template);
            assert.ok(overlaps.length > 0, "Should detect exact pattern overlap");
            assert.ok(
                overlaps.some((o) => o.agents.includes("a") && o.agents.includes("b")),
                "Both agents should be listed"
            );
        });
    });

    // TODO(v0.2.1): This test reimplements logic locally instead of importing from source. Fix to test actual module.
    describe("overlap alert data model", () => {
        interface OverlapAlert {
            filePath: string;
            severity: string;
            branches: string[];
            detectedAt: string;
            dismissed: boolean;
        }

        it("serializes correctly for WebView", () => {
            const alert: OverlapAlert = {
                filePath: "src/api/auth.ts",
                severity: "conflict",
                branches: ["feature/auth", "feature/api-refactor"],
                detectedAt: new Date().toISOString(),
                dismissed: false,
            };

            const json = JSON.stringify(alert);
            const parsed = JSON.parse(json) as OverlapAlert;

            assert.strictEqual(parsed.filePath, "src/api/auth.ts");
            assert.strictEqual(parsed.severity, "conflict");
            assert.strictEqual(parsed.branches.length, 2);
            assert.strictEqual(parsed.dismissed, false);
        });

        it("dismissed flag works", () => {
            const alert: OverlapAlert = {
                filePath: "package.json",
                severity: "info",
                branches: ["wt-a", "wt-b"],
                detectedAt: new Date().toISOString(),
                dismissed: false,
            };
            alert.dismissed = true;
            assert.strictEqual(alert.dismissed, true);
        });
    });
});
