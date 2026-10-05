/**
 * The JSON-RPC client DorkOS speaks to `codex app-server` with (spec
 * `codex-app-server-transport` §4).
 *
 * - **Framing.** One JSON message per line on stdin/stdout, no `"jsonrpc"`
 *   field. Lines are split on the byte `\n` (which never occurs inside a UTF-8
 *   multi-byte sequence) before decoding, so a character split across chunks
 *   survives. A line longer than the cap, or one that is not JSON, is a
 *   protocol fault: the client closes and the owner treats the process as
 *   crashed.
 * - **Requests.** Monotonic integer ids, a pending map, a per-method default
 *   timeout, and up to three retries (250/500/1000 ms) when the server answers
 *   `-32001` overloaded. Every outbound params object is parsed through its
 *   strict schema first: the server silently drops an unknown key.
 * - **Notifications.** Validated against `schemas.ts` where DorkOS reads them
 *   (a payload that fails is logged once and dropped, never thrown into a
 *   turn), then fanned out to the subscriber of their `threadId`, or to the
 *   process-level subscribers when they carry none. Unknown methods are counted
 *   and ignored.
 * - **Server requests.** Exactly one reply each, whatever happens: the handler's
 *   answer, else the method's own refusal (`refusalFor`), else a JSON-RPC error.
 *   Nothing here ever accepts anything.
 * - **stderr.** Drained into a 64 KiB ring and debug-logged with tokens
 *   redacted; never shown in a chat.
 *
 * @module services/runtimes/codex/app-server/json-rpc-client
 */
import type { Readable, Writable } from 'node:stream';
import { redactTokens, redactUrlQueries } from '@dorkos/shared/error-report';
import { logger } from '../../../../lib/logger.js';
import {
  SERVER_NOTIFICATION_METHODS,
  refusalFor,
  type ClientMethod,
  type ClientMethodMap,
  type ServerNotification,
  type ServerRequest,
} from './protocol/methods.js';
import { NOTIFICATION_SCHEMAS, OUTBOUND_PARAMS } from './protocol/schemas.js';
import { CodexProcessExitedError, CodexRpcError, CodexRpcTimeoutError } from './protocol/errors.js';

/** The default longest line accepted (an `aggregatedOutput` alone can reach 1 MiB). */
export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

/** How much of stderr is kept for a crash report. */
const STDERR_RING_BYTES = 64 * 1024;

/** Backoff between retries of an overloaded request. */
const OVERLOAD_BACKOFF_MS = [250, 500, 1000] as const;

/** Per-method default timeouts (spec §4). */
const DEFAULT_TIMEOUTS: Partial<Record<ClientMethod, number>> = {
  initialize: 15_000,
  'thread/start': 60_000,
  'thread/resume': 60_000,
  'turn/start': 15_000,
  'turn/interrupt': 15_000,
};
const FALLBACK_TIMEOUT_MS = 30_000;

const KNOWN_NOTIFICATIONS = new Set<string>(SERVER_NOTIFICATION_METHODS);

/** The three pipes of a spawned app-server. */
export interface CodexRpcStreams {
  /** The child's stdin. */
  readonly stdin: Writable;
  /** The child's stdout. */
  readonly stdout: Readable;
  /** The child's stderr; optional for in-memory peers. */
  readonly stderr?: Readable;
}

/** Options for one request. */
export interface CodexRequestOptions {
  /** Override the method's default timeout. */
  timeoutMs?: number;
  /** Cancels waiting (the request itself is not recalled). */
  signal?: AbortSignal;
}

/** Why a client closed. */
export interface CodexClientClose {
  /** `requested` when DorkOS closed it; anything else is a crash. */
  readonly kind: 'requested' | 'protocol-fault' | 'pipe' | 'exited';
  /** Human-readable detail for the log and the turn's error details. */
  readonly detail: string;
}

/** A subscriber to one thread's notifications. */
export interface ThreadSubscriber {
  /** One notification for the thread. */
  notification(notification: ServerNotification): void;
  /** The connection ended; no more notifications will come. */
  closed(close: CodexClientClose): void;
}

/** Handles a server → client request. Return `undefined` to decline. */
export type ServerRequestHandler = (request: ServerRequest) => Promise<unknown> | unknown;

/** Seams for {@link CodexJsonRpcClient}. */
export interface CodexJsonRpcClientOptions {
  /** Longest stdout line accepted. */
  maxLineBytes?: number;
  /** Error message prefix for an over-long line (the model catalog keeps its own wording). */
  lineLimitMessage?: string;
  /** Sleep seam for the overload backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Log label. */
  label?: string;
  /**
   * Close when stdout ends (default). An owner that watches the process's own
   * exit turns this off, so the close carries the exit code and signal.
   */
  closeOnStdoutEnd?: boolean;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** A JSON-RPC connection to one `codex app-server` process. */
export class CodexJsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly threadSubscribers = new Map<string, Set<ThreadSubscriber>>();
  private readonly processSubscribers = new Set<(n: ServerNotification) => void>();
  private readonly closeListeners = new Set<(close: CodexClientClose) => void>();
  private requestHandler: ServerRequestHandler | undefined;
  private readonly maxLineBytes: number;
  private readonly lineLimitMessage: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly label: string;
  private lineChunks: Buffer[] = [];
  private lineBytes = 0;
  private stderrRing = '';
  private closeReason: CodexClientClose | undefined;
  private readonly loggedUnknown = new Set<string>();
  private readonly loggedInvalid = new Set<string>();
  /** Counters, for diagnostics and tests. */
  readonly stats = { lateResponses: 0, unknownNotifications: 0, invalidNotifications: 0 };

  /**
   * Attach to a process's pipes.
   *
   * @param streams - The child's stdin, stdout and stderr.
   * @param options - Limits and seams.
   */
  constructor(
    private readonly streams: CodexRpcStreams,
    options: CodexJsonRpcClientOptions = {}
  ) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.lineLimitMessage =
      options.lineLimitMessage ?? 'Codex app-server sent a line over the byte limit';
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.label = options.label ?? 'codex app-server';
    streams.stdout.on('data', (chunk: Buffer | string) => this.onData(chunk));
    if (options.closeOnStdoutEnd !== false) {
      streams.stdout.once('end', () => this.close({ kind: 'exited', detail: 'stdout closed' }));
    }
    streams.stdout.once('error', (err: Error) => this.close({ kind: 'pipe', detail: err.message }));
    streams.stdin.on('error', (err: Error) => this.close({ kind: 'pipe', detail: err.message }));
    streams.stderr?.on('data', (chunk: Buffer | string) => this.onStderr(chunk));
  }

  /** Whether the connection has ended. */
  get isClosed(): boolean {
    return this.closeReason !== undefined;
  }

  /** Why it ended, once it has. */
  get closedBecause(): CodexClientClose | undefined {
    return this.closeReason;
  }

  /** The last 64 KiB of stderr, tokens redacted. */
  stderrTail(): string {
    return redactTokens(redactUrlQueries(this.stderrRing));
  }

  /**
   * Send a request and wait for its result. Overload answers are retried.
   *
   * @param method - A method DorkOS sends.
   * @param params - Its params; parsed through the method's strict schema first.
   * @param options - Timeout and cancellation.
   */
  async request<M extends ClientMethod>(
    method: M,
    params: ClientMethodMap[M]['params'],
    options: CodexRequestOptions = {}
  ): Promise<ClientMethodMap[M]['result']> {
    const schema = OUTBOUND_PARAMS[method];
    if (schema) {
      const parsed = schema.safeParse(params);
      if (!parsed.success) {
        throw new Error(`Refusing to send ${method}: ${parsed.error.message}`);
      }
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        return (await this.requestOnce(method, params, options)) as ClientMethodMap[M]['result'];
      } catch (err) {
        const backoff = OVERLOAD_BACKOFF_MS[attempt];
        if (!(err instanceof CodexRpcError) || err.kind !== 'overloaded' || backoff === undefined) {
          throw err;
        }
        await this.sleep(backoff);
      }
    }
  }

  private requestOnce(
    method: string,
    params: unknown,
    options: CodexRequestOptions
  ): Promise<unknown> {
    if (this.closeReason) {
      return Promise.reject(new CodexProcessExitedError(this.closeReason.detail));
    }
    options.signal?.throwIfAborted();
    const id = this.nextId++;
    const timeoutMs =
      options.timeoutMs ?? DEFAULT_TIMEOUTS[method as ClientMethod] ?? FALLBACK_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new CodexRpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      const onAbort = (): void => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        reject(
          options.signal?.reason instanceof Error ? options.signal.reason : new Error('aborted')
        );
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          options.signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        timer,
      });
      this.write(params === null || params === undefined ? { id, method } : { id, method, params });
    });
  }

  /**
   * Send a notification.
   *
   * @param method - The notification method.
   * @param params - Its params, if any.
   */
  notify(method: string, params?: unknown): void {
    if (this.closeReason) return;
    this.write(params === undefined ? { method } : { method, params });
  }

  /**
   * Receive one thread's notifications until the connection ends.
   *
   * @param threadId - The thread.
   * @param subscriber - Receives notifications and the close signal.
   * @returns Unsubscribes.
   */
  subscribeThread(threadId: string, subscriber: ThreadSubscriber): () => void {
    if (this.closeReason) {
      const reason = this.closeReason;
      queueMicrotask(() => subscriber.closed(reason));
      return () => {};
    }
    let set = this.threadSubscribers.get(threadId);
    if (!set) {
      set = new Set();
      this.threadSubscribers.set(threadId, set);
    }
    set.add(subscriber);
    return () => {
      const current = this.threadSubscribers.get(threadId);
      current?.delete(subscriber);
      if (current?.size === 0) this.threadSubscribers.delete(threadId);
    };
  }

  /**
   * Receive notifications that name no thread (`account/*`, `configWarning`, …).
   *
   * @param listener - Called per notification.
   * @returns Unsubscribes.
   */
  subscribeProcess(listener: (notification: ServerNotification) => void): () => void {
    this.processSubscribers.add(listener);
    return () => this.processSubscribers.delete(listener);
  }

  /**
   * Be told when the connection ends.
   *
   * @param listener - Called once with the reason.
   * @returns Unsubscribes.
   */
  onClose(listener: (close: CodexClientClose) => void): () => void {
    if (this.closeReason) {
      const reason = this.closeReason;
      queueMicrotask(() => listener(reason));
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /**
   * Install the one handler for server → client requests.
   *
   * @param handler - Returns the reply's result, or `undefined` to decline.
   */
  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.requestHandler = handler;
  }

  /**
   * End the connection: reject every pending request, signal every
   * subscriber, and stop reading. Idempotent; the first reason wins.
   *
   * @param close - Why.
   */
  close(close: CodexClientClose = { kind: 'requested', detail: 'closed by DorkOS' }): void {
    if (this.closeReason) return;
    this.closeReason = close;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new CodexProcessExitedError(close.detail));
    }
    const subscribers = [...this.threadSubscribers.values()].flatMap((set) => [...set]);
    this.threadSubscribers.clear();
    for (const subscriber of subscribers) subscriber.closed(close);
    for (const listener of [...this.closeListeners]) listener(close);
    this.closeListeners.clear();
    this.streams.stdout.removeAllListeners('data');
    if (close.kind !== 'requested') {
      logger.warn(`[CodexAppServer] ${this.label} connection ended: ${close.kind}`, {
        detail: close.detail,
        stderr: lastLine(this.stderrTail()),
      });
    }
  }

  private write(message: unknown): void {
    try {
      this.streams.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (err) {
      this.close({ kind: 'pipe', detail: err instanceof Error ? err.message : String(err) });
    }
  }

  private onData(chunk: Buffer | string): void {
    if (this.closeReason) return;
    let buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        this.lineChunks.push(buffer);
        this.lineBytes += buffer.length;
        if (this.lineBytes > this.maxLineBytes) {
          this.close({ kind: 'protocol-fault', detail: this.lineLimitMessage });
        }
        return;
      }
      const head = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (this.lineBytes + head.length > this.maxLineBytes) {
        this.close({ kind: 'protocol-fault', detail: this.lineLimitMessage });
        return;
      }
      const line = Buffer.concat([...this.lineChunks, head]).toString('utf8');
      this.lineChunks = [];
      this.lineBytes = 0;
      if (line.trim() !== '') this.onLine(line);
      if (this.closeReason) return;
    }
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.close({ kind: 'protocol-fault', detail: 'Codex app-server returned invalid JSON' });
      return;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      this.close({ kind: 'protocol-fault', detail: 'Codex app-server sent a non-object message' });
      return;
    }
    const msg = message as { id?: unknown; method?: unknown; params?: unknown };
    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string';
    if (typeof msg.method === 'string') {
      if (hasId) {
        void this.onServerRequest({
          id: msg.id as number | string,
          method: msg.method,
          params: msg.params,
        });
      } else {
        this.onNotification({ method: msg.method, params: msg.params });
      }
      return;
    }
    if (hasId) this.onResponse(msg as { id: number; result?: unknown; error?: unknown });
  }

  private onResponse(message: { id: number; result?: unknown; error?: unknown }): void {
    const entry = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!entry) {
      this.stats.lateResponses += 1;
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error !== undefined && message.error !== null) {
      entry.reject(
        new CodexRpcError(entry.method, message.error as { code?: unknown; message?: unknown })
      );
    } else {
      entry.resolve(message.result);
    }
  }

  private onNotification(notification: ServerNotification): void {
    if (!KNOWN_NOTIFICATIONS.has(notification.method)) {
      this.stats.unknownNotifications += 1;
      if (!this.loggedUnknown.has(notification.method)) {
        this.loggedUnknown.add(notification.method);
        logger.debug(`[CodexAppServer] ignoring unknown notification ${notification.method}`);
      }
      return;
    }
    const schema = NOTIFICATION_SCHEMAS[notification.method as keyof typeof NOTIFICATION_SCHEMAS];
    if (schema && !schema.safeParse(notification.params).success) {
      this.stats.invalidNotifications += 1;
      if (!this.loggedInvalid.has(notification.method)) {
        this.loggedInvalid.add(notification.method);
        logger.warn(`[CodexAppServer] dropping a malformed ${notification.method} notification`);
      }
      return;
    }
    const threadId = (notification.params as { threadId?: unknown } | null | undefined)?.threadId;
    if (typeof threadId === 'string') {
      for (const subscriber of [...(this.threadSubscribers.get(threadId) ?? [])]) {
        subscriber.notification(notification);
      }
      return;
    }
    for (const listener of [...this.processSubscribers]) listener(notification);
  }

  /** Answer one server request exactly once, whatever the handler does. */
  private async onServerRequest(request: ServerRequest): Promise<void> {
    let result: unknown;
    try {
      result = await this.requestHandler?.(request);
    } catch (err) {
      logger.warn(`[CodexAppServer] handler for ${request.method} failed; declining`, {
        err: err instanceof Error ? err.message : String(err),
      });
      result = undefined;
    }
    if (result === undefined) {
      result = refusalFor(request.method) ?? undefined;
      logger.debug(`[CodexAppServer] declined server request ${request.method}`);
    }
    if (this.closeReason) return;
    if (result === undefined) {
      this.write({
        id: request.id,
        error: { code: -32601, message: `DorkOS does not handle ${request.method}` },
      });
      return;
    }
    this.write({ id: request.id, result });
  }

  private onStderr(chunk: Buffer | string): void {
    const text = chunk.toString();
    this.stderrRing = (this.stderrRing + text).slice(-STDERR_RING_BYTES);
    for (const line of text.split('\n')) {
      if (line.trim() !== '') {
        logger.debug(`[CodexAppServer] ${redactTokens(redactUrlQueries(line))}`);
      }
    }
  }
}

/** The last non-empty line of a text, for a one-line crash note. */
export function lastLine(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines[lines.length - 1] ?? '';
}
