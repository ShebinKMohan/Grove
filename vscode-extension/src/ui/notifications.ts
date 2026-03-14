/**
 * Notification helpers with auto-dismiss timers.
 *
 * VS Code's showInformationMessage / showWarningMessage don't support
 * native timeouts or programmatic dismissal. We race the notification
 * promise against a timer that resolves to undefined (the same value
 * as a manual dismiss).
 *
 * IMPORTANT: The Promise.race approach stops the extension from waiting,
 * but does NOT remove the notification from VS Code's UI — it remains
 * in the notification center until the user dismisses it manually.
 * For this reason, do NOT use these helpers on notifications with action
 * buttons that the user needs to interact with — the buttons become
 * unreachable after the timeout fires.
 *
 * Use only for fire-and-forget informational/warning messages without
 * action buttons.
 */

import * as vscode from "vscode";

const DEFAULT_DISMISS_MS = 8_000;

function autoDismiss<T>(
    thenable: Thenable<T | undefined>,
    ms: number = DEFAULT_DISMISS_MS
): Thenable<T | undefined> {
    const timeout = new Promise<T | undefined>((resolve) => {
        setTimeout(() => resolve(undefined), ms);
    });
    return Promise.race([thenable, timeout]);
}

/**
 * Show an info notification that auto-dismisses after `ms` milliseconds.
 * Returns the chosen action (or undefined if dismissed/timed out).
 */
export function showAutoInfo(
    message: string,
    ms?: number,
    ...actions: string[]
): Thenable<string | undefined> {
    return autoDismiss(
        vscode.window.showInformationMessage(message, ...actions),
        ms
    );
}

/**
 * Show a warning notification that auto-dismisses after `ms` milliseconds.
 */
export function showAutoWarning(
    message: string,
    ms?: number,
    ...actions: string[]
): Thenable<string | undefined> {
    return autoDismiss(
        vscode.window.showWarningMessage(message, ...actions),
        ms
    );
}
