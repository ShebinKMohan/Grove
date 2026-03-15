import { useMemo } from "react";
import type { FileChange } from "../types";

interface FileActivityStreamProps {
    changes: FileChange[];
}

interface GroupedChanges {
    branch: string;
    worktreePath: string;
    changes: FileChange[];
}

export function FileActivityStream({ changes }: FileActivityStreamProps) {
    const grouped = useMemo(() => groupByBranch(changes), [changes]);

    return (
        <div className="file-activity">
            <div className="activity-header">
                <h2 className="section-title">File Activity</h2>
                {changes.length > 0 && (
                    <span className="activity-count text-muted">
                        {changes.length} change{changes.length !== 1 ? "s" : ""}
                    </span>
                )}
            </div>

            {changes.length === 0 ? (
                <div className="empty-state">
                    <p>No file changes detected yet.</p>
                    <p className="text-muted">
                        File changes across all active worktrees will appear here in real time.
                    </p>
                </div>
            ) : (
                <div className="activity-groups">
                    {grouped.map((group) => (
                        <BranchGroup key={`${group.branch}-${group.worktreePath}`} group={group} />
                    ))}
                </div>
            )}
        </div>
    );
}

function BranchGroup({ group }: { group: GroupedChanges }) {
    const deduplicated = useMemo(
        () => deduplicateChanges(group.changes),
        [group.changes]
    );

    const stats = useMemo(() => {
        // Count unique files, not raw events
        const files = new Set<string>();
        let created = 0, modified = 0, deleted = 0;
        for (const c of group.changes) {
            if (files.has(c.filePath)) continue;
            files.add(c.filePath);
            if (c.changeType === "created") created++;
            else if (c.changeType === "modified") modified++;
            else deleted++;
        }
        return { created, modified, deleted };
    }, [group.changes]);

    return (
        <div className="activity-branch-group">
            <div className="activity-branch-header">
                <span className="activity-branch-name">{group.branch}</span>
                <span className="activity-branch-stats">
                    {stats.created > 0 && (
                        <span className="stat-created">+{stats.created}</span>
                    )}
                    {stats.modified > 0 && (
                        <span className="stat-modified">~{stats.modified}</span>
                    )}
                    {stats.deleted > 0 && (
                        <span className="stat-deleted">-{stats.deleted}</span>
                    )}
                </span>
            </div>
            <div className="activity-branch-items">
                {deduplicated.map((change, i) => (
                    <FileChangeRow key={`${group.branch}-${change.filePath}-${i}`} change={change} />
                ))}
            </div>
        </div>
    );
}

function FileChangeRow({ change }: { change: FileChange & { repeatCount?: number } }) {
    const time = new Date(change.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });

    const label =
        change.changeType === "created"
            ? "Added"
            : change.changeType === "deleted"
              ? "Deleted"
              : "Modified";

    const repeat = change.repeatCount ?? 1;

    return (
        <div className="activity-row">
            <span className="activity-time">{time}</span>
            <span className={`activity-label activity-label-${change.changeType}`}>
                {label}
            </span>
            <span className="activity-filepath" title={change.filePath}>
                {change.filePath}
            </span>
            {repeat > 1 && (
                <span className="activity-repeat" title={`${repeat} consecutive changes`}>
                    x{repeat}
                </span>
            )}
        </div>
    );
}

/**
 * Deduplicate consecutive changes to the same file within a time window.
 * If the same file is modified 20 times in a row, collapse to one entry
 * showing the latest timestamp and a repeat count.
 */
function deduplicateChanges(changes: FileChange[]): (FileChange & { repeatCount?: number })[] {
    if (changes.length === 0) return [];

    const result: (FileChange & { repeatCount?: number })[] = [];
    let current = { ...changes[0], repeatCount: 1 };

    for (let i = 1; i < changes.length; i++) {
        const c = changes[i];
        if (
            c.filePath === current.filePath &&
            c.changeType === current.changeType &&
            c.branch === current.branch
        ) {
            // Same file, same type — just increment the count
            current.repeatCount = (current.repeatCount ?? 1) + 1;
        } else {
            result.push(current);
            current = { ...c, repeatCount: 1 };
        }
    }
    result.push(current);
    return result;
}

function groupByBranch(changes: FileChange[]): GroupedChanges[] {
    const map = new Map<string, GroupedChanges>();
    for (const change of changes) {
        const key = `${change.branch}::${change.worktreePath}`;
        let group = map.get(key);
        if (!group) {
            group = { branch: change.branch, worktreePath: change.worktreePath, changes: [] };
            map.set(key, group);
        }
        group.changes.push(change);
    }
    return Array.from(map.values());
}
