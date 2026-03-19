import { useMemo } from "react";
import type { SessionInfo } from "../types";
import vscode from "../vscode";

interface AgentCardProps {
    session: SessionInfo;
}

export function AgentCard({ session }: AgentCardProps) {
    const isActive =
        session.status === "running" || session.status === "idle";

    const startedLabel = useMemo(() => {
        return new Date(session.startedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
        });
    }, [session.startedAt]);

    const endedLabel = useMemo(() => {
        if (!session.endedAt) return null;
        return new Date(session.endedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
        });
    }, [session.endedAt]);

    const fileSummary = useMemo(() => {
        if (session.modifiedFiles.length === 0) return null;
        const dirs = new Set<string>();
        for (const f of session.modifiedFiles) {
            const parts = f.split("/");
            if (parts.length > 1) {
                dirs.add(parts.slice(0, -1).join("/"));
            }
        }
        return {
            count: session.modifiedFiles.length,
            dirs: dirs.size,
        };
    }, [session.modifiedFiles]);

    const statusLabel =
        session.status === "running"
            ? "Active"
            : session.status === "idle"
              ? "Waiting"
              : session.status === "completed"
                ? "Done"
                : "Error";

    return (
        <div className={`card card-${session.status}`}>
            <div className="card-header">
                <div className="card-title">
                    <span className={`status-dot status-${session.status}`} />
                    <span className="branch-name">{session.branch}</span>
                    <span className={`status-label status-label-${session.status}`}>
                        {statusLabel}
                    </span>
                </div>
            </div>

            {session.taskDescription && (
                <p className="card-task">{session.taskDescription}</p>
            )}

            <div className="card-meta">
                <span className="card-meta-item" title="Started at">
                    {startedLabel}
                    {endedLabel && ` \u2192 ${endedLabel}`}
                </span>
                {fileSummary && (
                    <span className="files-badge">
                        {fileSummary.count} file{fileSummary.count !== 1 ? "s" : ""}
                        {fileSummary.dirs > 0 && ` across ${fileSummary.dirs} dir${fileSummary.dirs !== 1 ? "s" : ""}`}
                    </span>
                )}
            </div>

            {session.modifiedFiles.length > 0 && (
                <div className="card-files">
                    <ul className="files-list">
                        {session.modifiedFiles.slice(0, 8).map((f) => (
                            <li key={f} className="file-item">
                                {f}
                            </li>
                        ))}
                        {session.modifiedFiles.length > 8 && (
                            <li className="file-item text-muted">
                                +{session.modifiedFiles.length - 8} more
                            </li>
                        )}
                    </ul>
                </div>
            )}

            <div className="card-actions">
                {isActive && (
                    <>
                        <button
                            className="btn btn-small"
                            onClick={() =>
                                vscode.postMessage({
                                    type: "focus-session",
                                    sessionId: session.id,
                                })
                            }
                        >
                            Open Terminal
                        </button>
                        <button
                            className="btn btn-small btn-secondary"
                            onClick={() =>
                                vscode.postMessage({
                                    type: "view-diff",
                                    worktreePath: session.worktreePath,
                                    branch: session.branch,
                                })
                            }
                        >
                            View Changes
                        </button>
                        <button
                            className="btn btn-small btn-danger"
                            onClick={() =>
                                vscode.postMessage({
                                    type: "stop-session",
                                    sessionId: session.id,
                                })
                            }
                        >
                            Stop
                        </button>
                    </>
                )}
                {!isActive && (
                    <button
                        className="btn btn-small btn-secondary"
                        onClick={() =>
                            vscode.postMessage({
                                type: "view-diff",
                                worktreePath: session.worktreePath,
                                branch: session.branch,
                            })
                        }
                    >
                        View Changes
                    </button>
                )}
            </div>

            {session.status === "error" && session.exitCode !== undefined && (
                <div className="card-error-message">
                    Exited with code {session.exitCode}
                </div>
            )}
        </div>
    );
}

