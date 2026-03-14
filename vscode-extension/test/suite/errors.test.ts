/**
 * Tests for utils/errors.ts — custom error types with fix suggestions.
 */

import * as assert from "assert";
import {
    WorktreePilotError,
    BranchAlreadyCheckedOutError,
    WorktreePathExistsError,
} from "../../src/utils/errors";

describe("WorktreePilotError", () => {
    it("sets message and fix", () => {
        const err = new WorktreePilotError("something failed", "try this fix");
        assert.strictEqual(err.message, "something failed");
        assert.strictEqual(err.fix, "try this fix");
    });

    it("sets name to WorktreePilotError", () => {
        const err = new WorktreePilotError("msg", "fix");
        assert.strictEqual(err.name, "WorktreePilotError");
    });

    it("stores original error when provided", () => {
        const original = new Error("original");
        const err = new WorktreePilotError("msg", "fix", original);
        assert.strictEqual(err.originalError, original);
    });

    it("originalError is undefined when not provided", () => {
        const err = new WorktreePilotError("msg", "fix");
        assert.strictEqual(err.originalError, undefined);
    });

    it("is an instance of Error", () => {
        const err = new WorktreePilotError("msg", "fix");
        assert.ok(err instanceof Error);
    });
});

describe("BranchAlreadyCheckedOutError", () => {
    it("includes branch name in message", () => {
        const err = new BranchAlreadyCheckedOutError("feature/auth");
        assert.ok(err.message.includes("feature/auth"));
    });

    it("suggests using different branch or removing worktree", () => {
        const err = new BranchAlreadyCheckedOutError("feature/auth");
        assert.ok(err.fix.includes("different branch"));
    });

    it("has correct name", () => {
        const err = new BranchAlreadyCheckedOutError("x");
        assert.strictEqual(err.name, "BranchAlreadyCheckedOutError");
    });
});

describe("WorktreePathExistsError", () => {
    it("includes path in message", () => {
        const err = new WorktreePathExistsError("/tmp/wt");
        assert.ok(err.message.includes("/tmp/wt"));
    });

    it("suggests cleanup in fix", () => {
        const err = new WorktreePathExistsError("/tmp/wt");
        assert.ok(err.fix.toLowerCase().includes("cleanup"));
    });

    it("has correct name", () => {
        const err = new WorktreePathExistsError("/x");
        assert.strictEqual(err.name, "WorktreePathExistsError");
    });
});
