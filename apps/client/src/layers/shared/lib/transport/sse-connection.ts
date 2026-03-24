/**
 * SSEConnection — framework-agnostic EventSource connection manager with
 * exponential backoff, heartbeat watchdog, and page visibility optimization.
 *
 * @module shared/lib/transport/sse-connection
 */
import type { ConnectionState } from '@dorkos/shared/types';
import { SSE_RESILIENCE } from '../constants';

/** Configuration for an SSEConnection instance. */
export interface SSEConnectionOptions {
  /** Event handlers for incoming SSE events, keyed by event type (e.g., 'sync_update', 'relay_message'). */
  eventHandlers: Record<string, (data: unknown) => void>;
  /** Called when connection state changes. */
  onStateChange?: (state: ConnectionState, failedAttempts: number) => void;
  /** Called on EventSource error event. */
  onError?: (error: Event) => void;
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
 * Manages a single EventSource connection with full resilience: exponential
 * backoff with jitter, heartbeat watchdog, page visibility optimization,
 * and a state machine (connecting → connected → reconnecting → disconnected).
 *
 * Framework-agnostic — no React dependency. Consumed by `useSSEConnection` hook.
 */
export class SSEConnection {
  private url: string;
  private options: ResolvedOptions;
  private eventSource: EventSource | null = null;
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

  /** Open the EventSource connection. Safe to call multiple times — closes any existing connection first. */
  connect(): void {
    if (this.destroyed) return;
    this.closeEventSource();
    this.setState('connecting');

    const es = new EventSource(this.url);

    es.onopen = () => {
      this.setState('connected');
      this.startStabilityTimer();
      this.resetWatchdog();
    };

    es.onerror = (event) => {
      this.options.onError(event);
      this.handleConnectionError();
    };

    // Register named event handlers
    for (const [eventType, handler] of Object.entries(this.options.eventHandlers)) {
      es.addEventListener(eventType, (e: MessageEvent) => {
        this.lastEventAt = Date.now();
        this.resetWatchdog();
        try {
          const data: unknown = JSON.parse(e.data as string);
          handler(data);
        } catch {
          handler(e.data);
        }
      });
    }

    // Listen for heartbeat events (resets watchdog, no app handler needed)
    es.addEventListener('heartbeat', () => {
      this.lastEventAt = Date.now();
      this.resetWatchdog();
    });

    this.eventSource = es;
  }

  /** Gracefully close the connection. Can reconnect later via `connect()`. */
  disconnect(): void {
    this.closeEventSource();
    this.clearAllTimers();
    if (this.state !== 'disconnected') {
      this.setState('disconnected');
    }
  }

  /** Permanent teardown — removes visibility listener, closes EventSource, clears all timers. Cannot reconnect after this. */
  destroy(): void {
    this.destroyed = true;
    this.closeEventSource();
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
          this.closeEventSource();
          this.clearTimers();
        }, graceMs);
      } else {
        // Tab became visible — cancel grace timer and reconnect if needed
        if (this.visibilityGraceTimer) {
          clearTimeout(this.visibilityGraceTimer);
          this.visibilityGraceTimer = null;
        }
        if (!this.eventSource || this.eventSource.readyState === EventSource.CLOSED) {
          this.connect();
        }
      }
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

  private handleConnectionError(): void {
    this.closeEventSource();
    this.clearTimers();
    this.failedAttempts++;

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

  /** Full jitter exponential backoff per AWS architecture blog. */
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

  private closeEventSource(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
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
