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

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

export type TeamStatus = "launching" | "running" | "completed" | "error" | "stopped";

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

export interface PreFlightResult {
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

    constructor(
        private readonly repoRoot: string,
        private readonly sessionTracker: SessionTracker
    ) {
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
        const config = vscode.workspace.getConfiguration("worktreePilot");
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
     * Returns the team state, or undefined if canceled.
     */
    async launchTeam(
        template: TeamTemplate,
        taskDescription: string,
        teamName: string
    ): Promise<TeamState | undefined> {
        const config = vscode.workspace.getConfiguration("worktreePilot");
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

        const projectConfig = loadProjectConfig(this.repoRoot) ?? undefined;
        const sharedFiles = projectConfig?.sharedFiles ?? [];

        // Set the agent teams env var if configured
        if (config.get<boolean>("enableAgentTeams", true)) {
            this.ensureAgentTeamsEnvVar();
        }

        try {
            // Step 1: Create worktrees for each agent
            log(`Launching team "${teamName}" with ${template.agents.length} agents`);

            for (let i = 0; i < template.agents.length; i++) {
                const agent = template.agents[i];
                const agentState = team.agents[i];
                agentState.status = "launching";
                this._onDidChangeTeams.fire();

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

                    // Step 2: Generate per-agent CLAUDE.md
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

                    log(`Created worktree for ${agent.displayName}: ${result.path}`);
                } catch (err) {
                    logError(`Failed to create worktree for ${agent.role}`, err);
                    agentState.status = "error";
                    this._onDidChangeTeams.fire();

                    // Ask user if they want to continue or abort
                    const action = await vscode.window.showWarningMessage(
                        `Failed to create worktree for ${agent.displayName}: ` +
                        `${err instanceof Error ? err.message : String(err)}`,
                        "Continue Without This Agent",
                        "Abort Team Launch"
                    );

                    if (action === "Abort Team Launch") {
                        await this.cleanupTeam(teamId);
                        return undefined;
                    }
                    continue;
                }
            }

            // Step 3: Spawn Claude Code sessions
            for (let i = 0; i < template.agents.length; i++) {
                const agent = template.agents[i];
                const agentState = team.agents[i];

                if (agentState.status === "error" || !agentState.worktreePath) {
                    continue;
                }

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

            log(
                `Team "${teamName}" launched: ${runningAgents.length}/${template.agents.length} agents running`
            );

            return team;
        } catch (err) {
            logError(`Team launch failed: ${teamName}`, err);
            team.status = "error";
            this._onDidChangeTeams.fire();
            return team;
        }
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
        const stillRunning = team.agents.some((a) => a.status === "running");
        if (!stillRunning) {
            team.status = "completed";
            team.endedAt = new Date().toISOString();
        }

        this._onDidChangeTeams.fire();
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
                    const config = vscode.workspace.getConfiguration("worktreePilot");
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
            if (env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS !== "true") {
                env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "true";
                settings.env = env;

                const dir = path.dirname(settingsPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(
                    settingsPath,
                    JSON.stringify(settings, null, 2) + "\n"
                );
                log("Set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=true in ~/.claude/settings.json");
            }
        } catch (err) {
            logError("Failed to set agent teams env var", err);
        }
    }

    private generateId(): string {
        const ts = Date.now().toString(36);
        const rand = Math.random().toString(36).slice(2, 6);
        return `team-${ts}-${rand}`;
    }

    // ── Disposal ─────────────────────────────────────────────

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this._onDidChangeTeams.dispose();
    }
}
