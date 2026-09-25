/**
 * Tests for ownership overlaps between agents in a team template
 * (detectOwnershipOverlaps in template-manager, which needs no VS Code API).
 *
 * The real-time OverlapDetector class is tested against the real class in
 * test/unit/overlap-detector.test.ts, with the `vscode` module replaced by
 * test/helpers/vscode-stub.ts. That file runs under vitest only, because
 * the mocha integration runner (test/suite/index.ts) loads this directory.
 */

import * as assert from "assert";

import { detectOwnershipOverlaps } from "../../src/core/template-manager";
import type { TeamTemplate } from "../../src/core/template-manager";

describe("template ownership overlaps (detectOwnershipOverlaps)", () => {
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
});
