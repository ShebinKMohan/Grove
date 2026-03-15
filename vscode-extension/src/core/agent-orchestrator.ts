/**
 * Agent Orchestrator — one-click team launch and management.
 *
 * Handles the full lifecycle of an Agent Team:
 * 1. Pre-flight checks (overlaps, env var, cost estimate)
 * 2. Worktree creation per agent
 * 3. Per-agent CLAUDE.md generation
 * 4. Session spawning
 * 5. Team state tracking
 *
 * Depends on VS Code API for terminal management and UI.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
    TeamTemplate,
    detectOwnershipOverlaps,
    type OwnershipOverlap,
} from "./template-manager";
import {
    createWorktree,
    removeWorktree,
} from "./worktree-manager";
import { generateClaudeMd } from "./claude-md-generator";
import { loadProjectConfig } from "./config-manager";
import { SessionTracker } from "./session-tracker";
import { launchClaude } from "../utils/terminal";
import { log, logError } from "../utils/logger";
import { formatErrorForUser } from "../utils/errors";
import { showAutoInfo } from "../ui/notifications";

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

type TeamStatus = "launching" | "running" | "completed" | "error" | "stopped" | "cancelled";

export interface AgentState {
    role: string;
    displayName: string;
    worktreePath: string;
    branch: string;
    sessionId?: string;
    status: "pending" | "launching" | "running" | "completed" | "error" | "stopped";
}

export interface TeamState {
    id: string;
    name: string;
    templateName: string;
    taskDescription: string;
    startedAt: string;
    endedAt?: string;
    status: TeamStatus;
    agents: AgentState[];
}

/** Serializable subset of AgentState for persistence. */
interface PersistedAgent {
    role: string;
    displayName: string;
    worktreePath: string;
    branch: string;
    status: AgentState["status"];
}

/** Serializable subset of TeamState for persistence. */
interface PersistedTeam {
    id: string;
    name: string;
    templateName: string;
    taskDescription: string;
    createdAt: string;
    endedAt?: string;
    status: TeamStatus;
    agents: PersistedAgent[];
}

interface PreFlightResult {
    ok: boolean;
    overlaps: OwnershipOverlap[];
    agentTeamsEnabled: boolean;
    estimatedTokens: string;
    worktreeCount: number;
    warnings: string[];
}

// ────────────────────────────────────────────
// Agent Orchestrator
// ────────────────────────────────────────────

export class AgentOrchestrator implements vscode.Disposable {
    private teams = new Map<string, TeamState>();
    private disposables: vscode.Disposable[] = [];
    private _onDidChangeTeams = new vscode.EventEmitter<void>();
    readonly onDidChangeTeams = this._onDidChangeTeams.event;
    private _isLaunching = false;

    constructor(
        private readonly repoRoot: string,
        private readonly sessionTracker: SessionTracker
    ) {
        // Restore persisted teams before wiring up listeners
        this.restoreTeams();

        // Watch for session changes to update team status
        this.disposables.push(
            this.sessionTracker.onDidChangeSessions(() => {
                this.syncTeamStatuses();
            })
        );
    }

    // ── Pre-Flight ───────────────────────────────────────────

    /**
     * Run pre-flight checks before launching a team.
     */
    preFlight(template: TeamTemplate): PreFlightResult {
        const config = vscode.workspace.getConfiguration("grove");
        const agentTeamsEnabled = config.get<boolean>("enableAgentTeams", true);
        const maxSessions = config.get<number>("maxConcurrentSessions", 5);

        const overlaps = detectOwnershipOverlaps(template);
        const warnings: string[] = [];

        // Check max concurrent sessions
        const currentActive = this.sessionTracker.activeCount;
        const newSessions = template.agents.length;
        if (currentActive + newSessions > maxSessions) {
            warnings.push(
                `This team needs ${newSessions} sessions, but only ` +
                `${maxSessions - currentActive} slots available ` +
                `(${currentActive} active, max ${maxSessions}).`
            );
        }

        // Check for read-only agents with no ownership (fine but note it)
        const reviewAgents = template.agents.filter(
            (a) => a.readOnly && a.ownership.length === 0
        );
        if (reviewAgents.length > 0) {
            warnings.push(
                `${reviewAgents.length} reviewer agent(s) have no ownership — ` +
                `they will review the full codebase.`
            );
        }

        if (overlaps.length > 0) {
            warnings.push(
                `${overlaps.length} file ownership overlap(s) detected between agents. ` +
                `Review before launching.`
            );
        }

        return {
            ok: warnings.length === 0,
            overlaps,
            agentTeamsEnabled,
            estimatedTokens: template.estimatedTokens || "Unknown",
            worktreeCount: template.agents.length,
            warnings,
        };
    }

    // ── Team Launch ──────────────────────────────────────────

    /**
     * Launch a full agent team. This is the one-click flow.
     *
     * Returns the team state, or undefined if canceled/guarded.
     */
    async launchTeam(
        template: TeamTemplate,
        taskDescription: string,
        teamName: string
    ): Promise<TeamState | undefined> {
        // ── Launch guard ─────────────────────────────────────
        if (this._isLaunching) {
            void showAutoInfo(
                "A team is already being launched. Please wait."
            );
            return undefined;
        }

        // ── Session count validation ─────────────────────────
        const config = vscode.workspace.getConfiguration("grove");
        const maxSessions = config.get<number>("maxConcurrentSessions", 5);
        const currentActive = this.sessionTracker.activeCount;
        const newSessions = template.agents.length;

        if (currentActive + newSessions > maxSessions) {
            const choice = await vscode.window.showWarningMessage(
                `This will create ${newSessions} sessions, exceeding the limit of ${maxSessions}. Proceed anyway?`,
                "Proceed",
                "Cancel"
            );
            if (choice !== "Proceed") {
                return undefined;
            }
        }

        this._isLaunching = true;
        try {
            return await this.doLaunchTeam(template, taskDescription, teamName);
        } finally {
            this._isLaunching = false;
        }
    }

    /**
     * Internal launch implementation wrapped in withProgress.
     */
    private async doLaunchTeam(
        template: TeamTemplate,
        taskDescription: string,
        teamName: string
    ): Promise<TeamState | undefined> {
        const config = vscode.workspace.getConfiguration("grove");
        const worktreeDir = config.get<string>(
            "worktreeLocation",
            ".claude/worktrees"
        );

        // Generate team ID
        const teamId = this.generateId();
        const team: TeamState = {
            id: teamId,
            name: teamName,
            templateName: template.name,
            taskDescription,
            startedAt: new Date().toISOString(),
            status: "launching",
            agents: template.agents.map((a) => ({
                role: a.role,
                displayName: a.displayName,
                worktreePath: "",
                branch: "",
                status: "pending",
            })),
        };

        this.teams.set(teamId, team);
        this._onDidChangeTeams.fire();
        this.persistTeams();

        const projectConfig = loadProjectConfig(this.repoRoot) ?? undefined;
        const sharedFiles = projectConfig?.sharedFiles ?? [];

        // Set the agent teams env var if configured
        if (config.get<boolean>("enableAgentTeams", true)) {
            this.ensureAgentTeamsEnvVar();
        }

        const totalAgents = template.agents.length;

        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Launching team "${teamName}"`,
                cancellable: true,
            },
            async (progress, token) => {
                try {
                    // ── Step 1: Create worktrees for each agent ──────
                    log(`Launching team "${teamName}" with ${totalAgents} agents`);

                    // Track worktrees created in THIS launch for cancellation cleanup
                    const createdWorktreePaths: string[] = [];
                    const createdClaudeMdPaths: string[] = [];

                    for (let i = 0; i < totalAgents; i++) {
                        // Check for cancellation between iterations
                        if (token.isCancellationRequested) {
                            await this.cancelLaunch(
                                team,
                                createdWorktreePaths,
                                createdClaudeMdPaths
                            );
                            return team;
                        }

                        const agent = template.agents[i];
                        const agentState = team.agents[i];
                        agentState.status = "launching";
                        this._onDidChangeTeams.fire();

                        progress.report({
                            message: `Creating worktree for ${agent.role}... (${i + 1}/${totalAgents})`,
                            increment: (1 / (totalAgents * 2)) * 100,
                        });

                        const branchName = `worktree-${teamName}-${agent.role}`;

                        try {
                            const baseBranch = config.get<string>(
                                "defaultBaseBranch",
                                "main"
                            );
                            const result = await createWorktree(
                                this.repoRoot,
                                branchName,
                                {
                                    worktreeDir,
                                    startPoint: baseBranch,
                                    autoGitignore: config.get<boolean>("autoGitignore", true),
                                    autoInstallDeps: config.get<boolean>(
                                        "autoInstallDependencies",
                                        true
                                    ),
                                }
                            );

                            agentState.worktreePath = result.path;
                            agentState.branch = result.branch;
                            createdWorktreePaths.push(result.path);

                            // Generate per-agent CLAUDE.md
                            const claudeMdPath = path.join(result.path, "CLAUDE.md");
                            generateClaudeMd({
                                agent,
                                template,
                                taskDescription,
                                teamName,
                                repoRoot: this.repoRoot,
                                worktreePath: result.path,
                                projectConfig,
                                sharedFiles,
                            });
                            createdClaudeMdPaths.push(claudeMdPath);

                            log(`Created worktree for ${agent.displayName}: ${result.path}`);
                        } catch (err) {
                            logError(`Failed to create worktree for ${agent.role}`, err);
                            agentState.status = "error";
                            this._onDidChangeTeams.fire();

                            // Ask user if they want to continue or abort
                            const action = await vscode.window.showWarningMessage(
                                formatErrorForUser(err, `Failed to create worktree for ${agent.displayName}`),
                                "Continue Without This Agent",
                                "Abort Team Launch"
                            );

                            if (action === "Abort Team Launch") {
                                await this.cancelLaunch(
                                    team,
                                    createdWorktreePaths,
                                    createdClaudeMdPaths
                                );
                                return undefined;
                            }
                            continue;
                        }
                    }

                    // ── Step 2: Spawn Claude Code sessions ───────────
                    for (let i = 0; i < totalAgents; i++) {
                        // Check for cancellation between iterations
                        if (token.isCancellationRequested) {
                            await this.cancelLaunch(
                                team,
                                createdWorktreePaths,
                                createdClaudeMdPaths
                            );
                            return team;
                        }

                        const agent = template.agents[i];
                        const agentState = team.agents[i];

                        if (agentState.status === "error" || !agentState.worktreePath) {
                            continue;
                        }

                        progress.report({
                            message: `Launching agent ${agent.role}... (${i + 1}/${totalAgents})`,
                            increment: (1 / (totalAgents * 2)) * 100,
                        });

                        try {
                            const terminal = await launchClaude(
                                agentState.branch,
                                agentState.worktreePath,
                                { skipSessionPrompt: true }
                            );

                            if (terminal) {
                                const session = this.sessionTracker.startSession(
                                    terminal,
                                    agentState.worktreePath,
                                    agentState.branch,
                                    `[${template.name}] ${agent.displayName}: ${taskDescription}`
                                );
                                agentState.sessionId = session.id;
                                agentState.status = "running";
                            } else {
                                agentState.status = "error";
                            }
                        } catch (err) {
                            logError(`Failed to launch session for ${agent.role}`, err);
                            agentState.status = "error";
                        }

                        this._onDidChangeTeams.fire();
                    }

                    // Update team status
                    const runningAgents = team.agents.filter(
                        (a) => a.status === "running"
                    );
                    team.status = runningAgents.length > 0 ? "running" : "error";
                    this._onDidChangeTeams.fire();
                    this.persistTeams();

                    log(
                        `Team "${teamName}" launched: ${runningAgents.length}/${totalAgents} agents running`
                    );

                    return team;
                } catch (err) {
                    logError(`Team launch failed: ${teamName}`, err);
                    team.status = "error";
                    this._onDidChangeTeams.fire();
                    this.persistTeams();
                    return team;
                }
            }
        );
    }

    /**
     * Cancel an in-progress team launch, cleaning up created worktrees and CLAUDE.md files.
     */
    private async cancelLaunch(
        team: TeamState,
        createdWorktreePaths: string[],
        createdClaudeMdPaths: string[]
    ): Promise<void> {
        // Stop any sessions that were already spawned
        for (const agent of team.agents) {
            if (agent.sessionId) {
                try {
                    this.sessionTracker.stopSession(agent.sessionId);
                } catch (err) {
                    logError(`Failed to stop session for ${agent.role} during cancellation`, err);
                }
                agent.status = "stopped";
            }
        }

        // Delete CLAUDE.md files created so far
        for (const mdPath of createdClaudeMdPaths) {
            try {
                if (fs.existsSync(mdPath)) {
                    fs.unlinkSync(mdPath);
                }
            } catch (err) {
                logError(`Failed to delete CLAUDE.md at ${mdPath}`, err);
            }
        }

        // Remove worktrees created so far
        const protectedBranches = vscode.workspace
            .getConfiguration("grove")
            .get<string[]>(
                "protectedBranches",
                ["main", "master", "develop", "production"]
            );

        let cleanedUp = 0;
        for (const wtPath of createdWorktreePaths) {
            try {
                await removeWorktree(this.repoRoot, wtPath, {
                    deleteBranch: true,
                    force: true,
                    protectedBranches,
                });
                cleanedUp++;
            } catch (err) {
                logError(`Failed to remove worktree at ${wtPath} during cancellation`, err);
            }
        }

        team.status = "cancelled";
        team.endedAt = new Date().toISOString();
        this._onDidChangeTeams.fire();
        this.persistTeams();

        void showAutoInfo(
            `Team launch cancelled. ${cleanedUp} worktree(s) cleaned up.`
        );

        log(`Team "${team.name}" launch cancelled. ${cleanedUp} worktrees cleaned up.`);
    }

    // ── Team Management ──────────────────────────────────────

    /**
     * Get all teams.
     */
    getAllTeams(): TeamState[] {
        return [...this.teams.values()];
    }

    /**
     * Get active teams.
     */
    getActiveTeams(): TeamState[] {
        return [...this.teams.values()].filter(
            (t) => t.status === "launching" || t.status === "running"
        );
    }

    /**
     * Get a team by ID.
     */
    getTeam(teamId: string): TeamState | undefined {
        return this.teams.get(teamId);
    }

    /**
     * Stop all agents in a team.
     */
    stopTeam(teamId: string): void {
        const team = this.teams.get(teamId);
        if (!team) return;

        for (const agent of team.agents) {
            if (agent.status === "running" || agent.status === "launching") {
                if (agent.sessionId) {
                    this.sessionTracker.stopSession(agent.sessionId);
                }
                agent.status = "stopped";
            }
        }

        team.status = "stopped";
        team.endedAt = new Date().toISOString();
        this._onDidChangeTeams.fire();
        this.persistTeams();
    }

    /**
     * Stop a single agent within a team.
     */
    stopAgent(teamId: string, role: string): void {
        const team = this.teams.get(teamId);
        if (!team) return;

        const agent = team.agents.find((a) => a.role === role);
        if (!agent?.sessionId) return;

        this.sessionTracker.stopSession(agent.sessionId);
        agent.status = "stopped";

        // Check if all agents are done
        const stillRunning = team.agents.some(
            (a) => a.status === "running" || a.status === "launching"
        );
        if (!stillRunning) {
            // If any agent was manually stopped, team is "stopped", not "completed"
            const anyStopped = team.agents.some((a) => a.status === "stopped");
            team.status = anyStopped ? "stopped" : "completed";
            team.endedAt = new Date().toISOString();
        }

        this._onDidChangeTeams.fire();
        this.persistTeams();
    }

    /**
     * Clean up a team's worktrees (after merge or abort).
     */
    async cleanupTeam(teamId: string): Promise<void> {
        const team = this.teams.get(teamId);
        if (!team) return;

        // Stop all running agents first
        this.stopTeam(teamId);

        // Remove worktrees
        for (const agent of team.agents) {
            if (agent.worktreePath) {
                try {
                    const config = vscode.workspace.getConfiguration("grove");
                    const protectedBranches = config.get<string[]>(
                        "protectedBranches",
                        ["main", "master", "develop", "production"]
                    );
                    await removeWorktree(this.repoRoot, agent.worktreePath, {
                        deleteBranch: true,
                        force: true,
                        protectedBranches,
                    });
                } catch (err) {
                    logError(
                        `Failed to remove worktree for ${agent.role}`,
                        err
                    );
                }
            }
        }

        this.teams.delete(teamId);
        this._onDidChangeTeams.fire();
        this.persistTeams();
    }

    // ── Private ──────────────────────────────────────────────

    /**
     * Sync agent statuses from session tracker.
     */
    private syncTeamStatuses(): void {
        let changed = false;

        for (const team of this.teams.values()) {
            if (team.status !== "running") continue;

            for (const agent of team.agents) {
                if (agent.status !== "running" || !agent.sessionId) continue;

                const session = this.sessionTracker.getSession(agent.sessionId);
                if (!session) continue;

                if (
                    session.status === "completed" ||
                    session.status === "error"
                ) {
                    agent.status = session.status;
                    changed = true;
                }
            }

            // Check if all agents are done
            const stillRunning = team.agents.some(
                (a) => a.status === "running" || a.status === "launching"
            );
            if (!stillRunning && team.status === "running") {
                const hasErrors = team.agents.some(
                    (a) => a.status === "error"
                );
                team.status = hasErrors ? "error" : "completed";
                team.endedAt = new Date().toISOString();
                changed = true;
            }
        }

        if (changed) {
            this._onDidChangeTeams.fire();
            this.persistTeams();
        }
    }

    /**
     * Ensure CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is set.
     */
    private ensureAgentTeamsEnvVar(): void {
        const settingsPath = path.join(
            os.homedir(),
            ".claude",
            "settings.json"
        );

        try {
            let settings: Record<string, unknown> = {};
            if (fs.existsSync(settingsPath)) {
                settings = JSON.parse(
                    fs.readFileSync(settingsPath, "utf-8")
                ) as Record<string, unknown>;
            }

            const rawEnv = settings.env;
            if (rawEnv !== undefined && (typeof rawEnv !== "object" || rawEnv === null || Array.isArray(rawEnv))) {
                logError(
                    `~/.claude/settings.json has unexpected "env" type (${typeof rawEnv}). Skipping env var setup.`,
                    undefined
                );
                return;
            }
            const env = (rawEnv ?? {}) as Record<string, string>;
            if (env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS !== "1") {
                env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
                settings.env = env;

                const dir = path.dirname(settingsPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(
                    settingsPath,
                    JSON.stringify(settings, null, 2) + "\n"
                );
                log("Set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in ~/.claude/settings.json");
            }
        } catch (err) {
            logError("Failed to set agent teams env var", err);
            void vscode.window.showWarningMessage(
                "Grove: Could not enable Agent Teams in Claude settings (~/.claude/settings.json). " +
                "Teams may not work correctly. Check file permissions."
            );
        }
    }

    private generateId(): string {
        const ts = Date.now().toString(36);
        const rand = Math.random().toString(36).slice(2, 6);
        return `team-${ts}-${rand}`;
    }

    // ── Persistence ─────────────────────────────────────────

    private get teamsFilePath(): string {
        return path.join(this.repoRoot, ".grove", "teams.json");
    }

    /**
     * Persist all teams to `.grove/teams.json` using atomic write (write to .tmp, then rename).
     */
    private persistTeams(): void {
        try {
            const dir = path.dirname(this.teamsFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const data: PersistedTeam[] = [...this.teams.values()].map(
                (t) => ({
                    id: t.id,
                    name: t.name,
                    templateName: t.templateName,
                    taskDescription: t.taskDescription,
                    createdAt: t.startedAt,
                    endedAt: t.endedAt,
                    status: t.status,
                    agents: t.agents.map((a) => ({
                        role: a.role,
                        displayName: a.displayName,
                        worktreePath: a.worktreePath,
                        branch: a.branch,
                        status: a.status,
                    })),
                })
            );

            // Atomic write: write to temp file then rename
            const tmpPath = this.teamsFilePath + ".tmp";
            fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
            fs.renameSync(tmpPath, this.teamsFilePath);
        } catch (err) {
            logError("Failed to persist teams", err);
        }
    }

    /**
     * Restore teams from `.grove/teams.json`.
     * Only restores teams whose worktree directories still exist.
     * Restored teams are set to 'stopped' status (no terminal reconnection).
     */
    private restoreTeams(): void {
        try {
            if (!fs.existsSync(this.teamsFilePath)) return;

            const raw = fs.readFileSync(this.teamsFilePath, "utf-8");
            let data: PersistedTeam[];
            try {
                data = JSON.parse(raw) as PersistedTeam[];
            } catch {
                // JSON is corrupted. Try the temp file as a backup.
                const tmpPath = this.teamsFilePath + ".tmp";
                if (fs.existsSync(tmpPath)) {
                    try {
                        data = JSON.parse(
                            fs.readFileSync(tmpPath, "utf-8")
                        ) as PersistedTeam[];
                        log("Restored teams from backup (.tmp) after corrupted teams.json");
                    } catch {
                        logError(
                            "Both teams.json and .tmp are corrupted. Starting fresh.",
                            undefined
                        );
                        return;
                    }
                } else {
                    logError(
                        "teams.json is corrupted and no backup exists. Starting fresh.",
                        undefined
                    );
                    return;
                }
            }

            if (!Array.isArray(data)) return;

            let restoredCount = 0;
            for (const persisted of data) {
                // Only restore teams that have at least one agent
                // with a worktree directory still on disk
                const hasExistingWorktree = persisted.agents.some(
                    (a) => a.worktreePath && fs.existsSync(a.worktreePath)
                );

                if (!hasExistingWorktree) continue;

                // Preserve terminal statuses; only override active states to "stopped"
                const isTerminalStatus = (s: TeamStatus): boolean =>
                    s === "completed" || s === "error" || s === "cancelled";

                const restoredStatus: TeamStatus = isTerminalStatus(persisted.status)
                    ? persisted.status
                    : "stopped";

                const team: TeamState = {
                    id: persisted.id,
                    name: persisted.name,
                    templateName: persisted.templateName,
                    taskDescription: persisted.taskDescription,
                    startedAt: persisted.createdAt,
                    endedAt: isTerminalStatus(persisted.status)
                        ? (persisted.endedAt ?? new Date().toISOString())
                        : new Date().toISOString(),
                    status: restoredStatus,
                    agents: persisted.agents.map((a) => ({
                        role: a.role,
                        displayName: a.displayName || a.role,
                        worktreePath: a.worktreePath,
                        branch: a.branch,
                        status: (a.status === "running" || a.status === "launching")
                            ? "stopped" as const
                            : a.status,
                    })),
                };

                this.teams.set(persisted.id, team);
                restoredCount++;
            }

            if (restoredCount > 0) {
                log(`Restored ${restoredCount} team(s) from disk`);
            }
        } catch (err) {
            logError("Failed to restore teams", err);
        }
    }

    // ── Disposal ─────────────────────────────────────────────

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this._onDidChangeTeams.dispose();
    }
}
