import type { OverlapAlert } from "../types";
import vscode from "../vscode";

interface OverlapAlertsProps {
    overlaps: OverlapAlert[];
}

export function OverlapAlerts({ overlaps }: OverlapAlertsProps) {
    const active = overlaps.filter((o) => !o.dismissed);

    if (active.length === 0) {
        return (
            <div className="empty-state">
                <p>No file overlaps detected.</p>
                <p className="text-muted">
                    When multiple agents modify the same file, overlap alerts will appear here.
                </p>
            </div>
        );
    }

    const conflicts = active.filter((o) => o.severity === "conflict");
    const warnings = active.filter((o) => o.severity === "warning");
    const infos = active.filter((o) => o.severity === "info");

    return (
        <div className="overlap-alerts">
            <div className="overlap-header">
                <h2 className="section-title">
                    File Overlaps ({active.length})
                </h2>
                <button
                    className="btn btn-small btn-secondary"
                    onClick={() =>
                        vscode.postMessage({ type: "dismiss-all-overlaps" })
                    }
                >
                    Dismiss All
                </button>
            </div>

            {conflicts.length > 0 && (
                <div className="overlap-group">
                    <div className="overlap-group-label overlap-conflict">
                        Conflicts ({conflicts.length})
                    </div>
                    {conflicts.map((o) => (
                        <OverlapItem key={o.filePath} overlap={o} />
                    ))}
                </div>
            )}

            {warnings.length > 0 && (
                <div className="overlap-group">
                    <div className="overlap-group-label overlap-warning">
                        Warnings ({warnings.length})
                    </div>
                    {warnings.map((o) => (
                        <OverlapItem key={o.filePath} overlap={o} />
                    ))}
                </div>
            )}

            {infos.length > 0 && (
                <div className="overlap-group">
                    <div className="overlap-group-label overlap-info">
                        Shared Config ({infos.length})
                    </div>
                    {infos.map((o) => (
                        <OverlapItem key={o.filePath} overlap={o} />
                    ))}
                </div>
            )}
        </div>
    );
}

function OverlapItem({ overlap }: { overlap: OverlapAlert }) {
    const severityIcon =
        overlap.severity === "conflict"
            ? "!!"
            : overlap.severity === "warning"
              ? "!"
              : "~";

    const fileName = overlap.filePath.split("/").pop() ?? overlap.filePath;

    return (
        <div className="overlap-item">
            <span className={`overlap-icon overlap-${overlap.severity}`}>
                {severityIcon}
            </span>
            <div className="overlap-details">
                <span className="overlap-file" title={overlap.filePath}>
                    {fileName}
                </span>
                <span className="overlap-branches">
                    {overlap.branches.map((b, i) => (
                        <span key={b}>
                            {i > 0 && <span className="overlap-sep"> + </span>}
                            <span className="overlap-branch">{b}</span>
                        </span>
                    ))}
                </span>
            </div>
            <button
                className="btn btn-small overlap-dismiss"
                onClick={() =>
                    vscode.postMessage({
                        type: "dismiss-overlap",
                        filePath: overlap.filePath,
                    })
                }
                title="Dismiss"
            >
                x
            </button>
        </div>
    );
}
