/**
 * Dashboard WebView Panel — creates and manages the React-based
 * dashboard inside a VS Code WebView tab.
 *
 * Handles:
 * - HTML scaffolding with CSP
 * - Bi-directional message passing (extension ↔ React app)
 * - File activity watchers for active worktree directories
 * - Periodic state sync with the React app
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { SessionTracker } from "../../core/session-tracker";
import { sanitizeRefName } from "../../utils/git";
import { OverlapDetector } from "../../core/overlap-detector";
import { listAllWorktrees } from "../../core/worktree-manager";
import { openTerminal } from "../../utils/terminal";
import { log, logError } from "../../utils/logger";

/** Serializable session info for the WebView */
interface WebViewSessionInfo {
    id: string;
    worktreePath: string;
    branch: string;
    taskDescription: string;
    startedAt: string;
    endedAt?: string;
    status: string;
    exitCode?: number;
    modifiedFiles: string[];
}

/** Serializable worktree info for the WebView */
interface WebViewWorktreeInfo {
    path: string;
    branch: string;
    commit: string;
    isMain: boolean;
    statusSummary: string;
    status: {
        modified: number;
        staged: number;
        untracked: number;
        conflicts: number;
    };
}

export class DashboardPanel implements vscode.Disposable {
    private static currentPanel: DashboardPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly disposables: vscode.Disposable[] = [];
    private fileWatchers: vscode.FileSystemWatcher[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;
    private fileChangeDebounce: Map<string, NodeJS.Timeout> = new Map();
    private fileChangeBuffer: Array<{
        timestamp: string;
        worktreePath: string;
        branch: string;
        filePath: string;
        changeType: string;
    }> = [];
    private static readonly MAX_BUFFER = 100;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        private readonly repoRoot: string,
        private readonly sessionTracker: SessionTracker,
        private readonly overlapDetector?: OverlapDetector
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;

        // Set the HTML content
        this.panel.webview.html = this.getHtmlContent();

        // Listen for messages from the WebView
        this.panel.webview.onDidReceiveMessage(
            (message) => void this.handleWebViewMessage(message),
            undefined,
            this.disposables
        );

        // Listen for session changes
        this.disposables.push(
            this.sessionTracker.onDidChangeSessions(() => {
                void this.sendUpdate();
                this.updateFileWatchers();
            })
        );

        // Listen for overlap changes
        if (this.overlapDetector) {
            this.disposables.push(
                this.overlapDetector.onDidChangeOverlaps(() => {
                    void this.sendUpdate();
                })
            );
        }

        // Clean up when panel is closed
        this.panel.onDidDispose(
            () => this.dispose(),
            undefined,
            this.disposables
        );

        // Start periodic refresh (every 5s for session status updates)
        this.refreshInterval = setInterval(() => {
            if (this.panel.visible) {
                void this.sendUpdate();
            }
        }, 5000);
    }

    /**
     * Create or reveal the dashboard panel.
     */
    static createOrShow(
        extensionUri: vscode.Uri,
        repoRoot: string,
        sessionTracker: SessionTracker,
        overlapDetector?: OverlapDetector
    ): DashboardPanel {
        // If panel already exists, reveal it
        if (DashboardPanel.currentPanel) {
            DashboardPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
            return DashboardPanel.currentPanel;
        }

        // Create new panel
        const panel = vscode.window.createWebviewPanel(
            "groveDashboard",
            "Grove",
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, "webview-ui", "dist"),
                ],
            }
        );

        // Set the tab icon
        panel.iconPath = {
            light: vscode.Uri.joinPath(extensionUri, "media", "icon.svg"),
            dark: vscode.Uri.joinPath(extensionUri, "media", "icon.svg"),
        };

        DashboardPanel.currentPanel = new DashboardPanel(
            panel,
            extensionUri,
            repoRoot,
            sessionTracker,
            overlapDetector
        );

        return DashboardPanel.currentPanel;
    }

    // ── HTML Content ─────────────────────────────────────────

    private getHtmlContent(): string {
        const webview = this.panel.webview;
        const distUri = vscode.Uri.joinPath(
            this.extensionUri,
            "webview-ui",
            "dist"
        );

        // Resolve asset paths
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(distUri, "assets", "main.js")
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(distUri, "assets", "index.css")
        );

        // CSP nonce for security
        const nonce = getNonce();

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
        http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';
                 font-src ${webview.cspSource};"
    />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Grove</title>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    // ── Message Handling ─────────────────────────────────────

    private async handleWebViewMessage(message: {
        type: string;
        [key: string]: unknown;
    }): Promise<void> {
        switch (message.type) {
            case "ready":
                await this.sendUpdate();
                // Replay buffered file changes so the webview doesn't lose history on reload
                for (const change of this.fileChangeBuffer) {
                    void this.panel.webview.postMessage({
                        type: "file-change",
                        change,
                    });
                }
                this.updateFileWatchers();
                break;

            case "stop-session": {
                const sessionId = message.sessionId as string;
                this.sessionTracker.stopSession(sessionId);
                break;
            }

            case "focus-session": {
                const sessionId = message.sessionId as string;
                const terminal =
                    this.sessionTracker.getTerminalForSession(sessionId);
                if (terminal) {
                    terminal.show();
                }
                break;
            }

            case "view-diff": {
                const worktreePath = message.worktreePath as string;
                const branch = message.branch as string;

                // Check if the worktree directory still exists
                if (!fs.existsSync(worktreePath)) {
                    void vscode.window.showWarningMessage(
                        `Worktree directory no longer exists: ${branch}\n\nThe worktree may have been deleted or cleaned up.`
                    );
                    break;
                }

                const config =
                    vscode.workspace.getConfiguration("grove");
                const baseBranch = config.get<string>(
                    "defaultBaseBranch",
                    "main"
                );
                const safeBranch = sanitizeRefName(baseBranch);

                // For the base branch itself, only show uncommitted changes
                if (branch === baseBranch) {
                    const terminal = openTerminal(
                        `Diff: ${branch}`,
                        worktreePath
                    );
                    terminal.sendText(
                        `echo "── Uncommitted changes ──" && ` +
                        `git diff --stat; ` +
                        `echo "" && echo "── Staged changes ──" && ` +
                        `git diff --cached --stat`
                    );
                } else {
                    const terminal = openTerminal(
                        `Diff: ${branch}`,
                        worktreePath
                    );
                    terminal.sendText(
                        `echo "── Changes vs ${safeBranch} ──" && ` +
                        `git diff ${safeBranch}...HEAD --stat 2>/dev/null; ` +
                        `echo "" && echo "── Uncommitted changes ──" && ` +
                        `git diff --stat; ` +
                        `echo "" && echo "── Staged changes ──" && ` +
                        `git diff --cached --stat`
                    );
                }
                break;
            }

            case "open-file-diff": {
                const worktreePath = message.worktreePath as string;
                const filePath = message.filePath as string;
                const config =
                    vscode.workspace.getConfiguration("grove");
                const baseBranch = config.get<string>(
                    "defaultBaseBranch",
                    "main"
                );
                await vscode.commands.executeCommand(
                    "grove.openFileDiff",
                    worktreePath,
                    filePath,
                    baseBranch
                );
                break;
            }

            case "dismiss-overlap": {
                const filePath = message.filePath as string;
                this.overlapDetector?.dismissOverlap(filePath);
                break;
            }

            case "dismiss-all-overlaps":
                this.overlapDetector?.dismissAll();
                break;

            case "clear-completed":
                this.sessionTracker.clearCompletedSessions();
                await this.sendUpdate();
                break;

            case "refresh":
                await this.sendUpdate();
                break;

            default:
                log(`Unknown webview message: ${message.type}`);
        }
    }

    // ── State Sync ───────────────────────────────────────────

    private async sendUpdate(): Promise<void> {
        if (this.disposed) return;
        try {
            const sessions = this.sessionTracker
                .getAllSessions()
                .map(
                    (s): WebViewSessionInfo => ({
                        id: s.id,
                        worktreePath: s.worktreePath,
                        branch: s.branch,
                        taskDescription: s.taskDescription,
                        startedAt: s.startedAt,
                        endedAt: s.endedAt,
                        status: s.status,
                        exitCode: s.exitCode,
                        modifiedFiles: s.modifiedFiles,
                    })
                );

            const rawWorktrees = await listAllWorktrees(this.repoRoot);
            if (this.disposed) return; // Panel may have been disposed during await
            const worktrees: WebViewWorktreeInfo[] = rawWorktrees.map((wt) => ({
                path: wt.path,
                branch: wt.branch,
                commit: wt.commit.slice(0, 7),
                isMain: wt.isMain,
                statusSummary: wt.statusSummary,
                status: wt.status,
            }));

            const overlaps = this.overlapDetector?.getOverlapAlerts() ?? [];

            void this.panel.webview.postMessage({
                type: "update",
                sessions,
                worktrees,
                overlaps,
            });
        } catch (err) {
            logError("Failed to send dashboard update", err);
        }
    }

    // ── File Activity Watchers ───────────────────────────────

    private updateFileWatchers(): void {
        // Dispose old watchers
        for (const watcher of this.fileWatchers) {
            watcher.dispose();
        }
        this.fileWatchers = [];

        // Clear stale debounce timers from previous sessions
        for (const timer of this.fileChangeDebounce.values()) {
            clearTimeout(timer);
        }
        this.fileChangeDebounce.clear();

        // Create watchers for each active session's worktree
        const activeSessions = this.sessionTracker.getActiveSessions();
        const config = vscode.workspace.getConfiguration("grove");
        const debounceMs = config.get<number>("fileWatcherDebounce", 500);

        for (const session of activeSessions) {
            if (!fs.existsSync(session.worktreePath)) continue;

            // Watch root-level files and common source directories.
            // Excludes node_modules, .git, dist, __pycache__ by not listing them.
            const pattern = new vscode.RelativePattern(
                session.worktreePath,
                "{*,src/**/*,lib/**/*,app/**/*,test/**/*,tests/**/*,pkg/**/*,cmd/**/*,internal/**/*,config/**/*,public/**/*,assets/**/*,scripts/**/*}"
            );

            const watcher = vscode.workspace.createFileSystemWatcher(
                pattern,
                false,
                false,
                false
            );

            const sendFileChange = (
                uri: vscode.Uri,
                changeType: "created" | "modified" | "deleted"
            ): void => {
                // Normalize to forward slashes for cross-platform consistency
                const relativePath = path.relative(session.worktreePath, uri.fsPath).replace(/\\/g, "/");

                // Skip .git directory, node_modules, build artifacts, and temp files
                if (relativePath.startsWith(".git") || relativePath.includes("/.git/")) return;
                if (
                    relativePath.includes("node_modules") ||
                    relativePath.includes("__pycache__") ||
                    relativePath.includes(".cache")
                ) {
                    return;
                }
                // Skip git temp files (*.git, *.lock, *.orig, *.swp, ~* backup files)
                const fileName = path.basename(relativePath);
                if (
                    fileName.endsWith(".git") ||
                    fileName.endsWith(".lock") ||
                    fileName.endsWith(".orig") ||
                    fileName.endsWith(".swp") ||
                    fileName.endsWith(".tmp") ||
                    fileName.startsWith("~") ||
                    fileName.startsWith(".#")
                ) {
                    return;
                }

                // Debounce per file
                const key = `${session.id}:${uri.fsPath}`;
                const existing = this.fileChangeDebounce.get(key);
                if (existing) clearTimeout(existing);

                this.fileChangeDebounce.set(
                    key,
                    setTimeout(() => {
                        this.fileChangeDebounce.delete(key);
                        if (this.disposed) return;
                        const change = {
                            timestamp: new Date().toISOString(),
                            worktreePath: session.worktreePath,
                            branch: session.branch,
                            filePath: relativePath,
                            changeType,
                        };
                        // Buffer for replay on webview reload
                        this.fileChangeBuffer.unshift(change);
                        if (this.fileChangeBuffer.length > DashboardPanel.MAX_BUFFER) {
                            this.fileChangeBuffer.length = DashboardPanel.MAX_BUFFER;
                        }
                        void this.panel.webview.postMessage({
                            type: "file-change",
                            change,
                        });
                    }, debounceMs)
                );
            };

            watcher.onDidCreate((uri) => sendFileChange(uri, "created"));
            watcher.onDidChange((uri) => sendFileChange(uri, "modified"));
            watcher.onDidDelete((uri) => sendFileChange(uri, "deleted"));

            this.fileWatchers.push(watcher);
        }
    }

    // ── Disposal ─────────────────────────────────────────────

    private disposed = false;

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        DashboardPanel.currentPanel = undefined;

        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }

        for (const timeout of this.fileChangeDebounce.values()) {
            clearTimeout(timeout);
        }
        this.fileChangeDebounce.clear();

        for (const watcher of this.fileWatchers) {
            watcher.dispose();
        }

        for (const d of this.disposables) {
            d.dispose();
        }

        // Note: do NOT call this.panel.dispose() here.
        // dispose() is called from the panel's onDidDispose callback,
        // meaning the panel is already disposed by VS Code.
    }
}

function getNonce(): string {
    let text = "";
    const possible =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
