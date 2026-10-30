/**
 * WSConnection — a durable event stream over a WebSocket, with exponential
 * backoff, a heartbeat watchdog, page-visibility release, and cursor-preserving
 * resume.
 *
 * It replaces the fetch-based SSE connection this file's tests used to describe
 * (ADR 260805-041016). The reason is a browser limit rather than a protocol
 * preference: HTTP/1.1 allows about six sockets per origin **per browser
 * profile**, and an SSE stream holds one for as long as it is open. A cockpit
 * window parks two of them (the global stream plus the open session's), so the
 * third window took the last socket and every request after it — including the
 * fourth window's own HTML — queued behind streams that never end. WebSockets
 * do not draw on that pool at all.
 *
 * The resilience contract is deliberately identical to the SSE one, because the
 * thing above it (`StreamManager`) did not change: same states, same full-jitter
 * backoff, same 45s silence watchdog, same hidden-tab release. Two mechanics had
 * to move, and only because a browser `WebSocket` constructor takes a URL and
 * nothing else:
 *
 * - **The resume cursor** rides `?resume=` instead of the `Last-Event-ID`
 *   header. It is still the whole frame id, so the server's epoch check is
 *   intact.
 * - **Liveness** is a `__heartbeat` frame rather than an SSE comment, because a
 *   protocol-level pong is invisible to page JavaScript and so cannot serve as
 *   proof of life.
 *
 * @module shared/lib/transport/ws-connection
 */
import type { ConnectionState } from '@dorkos/shared/types';
import {
  decodeStreamFrame,
  statusFromCloseCode,
  STREAM_HEARTBEAT_EVENT,
  STREAM_RESUME_PARAM,
} from '@dorkos/shared/stream-socket';

import { SSE_RESILIENCE } from '../constants';

/** `WebSocket.readyState` for an open connection. */
const WS_OPEN = 1;

/**
 * Every connection waiting out a backoff, so one that gets through can wake the
 * rest (DOR-3482).
 *
 * The streams a window holds — the global list and the open chat's — reach the
 * same server. When one of them reconnects, the server is back, and the others
 * should try now rather than sit out a backoff that may be at its 30s cap.
 * Matched by host, so a stream to a different server is never woken by this
 * one coming back.
 */
const waitingToRetry = new Set<WSConnection>();

/**
 * Statuses where reconnecting cannot help, so the stream stops and says why.
 *
 * The server states these as an application close code, because a browser
 * cannot read the status of a failed handshake. Retrying them produces the
 * worst failure shape there is: a page that renders, requests that work, and a
 * stream that is silently refused — which is exactly how a too-narrow origin
 * allowlist read as "the whole app is broken".
 */
const REFUSALS_NOT_WORTH_RETRYING: ReadonlySet<number> = new Set([400, 401, 403, 404]);

/** The server refused this stream, and said with what status. */
export class StreamRefusedError extends Error {
  /** The HTTP status the refusal carried. */
  readonly status: number;

  /**
   * Build a refusal from the status the close frame carried.
   *
   * @param status - The status decoded from the WebSocket close code.
   * @param reason - The close frame's reason, when the server sent one.
   */
  constructor(status: number, reason?: string) {
    super(
      `The server turned this stream down (${status})` +
        (reason ? `: ${reason}` : '') +
        (status === 403
          ? '. This address isn’t trusted yet. ' +
            'Add it to DORKOS_TRUSTED_HOSTS (or DORKOS_CORS_ORIGIN) and restart.'
          : '')
    );
    this.name = 'StreamRefusedError';
    this.status = status;
  }
}

/** Configuration for a {@link WSConnection}. */
export interface StreamConnectionOptions {
  /** Handlers for incoming frames, keyed by event name (e.g. `snapshot`, `text_delta`). */
  eventHandlers: Record<string, (data: unknown) => void>;
  /** Called when the connection state changes. */
  onStateChange?: (state: ConnectionState, failedAttempts: number) => void;
  /** Called on connection error. */
  onError?: (error: Error) => void;
  /** Silence watchdog timeout in ms. 0 disables it. Default: 45000. */
  heartbeatTimeoutMs?: number;
  /** Backoff base in ms. Default: 500. */
  backoffBaseMs?: number;
  /** Backoff cap in ms. Default: 30000. */
  backoffCapMs?: number;
  /**
   * Consecutive failures before the state says `disconnected`. Default: 5.
   *
   * The state changes; the retrying does not stop. Past this the socket keeps
   * trying at the backoff cap, the way a room's stream does (DOR-3482).
   */
  disconnectedThreshold?: number;
  /** Time connected before the failure count resets. Default: 10000. */
  stabilityWindowMs?: number;
}

/** Resolved options with all defaults applied. */
type ResolvedOptions = Required<StreamConnectionOptions>;

/**
 * Turn a durable stream's HTTP URL into the WebSocket URL for the same
 * endpoint, carrying the resume cursor when there is one.
 *
 * The paths are identical on both protocols — only the scheme changes — so this
 * is the single place that knows a stream URL is not fetched. Relative URLs
 * (`/api/events`, the web client's normal case) resolve against the page, and
 * absolute ones (packaged Electron, whose renderer origin is `file://`) keep
 * their host.
 *
 * @param url - The stream's HTTP URL, absolute or page-relative.
 * @param lastEventId - The cursor to resume from, when reconnecting.
 * @internal Exported for testing.
 */
export function toStreamSocketUrl(url: string, lastEventId?: string | null): string {
  const resolved = new URL(url, window.location.href);
  resolved.protocol = resolved.protocol === 'https:' ? 'wss:' : 'ws:';
  if (lastEventId) resolved.searchParams.set(STREAM_RESUME_PARAM, lastEventId);
  else resolved.searchParams.delete(STREAM_RESUME_PARAM);
  return resolved.toString();
}

/**
 * Call the handler registered for one event name, and nothing else.
 *
 * The event name comes from the stream and the handler map is a plain object,
 * so a bare `handlers[event]` also reaches every member the map merely
 * INHERITS: `constructor` invokes `Object`, `__proto__` is not callable at all
 * and throws out of the loop that reads events, killing the stream. Nothing
 * legitimate is lost by requiring an own, callable property — that is exactly
 * what `StreamManager` registers.
 *
 * @param handlers - The caller's handler map, keyed by event name.
 * @param event - The event name the frame carried.
 * @param data - The frame payload to hand the handler.
 */
function dispatchFrame(
  handlers: Record<string, (data: unknown) => void>,
  event: string,
  data: unknown
): void {
  if (!Object.hasOwn(handlers, event)) return;
  const handler = handlers[event];
  if (typeof handler !== 'function') return;
  handler(data);
}

/**
 * A single durable stream socket with full resilience: full-jitter exponential
 * backoff, a silence watchdog, page-visibility release, and a state machine
 * (connecting → connected → reconnecting → disconnected).
 *
 * **`disconnected` is a label, not the end.** After
 * {@link StreamConnectionOptions.disconnectedThreshold} failures in a row the
 * state says so, and the socket keeps trying underneath at the backoff cap. It
 * used to stop there for good: five failures take a few seconds against a
 * server that is down, so a chat whose server restarted said "Live updates
 * lost" until somebody sent a message, while a room beside it recovered on its
 * own (DOR-3482). Four things try at once rather than waiting out the cap: the
 * browser going back online, the tab coming forward, another stream to the same
 * server getting through, and a caller who knows the server is back
 * ({@link WSConnection.retryNow}). Only a
 * refusal the server stated, a caller's `disconnect()` and `destroy()` stop it.
 *
 * Framework-agnostic — no React dependency. Consumed by `StreamManager`.
 */
export class WSConnection {
  private readonly url: string;
  private readonly options: ResolvedOptions;
  private socket: WebSocket | null = null;
  private lastEventId: string | null = null;
  private state: ConnectionState = 'connecting';
  private failedAttempts = 0;
  private lastEventAt: number | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;
  private destroyed = false;
  /**
   * Whether retrying has been stopped on purpose: a caller's `disconnect()`, or
   * a refusal the server stated. Cleared by the next `connect()`.
   */
  private stopped = false;
  /** Released by a hidden tab: stays shut, whatever wakes it, until the tab is shown. */
  private parked = false;
  /**
   * This socket reopened after being down, and owes its siblings a wake-up once
   * it proves it is really back: a first frame, or a stable window. Waking them
   * on `open` alone let two streams the server accepts and then closes wake each
   * other in a tight loop.
   */
  private owesWake = false;

  constructor(url: string, options: StreamConnectionOptions) {
    this.url = url;
    this.options = {
      eventHandlers: options.eventHandlers,
      onStateChange: options.onStateChange ?? ((): void => {}),
      onError: options.onError ?? ((): void => {}),
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? SSE_RESILIENCE.HEARTBEAT_TIMEOUT_MS,
      backoffBaseMs: options.backoffBaseMs ?? SSE_RESILIENCE.BACKOFF_BASE_MS,
      backoffCapMs: options.backoffCapMs ?? SSE_RESILIENCE.BACKOFF_CAP_MS,
      disconnectedThreshold: options.disconnectedThreshold ?? SSE_RESILIENCE.DISCONNECTED_THRESHOLD,
      stabilityWindowMs: options.stabilityWindowMs ?? SSE_RESILIENCE.STABILITY_WINDOW_MS,
    };
  }

  /** Current connection state. */
  getState(): ConnectionState {
    return this.state;
  }

  /** Number of consecutive failed connection attempts. */
  getFailedAttempts(): number {
    return this.failedAttempts;
  }

  /** Timestamp of the last received frame, or `null` if none has arrived. */
  getLastEventAt(): number | null {
    return this.lastEventAt;
  }

  /** Open the socket. Safe to call repeatedly — any existing socket closes first. */
  connect(): void {
    if (this.destroyed) return;
    this.stopped = false;
    this.parked = false;
    this.listenForOnline();
    // A backoff still pending would close this healthy socket when it fires.
    this.clearTimers();
    this.setState('connecting');
    this.open();
  }

  /**
   * Try right now instead of waiting out the backoff, when not already open.
   *
   * For a caller that knows the server is back: the other stream to the same
   * server has just reconnected, so this one is likely to succeed too. A no-op
   * on an open socket, and on a stream that was stopped on purpose.
   */
  retryNow(): void {
    if (this.destroyed || this.stopped || this.parked) return;
    if (this.socket) return;
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    this.open();
  }

  /**
   * Open one socket and wire its handlers.
   *
   * Leaves the state alone, so a retry after the stream has said
   * `disconnected` keeps saying so until a socket actually opens, rather than
   * flickering through `connecting` on every attempt.
   */
  private open(): void {
    if (this.destroyed) return;
    this.closeSocket();

    let socket: WebSocket;
    try {
      socket = new WebSocket(toStreamSocketUrl(this.url, this.lastEventId));
    } catch (err) {
      // A malformed URL, or a mixed-content refusal. Same recovery as any other
      // failed attempt — the backoff will retry and eventually give up.
      this.handleConnectionError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.socket = socket;

    socket.onopen = (): void => {
      if (socket !== this.socket) return;
      this.owesWake = waitingToRetry.delete(this);
      this.setState('connected');
      this.startStabilityTimer();
      this.resetWatchdog();
    };

    socket.onmessage = (event: MessageEvent<unknown>): void => {
      if (socket !== this.socket) return;
      this.lastEventAt = Date.now();
      this.resetWatchdog();
      this.payWake();
      if (typeof event.data !== 'string') return;
      const frame = decodeStreamFrame(event.data);
      if (!frame) {
        console.warn('[WSConnection] dropping unparseable frame', { url: this.url });
        return;
      }
      // The frame id is retained even for an event nothing listens to: it is the
      // resume cursor, and forgetting one because no handler was registered
      // would silently replay it on the next reconnect.
      if (frame.id !== undefined) this.lastEventId = frame.id;
      if (frame.event === STREAM_HEARTBEAT_EVENT) return;
      dispatchFrame(this.options.eventHandlers, frame.event, frame.data);
    };

    socket.onerror = (): void => {
      // `error` on a WebSocket carries nothing useful and is always followed by
      // `close`, so the recovery is driven from there — reacting to both would
      // count one failure twice and double the backoff.
      if (socket !== this.socket) return;
      this.options.onError(new Error('Stream socket error'));
    };

    socket.onclose = (event: CloseEvent): void => {
      if (socket !== this.socket) return;
      this.socket = null;
      const status = statusFromCloseCode(event.code);

      // A refusal the server could state. Say so, loudly and once, rather than
      // retrying five times into a `disconnected` that names no cause — which is
      // what turned a too-narrow origin allowlist into "the app is broken":
      // the page rendered, requests worked, the turn ran, and the stream was
      // being refused with nothing on screen or in the console saying it.
      if (status !== null && REFUSALS_NOT_WORTH_RETRYING.has(status)) {
        console.error(
          `[WSConnection] the server refused this stream with ${status} — retrying cannot help`,
          { url: this.url, reason: event.reason || '(no reason given)' }
        );
        this.options.onError(new StreamRefusedError(status, event.reason));
        this.clearTimers();
        this.stopped = true;
        waitingToRetry.delete(this);
        this.setState('disconnected');
        return;
      }

      this.handleConnectionError();
    };
  }

  /** Gracefully close the socket. Can reconnect later via {@link connect}. */
  disconnect(): void {
    this.stopped = true;
    waitingToRetry.delete(this);
    this.closeSocket();
    this.clearAllTimers();
    if (this.state !== 'disconnected') {
      this.setState('disconnected');
    }
  }

  /** Permanent teardown — removes the visibility listener and clears all timers. */
  destroy(): void {
    this.destroyed = true;
    waitingToRetry.delete(this);
    this.closeSocket();
    this.clearAllTimers();
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }
  }

  /**
   * Release the socket while the tab is hidden and reopen on visibility.
   *
   * A WebSocket does not compete for the HTTP socket pool, so this is no longer
   * a scarcity measure — it is kept because it still stops a backgrounded window
   * holding a server-side subscription (and the projector waiter behind it) open
   * for hours. A session stream resumes from the retained cursor. The global
   * `/api/events` stream has no replay, so what it said while parked is gone:
   * the park reports `reconnecting`, and the reopen is a recovery that callers
   * re-sync from (DOR-2896).
   *
   * @param graceMs - Grace period before closing when hidden. Default: 30000.
   */
  enableVisibilityOptimization(graceMs: number = SSE_RESILIENCE.VISIBILITY_GRACE_MS): void {
    if (this.visibilityHandler) return; // Already enabled

    this.visibilityHandler = (): void => {
      if (document.hidden) {
        this.visibilityGraceTimer = setTimeout(() => {
          this.visibilityGraceTimer = null;
          this.closeSocket();
          this.clearTimers();
          // Down, so its reopen wakes the streams waiting beside it.
          this.parked = true;
          waitingToRetry.add(this);
          // A parked socket is down: events sent now are missed. Saying so is
          // what lets the reopen count as a recovery (`event-stream-context`
          // re-syncs every cache on one), since `closeSocket` drops `onclose`
          // and nothing else would report it. A stream that had already given up
          // keeps saying so.
          if (this.state !== 'disconnected') this.setState('reconnecting');
        }, graceMs);
        return;
      }
      if (this.visibilityGraceTimer) {
        clearTimeout(this.visibilityGraceTimer);
        this.visibilityGraceTimer = null;
      }
      // Not after a deliberate stop: a refused or disconnected stream stays so.
      if (this.stopped) return;
      if (!this.socket || this.socket.readyState !== WS_OPEN) this.connect();
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** The host this stream reaches, which is what "the same server" means. */
  private host(): string {
    return new URL(this.url, window.location.href).host;
  }

  /** This stream is really back: every other one waiting on the same server tries now. */
  private payWake(): void {
    if (!this.owesWake) return;
    this.owesWake = false;
    const host = this.host();
    for (const sibling of [...waitingToRetry]) {
      if (sibling.host() === host) sibling.retryNow();
    }
  }

  /**
   * Try at once when the browser comes back online.
   *
   * `online` means the machine had no network and now does, so whatever the
   * backoff was waiting for has probably changed. Added on the first connect
   * and removed by `destroy()`.
   */
  private listenForOnline(): void {
    if (this.onlineHandler || typeof window === 'undefined') return;
    this.onlineHandler = (): void => this.retryNow();
    window.addEventListener('online', this.onlineHandler);
  }

  private setState(newState: ConnectionState): void {
    if (this.state === newState) return;
    this.state = newState;
    this.options.onStateChange(newState, this.failedAttempts);
  }

  private handleConnectionError(error?: Error): void {
    if (this.destroyed) return;
    this.closeSocket();
    this.clearTimers();
    this.owesWake = false;
    this.failedAttempts++;

    if (error) this.options.onError(error);

    // Past the threshold the state says `disconnected`, and the retrying goes
    // on underneath at the backoff cap (DOR-3482). It used to stop here, which
    // left a chat dead after a server restart until somebody sent a message.
    this.setState(
      this.failedAttempts >= this.options.disconnectedThreshold ? 'disconnected' : 'reconnecting'
    );
    waitingToRetry.add(this);
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      this.open();
    }, this.calculateBackoff());
  }

  /** Full-jitter exponential backoff. */
  private calculateBackoff(): number {
    const exponential = Math.min(
      this.options.backoffCapMs,
      this.options.backoffBaseMs * Math.pow(2, this.failedAttempts)
    );
    return Math.random() * exponential;
  }

  private resetWatchdog(): void {
    if (this.options.heartbeatTimeoutMs <= 0) return;
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      this.handleConnectionError();
    }, this.options.heartbeatTimeoutMs);
  }

  private startStabilityTimer(): void {
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      this.payWake();
      this.failedAttempts = 0;
      this.options.onStateChange(this.state, 0);
    }, this.options.stabilityWindowMs);
  }

  /**
   * Close the current socket without treating it as a failure.
   *
   * The handlers are detached first: `close()` fires `onclose` asynchronously,
   * and a deliberate close that reached {@link handleConnectionError} would
   * count a reconnect the caller asked for as an outage.
   */
  private closeSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
  }

  /** Clear watchdog, backoff, and stability timers (not visibility grace). */
  private clearTimers(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }

  /** Clear ALL timers including visibility grace. */
  private clearAllTimers(): void {
    this.clearTimers();
    if (this.visibilityGraceTimer) {
      clearTimeout(this.visibilityGraceTimer);
      this.visibilityGraceTimer = null;
    }
  }
}
