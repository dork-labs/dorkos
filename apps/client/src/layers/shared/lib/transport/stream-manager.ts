/**
 * StreamManager — connection-only owner of the durable session streams.
 *
 * Owns AT MOST THREE stream connections per client (the connection budget,
 * specs chat-stream-reconnection + gen-ui-pip):
 *
 * 1. The ACTIVE-SESSION durable stream (snapshot → replay → live). Re-targets
 *    when the active session switches.
 * 2. The GLOBAL session-list stream (`session_upserted` / `session_removed` /
 *    `session_status`) — which is the SAME `/api/events` connection that carries
 *    the server's other broadcast events (tunnel status, relay traffic,
 *    extension reloads). Those {@link GENERIC_EVENTS} are dispatched to the
 *    multi-subscriber {@link StreamManager.subscribeEvent} API consumed by
 *    `shared/model/event-stream-context.tsx`, so generic consumers share the
 *    list connection instead of opening a third one (CLI-B5).
 * 3. The OPTIONAL PINNED-SESSION durable stream ({@link StreamManager.pinSession}):
 *    a second, independently-liveable session connection that keeps a popped-out
 *    (PIP) session streaming even after the operator switches the active session
 *    elsewhere. It exists ONLY while the pinned session differs from the attached
 *    one — when they coincide the two slots SHARE the single active connection
 *    (exactly one owner per connection; see the invariant on
 *    {@link StreamManager.pinSession}). So the ceiling is three, reached only
 *    while a PIP'd session is off-route.
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
import type { ConnectionState, UiCommand } from '@dorkos/shared/types';
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
  /**
   * Close while the tab is hidden and reconnect on visibility (real
   * {@link SSEConnection} only — in-process pumps and test fakes may omit it).
   */
  enableVisibilityOptimization?(): void;
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

/**
 * Every {@link SessionEvent} `type` discriminant the session stream emits.
 * Frames are registered per-name on the SSE connection, so a name missing here
 * is SILENTLY DROPPED over HTTP (the embedded transport pump bypasses this and
 * masked exactly that bug for `system_status`/`compact_boundary`). Must stay in
 * lockstep with `SessionEventSchema` — the parity test pins the two together.
 */
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
  'compact_boundary',
  'system_status',
  'operation_progress',
  'error',
  'turn_start',
  'turn_end',
  'ui_command',
  'devtools_capture_request',
] as const;

/** The 3 {@link SessionListEvent} `type` discriminants the global stream emits. */
const SESSION_LIST_EVENT_TYPES = ['session_upserted', 'session_removed', 'session_status'] as const;

/**
 * The non-session broadcast event names the unified `/api/events` stream emits.
 * Static — add new names here as the server emits them. They are dispatched
 * verbatim (no schema at this layer; payloads are validated by their consumers)
 * to {@link StreamManager.subscribeEvent} subscribers. The embedded transport
 * source only yields the session-list discriminants, so these never fire there.
 */
export const GENERIC_EVENTS = [
  'connected',
  'tunnel_status',
  'extension_reloaded',
  'commands_changed',
  'relay_connected',
  'relay_message',
  'relay_backpressure',
  'relay_signal',
  'relay_bindings_changed',
  'relay_adapters_changed',
] as const;

/** A member of {@link GENERIC_EVENTS}. */
export type GenericEventName = (typeof GENERIC_EVENTS)[number];

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

  // Pinned (PIP) session slot (gen-ui-pip). Keeps a popped-out session live
  // across active-session switches. INVARIANT: when
  // `pinnedSessionId === attachedSessionId` the two slots share the ACTIVE
  // connection and `pinnedConnection` is null (exactly one owner per
  // SSEConnectionLike). `pinnedConnection` is non-null ONLY while the pinned
  // session differs from the attached one. See {@link pinSession}.
  private pinnedSessionId: string | null = null;
  private pinnedCwd: string | null = null;
  private pinnedConnection: SSEConnectionLike | null = null;

  // Generic-event subscribers (CLI-B5): multi-subscriber, looked up live at
  // dispatch time so subscribing before or after connectList() both work.
  private genericListeners = new Map<GenericEventName, Set<(data: unknown) => void>>();

  // Agent-issued UI-command subscribers (DOR-97/DOR-104). A `ui_command`
  // SessionEvent is BOTH forwarded to `onSessionEvent` (so the store advances
  // its seq watermark and ignores it for rendering) AND dispatched here as a
  // side effect (e.g. open the canvas). App-layer wiring (`main.tsx`) owns the
  // DispatcherContext, so the side effect is an additive subscription rather
  // than a store fold.
  private uiCommandListeners = new Set<(command: UiCommand, sessionId: string) => void>();

  // Multi-subscriber taps for the extension event bridge (features layer). They
  // mirror the `subscribeUiCommand` precedent: additive side-channel listeners
  // dispatched ALONGSIDE the single store-owned `onSessionEvent`/`onListEvent`
  // listeners, never replacing them. Session-event taps are gated to the
  // attached (foreground) session — a background agent must not push activity
  // an extension attributes to the session the operator is watching.
  private sessionEventListeners = new Set<(sessionId: string, event: SessionEvent) => void>();
  private listEventListeners = new Set<(event: SessionListEvent) => void>();
  private attachedChangeListeners = new Set<
    (sessionId: string | null, previousSessionId: string | null) => void
  >();
  // Last attached id broadcast to `attachedChangeListeners`, so a re-attach
  // (which tears down + rebuilds the connection) emits exactly one transition.
  private lastNotifiedAttached: string | null = null;

  // Global-stream connection health, mirrored from the list connection's
  // onStateChange so consumers (status indicator, reconnect re-baselining)
  // can observe it without owning the connection.
  private listConnectionState: ConnectionState = 'connecting';
  private listFailedAttempts = 0;
  private listStateListeners = new Set<(state: ConnectionState, failedAttempts: number) => void>();

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

  /** The session the durable active-session stream is attached to, if any. */
  getAttachedSessionId(): string | null {
    return this.attachedSessionId;
  }

  /**
   * The session currently pinned (PIP), if any — symmetric with
   * {@link getAttachedSessionId}. Non-null whether the pin owns its own
   * connection (differs from the attached session) or shares the active one
   * (coincides with it). See {@link pinSession}.
   */
  getPinnedSessionId(): string | null {
    return this.pinnedSessionId;
  }

  /**
   * Subscribe to a named {@link GENERIC_EVENTS} broadcast from the global
   * `/api/events` stream. Multi-subscriber; payloads are dispatched verbatim
   * (unvalidated at this layer). Returns an unsubscribe function.
   *
   * @param eventName - The SSE event name to listen for.
   * @param handler - Callback invoked with the parsed event payload.
   */
  subscribeEvent(eventName: GenericEventName, handler: (data: unknown) => void): () => void {
    let set = this.genericListeners.get(eventName);
    if (!set) {
      set = new Set();
      this.genericListeners.set(eventName, set);
    }
    set.add(handler);
    return () => {
      this.genericListeners.get(eventName)?.delete(handler);
    };
  }

  /**
   * Subscribe to agent-issued UI commands (`control_ui` MCP tool) arriving on
   * the ACTIVE session's durable stream. Only commands for the attached session
   * are dispatched — a background session's agent must not pop the canvas over
   * the foreground one. Multi-subscriber; returns an unsubscribe function.
   *
   * Wired in `main.tsx` to `executeUiCommand(dispatcherContext, command, 'agent')`
   * — agent origin, so tab switches never persist over the user's per-agent
   * right-panel preference (DOR-227) — which
   * the app layer owns (it holds the store + theme setter). Replayed/snapshot
   * commands are NOT re-dispatched (the durable stream resumes exclusive on the
   * last-seen seq, and snapshots arrive via `onSnapshot`, not here), so a
   * reconnect never re-fires a command — canvas state persists via localStorage.
   *
   * @param handler - Callback invoked with the validated {@link UiCommand} and
   *   the attached session's id (so session-scoped commands like `open_pip` know
   *   which session issued them).
   */
  subscribeUiCommand(handler: (command: UiCommand, sessionId: string) => void): () => void {
    this.uiCommandListeners.add(handler);
    return () => {
      this.uiCommandListeners.delete(handler);
    };
  }

  /**
   * Subscribe to every validated {@link SessionEvent} on the ATTACHED
   * (foreground) session's durable stream. Gated to the attached session like
   * {@link subscribeUiCommand}: events for background sessions are not
   * delivered. Additive side channel — the store's `onSessionEvent` fold is
   * unaffected. Powers the extension event bridge (turn/tool activity).
   * Multi-subscriber; returns an unsubscribe function.
   *
   * @param handler - Invoked with the attached session's id and each event.
   */
  subscribeSessionEvent(handler: (sessionId: string, event: SessionEvent) => void): () => void {
    this.sessionEventListeners.add(handler);
    return () => {
      this.sessionEventListeners.delete(handler);
    };
  }

  /**
   * Subscribe to every validated {@link SessionListEvent} on the global
   * session-list stream (`session_upserted` / `session_removed` /
   * `session_status`). Additive side channel — the store's `onListEvent` fold
   * is unaffected. Powers the extension event bridge (session started/ended).
   * Multi-subscriber; returns an unsubscribe function.
   *
   * @param handler - Invoked with each validated session-list event.
   */
  subscribeListEvent(handler: (event: SessionListEvent) => void): () => void {
    this.listEventListeners.add(handler);
    return () => {
      this.listEventListeners.delete(handler);
    };
  }

  /**
   * Subscribe to changes in which session the active-session durable stream is
   * attached to (the operator's foreground session). Fires once per transition
   * with the new id (or `null` when fully detached) and the previous id. A
   * re-attach that rebuilds the connection for the SAME id does not fire.
   * Powers the extension event bridge (`session.switched`). Multi-subscriber;
   * returns an unsubscribe function.
   *
   * @param handler - Invoked with the new and previous attached session ids.
   */
  subscribeAttachedSessionChange(
    handler: (sessionId: string | null, previousSessionId: string | null) => void
  ): () => void {
    this.attachedChangeListeners.add(handler);
    return () => {
      this.attachedChangeListeners.delete(handler);
    };
  }

  /** Notify attached-change listeners when the foreground session transitions. */
  private notifyAttachedChange(next: string | null): void {
    if (this.lastNotifiedAttached === next) return;
    const previous = this.lastNotifiedAttached;
    this.lastNotifiedAttached = next;
    for (const listener of this.attachedChangeListeners) listener(next, previous);
  }

  /** Current connection state of the global session-list stream. */
  getListConnectionState(): ConnectionState {
    return this.listConnectionState;
  }

  /** Consecutive failed connection attempts of the global session-list stream. */
  getListFailedAttempts(): number {
    return this.listFailedAttempts;
  }

  /**
   * Observe the global session-list stream's connection state. The listener
   * fires on every state change (and on failed-attempt count updates). Returns
   * an unsubscribe function.
   */
  subscribeListConnectionState(
    listener: (state: ConnectionState, failedAttempts: number) => void
  ): () => void {
    this.listStateListeners.add(listener);
    return () => {
      this.listStateListeners.delete(listener);
    };
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
    // Capture the pin's OWN connection (off-route case) so we can rebuild it
    // against the new source (transition-table row 6). The shared case
    // (`pinnedConnection` null) needs no separate handling — the active
    // reattach below re-establishes it as shared. Pin STATE
    // (`pinnedSessionId`/`pinnedCwd`) survives the source switch; only the
    // connection object is rebuilt.
    const repin =
      this.pinnedSessionId !== null && this.pinnedConnection !== null
        ? { sessionId: this.pinnedSessionId, cwd: this.pinnedCwd }
        : null;
    const hadList = this.listConnection !== null;
    // Rebuild the session connection WITHOUT detachSession(): the attached
    // session is unchanged across a source switch, so observers must not see
    // an A→null→A flicker (same single-transition rule as attachSession).
    this.closeSessionStream();
    if (this.pinnedConnection) {
      this.pinnedConnection.destroy();
      this.pinnedConnection = null;
    }
    this.disconnectList();
    this.source = source;
    // Re-open whatever was live so a late source switch (HMR, view re-open)
    // doesn't silently kill active streams.
    if (reattach) {
      this.sessionConnection = this.openSessionStream(reattach.sessionId, reattach.cwd);
      this.sessionConnection.connect();
    }
    if (repin) {
      this.pinnedConnection = this.openSessionStream(repin.sessionId, repin.cwd);
      this.pinnedConnection.connect();
    }
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

    // ADOPT (pin transition-table row 2): the target is the separately-pinned
    // session, which already owns a live connection. Transfer that connection
    // into the active slot rather than opening a duplicate — the connection is
    // session-bound, so re-targeting which field holds it is pure bookkeeping
    // (no close/connect). The pin becomes shared again (`pinnedConnection`
    // null, honoring the invariant). The outgoing active connection is torn
    // down; it is neither shared with nor the pinned connection. Adoption is
    // only sound when the caller's cwd matches the pin's: the stream URL
    // (including `?cwd=`) is immutable per connection, so a DIVERGENT cwd must
    // take the re-open path below instead (this method's changed-cwd contract).
    if (sessionId === this.pinnedSessionId && this.pinnedConnection) {
      if (nextCwd === this.pinnedCwd) {
        this.closeSessionStream();
        this.sessionConnection = this.pinnedConnection;
        this.pinnedConnection = null;
        this.attachedSessionId = sessionId;
        this.attachedCwd = this.pinnedCwd;
        this.notifyAttachedChange(sessionId);
        return;
      }
      // Divergent cwd: the pinned connection reads the OLD cwd's history, so
      // adopting it would silently serve the wrong project. Destroy it and fall
      // through to the normal re-open — the pin then shares the fresh
      // connection (one-owner invariant) and `pinnedCwd` follows `nextCwd` in
      // the shared-cwd sync below.
      this.pinnedConnection.destroy();
      this.pinnedConnection = null;
    }

    // TRANSFER-OUT (row 1): the outgoing active connection is SHARED with the
    // pin (pinned === attached) and we are switching AWAY from that session.
    // Hand the shared connection to the pinned slot instead of destroying it,
    // so the now-off-route pinned session keeps streaming with zero gap — the
    // same avoid-flicker principle as `setSource`'s single-transition reattach.
    const outgoingSharedWithPin =
      this.attachedSessionId !== null &&
      this.attachedSessionId === this.pinnedSessionId &&
      this.sessionConnection !== null;
    if (outgoingSharedWithPin && sessionId !== this.pinnedSessionId) {
      this.pinnedConnection = this.sessionConnection;
      this.sessionConnection = null;
      // The transferred connection's URL was built from the OUTGOING attached
      // cwd (still in `attachedCwd` here — it is overwritten with `nextCwd`
      // below). pinSession's shared branch and the shared-cwd sync keep
      // `pinnedCwd` equal to it already, but the transfer is the moment cwd
      // truth changes slots, so restate it from the connection's own truth
      // rather than relying on that equality holding forever.
      this.pinnedCwd = this.attachedCwd;
    } else {
      // Normal re-target (row 3, the ordinary no-pin path, and a shared-session
      // cwd change): the outgoing active connection is neither shared-with-pin
      // nor transferable, so destroy it. No detach transition — a re-attach is
      // a single A→B switch, not A→null→B.
      this.closeSessionStream();
    }

    this.attachedSessionId = sessionId;
    this.attachedCwd = nextCwd;
    // If we just re-opened the SHARED session (pin coincides and holds no own
    // connection), keep the pinned cwd in step with the connection's new URL.
    if (this.pinnedSessionId === sessionId && this.pinnedConnection === null) {
      this.pinnedCwd = nextCwd;
    }
    this.sessionConnection = this.openSessionStream(sessionId, nextCwd);
    this.sessionConnection.connect();
    this.notifyAttachedChange(sessionId);
  }

  /**
   * Pin a session (PIP) so its durable stream stays live even after the operator
   * switches the active session elsewhere. Idempotent: re-pinning the SAME
   * `sessionId` is a no-op. Single-instance panel → single pin: pinning a
   * DIFFERENT session first unpins the current one (closing its connection).
   *
   * INVARIANT: when the pinned session equals the attached one the two slots
   * SHARE the single active connection and `pinnedConnection` stays null (one
   * owner per connection). A dedicated `pinnedConnection` opens ONLY when the
   * pinned session differs from the attached one — that off-route case is the
   * whole reason the slot exists. Uses the same {@link openSessionStream} path
   * as the active slot, so the pinned stream has identical snapshot/replay
   * semantics and folds into the store the active one.
   *
   * @param sessionId - The session to keep live in the background.
   * @param cwd - The pinned session's working directory, forwarded as `?cwd=`
   *   (see {@link sessionStreamUrl}). Omit/null when unknown; the caller
   *   (`LiveSessionWidget`) resolves it from session metadata at pin time.
   *   IGNORED when pinning the already-attached session — a shared pin's cwd
   *   is definitionally the attached connection's cwd (see the branch comment).
   */
  pinSession(sessionId: string, cwd?: string | null): void {
    if (this.pinnedSessionId === sessionId) return;

    // Single-instance panel: a different session was pinned — unpin it (row 5)
    // before pinning the new one.
    if (this.pinnedSessionId !== null) {
      this.unpinSession();
    }

    if (sessionId === this.attachedSessionId) {
      // Shared: the active connection already streams this session. Record the
      // pin without opening a second connection (invariant). The pin's cwd is
      // taken from `attachedCwd`, NOT the caller: the pin shares that exact
      // connection, whose `?cwd=` URL is immutable, so its cwd is
      // definitionally the attached one. Callers resolve cwd from a different
      // source (session-list metadata) than attachSession (selected cwd);
      // trusting the caller here would let `pinnedCwd` desync from the shared
      // connection's real cwd and corrupt the transfer/adopt cwd-equality
      // checks — forcing a needless destroy/reopen (zero-gap broken) or, on a
      // coincidental match, rebuilding the pinned stream against the wrong
      // project directory.
      this.pinnedSessionId = sessionId;
      this.pinnedCwd = this.attachedCwd;
      this.pinnedConnection = null;
      return;
    }

    // Off-route: open a dedicated pinned connection via the active slot's
    // path. Here the caller's cwd IS authoritative — it parameterizes the
    // fresh connection's URL.
    const nextCwd = cwd ?? null;
    this.pinnedSessionId = sessionId;
    this.pinnedCwd = nextCwd;
    this.pinnedConnection = this.openSessionStream(sessionId, nextCwd);
    this.pinnedConnection.connect();
  }

  /**
   * Unpin the current PIP session (transition-table row 4). Destroys the pinned
   * connection ONLY if the pin owned its own (the off-route case); the shared
   * case (`pinnedConnection` null) leaves the active connection — and the
   * attached session — completely untouched. Safe to call when nothing is
   * pinned.
   */
  unpinSession(): void {
    if (this.pinnedConnection) {
      this.pinnedConnection.destroy();
      this.pinnedConnection = null;
    }
    this.pinnedSessionId = null;
    this.pinnedCwd = null;
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

  /**
   * Destroy the active-session connection only, leaving `attachedSessionId`
   * intact. Used by {@link attachSession} for re-attach so it can overwrite the
   * id and emit a single A→B transition instead of A→null→B.
   */
  private closeSessionStream(): void {
    if (this.sessionConnection) {
      this.sessionConnection.destroy();
      this.sessionConnection = null;
    }
  }

  /** Tear down the active-session durable stream and mark the session detached. */
  detachSession(): void {
    this.closeSessionStream();
    this.attachedSessionId = null;
    this.attachedCwd = null;
    this.notifyAttachedChange(null);
  }

  /** Open the global session-list stream. Idempotent — repeat calls are no-ops. */
  connectList(): void {
    if (this.listConnection) return;
    this.updateListState('connecting', this.listFailedAttempts);
    this.listConnection = this.openListStream();
    this.listConnection.connect();
    // Hidden tabs release their connection after a grace period and reconnect
    // on visibility (browser six-connection budget; the historical `/api/events`
    // behavior). The binding re-baselines list statuses on every reconnect, so
    // the staleness window a hidden-tab close opens is self-healing.
    this.listConnection.enableVisibilityOptimization?.();
  }

  /** Construct the global session-list stream from the configured source. */
  private openListStream(): SSEConnectionLike {
    const eventHandlers = this.buildListEventHandlers();
    const onStateChange = (state: ConnectionState, failedAttempts = 0): void => {
      this.updateListState(state, failedAttempts);
    };
    if (this.source.kind === 'transport') {
      return new TransportListStreamPump({
        transport: this.source.transport,
        eventHandlers,
        onStateChange,
      });
    }
    return this.createConnection(`${this.source.baseUrl}/events`, {
      eventHandlers,
      onStateChange,
    });
  }

  /** Record the list stream's connection state and notify observers. */
  private updateListState(state: ConnectionState, failedAttempts: number): void {
    if (this.listConnectionState === state && this.listFailedAttempts === failedAttempts) return;
    this.listConnectionState = state;
    this.listFailedAttempts = failedAttempts;
    for (const listener of this.listStateListeners) {
      listener(state, failedAttempts);
    }
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

  /**
   * Build the global-stream handlers: the 3 session-list event names (validated,
   * forwarded to the binding) plus the {@link GENERIC_EVENTS} (dispatched verbatim
   * to {@link subscribeEvent} subscribers, looked up live at dispatch time).
   */
  private buildListEventHandlers(): Record<string, (data: unknown) => void> {
    const handlers: Record<string, (data: unknown) => void> = {};
    const onListEvent = (data: unknown): void => this.handleListEvent(data);
    for (const type of SESSION_LIST_EVENT_TYPES) {
      handlers[type] = onListEvent;
    }
    for (const name of GENERIC_EVENTS) {
      handlers[name] = (data: unknown) => {
        const set = this.genericListeners.get(name);
        if (!set) return;
        for (const handler of set) handler(data);
      };
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
    // A `ui_command` is an imperative side effect, not state — the store fold
    // above only advances its seq watermark. Dispatch the side effect here, but
    // ONLY for the attached (foreground) session so a background agent cannot
    // pop UI over the session the operator is watching.
    if (parsed.data.type === 'ui_command' && sessionId === this.attachedSessionId) {
      for (const handler of this.uiCommandListeners) handler(parsed.data.command, sessionId);
    }
    // Side-channel taps (extension event bridge) — gated to the attached
    // session, same rationale as `ui_command`.
    if (sessionId === this.attachedSessionId) {
      for (const listener of this.sessionEventListeners) listener(sessionId, parsed.data);
    }
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
    for (const listener of this.listEventListeners) listener(parsed.data);
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
