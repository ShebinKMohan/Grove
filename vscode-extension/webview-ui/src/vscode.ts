/**
 * VS Code WebView API accessor.
 * acquireVsCodeApi() can only be called once per webview session.
 */

import type { WebViewMessage } from "./types";

interface VsCodeApi {
    postMessage(message: WebViewMessage): void;
    getState(): unknown;
    setState(state: unknown): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vscode: VsCodeApi = typeof (window as any).acquireVsCodeApi === "function"
    ? (window as any).acquireVsCodeApi()
    : { postMessage: () => {}, getState: () => null, setState: () => {} };

export default vscode;
