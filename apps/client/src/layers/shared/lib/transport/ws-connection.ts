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
      `The server refused this stream with ${status}` +
        (reason ? `: ${reason}` : '') +
        (status === 403
          ? ' — this usually means the address you are reaching DorkOS on is not trusted. ' +
            'List it in DORKOS_TRUSTED_HOSTS (or DORKOS_CORS_ORIGIN) and restart.'
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
  /** Consecutive failures before entering `disconnected`. Default: 5. */
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
 * Shared with `transport-stream-pump.ts`, which feeds the same handler maps
 * from the embedded Transport instead of a socket, so both readers of those
 * maps dispatch by one rule.
 *
 * @param handlers - The caller's handler map, keyed by event name.
 * @param event - The event name the frame carried.
 * @param data - The frame payload to hand the handler.
 */
export function dispatchFrame(
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
  private destroyed = false;

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
    this.closeSocket();
    this.setState('connecting');

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
      this.setState('connected');
      this.startStabilityTimer();
      this.resetWatchdog();
    };

    socket.onmessage = (event: MessageEvent<unknown>): void => {
      if (socket !== this.socket) return;
      this.lastEventAt = Date.now();
      this.resetWatchdog();
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
        this.setState('disconnected');
        return;
      }

      this.handleConnectionError();
    };
  }

  /** Gracefully close the socket. Can reconnect later via {@link connect}. */
  disconnect(): void {
    this.closeSocket();
    this.clearAllTimers();
    if (this.state !== 'disconnected') {
      this.setState('disconnected');
    }
  }

  /** Permanent teardown — removes the visibility listener and clears all timers. */
  destroy(): void {
    this.destroyed = true;
    this.closeSocket();
    this.clearAllTimers();
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  /**
   * Release the socket while the tab is hidden and reopen on visibility.
   *
   * A WebSocket does not compete for the HTTP socket pool, so this is no longer
   * a scarcity measure — it is kept because it still stops a backgrounded window
   * holding a server-side subscription (and the projector waiter behind it) open
   * for hours. The reconnect resumes from the retained cursor, so nothing is
   * missed.
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
        }, graceMs);
        return;
      }
      if (this.visibilityGraceTimer) {
        clearTimeout(this.visibilityGraceTimer);
        this.visibilityGraceTimer = null;
      }
      if (!this.socket || this.socket.readyState !== WS_OPEN) this.connect();
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private setState(newState: ConnectionState): void {
    if (this.state === newState) return;
    this.state = newState;
    this.options.onStateChange(newState, this.failedAttempts);
  }

  private handleConnectionError(error?: Error): void {
    if (this.destroyed) return;
    this.closeSocket();
    this.clearTimers();
    this.failedAttempts++;

    if (error) this.options.onError(error);

    if (this.failedAttempts >= this.options.disconnectedThreshold) {
      this.setState('disconnected');
      return;
    }

    this.setState('reconnecting');
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      this.connect();
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
