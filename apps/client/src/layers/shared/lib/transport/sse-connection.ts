/**
 * SSEConnection — fetch-based SSE connection manager with exponential backoff,
 * heartbeat watchdog, and page visibility optimization.
 *
 * Uses `fetch` + `ReadableStream` instead of the browser `EventSource` API,
 * enabling custom headers (auth, Last-Event-ID) and server-directed retry.
 *
 * @module shared/lib/transport/sse-connection
 */
import type { ConnectionState } from '@dorkos/shared/types';

import { SSE_RESILIENCE } from '../constants';
import { parseSSEStream } from './sse-parser';

/** Configuration for an SSEConnection instance. */
export interface SSEConnectionOptions {
  /** Event handlers for incoming SSE events, keyed by event type (e.g., 'snapshot', 'session_event'). */
  eventHandlers: Record<string, (data: unknown) => void>;
  /** Called when connection state changes. */
  onStateChange?: (state: ConnectionState, failedAttempts: number) => void;
  /** Called on connection error. */
  onError?: (error: Error) => void;
  /** Additional headers to send with the fetch request (e.g., auth tokens). */
  headers?: Record<string, string>;
  /** Heartbeat watchdog timeout in ms. 0 disables watchdog. Default: 45000. */
  heartbeatTimeoutMs?: number;
  /** Backoff base in ms. Default: 500. */
  backoffBaseMs?: number;
  /** Backoff cap in ms. Default: 30000. */
  backoffCapMs?: number;
  /** Max consecutive failures before entering 'disconnected' state. Default: 5. */
  disconnectedThreshold?: number;
  /** Time connected before resetting failure count. Default: 10000. */
  stabilityWindowMs?: number;
}

/** Resolved options with all defaults applied. */
type ResolvedOptions = Required<SSEConnectionOptions>;

/**
 * Manages a single fetch-based SSE connection with full resilience: exponential
 * backoff with jitter, heartbeat watchdog, page visibility optimization,
 * and a state machine (connecting -> connected -> reconnecting -> disconnected).
 *
 * Framework-agnostic — no React dependency. Consumed by `useSSEConnection` hook.
 */
export class SSEConnection {
  private url: string;
  private options: ResolvedOptions;
  private abortController: AbortController | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private lastEventId: string | null = null;
  private serverRetryMs: number | null = null;
  private state: ConnectionState = 'connecting';
  private failedAttempts = 0;
  private lastEventAt: number | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private destroyed = false;

  constructor(url: string, options: SSEConnectionOptions) {
    this.url = url;
    this.options = {
      eventHandlers: options.eventHandlers,
      onStateChange: options.onStateChange ?? (() => {}),
      onError: options.onError ?? (() => {}),
      headers: options.headers ?? {},
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

  /** Timestamp of the last received event, or null if none received yet. */
  getLastEventAt(): number | null {
    return this.lastEventAt;
  }

  /** Open a fetch-based SSE connection. Safe to call multiple times — closes any existing connection first. */
  connect(): void {
    if (this.destroyed) return;
    this.closeConnection();
    this.setState('connecting');

    const controller = new AbortController();
    this.abortController = controller;
    this.openFetchConnection(controller);
  }

  /** Gracefully abort the connection. Can reconnect later via `connect()`. */
  disconnect(): void {
    this.closeConnection();
    this.clearAllTimers();
    if (this.state !== 'disconnected') {
      this.setState('disconnected');
    }
  }

  /** Permanent teardown — removes visibility listener, aborts fetch, clears all timers. Cannot reconnect after this. */
  destroy(): void {
    this.destroyed = true;
    this.closeConnection();
    this.clearAllTimers();
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  /**
   * Enable page visibility optimization. When the tab becomes hidden, the
   * connection is closed after a grace period. When visible again, it
   * reconnects immediately.
   *
   * @param graceMs - Grace period before closing when hidden. Default: 30000.
   */
  enableVisibilityOptimization(graceMs: number = SSE_RESILIENCE.VISIBILITY_GRACE_MS): void {
    if (this.visibilityHandler) return; // Already enabled

    this.visibilityHandler = () => {
      if (document.hidden) {
        // Tab became hidden — start grace timer
        this.visibilityGraceTimer = setTimeout(() => {
          this.visibilityGraceTimer = null;
          this.closeConnection();
          this.clearTimers();
        }, graceMs);
      } else {
        // Tab became visible — cancel grace timer and reconnect if needed
        if (this.visibilityGraceTimer) {
          clearTimeout(this.visibilityGraceTimer);
          this.visibilityGraceTimer = null;
        }
        if (!this.abortController || this.abortController.signal.aborted) {
          this.connect();
        }
      }
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** Open the fetch connection and consume the SSE stream via parseSSEStream. */
  private async openFetchConnection(controller: AbortController): Promise<void> {
    try {
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        ...this.options.headers,
      };
      if (this.lastEventId) {
        headers['Last-Event-ID'] = this.lastEventId;
      }

      const response = await fetch(this.url, {
        headers,
        // Carry the Better Auth session cookie so the durable SSE stream
        // authenticates when login is enabled (cookie cache keeps it off the DB).
        credentials: 'include',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      if (controller.signal.aborted) return;

      this.setState('connected');
      this.startStabilityTimer();
      this.resetWatchdog();

      const reader = response.body!.getReader();
      this.reader = reader;

      for await (const event of parseSSEStream(reader)) {
        if (controller.signal.aborted) break;
        this.lastEventAt = Date.now();
        this.resetWatchdog();

        if (event.id !== undefined) this.lastEventId = event.id;
        if (event.retry !== undefined) this.serverRetryMs = event.retry;
        if (event.comment) continue;

        const handler = this.options.eventHandlers[event.type];
        if (handler) handler(event.data);
      }

      // Stream ended without abort — treat as unexpected disconnect
      if (!controller.signal.aborted) {
        this.handleConnectionError(new Error('Stream ended'));
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      this.handleConnectionError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private setState(newState: ConnectionState): void {
    if (this.state === newState) return;
    this.state = newState;
    this.options.onStateChange(newState, this.failedAttempts);
  }

  private handleConnectionError(error?: Error): void {
    this.closeConnection();
    this.clearTimers();
    this.failedAttempts++;

    if (error) this.options.onError(error);

    if (this.failedAttempts >= this.options.disconnectedThreshold) {
      this.setState('disconnected');
      return;
    }

    this.setState('reconnecting');
    const delay = this.calculateBackoff();
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      this.connect();
    }, delay);
  }

  /** Full jitter exponential backoff with server-directed retry floor. */
  private calculateBackoff(): number {
    const exponential = Math.min(
      this.options.backoffCapMs,
      this.options.backoffBaseMs * Math.pow(2, this.failedAttempts)
    );
    const clientDelay = Math.random() * exponential;
    if (this.serverRetryMs !== null) {
      return Math.max(clientDelay, this.serverRetryMs);
    }
    return clientDelay;
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

  private closeConnection(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.reader = null;
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
