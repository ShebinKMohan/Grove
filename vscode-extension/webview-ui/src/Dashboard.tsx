import { useEffect, useState, useCallback, useMemo } from "react";
import type {
    SessionInfo,
    WorktreeInfo,
    FileChange,
    OverlapAlert,
    ExtensionMessage,
} from "./types";
import vscode from "./vscode";
import { AgentCard } from "./components/AgentCard";
import { FileActivityStream } from "./components/FileActivityStream";
import { WorktreeStatus } from "./components/WorktreeStatus";
import { OverlapAlerts } from "./components/OverlapAlerts";
import "./dashboard.css";

const MAX_FILE_CHANGES = 100;

type TabId = "sessions" | "activity" | "overlaps";

export function Dashboard() {
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
    const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
    const [overlaps, setOverlaps] = useState<OverlapAlert[]>([]);
    const [currentTab, setCurrentTab] = useState<TabId>("sessions");
    const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
        completed: true,
    });

    const toggleSection = useCallback((section: string) => {
        setCollapsedSections((prev) => ({
            ...prev,
            [section]: !prev[section],
        }));
    }, []);

    const handleMessage = useCallback(
        (event: MessageEvent<ExtensionMessage>) => {
            const message = event.data;
            switch (message.type) {
                case "update":
                    setSessions(message.sessions);
                    setWorktrees(message.worktrees);
                    setOverlaps(message.overlaps);
                    break;
                case "file-change":
                    setFileChanges((prev) => {
                        const next = [message.change, ...prev];
                        return next.slice(0, MAX_FILE_CHANGES);
                    });
                    break;
            }
        },
        []
    );

    useEffect(() => {
        window.addEventListener("message", handleMessage);
        vscode.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", handleMessage);
    }, [handleMessage]);

    const activeSessions = useMemo(
        () => sessions.filter((s) => s.status === "running" || s.status === "idle"),
        [sessions]
    );
    const completedSessions = useMemo(
        () => sessions.filter((s) => s.status === "completed" || s.status === "error"),
        [sessions]
    );
    const activeOverlapCount = useMemo(
        () => overlaps.filter((o) => !o.dismissed).length,
        [overlaps]
    );

    const totalFilesChanged = useMemo(() => {
        const allFiles = new Set<string>();
        for (const s of sessions) {
            for (const f of s.modifiedFiles) {
                allFiles.add(f);
            }
        }
        return allFiles.size;
    }, [sessions]);

    return (
        <div className="dashboard">
            <header className="dashboard-header">
                <h1>WorkTree Pilot</h1>
                <WorktreeStatus
                    worktrees={worktrees}
                    activeSessions={activeSessions.length}
                    overlapCount={activeOverlapCount}
                />
                <div className="header-actions">
                    <button
                        className="btn btn-secondary"
                        onClick={() =>
                            vscode.postMessage({ type: "refresh" })
                        }
                    >
                        Refresh
                    </button>
                </div>
            </header>

            {/* Quick stats bar */}
            {sessions.length > 0 && (
                <div className="stats-bar">
                    <div className="stat-item">
                        <span className="stat-value">{activeSessions.length}</span>
                        <span className="stat-desc">Active</span>
                    </div>
                    <div className="stat-item">
                        <span className="stat-value">{completedSessions.length}</span>
                        <span className="stat-desc">Completed</span>
                    </div>
                    <div className="stat-item">
                        <span className="stat-value">{totalFilesChanged}</span>
                        <span className="stat-desc">Files Changed</span>
                    </div>
                    <div className="stat-item">
                        <span className={`stat-value ${activeOverlapCount > 0 ? "stat-warn" : ""}`}>
                            {activeOverlapCount}
                        </span>
                        <span className="stat-desc">Overlaps</span>
                    </div>
                </div>
            )}

            <div className="tab-bar">
                <button
                    className={`tab ${currentTab === "sessions" ? "active" : ""}`}
                    onClick={() => setCurrentTab("sessions")}
                >
                    Sessions
                    {activeSessions.length > 0 && (
                        <span className="tab-badge tab-badge-active">{activeSessions.length}</span>
                    )}
                </button>
                <button
                    className={`tab ${currentTab === "activity" ? "active" : ""}`}
                    onClick={() => setCurrentTab("activity")}
                >
                    Activity
                    {fileChanges.length > 0 && (
                        <span className="tab-badge tab-badge-neutral">{fileChanges.length}</span>
                    )}
                </button>
                <button
                    className={`tab ${currentTab === "overlaps" ? "active" : ""}`}
                    onClick={() => setCurrentTab("overlaps")}
                >
                    Overlaps
                    {activeOverlapCount > 0 && (
                        <span className="tab-badge">{activeOverlapCount}</span>
                    )}
                </button>
            </div>

            <div className="tab-content">
                {currentTab === "sessions" && (
                    <div className="tab-panel">
                        {activeSessions.length > 0 && (
                            <div className="section">
                                <h2
                                    className="section-header"
                                    onClick={() => toggleSection("active")}
                                >
                                    <span className="section-arrow">
                                        {collapsedSections.active ? "\u25B6" : "\u25BC"}
                                    </span>
                                    Active Sessions ({activeSessions.length})
                                </h2>
                                {!collapsedSections.active && (
                                    <div className="cards-list">
                                        {activeSessions.map((session) => (
                                            <AgentCard
                                                key={session.id}
                                                session={session}
                                            />
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {completedSessions.length > 0 && (
                            <div className="section">
                                <h2
                                    className="section-header"
                                    onClick={() => toggleSection("completed")}
                                >
                                    <span className="section-arrow">
                                        {collapsedSections.completed ? "\u25B6" : "\u25BC"}
                                    </span>
                                    Completed ({completedSessions.length})
                                </h2>
                                {!collapsedSections.completed && (
                                    <div className="cards-list">
                                        {completedSessions.map((session) => (
                                            <AgentCard
                                                key={session.id}
                                                session={session}
                                            />
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {activeSessions.length === 0 &&
                            completedSessions.length === 0 && (
                                <div className="empty-state">
                                    <p>No sessions yet.</p>
                                    <p className="text-muted">
                                        Launch Claude Code from a worktree to see
                                        session activity here.
                                    </p>
                                </div>
                            )}
                    </div>
                )}

                {currentTab === "activity" && (
                    <div className="tab-panel">
                        <FileActivityStream changes={fileChanges} />
                    </div>
                )}

                {currentTab === "overlaps" && (
                    <div className="tab-panel">
                        <OverlapAlerts overlaps={overlaps} />
                    </div>
                )}
            </div>
        </div>
    );
}
