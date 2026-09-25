/**
 * A minimal, framework-free fake of the `vscode` module.
 *
 * Unit tests run under vitest, outside the extension host, where the real
 * `vscode` module does not exist. Pass the object returned by
 * `createVscodeStub()` to `vi.mock("vscode", ...)` and the code under test
 * gets these fakes instead:
 *
 *   vi.mock("vscode", async () =>
 *       (await import("../helpers/vscode-stub")).createVscodeStub()
 *   );
 *
 * Tests then drive and inspect the fake through its `__stub` controller
 * (recorded file watchers, event emitters, messages, commands and settings).
 *
 * Only the parts of the API that Grove's core classes touch are provided.
 * Anything missing fails loudly (vitest reports a missing mock export),
 * which is the point: extend this file when a new API is needed.
 *
 * This file deliberately does not import vitest, so it can be reused by
 * any test framework.
 */

import * as path from "path";

// ────────────────────────────────────────────
// Core value types
// ────────────────────────────────────────────

export interface DisposableLike {
    dispose(): unknown;
}

type Listener<T> = (e: T) => unknown;

/** The shape of `vscode.Event<T>`. */
export type FakeEvent<T> = (
    listener: Listener<T>,
    thisArgs?: unknown,
    disposables?: DisposableLike[]
) => DisposableLike;

export class FakeDisposable implements DisposableLike {
    private disposed = false;

    constructor(private readonly callOnDispose: () => unknown) {}

    static from(...items: DisposableLike[]): FakeDisposable {
        return new FakeDisposable(() => {
            for (const item of items) item.dispose();
        });
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.callOnDispose();
    }
}

/**
 * Mirrors `vscode.EventEmitter`: `event` subscribes, `fire` notifies the
 * current listeners, and after `dispose` firing and subscribing are no-ops.
 */
export class FakeEventEmitter<T> {
    private listeners: Array<Listener<T>> = [];
    private _disposed = false;

    get disposed(): boolean {
        return this._disposed;
    }

    get listenerCount(): number {
        return this.listeners.length;
    }

    readonly event: FakeEvent<T> = (listener, thisArgs, disposables) => {
        if (this._disposed) {
            return new FakeDisposable(() => undefined);
        }
        const bound: Listener<T> =
            thisArgs === undefined ? listener : listener.bind(thisArgs);
        this.listeners.push(bound);
        const subscription = new FakeDisposable(() => {
            this.listeners = this.listeners.filter((l) => l !== bound);
        });
        disposables?.push(subscription);
        return subscription;
    };

    fire(data: T): void {
        if (this._disposed) return;
        for (const listener of [...this.listeners]) {
            listener(data);
        }
    }

    dispose(): void {
        this._disposed = true;
        this.listeners = [];
    }
}

export class FakeUri {
    private constructor(
        readonly scheme: string,
        readonly fsPath: string
    ) {}

    static file(fsPath: string): FakeUri {
        return new FakeUri("file", fsPath);
    }

    static joinPath(base: FakeUri, ...segments: string[]): FakeUri {
        return new FakeUri(base.scheme, path.join(base.fsPath, ...segments));
    }

    get path(): string {
        return this.fsPath.replace(/\\/g, "/");
    }

    toString(): string {
        return `${this.scheme}://${this.path}`;
    }
}

export class FakeRelativePattern {
    readonly baseUri: FakeUri;

    constructor(
        base: string | FakeUri | { uri: FakeUri },
        readonly pattern: string
    ) {
        if (typeof base === "string") {
            this.baseUri = FakeUri.file(base);
        } else if (base instanceof FakeUri) {
            this.baseUri = base;
        } else {
            this.baseUri = base.uri;
        }
    }

    /** The base folder as a file-system path (like `RelativePattern.base`). */
    get base(): string {
        return this.baseUri.fsPath;
    }
}

export type FileEventKind = "create" | "change" | "delete";

/**
 * Stands in for `vscode.FileSystemWatcher`. It records the handlers the code
 * under test registers and lets tests fire events at them. Like the real
 * watcher, a disposed watcher (or one told to ignore an event kind) delivers
 * nothing.
 */
export class FakeFileSystemWatcher implements DisposableLike {
    readonly handlers: Record<FileEventKind, Array<Listener<FakeUri>>> = {
        create: [],
        change: [],
        delete: [],
    };

    private _disposed = false;
    private _disposeCount = 0;

    constructor(
        readonly globPattern: string | FakeRelativePattern,
        readonly ignoreCreateEvents = false,
        readonly ignoreChangeEvents = false,
        readonly ignoreDeleteEvents = false
    ) {}

    get disposed(): boolean {
        return this._disposed;
    }

    get disposeCount(): number {
        return this._disposeCount;
    }

    /** The watched folder when the glob is a RelativePattern. */
    get base(): string | undefined {
        return typeof this.globPattern === "string"
            ? undefined
            : this.globPattern.base;
    }

    readonly onDidCreate: FakeEvent<FakeUri> = (l, t, d) =>
        this.subscribe("create", l, t, d);
    readonly onDidChange: FakeEvent<FakeUri> = (l, t, d) =>
        this.subscribe("change", l, t, d);
    readonly onDidDelete: FakeEvent<FakeUri> = (l, t, d) =>
        this.subscribe("delete", l, t, d);

    /**
     * Deliver an event to the registered handlers.
     * Returns how many handlers were invoked (0 when disposed or ignoring).
     */
    fire(kind: FileEventKind, uri: FakeUri): number {
        if (this._disposed || this.ignores(kind)) return 0;
        const handlers = [...this.handlers[kind]];
        for (const handler of handlers) handler(uri);
        return handlers.length;
    }

    dispose(): void {
        this._disposed = true;
        this._disposeCount++;
    }

    private ignores(kind: FileEventKind): boolean {
        switch (kind) {
            case "create":
                return this.ignoreCreateEvents;
            case "change":
                return this.ignoreChangeEvents;
            case "delete":
                return this.ignoreDeleteEvents;
        }
    }

    private subscribe(
        kind: FileEventKind,
        listener: Listener<FakeUri>,
        thisArgs?: unknown,
        disposables?: DisposableLike[]
    ): DisposableLike {
        const bound: Listener<FakeUri> =
            thisArgs === undefined ? listener : listener.bind(thisArgs);
        this.handlers[kind].push(bound);
        const subscription = new FakeDisposable(() => {
            this.handlers[kind] = this.handlers[kind].filter((h) => h !== bound);
        });
        disposables?.push(subscription);
        return subscription;
    }
}

// ────────────────────────────────────────────
// Recorded interactions
// ────────────────────────────────────────────

export type MessageLevel = "information" | "warning" | "error";

export interface RecordedMessage {
    level: MessageLevel;
    message: string;
    /** Everything passed after the message (options object and/or items). */
    items: unknown[];
}

export interface RecordedCommand {
    command: string;
    args: unknown[];
}

export interface FakeConfiguration {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    has(key: string): boolean;
    update(key: string, value: unknown): Promise<void>;
}

/** Test-side handle for inspecting and driving the fake. */
export interface VscodeStubControl {
    /** Every watcher created, in creation order (disposed ones included). */
    readonly watchers: FakeFileSystemWatcher[];
    /** Every EventEmitter created through the fake, in creation order. */
    readonly emitters: Array<FakeEventEmitter<unknown>>;
    /** Settings, keyed by full name (e.g. "grove.fileWatcherDebounce"). */
    readonly config: Map<string, unknown>;
    readonly messages: RecordedMessage[];
    readonly executedCommands: RecordedCommand[];
    /** Lines written to output channels. */
    readonly output: string[];
    /**
     * Queued answers for show*Message calls, consumed first-in first-out.
     * When the queue is empty the call resolves to `undefined`, which is what
     * VS Code returns when the user closes the notification.
     */
    readonly messageResponses: unknown[];

    /** Watchers that have not been disposed. */
    activeWatchers(): FakeFileSystemWatcher[];
    /** The newest non-disposed watcher whose RelativePattern base is `basePath`. */
    watcherFor(basePath: string): FakeFileSystemWatcher | undefined;
    /**
     * Fire a file event for `fsPath` at every non-disposed watcher whose
     * RelativePattern base contains that path, the way VS Code routes events.
     * The glob part of the pattern is NOT evaluated. Returns the number of
     * handlers invoked across all watchers.
     */
    fireFileEvent(kind: FileEventKind, fsPath: string): number;
    /** Forget all recorded state (watchers, emitters, messages, settings...). */
    reset(): void;
}

/** The fake `vscode` module returned by `createVscodeStub()`. */
export interface VscodeStub {
    Disposable: typeof FakeDisposable;
    EventEmitter: typeof FakeEventEmitter;
    RelativePattern: typeof FakeRelativePattern;
    Uri: typeof FakeUri;
    workspace: {
        getConfiguration(section?: string): FakeConfiguration;
        createFileSystemWatcher(
            globPattern: string | FakeRelativePattern,
            ignoreCreateEvents?: boolean,
            ignoreChangeEvents?: boolean,
            ignoreDeleteEvents?: boolean
        ): FakeFileSystemWatcher;
    };
    window: {
        showInformationMessage(message: string, ...items: unknown[]): Promise<unknown>;
        showWarningMessage(message: string, ...items: unknown[]): Promise<unknown>;
        showErrorMessage(message: string, ...items: unknown[]): Promise<unknown>;
        createOutputChannel(name: string): {
            name: string;
            appendLine(value: string): void;
            dispose(): void;
        };
    };
    commands: {
        registerCommand(
            command: string,
            callback: (...args: unknown[]) => unknown
        ): FakeDisposable;
        executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
    };
    /** Test-only controller; not part of the vscode API. */
    __stub: VscodeStubControl;
}

// ────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────

function isInside(basePath: string, fsPath: string): boolean {
    const rel = path.relative(basePath, fsPath);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function createVscodeStub(): VscodeStub {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

    const control: VscodeStubControl = {
        watchers: [],
        emitters: [],
        config: new Map<string, unknown>(),
        messages: [],
        executedCommands: [],
        output: [],
        messageResponses: [],

        activeWatchers() {
            return control.watchers.filter((w) => !w.disposed);
        },

        watcherFor(basePath: string) {
            const resolved = path.resolve(basePath);
            return control
                .activeWatchers()
                .filter((w) => w.base !== undefined && path.resolve(w.base) === resolved)
                .pop();
        },

        fireFileEvent(kind: FileEventKind, fsPath: string) {
            const uri = FakeUri.file(fsPath);
            let invoked = 0;
            for (const watcher of control.activeWatchers()) {
                if (watcher.base !== undefined && isInside(watcher.base, fsPath)) {
                    invoked += watcher.fire(kind, uri);
                }
            }
            return invoked;
        },

        reset() {
            control.watchers.length = 0;
            control.emitters.length = 0;
            control.config.clear();
            control.messages.length = 0;
            control.executedCommands.length = 0;
            control.output.length = 0;
            control.messageResponses.length = 0;
            registeredCommands.clear();
        },
    };

    /** EventEmitter that registers itself with this stub's controller. */
    class EventEmitter<T> extends FakeEventEmitter<T> {
        constructor() {
            super();
            control.emitters.push(this as FakeEventEmitter<unknown>);
        }
    }

    function showMessage(
        level: MessageLevel,
        message: string,
        items: unknown[]
    ): Promise<unknown> {
        control.messages.push({ level, message, items });
        return Promise.resolve(control.messageResponses.shift());
    }

    function getConfiguration(section?: string): FakeConfiguration {
        const fullKey = (key: string): string =>
            section ? `${section}.${key}` : key;
        return {
            get<T>(key: string, defaultValue?: T): T | undefined {
                const k = fullKey(key);
                return control.config.has(k)
                    ? (control.config.get(k) as T)
                    : defaultValue;
            },
            has(key: string): boolean {
                return control.config.has(fullKey(key));
            },
            update(key: string, value: unknown): Promise<void> {
                control.config.set(fullKey(key), value);
                return Promise.resolve();
            },
        } as FakeConfiguration;
    }

    return {
        Disposable: FakeDisposable,
        EventEmitter,
        RelativePattern: FakeRelativePattern,
        Uri: FakeUri,

        workspace: {
            getConfiguration,
            createFileSystemWatcher(
                globPattern: string | FakeRelativePattern,
                ignoreCreateEvents?: boolean,
                ignoreChangeEvents?: boolean,
                ignoreDeleteEvents?: boolean
            ): FakeFileSystemWatcher {
                const watcher = new FakeFileSystemWatcher(
                    globPattern,
                    ignoreCreateEvents ?? false,
                    ignoreChangeEvents ?? false,
                    ignoreDeleteEvents ?? false
                );
                control.watchers.push(watcher);
                return watcher;
            },
        },

        window: {
            showInformationMessage: (message: string, ...items: unknown[]) =>
                showMessage("information", message, items),
            showWarningMessage: (message: string, ...items: unknown[]) =>
                showMessage("warning", message, items),
            showErrorMessage: (message: string, ...items: unknown[]) =>
                showMessage("error", message, items),
            createOutputChannel: (name: string) => ({
                name,
                appendLine: (value: string) => {
                    control.output.push(value);
                },
                dispose: () => undefined,
            }),
        },

        commands: {
            registerCommand(
                command: string,
                callback: (...args: unknown[]) => unknown
            ): FakeDisposable {
                registeredCommands.set(command, callback);
                return new FakeDisposable(() => registeredCommands.delete(command));
            },
            executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
                control.executedCommands.push({ command, args });
                const callback = registeredCommands.get(command);
                return Promise.resolve(callback ? callback(...args) : undefined);
            },
        },

        /** Test-only controller; not part of the vscode API. */
        __stub: control,
    };
}
