/**
 * Merge Sequencer — handles end-of-workflow merge process.
 *
 * Provides:
 * - Merge readiness report generation
 * - Merge order recommendation
 * - Sequential merge execution with test running
 * - Post-merge cleanup
 *
 * No VS Code dependency in the core logic — only the execution
 * flow uses vscode for terminal/notification integration.
 */

import * as fs from "fs";
import * as path from "path";
import { git, gitWrite, getCurrentBranch, GitError } from "../utils/git";
import {
    getChangedFiles,
    getDiffStats,
    removeWorktree,
    listUncommittedChanges,
} from "./worktree-manager";
import {
    discardLegacyGeneratedClaudeMd,
    isGroveGeneratedInstructions,
} from "./claude-md-generator";
import { log, logError } from "../utils/logger";
import { GroveError } from "../utils/errors";

/**
 * Turn a raw git error message into something a user can understand.
 */
function humanizeMergeError(raw: string, branch: string): string {
    if (raw.includes("unrelated histories")) {
        return `Branch '${branch}' has unrelated history. It may have been created from a different repository or orphan branch.`;
    }
    if (raw.includes("not something we can merge")) {
        return `Branch '${branch}' could not be found. Make sure the branch name is correct and exists locally.`;
    }
    if (raw.includes("index.lock") || (raw.includes("Unable to create") && raw.includes(".lock"))) {
        return `Git is locked by another process. Wait a moment and try again, or delete the lock file: rm -f .git/index.lock`;
    }
    if (raw.includes("CONFLICT") || raw.includes("conflict")) {
        return `Merge conflict while merging '${branch}'.`;
    }
    if (raw.includes("not possible because you have unmerged files")) {
        return `There are unresolved conflicts from a previous merge. Resolve them first or run 'git merge --abort'.`;
    }
    if (raw.includes("overwritten by merge")) {
        return `Local changes would be overwritten by merge. Commit or stash your changes first.`;
    }
    if (raw.includes("permission denied") || raw.includes("EACCES")) {
        return `Permission denied. Check file permissions in the repository.`;
    }
    return `Failed to merge '${branch}': ${raw}`;
}

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

export interface WorktreeMergeInfo {
    /** Worktree path */
    path: string;
    /** Branch name */
    branch: string;
    /** Files changed vs base branch */
    changedFiles: string[];
    /** Lines added */
    linesAdded: number;
    /** Lines removed */
    linesRemoved: number;
    /** New files created */
    newFiles: string[];
    /** Diff stat summary */
    diffStat: string;
    /** Reviewer findings (from REVIEW.md if it exists) */
    reviewFindings?: string;
    /** Handoff notes (from HANDOFF.md if it exists) */
    handoffNotes?: string;
    /** Whether the worktree has uncommitted changes */
    hasUncommittedChanges: boolean;
}

interface FileOverlapInfo {
    /** Relative file path */
    filePath: string;
    /** Branches that modified this file */
    branches: string[];
    /** Whether this is likely auto-resolvable */
    likelyAutoResolvable: boolean;
}

export interface ConflictPrediction {
    /** Branch being predicted */
    branch: string;
    /**
     * Files git reports as conflicting when this branch is merged after the
     * branches before it in the recommended order (empty with "file-overlap")
     */
    conflictFiles: string[];
    /** Earlier branches, and the base branch, that also changed those files */
    conflictsWith: string[];
    /** Files modified on both base and branch (potential conflicts) */
    baseOverlapFiles: string[];
    /** "merge-tree" when git merged in memory; "file-overlap" if it could not */
    method: "merge-tree" | "file-overlap";
}

export interface MergeReport {
    /** Timestamp of report generation */
    generatedAt: string;
    /** Base branch to merge into */
    baseBranch: string;
    /** Per-worktree merge info */
    worktrees: WorktreeMergeInfo[];
    /** Files modified in multiple worktrees */
    overlaps: FileOverlapInfo[];
    /** Predicted merge conflicts against the base branch */
    conflictPredictions: ConflictPrediction[];
    /** Recommended merge order */
    mergeOrder: MergeOrderEntry[];
    /** Total files changed across all worktrees */
    totalFilesChanged: number;
    /** Total lines added across all worktrees */
    totalLinesAdded: number;
    /** Total lines removed across all worktrees */
    totalLinesRemoved: number;
}

interface MergeOrderEntry {
    branch: string;
    worktreePath: string;
    reason: string;
}

type MergeStepStatus =
    | "pending"
    | "merging"
    | "testing"
    | "success"
    | "conflict"
    | "test-failed"
    | "skipped"
    | "error";

interface MergeStep {
    branch: string;
    worktreePath: string;
    status: MergeStepStatus;
    message?: string;
    conflictFiles?: string[];
}

// ────────────────────────────────────────────
// Pre-Merge Conflict Prediction
// ────────────────────────────────────────────

/** Result of merging two commits in memory with `git merge-tree`. */
interface MergeTreeResult {
    /** Tree of the merged result (with conflict markers where git conflicted). */
    tree: string;
    /** Paths git reports as conflicted; empty for a clean merge. */
    conflictFiles: string[];
}

/**
 * Merge two commits in memory with `git merge-tree --write-tree` (Git 2.38+).
 * The working tree, index and refs are untouched; git only writes objects.
 * Returns undefined when merge-tree cannot answer (Git older than 2.38,
 * unrelated histories, a missing branch).
 */
async function mergeTree(
    repoRoot: string,
    ours: string,
    theirs: string
): Promise<MergeTreeResult | undefined> {
    let stdout: string;
    try {
        stdout = await git(
            ["merge-tree", "--write-tree", "--name-only", "-z", ours, theirs],
            repoRoot,
            { trim: false }
        );
    } catch (err) {
        // Exit code 1 means the merge has conflicts; the result is on stdout.
        if (err instanceof GitError && err.exitCode === 1) {
            stdout = err.stdout;
        } else {
            return undefined;
        }
    }
    // -z output: <tree>\0<conflicted path>\0...\0\0<messages>
    const fields = stdout.split("\0");
    const conflictFiles: string[] = [];
    for (let i = 1; i < fields.length && fields[i] !== ""; i++) {
        conflictFiles.push(fields[i]);
    }
    return { tree: fields[0].trim(), conflictFiles: [...new Set(conflictFiles)] };
}

/** Files changed on `ref` since it diverged from `base`. */
async function changedSinceMergeBase(
    repoRoot: string,
    base: string,
    ref: string
): Promise<Set<string>> {
    try {
        const mergeBase = (await git(["merge-base", base, ref], repoRoot)).trim();
        const raw = await git(["diff", "--name-only", "-z", mergeBase, ref], repoRoot, { trim: false });
        return new Set(raw.split("\0").filter(Boolean));
    } catch {
        return new Set();
    }
}

export interface SequencePrediction {
    branch: string;
    /** Paths git reports as conflicting for this step; empty if it merges cleanly. */
    conflictFiles: string[];
    /** Earlier branches (and the base branch) that also changed those paths. */
    conflictsWith: string[];
}

/**
 * Predict conflicts for merging `branches` into `baseBranch` one after
 * another, in the given order, without touching the working tree, the
 * index or any ref.
 *
 * Step k merges branch k in memory with the base plus the earlier branches
 * that merged cleanly (each clean step is recorded with `git commit-tree`,
 * which writes an unreferenced commit object). This catches two branches
 * that change the same lines even when the base has not moved. A branch
 * predicted to conflict is left out of the simulated result, because its
 * final content depends on how the conflict is resolved.
 *
 * Returns undefined when `git merge-tree` cannot answer (Git older than
 * 2.38, unrelated histories), so callers can fall back to file-level checks.
 */
export async function predictMergeSequence(
    repoRoot: string,
    branches: string[],
    baseBranch: string
): Promise<SequencePrediction[] | undefined> {
    let current: string;
    try {
        current = (await git(["rev-parse", "--verify", `${baseBranch}^{commit}`], repoRoot)).trim();
    } catch {
        return undefined;
    }

    const merged: string[] = [];
    const predictions: SequencePrediction[] = [];
    for (const branch of branches) {
        let tip: string;
        try {
            tip = (await git(["rev-parse", "--verify", `${branch}^{commit}`], repoRoot)).trim();
        } catch {
            return undefined;
        }

        const result = await mergeTree(repoRoot, current, tip);
        if (!result) return undefined;

        if (result.conflictFiles.length === 0) {
            current = (
                await git(
                    [
                        "-c", "user.name=Grove",
                        "-c", "user.email=grove@localhost",
                        "commit-tree", "--no-gpg-sign",
                        result.tree, "-p", current, "-p", tip,
                        "-m", "Grove merge prediction",
                    ],
                    repoRoot
                )
            ).trim();
            merged.push(branch);
            predictions.push({ branch, conflictFiles: [], conflictsWith: [] });
            continue;
        }

        // Name who else changed the conflicting files: the base since this
        // branch diverged, and the earlier branches in the simulated result.
        const conflicting = new Set(result.conflictFiles);
        const touches = (files: Set<string>): boolean =>
            [...conflicting].some((file) => files.has(file));
        const conflictsWith: string[] = [];
        if (touches(await changedSinceMergeBase(repoRoot, tip, baseBranch))) {
            conflictsWith.push(baseBranch);
        }
        for (const earlier of merged) {
            if (touches(await changedSinceMergeBase(repoRoot, baseBranch, earlier))) {
                conflictsWith.push(earlier);
            }
        }
        predictions.push({ branch, conflictFiles: result.conflictFiles, conflictsWith });
    }
    return predictions;
}

/**
 * Find files that were changed on BOTH the base branch and the given branch
 * since they diverged (their merge-base). These are potential conflict sources
 * even if git can auto-merge them — the user should know about them.
 */
async function getBaseOverlapFiles(
    repoRoot: string,
    branch: string,
    baseBranch: string
): Promise<string[]> {
    try {
        const mergeBase = (
            await git(["merge-base", baseBranch, branch], repoRoot)
        ).trim();

        if (!mergeBase) return [];

        // Files changed on the base branch since divergence
        const baseChangesRaw = await git(
            ["diff", "--name-only", `${mergeBase}..${baseBranch}`],
            repoRoot
        );
        const baseFiles = new Set(
            baseChangesRaw.split("\n").filter(Boolean)
        );

        if (baseFiles.size === 0) return [];

        // Files changed on the worktree branch since divergence
        const branchChangesRaw = await git(
            ["diff", "--name-only", `${mergeBase}..${branch}`],
            repoRoot
        );
        const branchFiles = branchChangesRaw.split("\n").filter(Boolean);

        // Intersection: files changed on both sides
        return branchFiles.filter((f) => baseFiles.has(f));
    } catch {
        return [];
    }
}

// ────────────────────────────────────────────
// Merge Report Generation
// ────────────────────────────────────────────

/**
 * Generate a merge readiness report for a set of worktrees.
 * Includes pre-merge conflict prediction against the base branch.
 */
export async function generateMergeReport(
    worktreePaths: string[],
    baseBranch: string = "main"
): Promise<MergeReport> {
    const worktreeInfos: WorktreeMergeInfo[] = [];
    const allChangedFiles = new Map<string, string[]>(); // file → branches

    for (const wtPath of worktreePaths) {
        const info = await gatherWorktreeMergeInfo(wtPath, baseBranch);
        worktreeInfos.push(info);

        // Track files for overlap detection
        for (const file of info.changedFiles) {
            const branches = allChangedFiles.get(file) ?? [];
            branches.push(info.branch);
            allChangedFiles.set(file, branches);
        }
    }

    // Detect worktree-to-worktree overlaps
    const overlaps: FileOverlapInfo[] = [];
    for (const [filePath, branches] of allChangedFiles) {
        if (branches.length > 1) {
            overlaps.push({
                filePath,
                branches,
                likelyAutoResolvable: isLikelyAutoResolvable(filePath),
            });
        }
    }

    // Compute merge order
    const mergeOrder = recommendMergeOrder(worktreeInfos, undefined);

    // Predict conflicts along that order: each branch against the base plus
    // the branches merged before it (see predictMergeSequence).
    const conflictPredictions: ConflictPrediction[] = [];
    if (worktreePaths.length > 0) {
        let repoRoot: string;
        try {
            const { getRepoRoot } = await import("../utils/git");
            repoRoot = await getRepoRoot(worktreePaths[0]);
        } catch {
            repoRoot = path.resolve(worktreePaths[0], "..");
        }

        const ordered = mergeOrder
            .map((entry) => worktreeInfos.find((w) => w.branch === entry.branch))
            .filter((w): w is WorktreeMergeInfo => w !== undefined && w.changedFiles.length > 0);

        let sequence: SequencePrediction[] | undefined;
        try {
            sequence = await predictMergeSequence(
                repoRoot,
                ordered.map((w) => w.branch),
                baseBranch
            );
        } catch (err) {
            logError("Failed to predict merge conflicts", err);
        }

        for (const info of ordered) {
            const step = sequence?.find((p) => p.branch === info.branch);
            const baseOverlapFiles = await getBaseOverlapFiles(repoRoot, info.branch, baseBranch);
            const prediction: ConflictPrediction = {
                branch: info.branch,
                conflictFiles: step?.conflictFiles ?? [],
                conflictsWith: step?.conflictsWith ?? [],
                baseOverlapFiles,
                method: sequence ? "merge-tree" : "file-overlap",
            };
            if (prediction.conflictFiles.length > 0 || baseOverlapFiles.length > 0) {
                conflictPredictions.push(prediction);
            }
        }
    }

    // Compute totals
    const totalFilesChanged = new Set(
        worktreeInfos.flatMap((w) => w.changedFiles)
    ).size;
    const totalLinesAdded = worktreeInfos.reduce(
        (sum, w) => sum + w.linesAdded,
        0
    );
    const totalLinesRemoved = worktreeInfos.reduce(
        (sum, w) => sum + w.linesRemoved,
        0
    );

    return {
        generatedAt: new Date().toISOString(),
        baseBranch,
        worktrees: worktreeInfos,
        overlaps,
        conflictPredictions,
        mergeOrder,
        totalFilesChanged,
        totalLinesAdded,
        totalLinesRemoved,
    };
}

// ────────────────────────────────────────────
// Sequential Merge Execution
// ────────────────────────────────────────────

/**
 * Execute a sequential merge. Each step:
 * 1. Checkout base branch
 * 2. Merge worktree branch
 * 3. If conflict → pause
 * 4. If clean → optionally run tests
 * 5. If tests pass → continue
 *
 * Returns a MergeResult with the status of each step.
 * The caller (extension.ts) handles UI, conflict resolution, and test interaction.
 */
export async function executeMergeStep(
    repoRoot: string,
    branch: string,
    baseBranch: string = "main"
): Promise<MergeStep> {
    const step: MergeStep = {
        branch,
        worktreePath: "",
        status: "merging",
    };

    try {
        // Ensure we're on the base branch
        const currentBranch = await getCurrentBranch(repoRoot);
        if (currentBranch !== baseBranch) {
            await gitWrite(["checkout", baseBranch], repoRoot);
        }

        // Attempt merge
        try {
            const result = await gitWrite(
                ["merge", branch, "--no-edit"],
                repoRoot
            );
            step.status = "success";
            step.message = result || `Merged ${branch} successfully`;
        } catch (err) {
            // Check if it's a merge conflict
            const conflictFiles = await listUnmergedFiles(repoRoot);

            if (conflictFiles.length > 0) {
                step.status = "conflict";
                step.conflictFiles = conflictFiles;
                step.message = `Merge conflict in ${conflictFiles.length} file(s)`;
            } else {
                step.status = "error";
                const raw = err instanceof Error ? err.message : String(err);
                step.message = humanizeMergeError(raw, branch);
            }
        }
    } catch (err) {
        step.status = "error";
        const raw = err instanceof Error ? err.message : String(err);
        step.message = humanizeMergeError(raw, branch);
    }

    return step;
}

// ────────────────────────────────────────────
// Pre-Merge Auto-Commit
// ────────────────────────────────────────────

/**
 * Files an agent's instructions ask it to write at the worktree root for
 * coordination (read by the merge report). Merging them would put one
 * agent's notes on the base branch, and the second agent's copy would
 * conflict, so the merge flow leaves them unchecked by default.
 */
const COORDINATION_NOTES = new Set(["HANDOFF.md", "SHARED-CHANGES.md", "REVIEW.md", "FINDINGS.md"]);

/**
 * Why an untracked file should be left out of the auto-commit by default,
 * or undefined if it should be included.
 */
export function defaultExclusionReason(filePath: string): string | undefined {
    if (isNestedRepo(filePath)) {
        return "nested git repository, never merged";
    }
    if (COORDINATION_NOTES.has(filePath)) {
        return "Grove coordination note";
    }
    if (filePath === ".claude" || filePath.startsWith(".claude/")) {
        return "Claude Code local settings";
    }
    return undefined;
}

/**
 * `git ls-files --others` lists a nested git repository (a clone or a
 * `git init` inside the worktree) as one entry ending in "/". Staging it
 * would commit a bare gitlink without its files, so it is never staged.
 */
export function isNestedRepo(filePath: string): boolean {
    return filePath.endsWith("/");
}

/**
 * Commit an agent worktree's uncommitted work before it is merged.
 *
 * Stages every tracked change, plus exactly the untracked files listed in
 * `includeUntracked` (the caller asks the user which ones). A CLAUDE.md that
 * an earlier Grove version generated in the worktree is undone first, so
 * it can never reach the base branch. Returns the files that were committed.
 */
export async function autoCommitWorktree(
    worktreePath: string,
    includeUntracked: string[],
    message = "Grove: auto-commit agent changes"
): Promise<{ committed: boolean; files: string[] }> {
    await discardLegacyGeneratedClaudeMd(worktreePath);

    await gitWrite(["add", "-u"], worktreePath);
    await stagePaths(worktreePath, includeUntracked.filter((file) => !isNestedRepo(file)));

    const staged = (
        await git(["diff", "--cached", "--name-only", "-z"], worktreePath, { trim: false })
    ).split("\0").filter(Boolean);
    if (staged.length === 0) {
        return { committed: false, files: [] };
    }

    await gitWrite(["commit", "-m", message], worktreePath);
    return { committed: true, files: staged };
}

/**
 * Stage exactly these paths (no globbing), including deletions.
 * Chunked so a long list stays under the OS argument limit.
 */
async function stagePaths(cwd: string, paths: string[]): Promise<void> {
    const CHUNK = 100;
    for (let i = 0; i < paths.length; i += CHUNK) {
        await gitWrite(
            ["--literal-pathspecs", "add", "-A", "--", ...paths.slice(i, i + CHUNK)],
            cwd
        );
    }
}

/**
 * Branches whose committed CLAUDE.md was generated by Grove 0.6.0 or
 * earlier while the base branch's CLAUDE.md was not. Merging such a
 * branch would replace (or, if the base has none, add) CLAUDE.md on the
 * base branch.
 */
export async function findBranchesWithGeneratedClaudeMd(
    repoRoot: string,
    branches: string[],
    baseBranch: string
): Promise<{ branches: Array<{ branch: string; file: string }>; baseHasClaudeMd: boolean }> {
    // Read the root CLAUDE.md at a ref, matching its name without case and
    // following a symlink (for example CLAUDE.md -> AGENTS.md).
    const readAt = async (ref: string): Promise<{ file: string; content: string } | undefined> => {
        try {
            const entries = (await git(["ls-tree", "-z", ref], repoRoot, { trim: false }))
                .split("\0")
                .filter(Boolean)
                .map((line) => {
                    const tab = line.indexOf("\t");
                    return { mode: line.split(" ")[0], name: line.slice(tab + 1) };
                });
            const entry = entries.find((e) => e.name.toLowerCase() === "claude.md");
            if (!entry) return undefined;
            let name = entry.name;
            if (entry.mode === "120000") {
                name = path.posix.normalize(await git(["show", `${ref}:${entry.name}`], repoRoot));
                if (name.startsWith("../") || name.startsWith("/")) return undefined;
            }
            return { file: name, content: await git(["show", `${ref}:${name}`], repoRoot) };
        } catch {
            return undefined;
        }
    };

    const base = await readAt(baseBranch);
    const baseHasClaudeMd = base !== undefined;
    if (base !== undefined && isGroveGeneratedInstructions(base.content)) {
        return { branches: [], baseHasClaudeMd };
    }

    const found: Array<{ branch: string; file: string }> = [];
    for (const branch of branches) {
        const entry = await readAt(branch);
        if (entry !== undefined && isGroveGeneratedInstructions(entry.content)) {
            found.push({ branch, file: entry.file });
        }
    }
    return { branches: found, baseHasClaudeMd };
}

// ────────────────────────────────────────────
// Conflict Resolution
// ────────────────────────────────────────────

/**
 * Paths with unresolved merge conflicts in the given worktree.
 */
export async function listUnmergedFiles(repoRoot: string): Promise<string[]> {
    const raw = await git(
        ["diff", "--name-only", "--diff-filter=U", "-z"],
        repoRoot,
        { trim: false }
    );
    return [...new Set(raw.split("\0").filter(Boolean))];
}

/**
 * Conflicted files that still contain both a `<<<<<<<` and a `>>>>>>>`
 * conflict marker line on disk.
 */
export function findConflictMarkers(repoRoot: string, files: string[]): string[] {
    const start = /^<{7}( |$)/m;
    const end = /^>{7}( |$)/m;
    return files.filter((file) => {
        try {
            const content = fs.readFileSync(path.join(repoRoot, file), "utf-8");
            return start.test(content) && end.test(content);
        } catch {
            // Deleted as part of the resolution
            return false;
        }
    });
}

/**
 * Stage the user's conflict resolutions — only the conflicted paths, so
 * nothing else in the working tree is swept into the merge commit. Paths
 * the user already staged or removed (e.g. with `git rm`) are resolved in
 * the index and are skipped. Returns the paths still unmerged afterwards.
 */
export async function stageResolvedConflicts(
    repoRoot: string,
    conflictFiles: string[]
): Promise<string[]> {
    const pending = new Set(await listUnmergedFiles(repoRoot));
    // Stage what is on disk now (even if the user staged an earlier version);
    // skip a path that is gone and already resolved, e.g. with `git rm`.
    const toStage = conflictFiles.filter(
        (file) => pending.has(file) || fs.existsSync(path.join(repoRoot, file))
    );
    await stagePaths(repoRoot, toStage);
    return listUnmergedFiles(repoRoot);
}

/**
 * Check if the repository is in a clean state (no in-progress merge/rebase).
 * Call this before starting a merge sequence.
 */
export async function checkRepoState(repoRoot: string): Promise<{ clean: boolean; reason?: string }> {
    try {
        const status = await git(["status", "--porcelain"], repoRoot);
        const conflictPrefixes = ["UU", "AA", "DD", "DU", "UD", "AU", "UA"];
        const hasConflicts = status.split("\n").some(
            (line) => conflictPrefixes.some((p) => line.startsWith(p))
        );
        if (hasConflicts) {
            return { clean: false, reason: "Repository has unresolved merge conflicts." };
        }

        // Check for uncommitted changes that could be destroyed by checkout/merge
        if (status.trim().length > 0) {
            return { clean: false, reason: "Working tree has uncommitted changes. Commit or stash them first." };
        }

        // Check for MERGE_HEAD (in-progress merge)
        // Resolve against repoRoot since git-dir may be relative
        const gitDir = path.resolve(repoRoot, (await git(["rev-parse", "--git-dir"], repoRoot)).trim());
        if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
            return { clean: false, reason: "A merge is already in progress. Resolve or abort it first." };
        }
        if (fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"))) {
            return { clean: false, reason: "A rebase is in progress. Complete or abort it first." };
        }
    } catch {
        // If we can't check, assume clean and let git fail naturally
    }
    return { clean: true };
}

/**
 * True while a merge is in progress in the given checkout (MERGE_HEAD exists).
 */
export async function isMergeInProgress(repoRoot: string): Promise<boolean> {
    try {
        await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], repoRoot);
        return true;
    } catch {
        return false;
    }
}

/**
 * Abort an in-progress merge and verify it was successful.
 */
export async function abortMerge(repoRoot: string): Promise<void> {
    await gitWrite(["merge", "--abort"], repoRoot);

    // Verify merge state is actually cleared
    // Resolve against repoRoot since git-dir may be relative
    const gitDir = path.resolve(repoRoot, (await git(["rev-parse", "--git-dir"], repoRoot)).trim());
    if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
        throw new GroveError(
            "Could not abort the merge — merge state is still present.",
            "Open a terminal and run 'git merge --abort' manually. If that doesn't work, try 'git reset --hard HEAD'."
        );
    }
}

/**
 * Run a test command in the repo root.
 * Returns true if tests pass, false otherwise.
 */
export async function runTests(
    repoRoot: string,
    testCommand: string
): Promise<{ passed: boolean; output: string }> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    try {
        // Run the command through the shell to support complex commands
        // (e.g. "npm test && npm run lint")
        const { stdout, stderr } = await execFileAsync(
            process.platform === "win32" ? "cmd" : "sh",
            process.platform === "win32" ? ["/c", testCommand] : ["-c", testCommand],
            {
                cwd: repoRoot,
                maxBuffer: 10 * 1024 * 1024,
                timeout: 5 * 60 * 1000, // 5 minute timeout
            },
        );

        return {
            passed: true,
            output: stdout + (stderr ? `\n${stderr}` : ""),
        };
    } catch (err) {
        const error = err as { stdout?: string; stderr?: string; message?: string };
        return {
            passed: false,
            output:
                (error.stdout ?? "") +
                (error.stderr ? `\n${error.stderr}` : "") +
                (error.message ? `\n${error.message}` : ""),
        };
    }
}

/**
 * Auto-detect the test command from the project.
 */
export function detectTestCommand(repoRoot: string): string | undefined {
    // Check package.json
    const pkgPath = path.join(repoRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
                scripts?: Record<string, string>;
            };
            if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
                return "npm test";
            }
        } catch {
            // Ignore
        }
    }

    // Check for pytest — only trust pytest.ini as a definitive indicator.
    // pyproject.toml and setup.cfg are general Python config files and
    // do not imply pytest is the test runner.
    if (fs.existsSync(path.join(repoRoot, "pytest.ini"))) {
        return "pytest";
    }
    // Check pyproject.toml for [tool.pytest] section
    if (fs.existsSync(path.join(repoRoot, "pyproject.toml"))) {
        try {
            const content = fs.readFileSync(path.join(repoRoot, "pyproject.toml"), "utf-8");
            if (content.includes("[tool.pytest")) {
                return "pytest";
            }
        } catch {
            // Ignore
        }
    }

    // Check for go tests
    if (fs.existsSync(path.join(repoRoot, "go.mod"))) {
        return "go test ./...";
    }

    // Check for cargo tests
    if (fs.existsSync(path.join(repoRoot, "Cargo.toml"))) {
        return "cargo test";
    }

    return undefined;
}

// ────────────────────────────────────────────
// Post-Merge Cleanup
// ────────────────────────────────────────────

/**
 * Clean up worktrees after a successful merge.
 * Removes worktrees and optionally deletes branches.
 *
 * A worktree that still holds uncommitted or untracked files is only
 * removed if `confirmDiscard` returns true for it; otherwise it is kept and
 * listed in `kept`. Without a callback, such worktrees are always kept.
 */
export async function postMergeCleanup(
    repoRoot: string,
    worktrees: Array<{ path: string; branch: string }>,
    options: {
        deleteBranches?: boolean;
        protectedBranches?: string[];
        confirmDiscard?: (
            worktree: { path: string; branch: string },
            files: string[]
        ) => Promise<boolean>;
    } = {}
): Promise<{ removed: number; kept: string[]; errors: string[] }> {
    const { deleteBranches = true, protectedBranches, confirmDiscard } = options;
    let removed = 0;
    const kept: string[] = [];
    const errors: string[] = [];

    for (const wt of worktrees) {
        try {
            // A CLAUDE.md generated by Grove 0.6.0 or earlier is not user work.
            try {
                await discardLegacyGeneratedClaudeMd(wt.path);
            } catch (err) {
                logError(`Could not undo generated CLAUDE.md in ${wt.branch}`, err);
            }

            let leftovers: string[] = [];
            if (fs.existsSync(wt.path)) {
                const changes = await listUncommittedChanges(wt.path);
                leftovers = [...changes.tracked, ...changes.untracked];
            }
            if (leftovers.length > 0) {
                const discard = confirmDiscard
                    ? await confirmDiscard(wt, leftovers)
                    : false;
                if (!discard) {
                    log(`Kept worktree ${wt.path}: ${leftovers.length} file(s) not merged`);
                    kept.push(wt.branch);
                    continue;
                }
            }

            await removeWorktree(repoRoot, wt.path, {
                deleteBranch: deleteBranches,
                // Only force when the user agreed to discard the leftovers.
                force: leftovers.length > 0,
                // The branch was just merged into the checked-out target, so the
                // safe -d succeeds; if git disagrees, the branch is kept.
                forceDeleteBranch: false,
                ...(protectedBranches ? { protectedBranches } : {}),
            });
            removed++;
        } catch (err) {
            logError(`Post-merge cleanup failed for ${wt.branch}`, err);
            if (err instanceof GroveError) {
                errors.push(`${wt.branch}: ${err.message}`);
            } else {
                const raw = err instanceof Error ? err.message : String(err);
                if (raw.includes("EACCES") || raw.includes("permission denied")) {
                    errors.push(`${wt.branch}: Permission denied. Close any editors or terminals using this worktree and try again.`);
                } else if (raw.includes("index.lock") || raw.includes(".lock")) {
                    errors.push(`${wt.branch}: Git is locked by another process. Wait a moment and try again.`);
                } else {
                    errors.push(`${wt.branch}: Could not remove worktree. Check the Grove output channel for details.`);
                }
            }
        }
    }

    return { removed, kept, errors };
}

// ────────────────────────────────────────────
// Merge Order Recommendation
// ────────────────────────────────────────────

/**
 * Recommend a merge order based on file dependencies.
 */
export function recommendMergeOrder(
    worktrees: WorktreeMergeInfo[],
    templateOrder?: string[]
): MergeOrderEntry[] {
    // If template defines an order, use it (but also include worktrees not in the template)
    // Template mergeOrder contains role names (e.g. "backend", "frontend"),
    // while branches are named "worktree-<team>-<role>". Match by suffix.
    if (templateOrder && templateOrder.length > 0) {
        const branchMap = new Map(worktrees.map((w) => [w.branch, w]));

        // Build a role-to-worktree map: try exact branch match first,
        // then fall back to matching branches that end with the role name
        const findWorktreeForRole = (role: string): WorktreeMergeInfo | undefined => {
            // Exact match (branch name IS the role)
            if (branchMap.has(role)) return branchMap.get(role);
            // Suffix match (branch ends with -<role>)
            for (const wt of worktrees) {
                if (wt.branch.endsWith(`-${role}`)) return wt;
            }
            return undefined;
        };

        const ordered: MergeOrderEntry[] = [];
        const matchedBranches = new Set<string>();

        for (const role of templateOrder) {
            const wt = findWorktreeForRole(role);
            if (wt) {
                ordered.push({
                    branch: wt.branch,
                    worktreePath: wt.path,
                    reason: "Template-defined order",
                });
                matchedBranches.add(wt.branch);
            }
        }

        // Append any worktrees not matched by the template order
        for (const wt of worktrees) {
            if (!matchedBranches.has(wt.branch)) {
                ordered.push({
                    branch: wt.branch,
                    worktreePath: wt.path,
                    reason: "Not in template order — appended",
                });
            }
        }

        return ordered;
    }

    // Analyze dependencies: if worktree B changes files that import
    // from files created by worktree A, A should merge first.
    // Simpler heuristic: sort by "infrastructure first" —
    // types/models/utils before features before tests.

    const scored = worktrees.map((wt) => {
        let score = 50; // default middle
        let reason = "Default order";

        const files = wt.changedFiles;

        // Types/interfaces/models → merge first
        const hasTypes = files.some(
            (f) =>
                f.includes("/types") ||
                f.includes("/interfaces") ||
                f.includes("/models") ||
                f.endsWith(".d.ts")
        );
        if (hasTypes) {
            score = 10;
            reason = "Contains type/model definitions (merge first)";
        }

        // Core/lib/utils → merge early
        const hasCore = files.some(
            (f) =>
                f.includes("/core/") ||
                f.includes("/lib/") ||
                f.includes("/utils/") ||
                f.includes("/shared/")
        );
        if (hasCore && !hasTypes) {
            score = 20;
            reason = "Contains core/library code";
        }

        // API/services → merge middle
        const hasApi = files.some(
            (f) =>
                f.includes("/api/") ||
                f.includes("/services/") ||
                f.includes("/middleware/")
        );
        if (hasApi && score === 50) {
            score = 30;
            reason = "Contains API/service code";
        }

        // UI/components/pages → merge after backend
        const hasUi = files.some(
            (f) =>
                f.includes("/components/") ||
                f.includes("/pages/") ||
                f.includes("/views/")
        );
        if (hasUi && score === 50) {
            score = 40;
            reason = "Contains UI components";
        }

        // Tests → merge last
        const hasTests = files.some(
            (f) =>
                f.includes("/test") ||
                f.includes(".test.") ||
                f.includes(".spec.")
        );
        if (hasTests && score === 50) {
            score = 80;
            reason = "Contains tests (merge last)";
        }

        // Review-only (no code changes) → skip or merge last
        if (files.length === 0) {
            score = 100;
            reason = "No file changes";
        }

        return { wt, score, reason };
    });

    scored.sort((a, b) => a.score - b.score);

    return scored.map((s) => ({
        branch: s.wt.branch,
        worktreePath: s.wt.path,
        reason: s.reason,
    }));
}

// ────────────────────────────────────────────
// Report Formatting
// ────────────────────────────────────────────

/**
 * Format a merge report as markdown for display.
 */
export function formatMergeReportMarkdown(report: MergeReport): string {
    const lines: string[] = [];

    lines.push("# Merge Readiness Report");
    lines.push("");
    lines.push(
        `Generated: ${new Date(report.generatedAt).toLocaleString()}`
    );
    lines.push(`Base branch: \`${report.baseBranch}\``);
    lines.push("");

    // Summary
    lines.push("## Summary");
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Worktrees | ${report.worktrees.length} |`);
    lines.push(`| Total files changed | ${report.totalFilesChanged} |`);
    lines.push(`| Lines added | +${report.totalLinesAdded} |`);
    lines.push(`| Lines removed | -${report.totalLinesRemoved} |`);
    lines.push(`| File overlaps | ${report.overlaps.length} |`);

    // Conflict predictions summary
    const totalConflictFiles = report.conflictPredictions.reduce(
        (sum, p) => sum + p.conflictFiles.length, 0
    );
    const totalBaseOverlaps = report.conflictPredictions.reduce(
        (sum, p) => sum + p.baseOverlapFiles.length, 0
    );
    if (totalConflictFiles > 0) {
        lines.push(`| **Predicted conflicts** | **${totalConflictFiles} file(s)** |`);
    }
    if (totalBaseOverlaps > 0) {
        lines.push(`| Files changed on both base & branch | ${totalBaseOverlaps} |`);
    }
    lines.push("");

    // Conflict predictions (most important — show first)
    if (report.conflictPredictions.length > 0) {
        const hasExactConflicts = report.conflictPredictions.some(
            (p) => p.conflictFiles.length > 0
        );
        if (report.conflictPredictions.some((p) => p.method === "file-overlap")) {
            lines.push(
                "_`git merge-tree` could not run (it needs Git 2.38 or later and branches with a shared history), " +
                "so only the file-level checks below ran._"
            );
            lines.push("");
        }

        if (hasExactConflicts) {
            lines.push("## \u26A0\uFE0F Predicted Merge Conflicts");
            lines.push("");
            lines.push(
                "Merging in the recommended order below, `git merge-tree` reports conflicts in these files. " +
                "Each branch is checked against `" + report.baseBranch + "` plus the branches before it that merge " +
                "cleanly, so how you resolve an earlier conflict can change later results. Only committed work is checked:"
            );
            lines.push("");

            for (const pred of report.conflictPredictions) {
                if (pred.conflictFiles.length === 0) continue;
                const withWhom = pred.conflictsWith.length > 0 ? ` (with ${pred.conflictsWith.join(", ")})` : "";
                lines.push(`### \`${pred.branch}\` — ${pred.conflictFiles.length} conflicting file(s)${withWhom}`);
                lines.push("");
                for (const file of pred.conflictFiles) {
                    lines.push(`- \u274C \`${file}\``);
                }
                lines.push("");
            }
        }

        // Base overlap warnings (files changed on both sides but may auto-resolve)
        const hasBaseOverlaps = report.conflictPredictions.some(
            (p) => p.baseOverlapFiles.length > 0
        );
        if (hasBaseOverlaps) {
            lines.push("## Files Changed on Both Base & Branch");
            lines.push("");
            lines.push(
                "These files were modified on `" + report.baseBranch +
                "` since the branch diverged. They may merge cleanly or may conflict:"
            );
            lines.push("");

            for (const pred of report.conflictPredictions) {
                if (pred.baseOverlapFiles.length === 0) continue;
                lines.push(`**\`${pred.branch}\`** (${pred.baseOverlapFiles.length} shared file(s)):`);
                lines.push("");
                for (const file of pred.baseOverlapFiles) {
                    const isConfirmedConflict = pred.conflictFiles.includes(file);
                    const icon = isConfirmedConflict ? "\u274C" : "\u26A0\uFE0F";
                    const label = isConfirmedConflict ? "conflicts (git merge-tree)" : "changed on both sides";
                    lines.push(`- ${icon} \`${file}\` — ${label}`);
                }
                lines.push("");
            }
        }
    }

    // Worktree-to-worktree overlaps
    if (report.overlaps.length > 0) {
        lines.push("## Worktree-to-Worktree File Overlaps");
        lines.push("");
        lines.push(
            "These files were modified in multiple worktrees and may conflict when they are merged one after another:"
        );
        lines.push("");

        for (const overlap of report.overlaps) {
            const icon = overlap.likelyAutoResolvable ? "~" : "!!";
            const resolvability = overlap.likelyAutoResolvable
                ? "likely auto-resolvable"
                : "manual merge needed";
            lines.push(
                `- ${icon} \`${overlap.filePath}\` — ${overlap.branches.join(", ")} (${resolvability})`
            );
        }
        lines.push("");
    }

    // Merge Order
    lines.push("## Recommended Merge Order");
    lines.push("");
    for (let i = 0; i < report.mergeOrder.length; i++) {
        const entry = report.mergeOrder[i];
        lines.push(`${i + 1}. \`${entry.branch}\` — ${entry.reason}`);
    }
    lines.push("");

    // Per-worktree details
    lines.push("## Worktree Details");
    lines.push("");

    for (const wt of report.worktrees) {
        lines.push(`### ${wt.branch}`);
        lines.push("");
        lines.push(
            `- **${wt.changedFiles.length}** files changed | **+${wt.linesAdded}** / **-${wt.linesRemoved}** lines`
        );

        if (wt.hasUncommittedChanges) {
            lines.push("- **WARNING:** Has uncommitted changes");
        }

        if (wt.newFiles.length > 0) {
            lines.push(`- New files: ${wt.newFiles.map((f) => `\`${f}\``).join(", ")}`);
        }

        if (wt.reviewFindings) {
            lines.push("");
            lines.push("**Reviewer Findings:**");
            lines.push("");
            lines.push(wt.reviewFindings);
        }

        if (wt.handoffNotes) {
            lines.push("");
            lines.push("**Handoff Notes:**");
            lines.push("");
            lines.push(wt.handoffNotes);
        }

        lines.push("");

        if (wt.diffStat) {
            lines.push("```");
            lines.push(wt.diffStat);
            lines.push("```");
            lines.push("");
        }
    }

    return lines.join("\n");
}

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────

async function gatherWorktreeMergeInfo(
    worktreePath: string,
    baseBranch: string
): Promise<WorktreeMergeInfo> {
    const branch = await getCurrentBranch(worktreePath);
    const changedFiles = await getChangedFiles(worktreePath, baseBranch);
    const diffStat = await getDiffStats(worktreePath, baseBranch);

    // Parse lines added/removed from numstat
    let linesAdded = 0;
    let linesRemoved = 0;
    try {
        const numstat = await git(
            ["diff", "--numstat", `${baseBranch}...HEAD`],
            worktreePath
        );
        for (const line of numstat.split("\n")) {
            const [added, removed] = line.split("\t");
            if (added && removed && added !== "-") {
                linesAdded += parseInt(added, 10) || 0;
                linesRemoved += parseInt(removed, 10) || 0;
            }
        }
    } catch {
        // Ignore
    }

    // Detect new files
    let newFiles: string[] = [];
    try {
        const newFilesOutput = await git(
            ["diff", "--name-only", "--diff-filter=A", `${baseBranch}...HEAD`],
            worktreePath
        );
        newFiles = newFilesOutput.split("\n").filter(Boolean);
    } catch {
        // Ignore
    }

    // Check for uncommitted changes and include them in the report
    let hasUncommittedChanges = false;
    let uncommittedFiles: string[] = [];
    let uncommittedLinesAdded = 0;
    let uncommittedLinesRemoved = 0;
    try {
        const status = await git(["status", "--porcelain"], worktreePath);
        if (status.trim().length > 0) {
            hasUncommittedChanges = true;
            // Extract file paths from porcelain output
            uncommittedFiles = status
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                    // Porcelain format: XY filename  or  XY orig -> renamed
                    const filePart = line.slice(3);
                    // Handle renames (old -> new)
                    const arrowIdx = filePart.indexOf(" -> ");
                    return arrowIdx >= 0 ? filePart.slice(arrowIdx + 4) : filePart;
                })
                .filter(Boolean);

            // Get lines added/removed for all uncommitted changes (staged + unstaged)
            // `git diff HEAD` covers both staged and unstaged in one pass
            try {
                const uncommittedNumstat = await git(
                    ["diff", "--numstat", "HEAD"],
                    worktreePath
                );
                for (const line of uncommittedNumstat.split("\n")) {
                    const [added, removed] = line.split("\t");
                    if (added && removed && added !== "-") {
                        uncommittedLinesAdded += parseInt(added, 10) || 0;
                        uncommittedLinesRemoved += parseInt(removed, 10) || 0;
                    }
                }
            } catch {
                // Ignore — may fail if no HEAD commit
            }
        }
    } catch {
        // Ignore
    }

    // Merge committed and uncommitted changed files (deduplicated)
    const allChangedFiles = [...new Set([...changedFiles, ...uncommittedFiles])];

    // Identify truly new uncommitted files (untracked or added but not in committed changes).
    // Only files NOT already tracked by `git diff baseBranch...HEAD` are considered new.
    const allNewFiles = [...new Set([
        ...newFiles,
        ...uncommittedFiles.filter(
            (f) => !changedFiles.includes(f) && !newFiles.includes(f)
        ),
    ])];

    // Read REVIEW.md if exists
    let reviewFindings: string | undefined;
    const reviewPath = path.join(worktreePath, "REVIEW.md");
    if (fs.existsSync(reviewPath)) {
        try {
            reviewFindings = fs.readFileSync(reviewPath, "utf-8").trim();
        } catch {
            // Ignore
        }
    }

    // Read HANDOFF.md if exists
    let handoffNotes: string | undefined;
    const handoffPath = path.join(worktreePath, "HANDOFF.md");
    if (fs.existsSync(handoffPath)) {
        try {
            handoffNotes = fs.readFileSync(handoffPath, "utf-8").trim();
        } catch {
            // Ignore
        }
    }

    return {
        path: worktreePath,
        branch,
        changedFiles: allChangedFiles,
        linesAdded: linesAdded + uncommittedLinesAdded,
        linesRemoved: linesRemoved + uncommittedLinesRemoved,
        newFiles: allNewFiles,
        diffStat,
        reviewFindings,
        handoffNotes,
        hasUncommittedChanges,
    };
}

/**
 * Heuristic: is this file overlap likely auto-resolvable?
 * Config/lock files with additive changes (e.g., package.json deps)
 * are often auto-resolvable. Same-function edits are not.
 */
function isLikelyAutoResolvable(filePath: string): boolean {
    const autoResolvablePatterns = [
        "package.json",
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "go.sum",
        "Cargo.lock",
        "requirements.txt",
        ".gitignore",
    ];
    const fileName = path.basename(filePath);
    return autoResolvablePatterns.includes(fileName);
}
