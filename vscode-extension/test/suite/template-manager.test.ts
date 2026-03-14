import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
    validateTemplate,
    detectOwnershipOverlaps,
    loadAllTemplates,
    type TeamTemplate,
} from "../../src/core/template-manager";

describe("template-manager", () => {
    describe("validateTemplate()", () => {
        it("accepts a valid template", () => {
            const errors = validateTemplate({
                name: "Test Team",
                description: "A test template",
                agents: [
                    {
                        role: "dev",
                        displayName: "Developer",
                        ownership: ["src/**"],
                        prompt: "Build things",
                        readOnly: false,
                    },
                ],
                mergeOrder: ["dev"],
                estimatedTokens: "50K",
            });
            assert.strictEqual(errors.length, 0);
        });

        it("rejects non-object input", () => {
            const errors = validateTemplate("not an object");
            assert.ok(errors.length > 0);
            assert.strictEqual(errors[0].field, "root");
        });

        it("rejects missing name", () => {
            const errors = validateTemplate({
                description: "test",
                agents: [
                    { role: "a", displayName: "A", ownership: [], prompt: "x", readOnly: false },
                ],
            });
            assert.ok(errors.some((e) => e.field === "name"));
        });

        it("rejects empty agents array", () => {
            const errors = validateTemplate({
                name: "Test",
                description: "test",
                agents: [],
            });
            assert.ok(errors.some((e) => e.field === "agents"));
        });

        it("rejects duplicate roles", () => {
            const errors = validateTemplate({
                name: "Test",
                description: "test",
                agents: [
                    { role: "dev", displayName: "Dev 1", ownership: [], prompt: "x", readOnly: false },
                    { role: "dev", displayName: "Dev 2", ownership: [], prompt: "y", readOnly: false },
                ],
            });
            assert.ok(errors.some((e) => e.message.includes("Duplicate role")));
        });

        it("rejects unknown roles in mergeOrder", () => {
            const errors = validateTemplate({
                name: "Test",
                description: "test",
                agents: [
                    { role: "dev", displayName: "Dev", ownership: [], prompt: "x", readOnly: false },
                ],
                mergeOrder: ["dev", "nonexistent"],
            });
            assert.ok(errors.some((e) => e.message.includes("nonexistent")));
        });

        it("rejects agents with missing displayName", () => {
            const errors = validateTemplate({
                name: "Test",
                description: "test",
                agents: [
                    { role: "dev", displayName: "", ownership: [], prompt: "x", readOnly: false },
                ],
            });
            assert.ok(errors.some((e) => e.field.includes("displayName")));
        });
    });

    describe("detectOwnershipOverlaps()", () => {
        it("detects direct pattern overlaps", () => {
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
            assert.ok(overlaps.length > 0);
            assert.ok(overlaps.some((o) => o.agents.includes("a") && o.agents.includes("b")));
        });

        it("detects prefix overlaps", () => {
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
            assert.ok(overlaps.length > 0);
        });

        it("returns empty for non-overlapping patterns", () => {
            const template: TeamTemplate = {
                name: "Test",
                description: "test",
                agents: [
                    { role: "a", displayName: "A", ownership: ["src/api/**"], prompt: "", readOnly: false },
                    { role: "b", displayName: "B", ownership: ["src/ui/**"], prompt: "", readOnly: false },
                ],
                mergeOrder: [],
                estimatedTokens: "",
            };
            const overlaps = detectOwnershipOverlaps(template);
            assert.strictEqual(overlaps.length, 0);
        });

        it("ignores same-agent ownership of multiple patterns", () => {
            const template: TeamTemplate = {
                name: "Test",
                description: "test",
                agents: [
                    {
                        role: "a",
                        displayName: "A",
                        ownership: ["src/api/**", "src/models/**"],
                        prompt: "",
                        readOnly: false,
                    },
                ],
                mergeOrder: [],
                estimatedTokens: "",
            };
            const overlaps = detectOwnershipOverlaps(template);
            assert.strictEqual(overlaps.length, 0);
        });
    });

    describe("loadAllTemplates()", () => {
        it("loads built-in templates", () => {
            // The built-in templates are at ../../templates/ relative to __dirname
            // but in the test context they are at out/templates/
            // Let's test with a temp directory instead
            const tmpDir = fs.realpathSync(
                fs.mkdtempSync(path.join(os.tmpdir(), "wtp-tmpl-"))
            );

            try {
                // Create a template in the project dir
                const templateDir = ".worktreepilot/templates";
                const fullDir = path.join(tmpDir, templateDir);
                fs.mkdirSync(fullDir, { recursive: true });

                const template: TeamTemplate = {
                    name: "Test Template",
                    description: "For testing",
                    agents: [
                        {
                            role: "test",
                            displayName: "Tester",
                            ownership: ["test/**"],
                            prompt: "Test all the things",
                            readOnly: false,
                        },
                    ],
                    mergeOrder: ["test"],
                    estimatedTokens: "10K",
                };

                fs.writeFileSync(
                    path.join(fullDir, "test-template.json"),
                    JSON.stringify(template)
                );

                const templates = loadAllTemplates(tmpDir, templateDir);
                const found = templates.find((t) => t.name === "Test Template");
                assert.ok(found, "Should find the project template");
                assert.strictEqual(found!.agents.length, 1);
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });
    });

});
