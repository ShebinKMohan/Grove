/**
 * Unified Tree Provider — single hierarchical TreeView that replaces the
 * three separate worktree, session, and team providers.
 *
 * Visual structure:
 *   GROVE
 *     -- Workflow hint (dynamic next-step)
 *     ── ── ── separator ── ── ──
 *     -- Teams (if any)
 *          -- Agents
 *     -- Worktrees (main first, then alphabetical)
 *          -- Active session (child)
 *     -- Recent (separator, collapsed)
 *          -- Completed/error sessions
 */

import * as vscode from "vscode";
import * as path from "path";
import {
    listAllWorktrees,
    getChangedFilesWithStatus,
    WorktreeInfo,
    ChangedFile,
} from "../../core/worktree-manager";
import {
    SessionTracker,
    SessionInfo,
} from "../../core/session-tracker";
import {
    AgentOrchestrator,
    TeamState,
    AgentState,
} from "../../core/agent-orchestrator";
import { logError } from "../../utils/logger";

// ────────────────────────────────────────────
// Union type for all tree elements
// ────────────────────────────────────────────

export type UnifiedTreeElement =
    | WorkflowHintItem
    | DividerItem
    | TeamItem
    | AgentItem
    | WorktreeItem
    | SessionItem
    | ChangedFileItem
;

// ────────────────────────────────────────────
// WorkflowHintItem
// ────────────────────────────────────────────

type WorkflowHintKind =
    | "no-worktrees"
    | "no-sessions"
    | "sessions-running"
    | "all-done";

class WorkflowHintItem extends vscode.TreeItem {
    public readonly kind: WorkflowHintKind;

    constructor(kind: WorkflowHintKind, sessionCount: number) {
        const { label, commandId, commandTitle, icon, color } =
            WorkflowHintItem.resolve(kind, sessionCount);

        super(label, vscode.TreeItemCollapsibleState.None);
        this.kind = kind;
        this.contextValue = "workflow-hint";
        this.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
        this.command = {
            title: commandTitle,
            command: commandId,
        };
        this.tooltip = new vscode.MarkdownString(
            `$(${icon}) **Next step:** ${label}`
        );
    }

    private static resolve(
        kind: WorkflowHintKind,
        sessionCount: number
    ): {
        label: string;
        commandId: string;
        commandTitle: string;
        icon: string;
        color: string;
    } {
        switch (kind) {
            case "no-worktrees":
                return {
                    label: "Create a worktree to get started",
                    commandId: "grove.createWorktree",
                    commandTitle: "Create Worktree",
                    icon: "add",
                    color: "charts.green",
                };
            case "no-sessions":
                return {
                    label: "Launch Claude Code in your worktrees",
                    commandId: "grove.openDashboard",
                    commandTitle: "Open Dashboard",
                    icon: "rocket",
                    color: "charts.blue",
                };
            case "sessions-running":
                return {
                    label: `${sessionCount} session${sessionCount === 1 ? "" : "s"} running \u2014 Open Dashboard`,
                    commandId: "grove.openDashboard",
                    commandTitle: "Open Dashboard",
                    icon: "pulse",
                    color: "charts.green",
                };
            case "all-done":
                return {
                    label: "All done \u2014 Generate Merge Report",
                    commandId: "grove.generateMergeReport",
                    commandTitle: "Generate Merge Report",
                    icon: "check-all",
                    color: "charts.purple",
                };
        }
    }
}

// ────────────────────────────────────────────
// DividerItem — thin visual separator
// ────────────────────────────────────────────

class DividerItem extends vscode.TreeItem {
    constructor() {
        super("──────────", vscode.TreeItemCollapsibleState.None);
        this.contextValue = "divider";
        this.iconPath = new vscode.ThemeIcon(
            "dash",
            new vscode.ThemeColor("disabledForeground")
        );
        this.tooltip = "";
        this.description = "";
    }
}

// ────────────────────────────────────────────
// TeamItem
// ────────────────────────────────────────────

export class TeamItem extends vscode.TreeItem {
    public readonly team: TeamState;

    constructor(team: TeamState) {
        super(team.name, vscode.TreeItemCollapsibleState.Expanded);
        this.team = team;

        const agentCount = team.agents.length;
        const running = team.agents.filter((a) => a.status === "running").length;
        const statusLabel =
            team.status === "running"
                ? `${running}/${agentCount} running`
                : team.status;

        this.description = `${team.templateName} \u00b7 ${statusLabel}`;
        this.contextValue =
            team.status === "running" || team.status === "launching"
                ? "team-active"
                : "team-completed";

        this.iconPath = TeamItem.getIcon(team.status);
        this.tooltip = TeamItem.buildTooltip(team, agentCount);
    }

    private static getIcon(status: TeamState["status"]): vscode.ThemeIcon {
        switch (status) {
            case "launching":
                return new vscode.ThemeIcon(
                    "loading~spin",
                    new vscode.ThemeColor("charts.yellow")
                );
            case "running":
                return new vscode.ThemeIcon(
                    "organization",
                    new vscode.ThemeColor("charts.green")
                );
            case "completed":
                return new vscode.ThemeIcon(
                    "pass",
                    new vscode.ThemeColor("charts.blue")
                );
            case "error":
                return new vscode.ThemeIcon(
                    "error",
                    new vscode.ThemeColor("charts.red")
                );
            case "stopped":
                return new vscode.ThemeIcon(
                    "debug-stop",
                    new vscode.ThemeColor("disabledForeground")
                );
            case "cancelled":
                return new vscode.ThemeIcon(
                    "circle-slash",
                    new vscode.ThemeColor("disabledForeground")
                );
        }
    }

    private static buildTooltip(
        team: TeamState,
        agentCount: number
    ): vscode.MarkdownString {
        const md = new vscode.MarkdownString("", true);
        md.isTrusted = true;
        md.supportThemeIcons = true;

        md.appendMarkdown(`### $(organization) ${team.name}\n\n`);
        md.appendMarkdown("---\n\n");
        md.appendMarkdown(`Template: **${team.templateName}**\n\n`);
        md.appendMarkdown(`Status: **${team.status}**\n\n`);
        if (team.taskDescription) {
            md.appendMarkdown(`$(note) ${team.taskDescription}\n\n`);
        }
        md.appendMarkdown(`Agents: ${agentCount}\n\n`);
        md.appendMarkdown(
            `$(calendar) Started: ${new Date(team.startedAt).toLocaleString()}\n\n`
        );
        if (team.endedAt) {
            md.appendMarkdown(
                `Ended: ${new Date(team.endedAt).toLocaleString()}\n\n`
            );
        }

        return md;
    }
}

// ────────────────────────────────────────────
// AgentItem
// ────────────────────────────────────────────

export class AgentItem extends vscode.TreeItem {
    public readonly agentState: AgentState;
    public readonly teamId: string;

    constructor(agent: AgentState, teamId: string, tracker?: SessionTracker) {
        super(agent.displayName, vscode.TreeItemCollapsibleState.None);
        this.agentState = agent;
        this.teamId = teamId;

        const elapsed = AgentItem.computeElapsed(agent, tracker);
        const parts: string[] = [agent.role, AgentItem.statusLabel(agent.status)];
        if (elapsed) {
            parts.push(elapsed);
        }
        this.description = parts.join(" \u00b7 ");

        this.contextValue =
            agent.status === "running" || agent.status === "launching"
                ? "agent-active"
                : "agent-completed";

        this.iconPath = AgentItem.getIcon(agent.status);
        this.tooltip = AgentItem.buildTooltip(agent);
    }

    private static statusLabel(status: AgentState["status"]): string {
        switch (status) {
            case "pending":
                return "Pending";
            case "launching":
                return "Launching";
            case "running":
                return "Running";
            case "completed":
                return "Done";
            case "error":
                return "Error";
            case "stopped":
                return "Stopped";
        }
    }

    private static computeElapsed(
        agent: AgentState,
        tracker?: SessionTracker
    ): string | undefined {
        if (!tracker || !agent.sessionId) return undefined;
        const session = tracker.getSession(agent.sessionId);
        if (!session) return undefined;
        return tracker.getElapsedTime(session);
    }

    private static getIcon(status: AgentState["status"]): vscode.ThemeIcon {
        switch (status) {
            case "pending":
                return new vscode.ThemeIcon(
                    "circle-outline",
                    new vscode.ThemeColor("disabledForeground")
                );
            case "launching":
                return new vscode.ThemeIcon(
                    "loading~spin",
                    new vscode.ThemeColor("charts.yellow")
                );
            case "running":
                return new vscode.ThemeIcon(
                    "sync~spin",
                    new vscode.ThemeColor("charts.green")
                );
            case "completed":
                return new vscode.ThemeIcon(
                    "pass",
                    new vscode.ThemeColor("charts.blue")
                );
            case "error":
                return new vscode.ThemeIcon(
                    "error",
                    new vscode.ThemeColor("charts.red")
                );
            case "stopped":
                return new vscode.ThemeIcon(
                    "debug-stop",
                    new vscode.ThemeColor("disabledForeground")
                );
        }
    }

    private static buildTooltip(agent: AgentState): vscode.MarkdownString {
        const md = new vscode.MarkdownString("", true);
        md.isTrusted = true;
        md.supportThemeIcons = true;

        md.appendMarkdown(
            `**${agent.displayName}** (\`${agent.role}\`)\n\n`
        );
        md.appendMarkdown(`Status: ${agent.status}\n\n`);
        if (agent.branch) {
            md.appendMarkdown(`Branch: \`${agent.branch}\`\n\n`);
        }
        if (agent.worktreePath) {
            md.appendMarkdown(`Path: \`${agent.worktreePath}\`\n\n`);
        }

        return md;
    }
}

// ────────────────────────────────────────────
// WorktreeItem
// ────────────────────────────────────────────

export class WorktreeItem extends vscode.TreeItem {
    public readonly worktree: WorktreeInfo;
    public readonly hasActiveSession: boolean;

    constructor(worktree: WorktreeInfo, hasActiveSession: boolean) {
        // Always collapsible so users can expand to see changed files.
        // Auto-expand if there's an active session, else collapsed.
        super(
            worktree.branch,
            hasActiveSession
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed
        );
        this.worktree = worktree;
        this.hasActiveSession = hasActiveSession;
        this.description = this.buildDescription();
        this.tooltip = this.buildTooltip();
        this.iconPath = this.getStatusIcon();
        this.contextValue = this.resolveContextValue();
        this.resourceUri = vscode.Uri.file(worktree.path);
    }

    private resolveContextValue(): string {
        if (this.worktree.isMain) return "worktree-main";
        if (this.hasActiveSession) return "worktree-with-session";
        return "worktree";
    }

    private buildDescription(): string {
        if (this.worktree.isMain) {
            const parts: string[] = ["default"];
            const changes = this.getChangeSummary();
            if (changes) parts.push(changes);
            const sync = this.getSyncSummary();
            if (sync) parts.push(sync);
            return parts.join(" \u00b7 ");
        }

        if (this.worktree.statusSummary === "missing") {
            return "missing";
        }

        const parts: string[] = [];
        const dirName = path.basename(this.worktree.path);
        parts.push(dirName);

        const changes = this.getChangeSummary();
        if (changes) {
            parts.push(changes);
        } else {
            parts.push("clean");
        }

        const sync = this.getSyncSummary();
        if (sync) parts.push(sync);

        return parts.join(" \u00b7 ");
    }

    private getChangeSummary(): string {
        const { modified, staged, untracked, conflicts } = this.worktree.status;
        const parts: string[] = [];
        if (conflicts > 0) parts.push(`!${conflicts}`);
        if (staged > 0) parts.push(`+${staged}`);
        if (modified > 0) parts.push(`~${modified}`);
        if (untracked > 0) parts.push(`?${untracked}`);
        return parts.join(" ");
    }

    private getSyncSummary(): string {
        const { ahead, behind } = this.worktree;
        const parts: string[] = [];
        if (behind > 0) parts.push(`\u2193${behind}`);
        if (ahead > 0) parts.push(`\u2191${ahead}`);
        return parts.join(" ");
    }

    private buildTooltip(): vscode.MarkdownString {
        const md = new vscode.MarkdownString("", true);
        md.supportThemeIcons = true;

        if (this.worktree.isMain) {
            md.appendMarkdown(`### $(home) ${this.worktree.branch}\n\n`);
            md.appendMarkdown("$(star-full) **Default worktree**\n\n");
        } else {
            md.appendMarkdown(
                `### $(git-branch) ${this.worktree.branch}\n\n`
            );
        }

        md.appendMarkdown("---\n\n");
        md.appendMarkdown(`$(folder) \`${this.worktree.path}\`\n\n`);

        if (this.worktree.commit) {
            md.appendMarkdown(
                `$(git-commit) \`${this.worktree.commit}\`\n\n`
            );
        }

        const { modified, staged, untracked, conflicts } =
            this.worktree.status;
        if (this.worktree.statusSummary === "missing") {
            md.appendMarkdown(
                "$(error) **Worktree directory missing**\n\n"
            );
        } else if (
            conflicts > 0 ||
            modified > 0 ||
            staged > 0 ||
            untracked > 0
        ) {
            md.appendMarkdown("**Changes:**\n\n");
            if (conflicts > 0)
                md.appendMarkdown(`- $(alert) ${conflicts} conflict(s)\n`);
            if (staged > 0)
                md.appendMarkdown(`- $(diff-added) ${staged} staged\n`);
            if (modified > 0)
                md.appendMarkdown(`- $(diff-modified) ${modified} modified\n`);
            if (untracked > 0)
                md.appendMarkdown(`- $(diff-removed) ${untracked} untracked\n`);
            md.appendMarkdown("\n");
        } else {
            md.appendMarkdown(
                "$(pass) **Clean** \u2014 no pending changes\n\n"
            );
        }

        // Show ahead/behind info
        const { ahead, behind } = this.worktree;
        if (ahead > 0 || behind > 0) {
            md.appendMarkdown("**Remote sync:**\n\n");
            if (behind > 0)
                md.appendMarkdown(`- $(cloud-download) ${behind} commit(s) behind remote\n`);
            if (ahead > 0)
                md.appendMarkdown(`- $(cloud-upload) ${ahead} commit(s) ahead of remote\n`);
            md.appendMarkdown("\n");
        }

        md.appendMarkdown("---\n\n");
        md.appendMarkdown(
            "$(rocket) Launch Claude \u00b7 $(terminal) Open Terminal \u00b7 $(sync) Sync \u00b7 $(multiple-windows) New Window"
        );

        return md;
    }

    private getStatusIcon(): vscode.ThemeIcon {
        if (this.worktree.isMain) {
            return new vscode.ThemeIcon(
                "repo",
                new vscode.ThemeColor("charts.blue")
            );
        }

        if (this.worktree.statusSummary === "missing") {
            return new vscode.ThemeIcon(
                "warning",
                new vscode.ThemeColor("charts.red")
            );
        }

        if (this.worktree.status.conflicts > 0) {
            return new vscode.ThemeIcon(
                "git-merge",
                new vscode.ThemeColor("charts.red")
            );
        }

        if (this.hasActiveSession) {
            return new vscode.ThemeIcon(
                "git-branch",
                new vscode.ThemeColor("charts.green")
            );
        }

        const { modified, staged, untracked } = this.worktree.status;
        if (modified > 0 || staged > 0 || untracked > 0) {
            return new vscode.ThemeIcon(
                "git-branch",
                new vscode.ThemeColor("charts.yellow")
            );
        }

        return new vscode.ThemeIcon(
            "git-branch",
            new vscode.ThemeColor("foreground")
        );
    }
}

// ────────────────────────────────────────────
// SessionItem
// ────────────────────────────────────────────

export class SessionItem extends vscode.TreeItem {
    public readonly session: SessionInfo;

    constructor(session: SessionInfo, tracker: SessionTracker) {
        super(session.branch, vscode.TreeItemCollapsibleState.None);
        this.session = session;

        const elapsed = tracker.getElapsedTime(session);
        const parts: string[] = [SessionItem.statusLabel(session), elapsed];

        if (session.taskDescription) {
            parts.push(session.taskDescription);
        } else if (session.modifiedFiles.length > 0) {
            parts.push(`${session.modifiedFiles.length} files`);
        }

        this.description = parts.join(" \u00b7 ");
        this.iconPath = SessionItem.getIcon(session);
        this.contextValue = SessionItem.resolveContextValue(session);
        this.tooltip = SessionItem.buildTooltip(session, tracker);
    }

    private static statusLabel(session: SessionInfo): string {
        switch (session.status) {
            case "running":
                return "Running";
            case "idle":
                return "Idle";
            case "completed":
                return "Done";
            case "error":
                return "Error";
        }
    }

    private static getIcon(session: SessionInfo): vscode.ThemeIcon {
        switch (session.status) {
            case "running":
                return new vscode.ThemeIcon(
                    "play-circle",
                    new vscode.ThemeColor("charts.green")
                );
            case "idle":
                return new vscode.ThemeIcon(
                    "watch",
                    new vscode.ThemeColor("charts.yellow")
                );
            case "completed":
                return new vscode.ThemeIcon(
                    "check",
                    new vscode.ThemeColor("charts.blue")
                );
            case "error":
                return new vscode.ThemeIcon(
                    "close-dirty",
                    new vscode.ThemeColor("charts.red")
                );
        }
    }

    private static resolveContextValue(session: SessionInfo): string {
        if (session.status === "running" || session.status === "idle") {
            return "session-active";
        }
        return "session-completed";
    }

    private static buildTooltip(
        session: SessionInfo,
        tracker: SessionTracker
    ): vscode.MarkdownString {
        const md = new vscode.MarkdownString("", true);
        md.supportThemeIcons = true;

        md.appendMarkdown(`### $(rocket) ${session.branch}\n\n`);
        md.appendMarkdown("---\n\n");

        const statusIcon =
            session.status === "running"
                ? "$(sync~spin)"
                : session.status === "completed"
                    ? "$(check)"
                    : session.status === "error"
                        ? "$(error)"
                        : "$(clock)";
        md.appendMarkdown(
            `${statusIcon} **${SessionItem.statusLabel(session)}** \u2014 ${tracker.getElapsedTime(session)}\n\n`
        );

        if (session.taskDescription) {
            md.appendMarkdown(`$(note) ${session.taskDescription}\n\n`);
        }

        md.appendMarkdown(`$(folder) \`${session.worktreePath}\`\n\n`);

        const started = new Date(session.startedAt);
        md.appendMarkdown(
            `$(calendar) Started: ${started.toLocaleTimeString()}\n\n`
        );

        if (session.modifiedFiles.length > 0) {
            md.appendMarkdown(
                `**Modified files (${session.modifiedFiles.length}):**\n\n`
            );
            const displayed = session.modifiedFiles.slice(0, 10);
            for (const file of displayed) {
                md.appendMarkdown(`- \`${file}\`\n`);
            }
            if (session.modifiedFiles.length > 10) {
                md.appendMarkdown(
                    `- *...and ${session.modifiedFiles.length - 10} more*\n`
                );
            }
        }

        return md;
    }
}

// ────────────────────────────────────────────
// ChangedFileItem
// ────────────────────────────────────────────

class ChangedFileItem extends vscode.TreeItem {
    public readonly changedFile: ChangedFile;
    public readonly worktreePath: string;

    constructor(file: ChangedFile, worktreePath: string, baseBranch: string) {
        const fileName = path.basename(file.filePath);
        super(fileName, vscode.TreeItemCollapsibleState.None);
        this.changedFile = file;
        this.worktreePath = worktreePath;

        const dir = path.dirname(file.filePath);
        this.description = dir === "." ? "" : dir;
        this.contextValue = "changed-file";
        this.iconPath = ChangedFileItem.getIcon(file.status);
        this.tooltip = `${file.filePath} (${file.status})`;

        const fileUri = vscode.Uri.file(
            path.join(worktreePath, file.filePath)
        );
        this.resourceUri = fileUri;

        if (file.status === "modified" || file.status === "renamed") {
            // Open inline diff: base branch version vs current worktree version
            this.command = {
                title: "Show Diff",
                command: "grove.openFileDiff",
                arguments: [worktreePath, file.filePath, baseBranch],
            };
        } else {
            // Added or deleted — just open the file
            this.command = {
                title: "Open File",
                command: "vscode.open",
                arguments: [fileUri],
            };
        }
    }

    private static getIcon(
        status: ChangedFile["status"]
    ): vscode.ThemeIcon {
        switch (status) {
            case "added":
                return new vscode.ThemeIcon(
                    "diff-added",
                    new vscode.ThemeColor("gitDecoration.addedResourceForeground")
                );
            case "modified":
                return new vscode.ThemeIcon(
                    "diff-modified",
                    new vscode.ThemeColor("gitDecoration.modifiedResourceForeground")
                );
            case "deleted":
                return new vscode.ThemeIcon(
                    "diff-removed",
                    new vscode.ThemeColor("gitDecoration.deletedResourceForeground")
                );
            case "renamed":
                return new vscode.ThemeIcon(
                    "diff-renamed",
                    new vscode.ThemeColor("gitDecoration.renamedResourceForeground")
                );
        }
    }
}

// ────────────────────────────────────────────
// Unified Tree Data Provider
// ────────────────────────────────────────────

export class UnifiedTreeProvider
    implements vscode.TreeDataProvider<UnifiedTreeElement>, vscode.Disposable
{
    private _onDidChangeTreeData = new vscode.EventEmitter<
        UnifiedTreeElement | undefined | null
    >();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private repoRoot: string | undefined;
    private tracker: SessionTracker | undefined;
    private orchestrator: AgentOrchestrator | undefined;

    private disposables: vscode.Disposable[] = [];

    // Cached data for child lookups (populated during root getChildren)
    private cachedWorktrees: WorktreeInfo[] = [];
    private cachedActiveSessions: SessionInfo[] = [];
    private cachedCompletedCount = 0;
    private cachedTeams: TeamState[] = [];

    // ── Configuration ───────────────────────────────────────

    setRepoRoot(root: string): void {
        this.repoRoot = root;
    }

    setTracker(tracker: SessionTracker): void {
        this.tracker = tracker;
        this.disposables.push(
            tracker.onDidChangeSessions(() => this.refresh())
        );
    }

    setOrchestrator(orchestrator: AgentOrchestrator): void {
        this.orchestrator = orchestrator;
        this.disposables.push(
            orchestrator.onDidChangeTeams(() => this.refresh())
        );
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    // ── TreeDataProvider ────────────────────────────────────

    getTreeItem(element: UnifiedTreeElement): vscode.TreeItem {
        return element;
    }

    async getChildren(
        element?: UnifiedTreeElement
    ): Promise<UnifiedTreeElement[]> {
        // ── Child nodes ─────────────────────────────────────
        if (element) {
            return this.getChildrenOf(element);
        }

        // ── Root level ──────────────────────────────────────
        return this.getRootChildren();
    }

    // ── Root Children ───────────────────────────────────────

    private async getRootChildren(): Promise<UnifiedTreeElement[]> {
        await this.refreshCaches();

        const items: UnifiedTreeElement[] = [];

        // 1. Workflow hint (next-step guidance)
        const hint = this.buildWorkflowHint();
        if (hint) {
            items.push(hint);
            // Visual divider between guidance and workspace
            items.push(new DividerItem());
        }

        // 2. Active teams
        const activeTeams = this.cachedTeams
            .filter(
                (t) => t.status === "running" || t.status === "launching"
            )
            .sort(
                (a, b) =>
                    new Date(b.startedAt).getTime() -
                    new Date(a.startedAt).getTime()
            );
        for (const team of activeTeams) {
            items.push(new TeamItem(team));
        }

        // 3. Worktrees (main first, then alphabetical)
        const sortedWorktrees = [...this.cachedWorktrees].sort((a, b) => {
            if (a.isMain && !b.isMain) return -1;
            if (!a.isMain && b.isMain) return 1;
            return a.branch.localeCompare(b.branch);
        });

        for (const wt of sortedWorktrees) {
            const hasSession = this.tracker
                ? this.tracker.hasActiveSession(wt.path)
                : false;
            items.push(new WorktreeItem(wt, hasSession));
        }

        return items;
    }

    // ── Child Children ──────────────────────────────────────

    private async getChildrenOf(
        element: UnifiedTreeElement
    ): Promise<UnifiedTreeElement[]> {
        if (element instanceof TeamItem) {
            return this.getTeamChildren(element);
        }

        if (element instanceof WorktreeItem) {
            return this.getWorktreeChildren(element);
        }

        // Leaf nodes: WorkflowHintItem, DividerItem, AgentItem, SessionItem, ChangedFileItem
        return [];
    }

    private getTeamChildren(teamItem: TeamItem): AgentItem[] {
        return teamItem.team.agents.map(
            (agent) =>
                new AgentItem(agent, teamItem.team.id, this.tracker)
        );
    }

    private async getWorktreeChildren(
        worktreeItem: WorktreeItem
    ): Promise<UnifiedTreeElement[]> {
        const children: UnifiedTreeElement[] = [];

        // 1. Active sessions for this worktree
        if (this.tracker) {
            const sessions = this.cachedActiveSessions.filter(
                (s) => s.worktreePath === worktreeItem.worktree.path
            );
            for (const s of sessions) {
                children.push(new SessionItem(s, this.tracker));
            }
        }

        // 2. Changed files (committed + uncommitted vs base branch)
        if (
            !worktreeItem.worktree.isMain &&
            worktreeItem.worktree.statusSummary !== "missing"
        ) {
            try {
                const config = vscode.workspace.getConfiguration("grove");
                const baseBranch = config.get<string>(
                    "defaultBaseBranch",
                    "main"
                );
                const changedFiles = await getChangedFilesWithStatus(
                    worktreeItem.worktree.path,
                    baseBranch
                );
                for (const file of changedFiles) {
                    children.push(
                        new ChangedFileItem(file, worktreeItem.worktree.path, baseBranch)
                    );
                }
            } catch {
                // Non-critical — just show no files
            }
        }

        return children;
    }

    // ── Workflow Hint Logic ─────────────────────────────────

    private buildWorkflowHint(): WorkflowHintItem | undefined {
        const nonMainWorktrees = this.cachedWorktrees.filter(
            (wt) => !wt.isMain
        );
        const activeCount = this.cachedActiveSessions.length;
        const completedCount = this.cachedCompletedCount;

        // No worktrees beyond main
        if (nonMainWorktrees.length === 0) {
            return new WorkflowHintItem("no-worktrees", 0);
        }

        // Worktrees exist but no sessions at all
        if (activeCount === 0 && completedCount === 0) {
            return new WorkflowHintItem("no-sessions", 0);
        }

        // Sessions are running
        if (activeCount > 0) {
            return new WorkflowHintItem("sessions-running", activeCount);
        }

        // All sessions completed (some completed, none active)
        if (completedCount > 0 && activeCount === 0) {
            return new WorkflowHintItem("all-done", 0);
        }

        return undefined;
    }

    // ── Cache Management ────────────────────────────────────

    private async refreshCaches(): Promise<void> {
        // Worktrees
        if (this.repoRoot) {
            try {
                this.cachedWorktrees = await listAllWorktrees(this.repoRoot);
            } catch (err) {
                logError("Failed to list worktrees", err);
                this.cachedWorktrees = [];
            }
        } else {
            this.cachedWorktrees = [];
        }

        // Sessions
        if (this.tracker) {
            this.cachedActiveSessions = this.tracker.getActiveSessions();
            this.cachedCompletedCount = this.tracker
                .getAllSessions()
                .filter(
                    (s) => s.status === "completed" || s.status === "error"
                ).length;
        } else {
            this.cachedActiveSessions = [];
            this.cachedCompletedCount = 0;
        }

        // Teams
        if (this.orchestrator) {
            this.cachedTeams = this.orchestrator.getAllTeams();
        } else {
            this.cachedTeams = [];
        }
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this._onDidChangeTreeData.dispose();
    }
}

// ────────────────────────────────────────────
// Completed Tree Provider — bottom panel
// ────────────────────────────────────────────

type CompletedTreeElement = SessionItem | TeamItem | AgentItem;

export class CompletedTreeProvider
    implements vscode.TreeDataProvider<CompletedTreeElement>, vscode.Disposable
{
    private _onDidChangeTreeData = new vscode.EventEmitter<
        CompletedTreeElement | undefined | null
    >();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private tracker: SessionTracker | undefined;
    private orchestrator: AgentOrchestrator | undefined;
    private disposables: vscode.Disposable[] = [];

    setTracker(tracker: SessionTracker): void {
        this.tracker = tracker;
        this.disposables.push(
            tracker.onDidChangeSessions(() => this.refresh())
        );
    }

    setOrchestrator(orchestrator: AgentOrchestrator): void {
        this.orchestrator = orchestrator;
        this.disposables.push(
            orchestrator.onDidChangeTeams(() => this.refresh())
        );
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: CompletedTreeElement): vscode.TreeItem {
        return element;
    }

    getChildren(element?: CompletedTreeElement): CompletedTreeElement[] {
        if (element instanceof TeamItem) {
            return element.team.agents.map(
                (agent) => new AgentItem(agent, element.team.id, this.tracker)
            );
        }
        if (element) return [];

        // Root level: completed teams + completed sessions
        const items: CompletedTreeElement[] = [];

        // Completed teams
        if (this.orchestrator) {
            const completedTeams = this.orchestrator
                .getAllTeams()
                .filter(
                    (t) =>
                        t.status === "completed" ||
                        t.status === "error" ||
                        t.status === "stopped" ||
                        t.status === "cancelled"
                );
            for (const team of completedTeams) {
                const item = new TeamItem(team);
                item.collapsibleState =
                    vscode.TreeItemCollapsibleState.Collapsed;
                items.push(item);
            }
        }

        // Completed sessions
        if (this.tracker) {
            const completed = this.tracker
                .getAllSessions()
                .filter(
                    (s) => s.status === "completed" || s.status === "error"
                )
                .sort(
                    (a, b) =>
                        new Date(b.endedAt ?? b.startedAt).getTime() -
                        new Date(a.endedAt ?? a.startedAt).getTime()
                )
                .slice(0, 10);

            for (const s of completed) {
                items.push(new SessionItem(s, this.tracker));
            }
        }

        return items;
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this._onDidChangeTreeData.dispose();
    }
}
