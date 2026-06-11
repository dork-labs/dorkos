/**
 * StreamManager — connection-only owner of the two durable session streams.
 *
 * Owns exactly TWO stream connections per client (the two-connection budget,
 * spec chat-stream-reconnection):
 *
 * 1. The ACTIVE-SESSION durable stream (snapshot → replay → live). Re-targets
 *    when the active session switches.
 * 2. The GLOBAL session-list stream (`session_upserted` / `session_removed` /
 *    `session_status`).
 *
 * The streams come from a configurable SOURCE:
 * - **HTTP/SSE** (default): `SSEConnection`s against `${baseUrl}/sessions/:id/events`
 *   and `${baseUrl}/events`. `main.tsx` calls {@link StreamManager.useHttpSource}
 *   with the same resolved origin as `HttpTransport`, so the packaged Electron
 *   renderer (file:// + localhost API) reaches the streams too.
 * - **Transport pump** (embedded/Obsidian): {@link StreamManager.useTransportSource}
 *   iterates the Transport seam in-process (`getSessionSnapshot` +
 *   `subscribeSession`, `subscribeSessionList`) — no network at all.
 *
 * It is a framework-agnostic singleton living in the `shared` FSD layer: it knows
 * nothing about Zustand, the session store, or the `entities` layer. It parses and
 * validates incoming frames against the runtime-neutral contract
 * (`@dorkos/shared/session-stream`) and forwards every VALID frame to a single set
 * of listeners. The store (wired by the binding in the `entities` layer) owns
 * `lastAppliedSeq` and the idempotent seq dedup — StreamManager forwards every
 * validated event without dedup.
 *
 * HMR/StrictMode safety: the singleton is stashed on `import.meta.hot?.data` so
 * Vite HMR re-evaluation and React StrictMode double-mounts never open duplicate
 * connections (mirrors `shared/model/event-stream-context.tsx`).
 *
 * @module shared/lib/transport/stream-manager
 */
import type { ConnectionState } from '@dorkos/shared/types';
import {
  SessionEventSchema,
  SessionSnapshotSchema,
  SessionListEventSchema,
  type SessionEvent,
  type SessionSnapshot,
  type SessionListEvent,
} from '@dorkos/shared/session-stream';

import { SSEConnection, type SSEConnectionOptions } from './sse-connection';
import {
  TransportSessionStreamPump,
  TransportListStreamPump,
  type TransportStreams,
} from './transport-stream-pump';

/**
 * Minimal surface of {@link SSEConnection} StreamManager depends on. Defining it
 * as an interface lets tests inject a fake connection (no real network / no fetch
 * mocking) while production uses the real class — this is the testability seam.
 */
export interface SSEConnectionLike {
  /** Open the SSE connection. */
  connect(): void;
  /** Gracefully abort; can reconnect later via {@link connect}. */
  disconnect(): void;
  /** Permanent teardown; cannot reconnect after this. */
  destroy(): void;
}

/**
 * Factory used to construct a connection. Production passes
 * `(url, opts) => new SSEConnection(url, opts)`; tests inject a fake that records
 * handlers and lets the test push frames synchronously.
 */
export type CreateConnection = (url: string, opts: SSEConnectionOptions) => SSEConnectionLike;

/** Listeners StreamManager forwards validated frames and state changes to. */
export interface StreamManagerListeners {
  /** A cold-connect snapshot arrived for `sessionId` (hydration frame). */
  onSnapshot?: (sessionId: string, snapshot: SessionSnapshot) => void;
  /** A live/replayed session event arrived for `sessionId` (no dedup applied). */
  onSessionEvent?: (sessionId: string, event: SessionEvent) => void;
  /** A global session-list event arrived. */
  onListEvent?: (event: SessionListEvent) => void;
  /** The active-session stream's connection state changed. */
  onSessionConnectionState?: (sessionId: string, state: ConnectionState) => void;
}

/** The 16 {@link SessionEvent} `type` discriminants the session stream emits. */
const SESSION_EVENT_TYPES = [
  'text_delta',
  'thinking_delta',
  'tool_call',
  'tool_result',
  'tool_progress',
  'approval_required',
  'question_prompt',
  'elicitation_prompt',
  'interaction_resolved',
  'status_change',
  'todo_update',
  'subagent_update',
  'hook_update',
  'memory_recall',
  'turn_start',
  'turn_end',
] as const;

/** The 3 {@link SessionListEvent} `type` discriminants the global stream emits. */
const SESSION_LIST_EVENT_TYPES = ['session_upserted', 'session_removed', 'session_status'] as const;

/**
 * Default API base URL — the web client's relative path (proxied by Vite in dev,
 * served same-origin in production). Overridden via {@link StreamManager.useHttpSource}
 * when the renderer's origin cannot reach `/api` relatively (packaged Electron).
 */
const DEFAULT_BASE_URL = '/api';

/** Where StreamManager sources its streams from (see module doc). */
type StreamSource =
  | { kind: 'sse'; baseUrl: string }
  | { kind: 'transport'; transport: TransportStreams };

/**
 * Build the URL of a session's durable event stream. The `cwd` query is
 * REQUIRED for correctness: the server resolves completed-message history
 * from the JSONL project directory derived from `cwd`, so omitting it makes the
 * cold snapshot read the wrong (default) project and return empty history for
 * any session outside the default cwd. Other session endpoints (`/messages`,
 * `/:id`, `/tasks`) already pass `cwd`; the durable stream must match.
 */
function sessionStreamUrl(
  baseUrl: string,
  sessionId: string,
  cwd: string | null | undefined
): string {
  const base = `${baseUrl}/sessions/${sessionId}/events`;
  return cwd ? `${base}?cwd=${encodeURIComponent(cwd)}` : base;
}

/**
 * Connection-only manager for the two durable SSE streams. Single-consumer:
 * {@link setListeners} replaces the listener set (the binding wires the store).
 */
export class StreamManager {
  private readonly createConnection: CreateConnection;
  private listeners: StreamManagerListeners = {};
  private source: StreamSource = { kind: 'sse', baseUrl: DEFAULT_BASE_URL };

  private sessionConnection: SSEConnectionLike | null = null;
  private attachedSessionId: string | null = null;
  private attachedCwd: string | null = null;
  private listConnection: SSEConnectionLike | null = null;

  /**
   * Construct a StreamManager, optionally with an injected connection factory.
   *
   * @param options - Optional injected connection factory (testability seam).
   *   Defaults to constructing a real {@link SSEConnection}.
   */
  constructor(options: { createConnection?: CreateConnection } = {}) {
    this.createConnection =
      options.createConnection ?? ((url, opts) => new SSEConnection(url, opts));
  }

  /** Replace the listener set. The binding calls this once to wire the store. */
  setListeners(listeners: StreamManagerListeners): void {
    this.listeners = listeners;
  }

  /**
   * Source streams over HTTP/SSE against `baseUrl` (e.g. `/api`, or
   * `http://localhost:4242/api` in packaged Electron where the renderer's
   * origin cannot resolve a relative `/api`). Call before the first
   * attach/connect — switching the source tears down any open streams so
   * nothing keeps flowing from the previous origin.
   *
   * @param baseUrl - Same resolved origin `HttpTransport` is constructed with.
   */
  useHttpSource(baseUrl: string): void {
    this.setSource({ kind: 'sse', baseUrl });
  }

  /**
   * Source streams from the Transport seam via in-process iteration (embedded
   * mode — Obsidian's `DirectTransport`, where no HTTP server exists). Call
   * before the first attach/connect; switching tears down open streams.
   *
   * @param transport - The transport whose stream methods to pump.
   */
  useTransportSource(transport: TransportStreams): void {
    this.setSource({ kind: 'transport', transport });
  }

  private setSource(source: StreamSource): void {
    // Identical source → no-op, so StrictMode/HMR re-wiring doesn't churn
    // (tear down + re-open) perfectly healthy streams.
    const prev = this.source;
    if (
      prev.kind === source.kind &&
      (source.kind === 'sse'
        ? (prev as { baseUrl: string }).baseUrl === source.baseUrl
        : (prev as { transport: TransportStreams }).transport === source.transport)
    ) {
      return;
    }
    const reattach =
      this.attachedSessionId !== null
        ? { sessionId: this.attachedSessionId, cwd: this.attachedCwd }
        : null;
    const hadList = this.listConnection !== null;
    this.detachSession();
    this.disconnectList();
    this.source = source;
    // Re-open whatever was live so a late source switch (HMR, view re-open)
    // doesn't silently kill active streams.
    if (reattach) this.attachSession(reattach.sessionId, reattach.cwd);
    if (hadList) this.connectList();
  }

  /**
   * Point the active-session durable stream at `sessionId` (scoped to `cwd`).
   *
   * Idempotent on the SAME id+cwd (StrictMode/HMR safety): a repeat call for the
   * already-attached session is a no-op so no duplicate connection opens. For a
   * NEW id OR a changed `cwd` it destroys the existing connection and constructs
   * a fresh one (the stream URL — including the `cwd` query — is immutable per
   * connection, so a cwd change must re-open to read the correct project's
   * history).
   *
   * @param sessionId - The session to subscribe the durable stream to.
   * @param cwd - The session's working directory, forwarded as `?cwd=` so the
   *   server resolves history from the correct JSONL project (see
   *   {@link sessionStreamUrl}). Omit/null only when no directory is selected.
   */
  attachSession(sessionId: string, cwd?: string | null): void {
    const nextCwd = cwd ?? null;
    if (
      this.attachedSessionId === sessionId &&
      this.attachedCwd === nextCwd &&
      this.sessionConnection
    )
      return;

    this.detachSession();
    this.attachedSessionId = sessionId;
    this.attachedCwd = nextCwd;

    this.sessionConnection = this.openSessionStream(sessionId, nextCwd);
    this.sessionConnection.connect();
  }

  /** Construct the active-session stream from the configured source. */
  private openSessionStream(sessionId: string, cwd: string | null): SSEConnectionLike {
    const eventHandlers = this.buildSessionEventHandlers(sessionId);
    const onStateChange = (state: ConnectionState): void => {
      this.listeners.onSessionConnectionState?.(sessionId, state);
    };
    if (this.source.kind === 'transport') {
      return new TransportSessionStreamPump({
        transport: this.source.transport,
        sessionId,
        cwd,
        eventHandlers,
        onStateChange,
      });
    }
    return this.createConnection(sessionStreamUrl(this.source.baseUrl, sessionId, cwd), {
      eventHandlers,
      onStateChange,
    });
  }

  /** Tear down the active-session durable stream. */
  detachSession(): void {
    if (this.sessionConnection) {
      this.sessionConnection.destroy();
      this.sessionConnection = null;
    }
    this.attachedSessionId = null;
    this.attachedCwd = null;
  }

  /** Open the global session-list stream. Idempotent — repeat calls are no-ops. */
  connectList(): void {
    if (this.listConnection) return;
    this.listConnection = this.openListStream();
    this.listConnection.connect();
  }

  /** Construct the global session-list stream from the configured source. */
  private openListStream(): SSEConnectionLike {
    const eventHandlers = this.buildListEventHandlers();
    if (this.source.kind === 'transport') {
      return new TransportListStreamPump({ transport: this.source.transport, eventHandlers });
    }
    return this.createConnection(`${this.source.baseUrl}/events`, { eventHandlers });
  }

  /** Tear down the global session-list stream. */
  disconnectList(): void {
    if (this.listConnection) {
      this.listConnection.destroy();
      this.listConnection = null;
    }
  }

  /**
   * Build the per-session frame handlers: one `snapshot` handler plus a shared
   * handler registered under each {@link SESSION_EVENT_TYPES} name.
   * Validates every frame and drops (warns on) malformed ones.
   */
  private buildSessionEventHandlers(sessionId: string): Record<string, (data: unknown) => void> {
    const handlers: Record<string, (data: unknown) => void> = {
      snapshot: (data) => this.handleSnapshot(sessionId, data),
    };
    const onEvent = (data: unknown): void => this.handleSessionEvent(sessionId, data);
    for (const type of SESSION_EVENT_TYPES) {
      handlers[type] = onEvent;
    }
    return handlers;
  }

  /** Build the global-stream handlers for the 3 session-list event names. */
  private buildListEventHandlers(): Record<string, (data: unknown) => void> {
    const handlers: Record<string, (data: unknown) => void> = {};
    const onListEvent = (data: unknown): void => this.handleListEvent(data);
    for (const type of SESSION_LIST_EVENT_TYPES) {
      handlers[type] = onListEvent;
    }
    return handlers;
  }

  private handleSnapshot(sessionId: string, data: unknown): void {
    const parsed = SessionSnapshotSchema.safeParse(data);
    if (!parsed.success) {
      console.warn('[StreamManager] dropping malformed snapshot frame', {
        sessionId,
        issues: parsed.error.issues,
      });
      return;
    }
    this.listeners.onSnapshot?.(sessionId, parsed.data);
  }

  private handleSessionEvent(sessionId: string, data: unknown): void {
    const parsed = SessionEventSchema.safeParse(data);
    if (!parsed.success) {
      console.warn('[StreamManager] dropping malformed session-event frame', {
        sessionId,
        issues: parsed.error.issues,
      });
      return;
    }
    this.listeners.onSessionEvent?.(sessionId, parsed.data);
  }

  private handleListEvent(data: unknown): void {
    const parsed = SessionListEventSchema.safeParse(data);
    if (!parsed.success) {
      console.warn('[StreamManager] dropping malformed session-list frame', {
        issues: parsed.error.issues,
      });
      return;
    }
    this.listeners.onListEvent?.(parsed.data);
  }
}

/**
 * Create or reuse the singleton, preserving it across Vite HMR re-evaluation.
 * `import.meta.hot` is undefined in production (tree-shaken) and may be undefined
 * in test environments, so the guards are inert there and a fresh instance is
 * constructed per module load.
 */
function getOrCreateStreamManager(): StreamManager {
  const existing = import.meta.hot?.data?.streamManager as StreamManager | undefined;
  if (existing) return existing;

  const manager = new StreamManager();
  if (import.meta.hot?.data) {
    import.meta.hot.data.streamManager = manager;
  }
  return manager;
}

/** The app-wide StreamManager singleton (HMR-safe). */
export const streamManager = getOrCreateStreamManager();
