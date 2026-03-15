/**
 * Session Tracker — tracks active Claude Code terminal sessions.
 * Maps VS Code Terminal instances to worktrees and persists session data.
 *
 * Sessions are tracked in-memory with JSON file persistence at
 * .grove/sessions.json for cross-restart state.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getChangedFiles } from "./worktree-manager";
import { sanitizeRefName } from "../utils/git";
import { log, logError } from "../utils/logger";

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

type SessionStatus =
    | "running"
    | "idle"
    | "completed"
    | "error";

export interface SessionInfo {
    /** Unique session ID */
    id: string;
    /** Worktree path */
    worktreePath: string;
    /** Branch name */
    branch: string;
    /** User-defined task description */
    taskDescription: string;
    /** ISO timestamp when session started */
    startedAt: string;
    /** ISO timestamp when session ended (if completed) */
    endedAt?: string;
    /** Current session status */
    status: SessionStatus;
    /** Exit code if terminal closed */
    exitCode?: number;
    /** Files modified since session started */
    modifiedFiles: string[];
}

/** Serializable session data (without terminal reference) */
interface PersistedSession {
    id: string;
    worktreePath: string;
    branch: string;
    taskDescription: string;
    startedAt: string;
    endedAt?: string;
    status: SessionStatus;
    exitCode?: number;
}

// ────────────────────────────────────────────
// Session Tracker
// ────────────────────────────────────────────

export class SessionTracker implements vscode.Disposable {
    private sessions = new Map<string, SessionInfo>();
    private terminalMap = new Map<vscode.Terminal, string>(); // terminal → session ID
    private disposables: vscode.Disposable[] = [];

    private _onDidChangeSessions = new vscode.EventEmitter<void>();
    readonly onDidChangeSessions = this._onDidChangeSessions.event;

    constructor(
        private readonly repoRoot: string,
        private readonly notifyOnComplete: () => boolean
    ) {
        // Watch for terminal close events
        this.disposables.push(
            vscode.window.onDidCloseTerminal((terminal) => {
                void this.handleTerminalClose(terminal);
            })
        );

        // Restore persisted sessions (mark old running ones as completed)
        this.restoreSessions();
    }

    // ── Public API ──────────────────────────────────────────

    /**
     * Register a new session for a terminal + worktree.
     */
    startSession(
        terminal: vscode.Terminal,
        worktreePath: string,
        branch: string,
        taskDescription: string = ""
    ): SessionInfo {
        const id = this.generateId();
        const session: SessionInfo = {
            id,
            worktreePath,
            branch,
            taskDescription,
            startedAt: new Date().toISOString(),
            status: "running",
            modifiedFiles: [],
        };

        this.sessions.set(id, session);
        this.terminalMap.set(terminal, id);
        this.persistSessions();
        this._onDidChangeSessions.fire();

        log(`Session started: ${id} for ${branch} at ${worktreePath}`);
        return session;
    }

    /**
     * Get all active sessions (running or idle).
     */
    getActiveSessions(): SessionInfo[] {
        return [...this.sessions.values()].filter(
            (s) => s.status === "running" || s.status === "idle"
        );
    }

    /**
     * Get all sessions (including completed).
     */
    getAllSessions(): SessionInfo[] {
        return [...this.sessions.values()];
    }

    /**
     * Get session by ID.
     */
    getSession(id: string): SessionInfo | undefined {
        return this.sessions.get(id);
    }

    /**
     * Get session associated with a worktree path.
     * Returns the most recent active session for that worktree.
     */
    getSessionForWorktree(worktreePath: string): SessionInfo | undefined {
        const matches = [...this.sessions.values()]
            .filter(
                (s) =>
                    s.worktreePath === worktreePath &&
                    (s.status === "running" || s.status === "idle")
            )
            .sort(
                (a, b) =>
                    new Date(b.startedAt).getTime() -
                    new Date(a.startedAt).getTime()
            );
        return matches[0];
    }

    /**
     * Get the terminal associated with a session.
     */
    getTerminalForSession(sessionId: string): vscode.Terminal | undefined {
        for (const [terminal, id] of this.terminalMap) {
            if (id === sessionId) return terminal;
        }
        return undefined;
    }

    /**
     * Stop a session — closes the terminal.
     */
    stopSession(sessionId: string): void {
        const terminal = this.getTerminalForSession(sessionId);
        if (terminal) {
            terminal.dispose();
            // handleTerminalClose will update the session
        } else {
            // Terminal already gone, just mark as completed
            const session = this.sessions.get(sessionId);
            if (session && session.status === "running") {
                session.status = "completed";
                session.endedAt = new Date().toISOString();
                this.persistSessions();
                this._onDidChangeSessions.fire();
            }
        }
    }

    /**
     * Stop all active sessions.
     */
    stopAllSessions(): void {
        // Dispose terminals for sessions that have terminal mappings
        for (const [terminal] of this.terminalMap) {
            terminal.dispose();
        }
        // Also mark any orphaned "running"/"idle" sessions as completed
        // (sessions whose terminals were already closed but status wasn't updated)
        for (const session of this.sessions.values()) {
            if (session.status === "running" || session.status === "idle") {
                session.status = "completed";
                session.endedAt = session.endedAt ?? new Date().toISOString();
            }
        }
        this.persistSessions();
        this._onDidChangeSessions.fire();
    }

    /**
     * Update the task description for a session.
     */
    setTaskDescription(sessionId: string, description: string): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.taskDescription = description;
            this.persistSessions();
            this._onDidChangeSessions.fire();
        }
    }

    /**
     * Refresh modified files list for a session by running git diff.
     */
    async refreshModifiedFiles(
        sessionId: string,
        baseBranch: string = "main"
    ): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        try {
            session.modifiedFiles = await getChangedFiles(
                session.worktreePath,
                baseBranch
            );
            this._onDidChangeSessions.fire();
        } catch (err) {
            log(`Could not refresh file list for session ${session.branch}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /**
     * Check if a worktree has an active session.
     */
    hasActiveSession(worktreePath: string): boolean {
        return this.getSessionForWorktree(worktreePath) !== undefined;
    }

    /**
     * Get the number of active sessions.
     */
    get activeCount(): number {
        return this.getActiveSessions().length;
    }

    /**
     * Remove completed sessions from the list.
     */
    clearCompletedSessions(): void {
        for (const [id, session] of this.sessions) {
            if (session.status === "completed" || session.status === "error") {
                this.sessions.delete(id);
            }
        }
        this.persistSessions();
        this._onDidChangeSessions.fire();
    }

    /**
     * Get elapsed time string for a session.
     */
    getElapsedTime(session: SessionInfo): string {
        const start = new Date(session.startedAt).getTime();
        const end = session.endedAt
            ? new Date(session.endedAt).getTime()
            : Date.now();
        const elapsed = end - start;

        const seconds = Math.floor(elapsed / 1000);
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        return `${hours}h ${remainingMinutes}m`;
    }

    // ── Private ─────────────────────────────────────────────

    private async handleTerminalClose(
        terminal: vscode.Terminal
    ): Promise<void> {
        const sessionId = this.terminalMap.get(terminal);
        if (!sessionId) return;

        const session = this.sessions.get(sessionId);
        if (!session) return;

        // Update session status
        const exitCode = terminal.exitStatus?.code;
        session.status = exitCode === 0 || exitCode === undefined
            ? "completed"
            : "error";
        session.exitCode = exitCode;
        session.endedAt = new Date().toISOString();

        // Refresh modified files one last time
        try {
            const config = vscode.workspace.getConfiguration("grove");
            const baseBranch = config.get<string>("defaultBaseBranch", "main");
            session.modifiedFiles = await getChangedFiles(
                session.worktreePath,
                baseBranch
            );
        } catch (err) {
            log(`Could not get final file list for session ${session.branch}: ${err instanceof Error ? err.message : String(err)}`);
        }

        this.terminalMap.delete(terminal);
        this.persistSessions();
        this._onDidChangeSessions.fire();

        log(
            `Session ended: ${sessionId} (${session.branch}) ` +
            `status=${session.status} exit=${exitCode ?? "?"}`
        );

        // Fire notification if configured
        if (this.notifyOnComplete()) {
            const fileCount = session.modifiedFiles.length;
            const fileMsg = fileCount > 0 ? ` (${fileCount} files changed)` : "";
            const action = await vscode.window.showInformationMessage(
                `Claude session completed: ${session.branch}${fileMsg}`,
                "View Diff",
                "Dismiss"
            );
            if (action === "View Diff") {
                const diffTerminal = vscode.window.createTerminal({
                    name: `Diff: ${session.branch}`,
                    cwd: session.worktreePath,
                });
                diffTerminal.show();
                const config = vscode.workspace.getConfiguration("grove");
                const baseBranch = config.get<string>("defaultBaseBranch", "main");
                diffTerminal.sendText(`git diff ${sanitizeRefName(baseBranch)}...HEAD --stat`);
            }
        }
    }

    private generateId(): string {
        const ts = Date.now().toString(36);
        const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
        return `${ts}-${rand}`;
    }

    // ── Persistence ─────────────────────────────────────────

    private get sessionsFilePath(): string {
        return path.join(this.repoRoot, ".grove", "sessions.json");
    }

    private persistSessions(): void {
        try {
            const dir = path.dirname(this.sessionsFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const data: PersistedSession[] = [...this.sessions.values()].map(
                (s) => ({
                    id: s.id,
                    worktreePath: s.worktreePath,
                    branch: s.branch,
                    taskDescription: s.taskDescription,
                    startedAt: s.startedAt,
                    endedAt: s.endedAt,
                    status: s.status,
                    exitCode: s.exitCode,
                })
            );

            // Write to temp file then rename for atomic persistence.
            // Prevents corrupted JSON if VS Code crashes mid-write.
            const tmpPath = this.sessionsFilePath + ".tmp";
            fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
            fs.renameSync(tmpPath, this.sessionsFilePath);
        } catch (err) {
            logError("Failed to persist sessions", err);
        }
    }

    private restoreSessions(): void {
        try {
            if (!fs.existsSync(this.sessionsFilePath)) return;

            const raw = fs.readFileSync(this.sessionsFilePath, "utf-8");
            let data: PersistedSession[];
            try {
                data = JSON.parse(raw) as PersistedSession[];
            } catch {
                // JSON is corrupted (e.g., partial write from a crash).
                // Try the temp file as a backup.
                const tmpPath = this.sessionsFilePath + ".tmp";
                if (fs.existsSync(tmpPath)) {
                    try {
                        data = JSON.parse(fs.readFileSync(tmpPath, "utf-8")) as PersistedSession[];
                        log("Restored sessions from backup (.tmp) after corrupted sessions.json");
                    } catch {
                        logError("Both sessions.json and .tmp are corrupted. Starting fresh.", undefined);
                        return;
                    }
                } else {
                    logError("sessions.json is corrupted and no backup exists. Starting fresh.", undefined);
                    return;
                }
            }
            if (!Array.isArray(data)) return;

            for (const persisted of data) {
                // Mark previously-running sessions as completed (VS Code restarted)
                const wasRunning =
                    persisted.status === "running" || persisted.status === "idle";
                const status: SessionStatus = wasRunning
                    ? "completed"
                    : persisted.status;

                // Drop interrupted sessions that had no meaningful duration
                // (e.g., window reloaded right after launch). They just clutter the UI.
                if (wasRunning && !persisted.endedAt) {
                    log(`Dropping interrupted 0-duration session: ${persisted.branch}`);
                    continue;
                }

                this.sessions.set(persisted.id, {
                    ...persisted,
                    status,
                    endedAt: persisted.endedAt,
                    modifiedFiles: [],
                });
            }

            log(`Restored ${data.length} session(s) from disk`);
        } catch (err) {
            logError("Failed to restore sessions", err);
        }
    }

    // ── Disposal ────────────────────────────────────────────

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this._onDidChangeSessions.dispose();
    }
}
