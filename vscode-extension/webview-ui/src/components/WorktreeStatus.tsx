import type { WorktreeInfo } from "../types";

interface WorktreeStatusProps {
    worktrees: WorktreeInfo[];
    activeSessions: number;
    overlapCount: number;
}

export function WorktreeStatus({
    worktrees,
    activeSessions,
    overlapCount,
}: WorktreeStatusProps) {
    const total = worktrees.length;

    if (total === 0 && activeSessions === 0 && overlapCount === 0) {
        return null;
    }

    return (
        <span className="status-summary">
            <span>
                {total} worktree{total !== 1 ? "s" : ""}
            </span>
            <span className="stat-sep">&middot;</span>
            <span>
                {activeSessions} active
            </span>
            {overlapCount > 0 && (
                <>
                    <span className="stat-sep">&middot;</span>
                    <span className="stat-overlap">
                        {overlapCount} overlap{overlapCount !== 1 ? "s" : ""}
                    </span>
                </>
            )}
        </span>
    );
}
