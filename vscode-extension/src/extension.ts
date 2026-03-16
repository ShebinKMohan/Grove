/**
 * Grove — VS Code Extension Entry Point.
 * Control plane for parallel AI development with git worktrees.
 *
 * Registers all commands, views, and lifecycle management.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getRepoRoot, getCurrentBranch, listLocalBranches, git, gitWrite, sanitizeRefName } from "./utils/git";
import { showAutoInfo, showAutoWarning, showAutoError } from "./ui/notifications";
import {
    UnifiedTreeProvider,
    CompletedTreeProvider,
    WorktreeItem,
    SessionItem,
    AgentItem,
} from "./ui/sidebar/unified-tree-provider";
import { SessionTracker } from "./core/session-tracker";
import { AgentOrchestrator } from "./core/agent-orchestrator";
import { OverlapDetector } from "./core/overlap-detector";
import {
    initTemplateManager,
    listTemplateNames,
    loadTemplate,
} from "./core/template-manager";
import {
    createWorktree,
    removeWorktree,
    listAllWorktrees,
    validateBranchName,
    fetchRemote,
    syncWorktree,
} from "./core/worktree-manager";
import { openTerminal, openInNewWindow, launchClaude } from "./utils/terminal";
import { DashboardPanel } from "./ui/webview/dashboard-panel";
import {
    generateMergeReport,
    executeMergeStep,
    abortMerge,
    checkRepoState,
    runTests,
    detectTestCommand,
    postMergeCleanup,
    formatMergeReportMarkdown,
} from "./core/merge-sequencer";
import { formatErrorForUser } from "./utils/errors";
import { log, logError, disposeLogger } from "./utils/logger";

/** Read the user-configured protected branches list from VS Code settings. */
function getProtectedBranches(): string[] {
    const config = vscode.workspace.getConfiguration("grove");
    return config.get<string[]>("protectedBranches", ["main", "master", "develop", "production"]);
}

/**
 * Build a human-readable description for a worktree in merge-related quick picks.
 * Shows uncommitted change counts prominently so users see WIP before merging.
 */
function mergePickDescription(status: { modified: number; staged: number; untracked: number; conflicts: number }, statusSummary: string): string {
    const total = status.modified + status.staged + status.untracked + status.conflicts;
    if (statusSummary === "missing") return "$(warning) missing";
    if (statusSummary === "error") return "$(warning) error";
    if (total === 0) return "$(check) clean";
    const parts: string[] = [];
    if (status.conflicts > 0) parts.push(`${status.conflicts} conflict(s)`);
    if (status.staged > 0) parts.push(`${status.staged} staged`);
    if (status.modified > 0) parts.push(`${status.modified} modified`);
    if (status.untracked > 0) parts.push(`${status.untracked} untracked`);
    return `$(alert) ${total} uncommitted change${total === 1 ? "" : "s"} (${parts.join(", ")})`;
}

/**
 * All command IDs declared in package.json. When the workspace is not
 * a git repo (or no folder is open) we still need to register them so
 * VS Code doesn't show "command not found".
 */
const ALL_COMMAND_IDS: readonly string[] = [
    "grove.createWorktree",
    "grove.deleteWorktree",
    "grove.cleanupWorktrees",
    "grove.launchSession",
    "grove.openDashboard",
    "grove.openInTerminal",
    "grove.openInNewWindow",
    "grove.viewDiff",
    "grove.stopSession",
    "grove.stopAllSessions",
    "grove.focusSession",
    "grove.setTaskDescription",
    "grove.clearCompletedSessions",
    "grove.refreshSidebar",
    "grove.launchTeam",
    "grove.stopTeam",
    "grove.stopAgent",
    "grove.focusAgent",
    "grove.cleanupTeam",
    "grove.runOverlapCheck",
    "grove.generateMergeReport",
    "grove.executeMergeSequence",
    "grove.syncWorktree",
    "grove.pushWorktree",
    "grove.quickMenu",
    "grove.openFileDiff",
    "grove.selectRepository",
] as const;

/**
 * Register all declared commands as no-ops that show a friendly error.
 * Called when the extension cannot fully activate (no folder, no git repo,
 * or an unexpected error) so VS Code never reports "command not found".
 */
function registerStubCommands(
    context: vscode.ExtensionContext,
    title: string,
    detail: string
): void {
    for (const id of ALL_COMMAND_IDS) {
        context.subscriptions.push(
            vscode.commands.registerCommand(id, () => {
                void vscode.window.showErrorMessage(
                    `Grove — ${title}\n\n${detail}`,
                    { modal: false }
                );
            })
        );
    }
}

export async function activate(
    context: vscode.ExtensionContext
): Promise<void> {
    log("Grove activating...");

    // ── Tree Providers (register unconditionally) ─────────
    // Views declared in package.json must always be registered,
    // even when the workspace is not a git repo.

    const unifiedProvider = new UnifiedTreeProvider();
    const completedProvider = new CompletedTreeProvider();

    const explorerView = vscode.window.createTreeView(
        "grove.explorer",
        { treeDataProvider: unifiedProvider, showCollapseAll: true }
    );

    const completedView = vscode.window.createTreeView(
        "grove.completed",
        { treeDataProvider: completedProvider, showCollapseAll: true }
    );

    context.subscriptions.push(explorerView, completedView);

    // ── Pre-flight: workspace & git ──────────────────────
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        log("No workspace folder open");
        registerStubCommands(
            context,
            "No folder open",
            "Open a project folder (File → Open Folder) to use Grove."
        );
        return;
    }

    let repoRoot: string | undefined;

    // Check if user previously selected a repo for this workspace
    const savedRepo = context.workspaceState.get<string>("grove.selectedRepoRoot");
    if (savedRepo) {
        try {
            repoRoot = await getRepoRoot(savedRepo);
            log(`Using previously selected repo: ${repoRoot}`);
        } catch {
            // Saved repo no longer valid — clear and re-detect
            await context.workspaceState.update("grove.selectedRepoRoot", undefined);
        }
    }

    // Try each workspace folder, then scan subdirectories for git repos
    if (!repoRoot) {
        for (const folder of workspaceFolders) {
            try {
                repoRoot = await getRepoRoot(folder.uri.fsPath);
                break;
            } catch {
                // Not a git repo — continue checking
            }
        }
    }

    // If no workspace folder is a git repo, scan immediate subdirectories
    if (!repoRoot) {
        const rootDir = workspaceFolders[0].uri.fsPath;
        const gitRepos: Array<{ label: string; path: string }> = [];
        try {
            const entries = fs.readdirSync(rootDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
                const subPath = path.join(rootDir, entry.name);
                try {
                    const repo = await getRepoRoot(subPath);
                    gitRepos.push({ label: entry.name, path: repo });
                } catch {
                    // Not a git repo
                }
            }
        } catch {
            // Can't read directory
        }

        if (gitRepos.length === 1) {
            // Only one git repo found — use it automatically
            repoRoot = gitRepos[0].path;
            log(`Auto-selected nested git repo: ${repoRoot}`);
        } else if (gitRepos.length > 1) {
            // Multiple repos — let user pick
            const pick = await vscode.window.showQuickPick(
                gitRepos.map((r) => ({
                    label: r.label,
                    detail: r.path,
                    repoPath: r.path,
                })),
                {
                    placeHolder: "Select a git repository for Grove",
                    title: "Grove: Multiple Git Repos Found",
                }
            );
            if (pick) {
                repoRoot = pick.repoPath;
            }
        }
    }

    if (!repoRoot) {
        // Check if git is missing vs. no repo
        try {
            await getRepoRoot(workspaceFolders[0].uri.fsPath);
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            const isGitMissing = detail.toLowerCase().includes("enoent") ||
                detail.toLowerCase().includes("not found");

            if (isGitMissing) {
                log("git not found in PATH");
                registerStubCommands(
                    context,
                    "Git not found",
                    "Grove requires git. Install git and make sure it is in your PATH, then reload the window (⇧⌘P → Reload Window)."
                );
                void vscode.window.showErrorMessage(
                    "Grove: git is not installed or not in your PATH. Install git and reload the window."
                );
                return;
            }
        }

        log("No git repository found in workspace or subdirectories");
        registerStubCommands(
            context,
            "No git repository found",
            "No git repository found in this folder or its subdirectories. Run 'git init' or open a folder with a git project, then reload the window."
        );
        void vscode.window.showWarningMessage(
            "Grove is inactive — no git repository found in this workspace or its subdirectories."
        );
        return;
    }

    // Save the selected repo for future activations
    await context.workspaceState.update("grove.selectedRepoRoot", repoRoot);
    log(`Git repo found: ${repoRoot}`);

    // ── Register grove.selectRepository (always available) ──
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.selectRepository",
            async () => {
                const folders = vscode.workspace.workspaceFolders;
                if (!folders) return;

                const repos: Array<{ label: string; detail: string; repoPath: string }> = [];

                // Check each workspace folder
                for (const folder of folders) {
                    try {
                        const repo = await getRepoRoot(folder.uri.fsPath);
                        repos.push({
                            label: path.basename(repo),
                            detail: repo,
                            repoPath: repo,
                        });
                    } catch {
                        // Not a git repo
                    }

                    // Scan subdirectories
                    try {
                        const entries = fs.readdirSync(folder.uri.fsPath, { withFileTypes: true });
                        for (const entry of entries) {
                            if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
                            const subPath = path.join(folder.uri.fsPath, entry.name);
                            try {
                                const repo = await getRepoRoot(subPath);
                                if (!repos.some((r) => r.repoPath === repo)) {
                                    repos.push({
                                        label: entry.name,
                                        detail: repo,
                                        repoPath: repo,
                                    });
                                }
                            } catch {
                                // Not a git repo
                            }
                        }
                    } catch {
                        // Can't read directory
                    }
                }

                // Also allow browsing for a folder
                repos.push({
                    label: "$(folder) Browse for a folder...",
                    detail: "Select a git repository from your filesystem",
                    repoPath: "__browse__",
                });

                const pick = await vscode.window.showQuickPick(repos, {
                    placeHolder: `Current: ${repoRoot}`,
                    title: "Grove: Select Git Repository",
                });

                if (!pick) return;

                let selectedPath = pick.repoPath;
                if (selectedPath === "__browse__") {
                    const uri = await vscode.window.showOpenDialog({
                        canSelectFolders: true,
                        canSelectFiles: false,
                        canSelectMany: false,
                        openLabel: "Select Git Repository",
                    });
                    if (!uri || uri.length === 0) return;
                    try {
                        selectedPath = await getRepoRoot(uri[0].fsPath);
                    } catch {
                        void vscode.window.showErrorMessage(
                            "The selected folder is not a git repository."
                        );
                        return;
                    }
                }

                await context.workspaceState.update("grove.selectedRepoRoot", selectedPath);
                void vscode.window.showInformationMessage(
                    `Grove will use '${path.basename(selectedPath)}'. Reloading...`
                );
                // Reload to re-activate with the new repo
                await vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
        )
    );

    // ── Full initialization (wrapped to guarantee commands are registered) ──
    try {
        await activateWithRepo(context, repoRoot, unifiedProvider, completedProvider);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logError("Grove failed to activate", err);
        registerStubCommands(
            context,
            "Activation failed",
            `Something went wrong during startup: ${detail}\n\nTry reloading the window (⇧⌘P → Reload Window). If this keeps happening, please report it at https://github.com/ShebinKMohan/Grove/issues`
        );
        void vscode.window.showErrorMessage(
            `Grove failed to activate: ${detail}. Try reloading the window.`
        );
    }
}

/**
 * Main activation logic — only called when a valid git repo has been found.
 * Separated so that any error here is caught by the caller and turned into
 * friendly stub commands instead of a cryptic "command not found".
 */
async function activateWithRepo(
    context: vscode.ExtensionContext,
    repoRoot: string,
    unifiedProvider: UnifiedTreeProvider,
    completedProvider: CompletedTreeProvider,
): Promise<void> {
    initTemplateManager(context.extensionPath);

    // ── Session Tracker ─────────────────────────────────────

    const sessionTracker = new SessionTracker(repoRoot, () => {
        const config = vscode.workspace.getConfiguration("grove");
        return config.get<boolean>("notifyOnSessionComplete", true);
    });

    // ── Agent Orchestrator & Overlap Detector ───────────────

    const orchestrator = new AgentOrchestrator(repoRoot, sessionTracker);

    const overlapConfig = vscode.workspace.getConfiguration("grove");
    const overlapDetector = new OverlapDetector(
        overlapConfig.get<number>("fileWatcherDebounce", 500)
    );

    // Update overlap watchers when sessions change
    context.subscriptions.push(sessionTracker.onDidChangeSessions(() => {
        const activeSessions = sessionTracker.getActiveSessions();
        if (activeSessions.length > 1) {
            overlapDetector.watchWorktrees(
                activeSessions.map((s) => ({
                    path: s.worktreePath,
                    branch: s.branch,
                }))
            );
        } else {
            overlapDetector.reset();
        }
    }));

    // Wire up tree providers with data sources
    unifiedProvider.setRepoRoot(repoRoot);
    unifiedProvider.setTracker(sessionTracker);
    unifiedProvider.setOrchestrator(orchestrator);

    completedProvider.setTracker(sessionTracker);
    completedProvider.setOrchestrator(orchestrator);

    // Initial refresh so existing worktrees show up immediately
    unifiedProvider.refresh();
    completedProvider.refresh();

    // ── Git Content Provider (for diff views) ────────────────

    // Provides file contents at a specific git ref, used by the
    // inline diff viewer to show the base branch version of a file.
    const gitContentProvider = new (class implements vscode.TextDocumentContentProvider {
        provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
            // URI format: grove-git:/<worktreePath>?ref=<ref>&file=<relativePath>
            const params = new URLSearchParams(uri.query);
            const ref = params.get("ref") ?? "HEAD";
            const file = params.get("file") ?? "";
            const cwd = uri.path;
            return git(["show", `${sanitizeRefName(ref)}:${file}`], cwd).catch(
                () => `(file did not exist in ${ref})`
            );
        }
    })();

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            "grove-git",
            gitContentProvider
        )
    );

    // grove.openFileDiff — opens VS Code's diff editor comparing
    // the base branch version of a file against the current worktree version.
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.openFileDiff",
            async (worktreePath: string, filePath: string, baseBranch: string) => {
                const currentUri = vscode.Uri.file(
                    path.join(worktreePath, filePath)
                );
                const baseUri = vscode.Uri.from({
                    scheme: "grove-git",
                    path: worktreePath,
                    query: `ref=${encodeURIComponent(baseBranch)}&file=${encodeURIComponent(filePath)}`,
                });
                const title = `${path.basename(filePath)} (${baseBranch} ↔ worktree)`;
                await vscode.commands.executeCommand(
                    "vscode.diff",
                    baseUri,
                    currentUri,
                    title
                );
            }
        )
    );

    // ── Status Bar ──────────────────────────────────────────

    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100
    );
    statusBarItem.command = "grove.quickMenu";

    async function updateStatusBar(): Promise<void> {
        const config = vscode.workspace.getConfiguration("grove");
        if (!config.get<boolean>("showStatusBarItem", true)) {
            statusBarItem.hide();
            return;
        }
        try {
            const branch = await getCurrentBranch(repoRoot);
            const worktrees = await listAllWorktrees(repoRoot);
            const activeSessionCount = sessionTracker.activeCount;
            let text = `$(git-branch) ${branch} | ${worktrees.length} wt`;
            if (activeSessionCount > 0) {
                text += ` | $(rocket) ${activeSessionCount}`;
            }
            statusBarItem.text = text;
            statusBarItem.tooltip =
                `Grove: ${worktrees.length} worktree(s)` +
                (activeSessionCount > 0
                    ? `, ${activeSessionCount} active session(s)`
                    : "") +
                "\nClick for quick menu";
            statusBarItem.show();
        } catch {
            statusBarItem.hide();
        }
    }

    // ── Refresh Helper ──────────────────────────────────────

    let isRefreshing = false;
    const refreshAll = (): void => {
        if (isRefreshing) return;
        isRefreshing = true;
        try {
            unifiedProvider.refresh();
            completedProvider.refresh();
            void updateStatusBar();
        } finally {
            isRefreshing = false;
        }
    };

    // Update status bar when sessions change
    context.subscriptions.push(
        sessionTracker.onDidChangeSessions(() => void updateStatusBar())
    );

    // ── Periodic sidebar refresh ──────────────────────────────
    // TreeView items are static — they only update on refresh().
    // Background refresh keeps worktree status, ahead/behind counts,
    // and session indicators current without manual refreshing.
    // 30s with active sessions, 60s when idle.
    let bgRefreshTimer: NodeJS.Timeout | undefined;
    function scheduleBgRefresh(): void {
        const delay = sessionTracker.activeCount > 0 ? 30_000 : 60_000;
        bgRefreshTimer = setTimeout(() => {
            refreshAll();
            scheduleBgRefresh();
        }, delay);
    }
    scheduleBgRefresh();

    context.subscriptions.push(
        { dispose: () => { if (bgRefreshTimer) clearTimeout(bgRefreshTimer); } }
    );

    // ── Workspace folder changes (add/remove worktree from Explorer) ──
    // When a worktree is added/removed as a workspace folder the tree view
    // must refresh so items stay visible and context values stay accurate.
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => refreshAll())
    );

    // ── Commands ────────────────────────────────────────────

    // Create Worktree (streamlined single-input flow)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.createWorktree",
            async () => {
                const config =
                    vscode.workspace.getConfiguration("grove");
                const defaultBase = config.get<string>(
                    "defaultBaseBranch",
                    "main"
                );

                // Step 1: Pick the base branch to create the worktree from
                const branches = await listLocalBranches(repoRoot);
                // Put the default base branch first, then current branch
                const currentBranch = await getCurrentBranch(repoRoot).catch(() => "");
                const branchItems: vscode.QuickPickItem[] = [];
                const seen = new Set<string>();

                // Default base branch first
                if (branches.includes(defaultBase)) {
                    branchItems.push({
                        label: defaultBase,
                        description: "default base branch",
                    });
                    seen.add(defaultBase);
                }
                // Current branch second (if different)
                if (currentBranch && !seen.has(currentBranch)) {
                    branchItems.push({
                        label: currentBranch,
                        description: "current branch",
                    });
                    seen.add(currentBranch);
                }
                // Rest of local branches
                for (const b of branches) {
                    if (!seen.has(b)) {
                        branchItems.push({ label: b });
                        seen.add(b);
                    }
                }

                const basePick = await vscode.window.showQuickPick(
                    branchItems,
                    {
                        placeHolder: "Select the base branch to create the worktree from",
                        title: "Grove: Base Branch",
                    }
                );
                if (!basePick) return;
                const baseBranch = basePick.label;

                // Step 2: Enter new branch name
                const branchName = await vscode.window.showInputBox({
                    prompt: `New branch name (will be created from '${baseBranch}')`,
                    placeHolder:
                        "e.g. feature/add-login or fix/bug-123",
                    title: "Grove: Create Worktree",
                    validateInput: (value) => {
                        if (!value) return "Branch name cannot be empty.";
                        return validateBranchName(value);
                    },
                });
                if (!branchName) return;

                const worktreeDir = config.get<string>(
                    "worktreeLocation",
                    ".claude/worktrees"
                );

                // Create with progress
                try {
                    const result = await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: `Creating worktree '${branchName}'...`,
                            cancellable: false,
                        },
                        async () => {
                            const pmSetting = config.get<string>("packageManager", "auto");
                            const pm = pmSetting === "auto" ? undefined : pmSetting as import("./utils/package-manager").PackageManager;
                            return createWorktree(repoRoot, branchName, {
                                startPoint: baseBranch,
                                worktreeDir,
                                autoGitignore: config.get<boolean>(
                                    "autoGitignore",
                                    true
                                ),
                                autoInstallDeps: config.get<boolean>(
                                    "autoInstallDependencies",
                                    true
                                ),
                                packageManager: pm,
                            });
                        }
                    );

                    refreshAll();

                    // Success with actions
                    const action =
                        await vscode.window.showInformationMessage(
                            `Worktree created: ${result.branch}`,
                            "Launch Claude Code",
                            "Open Terminal",
                            "Open in New Window"
                        );

                    if (action === "Launch Claude Code") {
                        await launchClaudeWithTracking(
                            result.branch,
                            result.path
                        );
                    } else if (action === "Open Terminal") {
                        openTerminal(`WT: ${result.branch}`, result.path);
                    } else if (action === "Open in New Window") {
                        await openInNewWindow(result.path);
                    }
                } catch (err) {
                    logError("Failed to create worktree", err);
                    void showAutoError(
                        formatErrorForUser(err, "Failed to create worktree")
                    );
                }
            }
        )
    );

    // Delete Worktree (context menu on single worktree)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.deleteWorktree",
            async (item?: WorktreeItem) => {
                if (!item?.worktree) return;
                const wt = item.worktree;

                if (wt.isMain) {
                    void showAutoWarning(
                        "Cannot delete the main worktree."
                    );
                    return;
                }

                // Check for active session
                if (sessionTracker.hasActiveSession(wt.path)) {
                    const confirm = await vscode.window.showWarningMessage(
                        `Worktree '${wt.branch}' has an active Claude session. Stop it and delete?`,
                        { modal: true },
                        "Stop & Delete"
                    );
                    if (confirm !== "Stop & Delete") return;

                    const session = sessionTracker.getSessionForWorktree(
                        wt.path
                    );
                    if (session) {
                        sessionTracker.stopSession(session.id);
                    }
                }

                try {
                    // Warn about uncommitted changes
                    if (
                        wt.statusSummary !== "clean" &&
                        wt.statusSummary !== "missing"
                    ) {
                        const confirm = await vscode.window.showWarningMessage(
                            `Worktree '${wt.branch}' has uncommitted changes. Delete anyway?`,
                            { modal: true },
                            "Force Delete"
                        );
                        if (confirm !== "Force Delete") return;

                        await removeWorktree(repoRoot, wt.path, {
                            deleteBranch: true,
                            force: true,
                            protectedBranches: getProtectedBranches(),
                        });
                    } else {
                        const deleteBranch =
                            await vscode.window.showWarningMessage(
                                `Delete worktree '${wt.branch}'?`,
                                { modal: true },
                                "Delete Worktree Only",
                                "Delete + Local Branch"
                            );
                        if (!deleteBranch) return;

                        await removeWorktree(repoRoot, wt.path, {
                            deleteBranch: deleteBranch === "Delete + Local Branch",
                            protectedBranches: getProtectedBranches(),
                        });
                    }

                    refreshAll();
                    void showAutoInfo(
                        `Deleted worktree: ${wt.branch}`
                    );
                } catch (err) {
                    void showAutoError(
                        formatErrorForUser(err, `Failed to delete worktree '${wt.branch}'`)
                    );
                }
            }
        )
    );

    // Cleanup Worktrees (batch cleanup wizard)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.cleanupWorktrees",
            async () => {
                let worktrees;
                try {
                    worktrees = await listAllWorktrees(repoRoot);
                } catch (err) {
                    void showAutoError(formatErrorForUser(err, "Failed to list worktrees"));
                    return;
                }
                const removable = worktrees.filter((wt) => !wt.isMain);

                if (removable.length === 0) {
                    void showAutoInfo(
                        "No worktrees to clean up."
                    );
                    return;
                }

                const items = removable.map((wt) => ({
                    label: wt.branch,
                    description: wt.statusSummary || "",
                    detail: wt.path,
                    picked: false,
                    worktree: wt,
                }));

                const picked = await vscode.window.showQuickPick(items, {
                    placeHolder: "Select worktrees to remove",
                    title: "Grove: Cleanup",
                    canPickMany: true,
                });
                if (!picked || picked.length === 0) return;

                const deleteBranches =
                    (await vscode.window.showWarningMessage(
                        "Also delete the associated branches?",
                        { modal: true },
                        "Yes"
                    )) === "Yes";

                const selected = picked.map((p) => p.worktree);
                const dirty = selected.filter(
                    (wt) =>
                        wt.statusSummary !== "clean" &&
                        wt.statusSummary !== "missing"
                );

                let force = false;
                let toRemove = selected;
                if (dirty.length > 0) {
                    force =
                        (await vscode.window.showWarningMessage(
                            `${dirty.length} worktree(s) have uncommitted changes. Force remove?`,
                            { modal: true },
                            "Yes"
                        )) === "Yes";
                    if (!force) {
                        toRemove = selected.filter(
                            (wt) =>
                                wt.statusSummary === "clean" ||
                                wt.statusSummary === "missing"
                        );
                        if (toRemove.length === 0) {
                            void showAutoInfo(
                                "No clean worktrees left to remove."
                            );
                            return;
                        }
                    }
                }

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: "Cleaning up worktrees...",
                        cancellable: false,
                    },
                    async (progress) => {
                        let removed = 0;
                        const failed: string[] = [];
                        for (const wt of toRemove) {
                            progress.report({
                                message: `Removing ${wt.branch}...`,
                                increment: 100 / toRemove.length,
                            });
                            try {
                                // Stop any active sessions first
                                const session =
                                    sessionTracker.getSessionForWorktree(
                                        wt.path
                                    );
                                if (session) {
                                    sessionTracker.stopSession(session.id);
                                }

                                await removeWorktree(repoRoot, wt.path, {
                                    deleteBranch: deleteBranches,
                                    force,
                                    protectedBranches: getProtectedBranches(),
                                });

                                removed++;
                            } catch (err) {
                                logError(
                                    `Failed to remove ${wt.branch}`,
                                    err
                                );
                                failed.push(wt.branch);
                            }
                        }
                        if (failed.length > 0) {
                            void showAutoWarning(
                                `Cleaned up ${removed} worktree(s), but ${failed.length} failed: ${failed.join(", ")}.\n\nCheck the Grove output channel for details.`
                            );
                        } else {
                            void showAutoInfo(
                                `Cleaned up ${removed} worktree(s).`
                            );
                        }
                    }
                );

                refreshAll();
            }
        )
    );

    // ── Session Launch Helper ───────────────────────────────

    async function launchClaudeWithTracking(
        branch: string,
        worktreePath: string,
        taskDescription?: string
    ): Promise<void> {
        // Check max concurrent sessions
        const config = vscode.workspace.getConfiguration("grove");
        const maxSessions = config.get<number>("maxConcurrentSessions", 5);
        if (sessionTracker.activeCount >= maxSessions) {
            void showAutoWarning(
                `Maximum concurrent sessions (${maxSessions}) reached. Stop a session first.`
            );
            return;
        }

        // Check if worktree is behind remote — warn before starting work
        try {
            const worktrees = await listAllWorktrees(repoRoot);
            const wt = worktrees.find((w) => w.path === worktreePath);
            if (wt && wt.behind > 0) {
                const action = await vscode.window.showWarningMessage(
                    `'${branch}' is ${wt.behind} commit(s) behind remote. Pull before starting to avoid conflicts.`,
                    "Sync & Continue",
                    "Continue Anyway",
                    "Cancel"
                );
                if (action === "Sync & Continue") {
                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: `Syncing ${branch}...`,
                            cancellable: false,
                        },
                        async () => {
                            await fetchRemote(repoRoot);
                            await syncWorktree(worktreePath);
                        }
                    );
                    refreshAll();
                    void showAutoInfo(`Synced '${branch}' with remote.`);
                } else if (action !== "Continue Anyway") {
                    return;
                }
            }
        } catch {
            // Non-critical — proceed even if the check fails
        }

        const task = taskDescription ?? "";

        const terminal = await launchClaude(branch, worktreePath);
        if (terminal) {
            sessionTracker.startSession(
                terminal,
                worktreePath,
                branch,
                task
            );
        }
        // launchClaude returns undefined when user cancels the session
        // prompt or when Claude is not installed (which already shows
        // its own error dialog). No additional message needed here.
    }

    // Launch Claude Code in Worktree (from worktree context menu)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.launchSession",
            async (item?: WorktreeItem) => {
                if (!item?.worktree) return;

                try {
                    // Warn if session already running for this worktree
                    if (sessionTracker.hasActiveSession(item.worktree.path)) {
                        const action = await vscode.window.showWarningMessage(
                            `A Claude session is already running in '${item.worktree.branch}'.`,
                            "Open Terminal",
                            "Launch Another",
                            "Cancel"
                        );
                        if (action === "Open Terminal") {
                            const session = sessionTracker.getSessionForWorktree(
                                item.worktree.path
                            );
                            if (session) {
                                const terminal =
                                    sessionTracker.getTerminalForSession(
                                        session.id
                                    );
                                if (terminal) {
                                    terminal.show();
                                    return;
                                }
                            }
                        } else if (action !== "Launch Another") {
                            return;
                        }
                    }

                    await launchClaudeWithTracking(
                        item.worktree.branch,
                        item.worktree.path
                    );
                } catch (err) {
                    void showAutoError(
                        formatErrorForUser(err, "Failed to launch Claude session")
                    );
                }
            }
        )
    );

    // Stop Session (from session context menu)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.stopSession",
            async (item?: SessionItem) => {
                if (!item?.session) return;

                if (
                    item.session.status !== "running" &&
                    item.session.status !== "idle"
                ) {
                    return;
                }

                const confirm = await vscode.window.showWarningMessage(
                    `Stop Claude session for '${item.session.branch}'?`,
                    { modal: true },
                    "Stop"
                );
                if (confirm !== "Stop") return;

                try {
                    sessionTracker.stopSession(item.session.id);
                } catch (err) {
                    void showAutoError(
                        formatErrorForUser(err, "Failed to stop session")
                    );
                }
            }
        )
    );

    // Stop All Sessions
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.stopAllSessions",
            async () => {
                const count = sessionTracker.activeCount;
                if (count === 0) {
                    void showAutoInfo(
                        "No active sessions."
                    );
                    return;
                }

                const confirm = await vscode.window.showWarningMessage(
                    `Stop all ${count} active session(s)?`,
                    { modal: true },
                    "Stop All"
                );
                if (confirm !== "Stop All") return;

                try {
                    sessionTracker.stopAllSessions();
                    void showAutoInfo(
                        `Stopped ${count} session(s).`
                    );
                } catch (err) {
                    void showAutoError(
                        formatErrorForUser(err, "Failed to stop sessions")
                    );
                }
            }
        )
    );

    // Focus Session Terminal (from session context menu)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.focusSession",
            (item?: SessionItem) => {
                if (!item?.session) return;
                const terminal = sessionTracker.getTerminalForSession(
                    item.session.id
                );
                if (terminal) {
                    terminal.show();
                } else {
                    void showAutoWarning(
                        "Terminal no longer available."
                    );
                }
            }
        )
    );

    // Set Task Description (from session context menu)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.setTaskDescription",
            async (item?: SessionItem) => {
                if (!item?.session) return;

                const desc = await vscode.window.showInputBox({
                    prompt: "Update task description",
                    value: item.session.taskDescription,
                    title: "Grove: Task Description",
                });
                if (desc === undefined) return;

                try {
                    sessionTracker.setTaskDescription(item.session.id, desc);
                } catch (err) {
                    void showAutoError(
                        formatErrorForUser(err, "Failed to update task description")
                    );
                }
            }
        )
    );

    // Clear Completed Sessions
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.clearCompletedSessions",
            () => {
                sessionTracker.clearCompletedSessions();
            }
        )
    );

    // Open in Terminal
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.openInTerminal",
            async (item?: WorktreeItem) => {
                if (!item?.worktree) return;
                try {
                    openTerminal(
                        `WT: ${item.worktree.branch}`,
                        item.worktree.path
                    );
                } catch (err) {
                    void showAutoError(
                        formatErrorForUser(err, "Failed to open terminal")
                    );
                }
            }
        )
    );

    // Open in New Window
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.openInNewWindow",
            async (item?: WorktreeItem) => {
                if (!item?.worktree) return;
                try {
                    await openInNewWindow(item.worktree.path);
                } catch (err) {
                    void showAutoError(
                        formatErrorForUser(err, "Failed to open new window")
                    );
                }
            }
        )
    );

    // View Diff
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.viewDiff",
            async (item?: WorktreeItem) => {
                if (!item?.worktree) return;
                try {
                    if (!fs.existsSync(item.worktree.path)) {
                        void showAutoWarning(
                            `Worktree directory no longer exists: ${item.worktree.branch}`
                        );
                        return;
                    }
                    const config = vscode.workspace.getConfiguration(
                        "grove"
                    );
                    const baseBranch = config.get<string>(
                        "defaultBaseBranch",
                        "main"
                    );
                    const safeBranch = sanitizeRefName(baseBranch);
                    const terminal = openTerminal(
                        `Diff: ${item.worktree.branch}`,
                        item.worktree.path
                    );
                    if (item.worktree.isMain) {
                        terminal.sendText(
                            `git diff --stat && echo "" && git diff --cached --stat`
                        );
                    } else {
                        terminal.sendText(
                            `git diff ${safeBranch}...HEAD --stat`
                        );
                    }
                } catch (err) {
                    void showAutoError(
                        formatErrorForUser(err, "Failed to view diff")
                    );
                }
            }
        )
    );

    // Sync Worktree — pull latest from remote
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.syncWorktree",
            async (item?: WorktreeItem) => {
                if (!item?.worktree) return;
                const wt = item.worktree;

                try {
                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: `Syncing ${wt.branch}...`,
                            cancellable: false,
                        },
                        async () => {
                            // Fetch first so we have the latest remote refs
                            await fetchRemote(repoRoot);
                            await syncWorktree(wt.path);
                        }
                    );
                    refreshAll();
                    void showAutoInfo(
                        `Synced '${wt.branch}' with remote.`
                    );
                } catch (err) {
                    const raw = err instanceof Error ? err.message : String(err);
                    if (raw.includes("no tracking information")) {
                        void showAutoWarning(
                            `Branch '${wt.branch}' has no remote tracking branch.\n\nFix: Push it first with: git push -u origin ${wt.branch}`
                        );
                    } else if (raw.includes("conflict")) {
                        void showAutoWarning(
                            `Rebase conflict while syncing '${wt.branch}'.\n\nFix: Resolve the conflict in the terminal that just opened, then run 'git rebase --continue'.`
                        );
                        openTerminal(`Sync: ${wt.branch}`, wt.path);
                    } else {
                        void showAutoError(
                            formatErrorForUser(err, `Failed to sync '${wt.branch}'`)
                        );
                    }
                }
            }
        )
    );

    // Push Worktree — push commits to remote
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.pushWorktree",
            async (item?: WorktreeItem) => {
                if (!item?.worktree) return;
                const wt = item.worktree;

                try {
                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: `Pushing ${wt.branch}...`,
                            cancellable: false,
                        },
                        async () => {
                            await gitWrite(
                                ["push", "-u", "origin", wt.branch],
                                wt.path
                            );
                        }
                    );
                    refreshAll();
                    void showAutoInfo(
                        `Pushed '${wt.branch}' to remote.`
                    );
                } catch (err) {
                    const raw = err instanceof Error ? err.message : String(err);
                    if (raw.includes("rejected") || raw.includes("non-fast-forward")) {
                        void showAutoWarning(
                            `Push rejected for '${wt.branch}'. Remote has changes you don't have.\n\nFix: Sync from remote first, then push again.`
                        );
                    } else {
                        void showAutoError(
                            formatErrorForUser(err, `Failed to push '${wt.branch}'`)
                        );
                    }
                }
            }
        )
    );

    // Refresh Sidebar — fetches remote refs so behind counts are up to date
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.refreshSidebar",
            async () => {
                try {
                    await fetchRemote(repoRoot);
                } catch {
                    // Non-critical — refresh even if fetch fails (offline, etc.)
                }
                refreshAll();
            }
        )
    );


    // Open Dashboard
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.openDashboard",
            () => {
                DashboardPanel.createOrShow(
                    context.extensionUri,
                    repoRoot,
                    sessionTracker,
                    overlapDetector
                );
            }
        )
    );

    // Quick Menu (status bar click)
    context.subscriptions.push(
        vscode.commands.registerCommand("grove.quickMenu", async () => {
            try {
                const items: Array<vscode.QuickPickItem & { commandId: string }> = [
                    { label: "$(add) Create Worktree", commandId: "grove.createWorktree" },
                    { label: "$(organization) Launch Agent Team", commandId: "grove.launchTeam" },
                    { label: "$(dashboard) Open Dashboard", commandId: "grove.openDashboard" },
                ];

                if (sessionTracker.activeCount > 0) {
                    items.push(
                        { label: "$(debug-stop) Stop All Sessions", commandId: "grove.stopAllSessions" },
                    );
                }

                items.push(
                    { label: "$(shield) Check File Overlaps", commandId: "grove.runOverlapCheck" },
                    { label: "$(checklist) Generate Merge Report", commandId: "grove.generateMergeReport" },
                    { label: "$(merge) Execute Merge Sequence", commandId: "grove.executeMergeSequence" },
                );

                const picked = await vscode.window.showQuickPick(items, {
                    placeHolder: `Grove (${sessionTracker.activeCount} active sessions)`,
                });
                if (picked) {
                    await vscode.commands.executeCommand(picked.commandId);
                }
            } catch (err) {
                void showAutoError(
                    formatErrorForUser(err, "Quick menu error")
                );
            }
        })
    );

    // ── Team Commands ─────────────────────────────────────────

    // Launch Agent Team
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.launchTeam",
            async () => {
                try {
                    const config = vscode.workspace.getConfiguration("grove");
                    const templateDir = config.get<string>(
                        "templateDirectory",
                        ".grove/templates"
                    );

                    // 1. Pick a template
                    const templateList = listTemplateNames(repoRoot, templateDir);
                    if (templateList.length === 0) {
                        void showAutoWarning(
                            "No team templates found. Create one with " +
                            "'Grove: Create Team Template'."
                        );
                        return;
                    }

                    const templatePick = await vscode.window.showQuickPick(
                        templateList.map((t) => ({
                            label: t.name,
                            description: `(${t.source})`,
                            detail: t.description,
                        })),
                        {
                            placeHolder: "Select a team template",
                            title: "Grove: Launch Agent Team",
                        }
                    );
                    if (!templatePick) return;

                    const template = loadTemplate(
                        templatePick.label,
                        repoRoot,
                        templateDir
                    );
                    if (!template) {
                        void showAutoError(
                            `Failed to load template '${templatePick.label}'.\n\nThe template file may be corrupted or contain invalid JSON. Check the .grove/templates/ directory and the Grove output channel for details.`
                        );
                        return;
                    }

                    // 2. Get task description
                    const taskDescription = await vscode.window.showInputBox({
                        prompt: "What should this team work on?",
                        placeHolder: "e.g., Implement user authentication with JWT and OAuth",
                        title: "Grove: Task Description",
                    });
                    if (taskDescription === undefined) return;

                    // 3. Get team name
                    const teamName = await vscode.window.showInputBox({
                        prompt: "Team name (used for branch naming)",
                        placeHolder: "e.g., auth-feature",
                        title: "Grove: Team Name",
                        validateInput: (value) => {
                            if (!value) return "Team name is required.";
                            if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
                                return "Use letters, numbers, dots, hyphens, underscores.";
                            }
                            return null;
                        },
                    });
                    if (!teamName) return;

                    // 4. Pre-flight checks
                    const preflight = orchestrator.preFlight(template);

                    // Show overlaps if any
                    if (preflight.overlaps.length > 0) {
                        const overlapMsg = preflight.overlaps
                            .map((o) => `  ${o.pattern}: ${o.agents.join(", ")}`)
                            .join("\n");
                        const proceed = await vscode.window.showWarningMessage(
                            `Ownership overlaps detected:\n${overlapMsg}`,
                            { modal: true },
                            "Continue Anyway"
                        );
                        if (proceed !== "Continue Anyway") return;
                    }

                    // Show non-overlap warnings (always, even if overlaps were shown)
                    const nonOverlapWarnings = preflight.warnings.filter(
                        (w) => !w.toLowerCase().includes("overlap")
                    );
                    if (nonOverlapWarnings.length > 0) {
                        const proceed = await vscode.window.showWarningMessage(
                            nonOverlapWarnings.join("\n"),
                            { modal: true },
                            "Continue"
                        );
                        if (proceed !== "Continue") return;
                    }

                    // 5. Confirmation
                    const showEstimates = config.get<boolean>(
                        "showTokenEstimates",
                        true
                    );
                    const confirmMsg =
                        `Launch "${template.name}" team "${teamName}"?\n\n` +
                        `• ${template.agents.length} agents / worktrees\n` +
                        `• Task: ${taskDescription || "(none)"}` +
                        (showEstimates
                            ? `\n• Estimated tokens: ${preflight.estimatedTokens}`
                            : "");

                    const confirm = await vscode.window.showInformationMessage(
                        confirmMsg,
                        { modal: true },
                        "Launch Team"
                    );
                    if (confirm !== "Launch Team") return;

                    // 6. Launch (orchestrator manages its own progress + cancellation)
                    const team = await orchestrator.launchTeam(
                        template,
                        taskDescription || "",
                        teamName
                    );

                    if (team && team.status !== "cancelled") {
                        refreshAll();

                        const running = team.agents.filter(
                            (a) => a.status === "running"
                        ).length;
                        void showAutoInfo(
                            `Team "${teamName}" launched: ${running}/${template.agents.length} agents running.`
                        );

                        // Auto-open dashboard after team launch
                        DashboardPanel.createOrShow(
                            context.extensionUri,
                            repoRoot,
                            sessionTracker,
                            overlapDetector
                        );
                    } else if (team) {
                        refreshAll();
                    }
                } catch (err) {
                    logError("Team launch failed", err);
                    void showAutoError(
                        formatErrorForUser(err, "Team launch failed")
                    );
                }
            }
        )
    );

    // Stop Team (from team context menu)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.stopTeam",
            async (item?: { team?: { id: string; name: string } }) => {
                const teamId = item?.team?.id;
                if (!teamId) return;

                const confirm = await vscode.window.showWarningMessage(
                    `Stop all agents in team "${item.team?.name}"?`,
                    { modal: true },
                    "Stop Team"
                );
                if (confirm !== "Stop Team") return;

                try {
                    orchestrator.stopTeam(teamId);
                    refreshAll();
                } catch (err) {
                    void showAutoError(
                        formatErrorForUser(err, "Failed to stop team")
                    );
                }
            }
        )
    );

    // Stop Agent (from agent context menu in team tree)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.stopAgent",
            async (item?: AgentItem) => {
                if (!item?.agentState || !item.teamId) return;

                try {
                    orchestrator.stopAgent(item.teamId, item.agentState.role);
                    refreshAll();
                } catch (err) {
                    void showAutoError(
                        formatErrorForUser(err, "Failed to stop agent")
                    );
                }
            }
        )
    );

    // Focus Agent Terminal (from agent context menu in team tree)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.focusAgent",
            (item?: AgentItem) => {
                if (!item?.agentState?.sessionId) return;

                const terminal = sessionTracker.getTerminalForSession(
                    item.agentState.sessionId
                );
                if (terminal) {
                    terminal.show();
                } else {
                    void showAutoWarning(
                        "Terminal no longer available."
                    );
                }
            }
        )
    );

    // Cleanup Team (remove worktrees after merge)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.cleanupTeam",
            async (item?: { team?: { id: string; name: string } }) => {
                const teamId = item?.team?.id;
                if (!teamId) return;

                const confirm = await vscode.window.showWarningMessage(
                    `Delete all worktrees for team "${item.team?.name}"? This cannot be undone.`,
                    { modal: true },
                    "Delete Worktrees"
                );
                if (confirm !== "Delete Worktrees") return;

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Cleaning up team "${item.team?.name}"...`,
                        cancellable: false,
                    },
                    async () => {
                        try {
                            await orchestrator.cleanupTeam(teamId);
                        } catch (err) {
                            logError("Team cleanup failed", err);
                            void showAutoError(
                                formatErrorForUser(err, "Team cleanup failed")
                            );
                        }
                        refreshAll();
                    }
                );
            }
        )
    );

    // Run Overlap Check (manual scan)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.runOverlapCheck",
            async () => {
                try {
                    const activeSessions = sessionTracker.getActiveSessions();
                    if (activeSessions.length < 2) {
                        void showAutoInfo(
                            "Need at least 2 active sessions to check for overlaps."
                        );
                        return;
                    }

                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: "Scanning for file overlaps...",
                            cancellable: false,
                        },
                        async () => {
                            const config = vscode.workspace.getConfiguration("grove");
                            const baseBranch = config.get<string>("defaultBaseBranch", "main");

                            await overlapDetector.scanExistingChanges(
                                activeSessions.map((s) => ({
                                    path: s.worktreePath,
                                    branch: s.branch,
                                })),
                                baseBranch
                            );

                            const count = overlapDetector.activeOverlapCount;
                            if (count > 0) {
                                const action = await vscode.window.showWarningMessage(
                                    `Found ${count} file overlap(s) across worktrees.`,
                                    "Open Dashboard"
                                );
                                if (action === "Open Dashboard") {
                                    DashboardPanel.createOrShow(
                                        context.extensionUri,
                                        repoRoot,
                                        sessionTracker,
                                        overlapDetector
                                    );
                                }
                            } else {
                                void showAutoInfo(
                                    "No file overlaps detected."
                                );
                            }
                        }
                    );
                } catch (err) {
                    logError("Overlap check failed", err);
                    void showAutoError(
                        formatErrorForUser(err, "Overlap check failed")
                    );
                }
            }
        )
    );

    // ── Merge Commands ─────────────────────────────────────

    // Generate Merge Report
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.generateMergeReport",
            async () => {
                try {
                    const worktrees = await listAllWorktrees(repoRoot);
                    const nonMain = worktrees.filter((wt) => !wt.isMain);

                    if (nonMain.length === 0) {
                        void showAutoInfo(
                            "No worktrees to generate a merge report for."
                        );
                        return;
                    }

                    // Let user select which worktrees to include
                    const picks = await vscode.window.showQuickPick(
                        nonMain.map((wt) => ({
                            label: wt.branch,
                            description: mergePickDescription(wt.status, wt.statusSummary),
                            detail: wt.path,
                            picked: true,
                            worktree: wt,
                        })),
                        {
                            placeHolder: "Select worktrees to include in merge report",
                            title: "Grove: Merge Report",
                            canPickMany: true,
                        }
                    );
                    if (!picks || picks.length === 0) return;

                    const config = vscode.workspace.getConfiguration("grove");
                    const baseBranch = config.get<string>("defaultBaseBranch", "main");

                    const report = await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: "Generating merge report...",
                            cancellable: false,
                        },
                        async () =>
                            generateMergeReport(
                                picks.map((p) => p.worktree.path),
                                baseBranch
                            )
                    );

                    // Show report in a new untitled markdown document
                    const markdown = formatMergeReportMarkdown(report);
                    const doc = await vscode.workspace.openTextDocument({
                        content: markdown,
                        language: "markdown",
                    });
                    await vscode.window.showTextDocument(doc, {
                        preview: true,
                        viewColumn: vscode.ViewColumn.One,
                    });

                    // Summary notification
                    const overlapCount = report.overlaps.length;
                    const conflictCount = report.conflictPredictions.reduce(
                        (sum, p) => sum + p.conflictFiles.length, 0
                    );
                    const baseOverlapCount = report.conflictPredictions.reduce(
                        (sum, p) => sum + p.baseOverlapFiles.length, 0
                    );

                    if (conflictCount > 0) {
                        void vscode.window.showWarningMessage(
                            `Merge report ready. ${conflictCount} merge conflict(s) predicted against ${baseBranch}! Review the report before merging.`
                        );
                    } else if (baseOverlapCount > 0) {
                        void vscode.window.showWarningMessage(
                            `Merge report ready. ${baseOverlapCount} file(s) changed on both base and branch — check the report for potential conflicts.`
                        );
                    } else if (overlapCount > 0) {
                        void showAutoInfo(
                            `Merge report ready. ${overlapCount} worktree-to-worktree overlap(s) detected.`
                        );
                    } else {
                        void showAutoInfo("Merge report ready. No conflicts detected.");
                    }
                } catch (err) {
                    logError("Merge report generation failed", err);
                    void showAutoError(
                        formatErrorForUser(err, "Merge report failed")
                    );
                }
            }
        )
    );

    // Execute Merge Sequence
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "grove.executeMergeSequence",
            async () => {
                try {
                    const worktrees = await listAllWorktrees(repoRoot);
                    const nonMain = worktrees.filter((wt) => !wt.isMain);

                    if (nonMain.length === 0) {
                        void showAutoInfo(
                            "No worktrees to merge."
                        );
                        return;
                    }

                    const config = vscode.workspace.getConfiguration("grove");
                    const baseBranch = config.get<string>("defaultBaseBranch", "main");

                    // Select worktrees — numbered to show merge order, with merge direction
                    const picks = await vscode.window.showQuickPick(
                        nonMain.map((wt, i) => ({
                            label: `${i + 1}. ${wt.branch} \u2192 ${baseBranch}`,
                            description: mergePickDescription(wt.status, wt.statusSummary),
                            detail: wt.path,
                            picked: true,
                            worktree: wt,
                        })),
                        {
                            placeHolder: "Select and reorder worktrees to merge sequentially",
                            title: "Grove: Merge Sequence",
                            canPickMany: true,
                        }
                    );
                    if (!picks || picks.length === 0) return;

                    const total = picks.length;

                    // Detect test command
                    let testCmd = config.get<string>("testCommand", "");
                    if (!testCmd) {
                        testCmd = detectTestCommand(repoRoot) ?? "";
                    }

                    const runTestsAfterMerge = testCmd
                        ? (await vscode.window.showQuickPick(
                              [
                                  { label: "Yes", description: `Run: ${testCmd}`, value: true },
                                  { label: "No", description: "Skip tests", value: false },
                              ],
                              {
                                  placeHolder: "Run tests after each merge?",
                                  title: "Grove: Test After Merge",
                              }
                          ))?.value ?? false
                        : false;

                    // ── Pre-Merge Conflict Prediction ──
                    const report = await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: "Checking for merge conflicts...",
                            cancellable: false,
                        },
                        async () =>
                            generateMergeReport(
                                picks.map((p) => p.worktree.path),
                                baseBranch
                            )
                    );

                    const predictedConflicts = report.conflictPredictions.filter(
                        (p) => p.conflictFiles.length > 0
                    );
                    const baseOverlaps = report.conflictPredictions.filter(
                        (p) => p.baseOverlapFiles.length > 0
                    );

                    if (predictedConflicts.length > 0) {
                        const conflictDetails = predictedConflicts.map((p) =>
                            `${p.branch}: ${p.conflictFiles.join(", ")}`
                        ).join("\n");
                        const proceed = await vscode.window.showWarningMessage(
                            `Merge conflicts predicted!\n\n${conflictDetails}\n\nThese branches will conflict with ${baseBranch}. You can proceed and resolve manually, or abort and fix first.`,
                            { modal: true },
                            "Proceed Anyway",
                            "Generate Report"
                        );
                        if (proceed === "Generate Report") {
                            const markdown = formatMergeReportMarkdown(report);
                            const doc = await vscode.workspace.openTextDocument({
                                content: markdown,
                                language: "markdown",
                            });
                            await vscode.window.showTextDocument(doc, {
                                preview: true,
                                viewColumn: vscode.ViewColumn.One,
                            });
                            return;
                        }
                        if (proceed !== "Proceed Anyway") return;
                    } else if (baseOverlaps.length > 0) {
                        const overlapDetails = baseOverlaps.map((p) =>
                            `${p.branch}: ${p.baseOverlapFiles.length} shared file(s)`
                        ).join("\n");
                        const proceed = await vscode.window.showWarningMessage(
                            `Some files were changed on both ${baseBranch} and these branches since they diverged:\n\n${overlapDetails}\n\nThey may merge cleanly or may require manual resolution.`,
                            { modal: true },
                            "Continue",
                            "Generate Report"
                        );
                        if (proceed === "Generate Report") {
                            const markdown = formatMergeReportMarkdown(report);
                            const doc = await vscode.workspace.openTextDocument({
                                content: markdown,
                                language: "markdown",
                            });
                            await vscode.window.showTextDocument(doc, {
                                preview: true,
                                viewColumn: vscode.ViewColumn.One,
                            });
                            return;
                        }
                        if (proceed !== "Continue") return;
                    }

                    // Confirmation — show the numbered merge plan
                    const planLines = picks.map((p, i) =>
                        `${i + 1}. ${p.worktree.branch} \u2192 ${baseBranch}`
                    ).join("\n");
                    const confirmMsg =
                        `Merge ${total} branch(es) into ${baseBranch} in this order?\n\n${planLines}`;
                    const confirm = await vscode.window.showWarningMessage(
                        confirmMsg,
                        { modal: true },
                        "Start Merge"
                    );
                    if (confirm !== "Start Merge") return;

                    // ── Pre-Merge Safety: check for active sessions ──
                    const worktreePathsToMerge = picks.map((p) => p.worktree.path);
                    const activeSessionsInMerge = sessionTracker
                        .getActiveSessions()
                        .filter((s) => worktreePathsToMerge.includes(s.worktreePath));

                    if (activeSessionsInMerge.length > 0) {
                        const sessionAction = await vscode.window.showWarningMessage(
                            `${activeSessionsInMerge.length} agent session(s) are still running in worktrees being merged. Stop them before merging.`,
                            "Stop All & Continue",
                            "Cancel"
                        );
                        if (sessionAction === "Stop All & Continue") {
                            for (const session of activeSessionsInMerge) {
                                sessionTracker.stopSession(session.id);
                            }
                        } else {
                            return;
                        }
                    }

                    // Save all open files before merging
                    await vscode.workspace.saveAll(false);

                    // Pre-flight: ensure repo is in a clean state
                    const repoState = await checkRepoState(repoRoot);
                    if (!repoState.clean) {
                        void showAutoError(
                            `Cannot start merge: ${repoState.reason}`
                        );
                        return;
                    }

                    // Auto-commit uncommitted changes in each worktree before merging.
                    // Only stage tracked files (git add -u) to avoid committing
                    // generated CLAUDE.md, .env files, or other untracked artifacts.
                    for (const pick of picks) {
                        const wtPath = pick.worktree.path;
                        try {
                            const status = await git(["status", "--porcelain"], wtPath);
                            if (status.trim().length > 0) {
                                await gitWrite(["add", "-u"], wtPath);
                                // Check if there's actually anything staged after -u
                                const staged = await git(["diff", "--cached", "--name-only"], wtPath);
                                if (staged.trim().length > 0) {
                                    await gitWrite(
                                        ["commit", "-m", "Grove: auto-commit agent changes"],
                                        wtPath
                                    );
                                    log(`Auto-committed changes in ${pick.worktree.branch}`);
                                }
                            }
                        } catch (err) {
                            logError(`Failed to auto-commit in ${pick.worktree.branch}`, err);
                        }
                    }

                    // ── Capture pre-merge state for abort recovery ───
                    const preMergeHash = (await git(["rev-parse", "HEAD"], repoRoot)).trim();
                    const mergedBranches: string[] = [];
                    const results: Array<{ branch: string; status: string; message: string }> = [];

                    // ── Execute merges inside a single progress notification ──
                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: "Grove: Merge Sequence",
                            cancellable: false,
                        },
                        async (progress) => {
                    for (let i = 0; i < total; i++) {
                        const pick = picks[i];
                        const branch = pick.worktree.branch;
                        const stepLabel = `${i + 1}/${total}: ${branch} \u2192 ${baseBranch}`;

                        progress.report({
                            message: `Merging ${stepLabel}...`,
                            increment: (1 / total) * 100,
                        });

                        const step = await executeMergeStep(repoRoot, branch, baseBranch);

                        if (step.status === "conflict") {
                            progress.report({ message: `Step ${i + 1}/${total} \u2014 conflict in ${branch}` });

                            const action = await vscode.window.showWarningMessage(
                                `Step ${i + 1}/${total} conflict: ${branch} \u2192 ${baseBranch}\n\nConflicting files: ${step.conflictFiles?.join(", ")}`,
                                { modal: true },
                                "Open Terminal to Resolve",
                                "Abort Merge",
                                "Skip This Branch"
                            );

                            if (action === "Open Terminal to Resolve") {
                                const terminal = openTerminal(
                                    `Resolve: ${branch}`,
                                    repoRoot
                                );
                                terminal.sendText("git status");

                                await vscode.window.showInformationMessage(
                                    "Resolve conflicts in the terminal, commit, then click Continue.",
                                    { modal: true },
                                    "Continue"
                                );

                                // Verify conflicts are actually resolved
                                const postResolveState = await checkRepoState(repoRoot);
                                if (!postResolveState.clean) {
                                    const forceAction = await vscode.window.showWarningMessage(
                                        `Conflicts may not be fully resolved: ${postResolveState.reason}`,
                                        { modal: true },
                                        "Continue Anyway",
                                        "Abort Merge"
                                    );
                                    if (forceAction !== "Continue Anyway") {
                                        try { await abortMerge(repoRoot); } catch { /* already resolved */ }
                                        results.push({ branch, status: "aborted", message: "Merge aborted \u2014 conflicts unresolved" });
                                        const prev = mergedBranches.length > 0 ? ` Previously merged: ${mergedBranches.join(", ")}.` : "";
                                        void showAutoInfo(
                                            `Step ${i + 1}/${total} aborted: ${branch}.${prev} To undo all merges: git reset --hard ${preMergeHash}`,
                                            20_000
                                        );
                                        break;
                                    }
                                }

                                mergedBranches.push(branch);
                                results.push({ branch, status: "resolved", message: "Conflicts resolved manually" });
                                progress.report({ message: `Step ${i + 1}/${total} \u2014 ${branch} resolved` });
                            } else if (action === "Abort Merge") {
                                try { await abortMerge(repoRoot); } catch { /* no merge in progress */ }
                                results.push({ branch, status: "aborted", message: "Merge aborted" });
                                const prev = mergedBranches.length > 0 ? ` Previously merged: ${mergedBranches.join(", ")}.` : "";
                                void showAutoInfo(
                                    `Step ${i + 1}/${total} aborted: ${branch}.${prev} To undo all merges: git reset --hard ${preMergeHash}`,
                                    20_000
                                );
                                break;
                            } else {
                                try { await abortMerge(repoRoot); } catch { /* no merge in progress */ }
                                results.push({ branch, status: "skipped", message: "Skipped due to conflict" });
                                progress.report({ message: `Step ${i + 1}/${total} \u2014 ${branch} skipped` });
                                continue;
                            }
                        } else if (step.status === "error") {
                            // Clean up any partial merge state before continuing
                            try { await abortMerge(repoRoot); } catch { /* no merge in progress */ }
                            results.push({ branch, status: "error", message: step.message ?? "Unknown error" });
                            progress.report({ message: `Step ${i + 1}/${total} \u2014 ${branch} failed` });

                            const action = await vscode.window.showErrorMessage(
                                `Step ${i + 1}/${total} failed: ${branch} \u2192 ${baseBranch}\n\n${step.message}`,
                                "Continue",
                                "Abort"
                            );
                            if (action !== "Continue") {
                                const prev = mergedBranches.length > 0 ? ` Previously merged: ${mergedBranches.join(", ")}.` : "";
                                void showAutoInfo(
                                    `Merge sequence stopped at step ${i + 1}/${total}: ${branch}.${prev} To undo all merges: git reset --hard ${preMergeHash}`,
                                    20_000
                                );
                                break;
                            }
                            continue;
                        } else {
                            mergedBranches.push(branch);
                            results.push({ branch, status: "merged", message: "Clean merge" });
                            progress.report({ message: `Step ${i + 1}/${total} \u2014 ${branch} \u2713` });
                        }

                        // Run tests if configured
                        if (runTestsAfterMerge && testCmd) {
                            progress.report({ message: `Testing after ${stepLabel}...` });
                            const testResult = await runTests(repoRoot, testCmd);

                            if (!testResult.passed) {
                                progress.report({ message: `Step ${i + 1}/${total} \u2014 tests failed after ${branch}` });
                                const action = await vscode.window.showWarningMessage(
                                    `Tests failed after step ${i + 1}/${total}: ${branch} \u2192 ${baseBranch}`,
                                    { modal: true },
                                    "Continue Anyway",
                                    "Open Terminal",
                                    "Abort"
                                );

                                if (action === "Open Terminal") {
                                    openTerminal(`Tests: ${branch}`, repoRoot);
                                    const postFix = await vscode.window.showInformationMessage(
                                        "Investigate the test failure in the terminal, then decide how to proceed.",
                                        { modal: true },
                                        "Continue",
                                        "Abort"
                                    );
                                    if (postFix === "Abort" || !postFix) {
                                        results[results.length - 1].status = "test-failed";
                                        const prev = mergedBranches.length > 0 ? ` Previously merged: ${mergedBranches.join(", ")}.` : "";
                                        void showAutoInfo(
                                            `Merge sequence stopped at step ${i + 1}/${total} (test failure): ${branch}.${prev} To undo all merges: git reset --hard ${preMergeHash}`,
                                            20_000
                                        );
                                        break;
                                    }
                                } else if (action === "Abort" || !action) {
                                    results[results.length - 1].status = "test-failed";
                                    const prev = mergedBranches.length > 0 ? ` Previously merged: ${mergedBranches.join(", ")}.` : "";
                                    void showAutoInfo(
                                        `Merge sequence stopped at step ${i + 1}/${total} (test failure): ${branch}.${prev} To undo all merges: git reset --hard ${preMergeHash}`,
                                        20_000
                                    );
                                    break;
                                }
                            }
                        }
                    }
                        }
                    );

                    // Show summary
                    const succeeded = results.filter(
                        (r) => r.status === "merged" || r.status === "resolved"
                    ).length;
                    const failed = results.filter(
                        (r) => r.status === "error" || r.status === "test-failed"
                    ).length;
                    const skipped = results.filter(
                        (r) => r.status === "skipped" || r.status === "aborted"
                    ).length;

                    // Build per-step summary
                    const stepLines = results.map((r, i) => {
                        const icon = (r.status === "merged" || r.status === "resolved") ? "\u2713"
                            : (r.status === "error" || r.status === "test-failed") ? "\u2717"
                            : "\u2014";
                        return `${icon} ${i + 1}. ${r.branch} \u2192 ${baseBranch}: ${r.message}`;
                    }).join("\n");

                    const summary =
                        `Merge complete: ${succeeded} succeeded` +
                        (failed > 0 ? `, ${failed} failed` : "") +
                        (skipped > 0 ? `, ${skipped} skipped` : "") +
                        `\n\n${stepLines}`;

                    // Offer cleanup
                    if (succeeded > 0) {
                        const cleanup = await vscode.window.showInformationMessage(
                            summary,
                            "Cleanup Merged Worktrees",
                            "Keep Worktrees"
                        );
                        if (cleanup === "Cleanup Merged Worktrees") {
                            const mergedPicks = picks.filter((_, i) =>
                                results[i]?.status === "merged" || results[i]?.status === "resolved"
                            );
                            await postMergeCleanup(
                                repoRoot,
                                mergedPicks.map((p) => ({
                                    path: p.worktree.path,
                                    branch: p.worktree.branch,
                                })),
                                { protectedBranches: getProtectedBranches() }
                            );
                            refreshAll();
                        }
                    } else {
                        void showAutoInfo(summary);
                    }

                    refreshAll();
                } catch (err) {
                    logError("Merge sequence failed", err);
                    void showAutoError(
                        formatErrorForUser(err, "Merge sequence failed")
                    );
                }
            }
        )
    );

    // ── File Watcher for auto-refresh ───────────────────────

    const gitWorktreesPattern = new vscode.RelativePattern(
        repoRoot,
        ".git/worktrees/*/HEAD"
    );
    const watcher =
        vscode.workspace.createFileSystemWatcher(gitWorktreesPattern);
    let refreshTimeout: NodeJS.Timeout | undefined;
    const debouncedRefresh = (): void => {
        if (refreshTimeout) clearTimeout(refreshTimeout);
        refreshTimeout = setTimeout(refreshAll, 2000);
    };
    watcher.onDidCreate(debouncedRefresh);
    watcher.onDidDelete(debouncedRefresh);
    watcher.onDidChange(debouncedRefresh);

    // ── Register disposables ────────────────────────────────

    context.subscriptions.push(
        unifiedProvider,
        completedProvider,
        sessionTracker,
        orchestrator,
        overlapDetector,
        statusBarItem,
        watcher,
        { dispose: () => { if (refreshTimeout) clearTimeout(refreshTimeout); } }
    );

    // Initial status bar update
    await updateStatusBar();

    log("Grove activated successfully");
}

export function deactivate(): void {
    disposeLogger();
}
