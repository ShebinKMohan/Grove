/**
 * Notification helpers with real auto-dismiss.
 *
 * Uses `vscode.window.withProgress(ProgressLocation.Notification)` which
 * actually removes the notification from the UI when the callback completes.
 *
 * The progress increment is set to 100% immediately so no spinner appears —
 * it just looks like a regular notification that disappears after the timer.
 * A countdown shows in the last 3 seconds.
 */

import * as vscode from "vscode";

const INFO_DISMISS_MS = 5_000;
const WARNING_DISMISS_MS = 7_000;
const ERROR_DISMISS_MS = 10_000;

/**
 * Show a self-dismissing notification that looks like a regular message.
 * No spinner — the progress completes instantly, then waits for the timer.
 */
function showAutoDismissNotification(
    message: string,
    ms: number
): void {
    void vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
        },
        async (progress) => {
            // Complete progress immediately so no spinner shows
            progress.report({ increment: 100, message });

            // Wait for most of the display time
            const countdownStart = Math.min(3, Math.ceil(ms / 1000));
            const displayMs = ms - (countdownStart * 1000);
            if (displayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, displayMs));
            }

            // Show countdown in the last few seconds
            for (let i = countdownStart; i > 0; i--) {
                progress.report({ message: `${message}  \u00b7  ${i}s` });
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
    );
}

/**
 * Show an info notification that auto-dismisses.
 */
export function showAutoInfo(
    message: string,
    ms: number = INFO_DISMISS_MS
): void {
    showAutoDismissNotification(message, ms);
}

/**
 * Show a warning notification that auto-dismisses.
 */
export function showAutoWarning(
    message: string,
    ms: number = WARNING_DISMISS_MS
): void {
    showAutoDismissNotification(message, ms);
}

/**
 * Show an error notification that auto-dismisses.
 */
export function showAutoError(
    message: string,
    ms: number = ERROR_DISMISS_MS
): void {
    showAutoDismissNotification(message, ms);
}
