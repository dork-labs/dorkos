/**
 * OpenCode global-event hub — the ONE `client.global.event()` subscription per
 * runtime (NOTES.md §1, event-mapper module doc). Per-turn consumers register
 * a listener; the hub pumps the sidecar's `/global/event` stream while at
 * least one listener is live and fans every RAW parsed {@link GlobalEvent}
 * envelope to all of them (the demux filter runs at the listener, where the
 * `{directory, sessionID}` key is known).
 *
 * RESTART / RESUBSCRIBE (the handoff-critical pattern): a sidecar restart
 * mints a NEW client + basic-auth password, so the SDK's own SSE retry would
 * reconnect with STALE credentials forever. The hub therefore disables the
 * SDK-internal retry (`sseMaxRetryAttempts: 0`) and owns reconnection itself:
 * a failed or closed stream is caught, active listeners are told the stream
 * dropped (their in-flight turns terminate with a typed error — a dead
 * sidecar cannot finish a turn it lost), and the loop re-enters
 * `provider.getClient()` — which blocks through the server-manager's
 * crash-restart backoff and hands back a FRESH client — before resubscribing.
 *
 * @module services/runtimes/opencode/global-event-hub
 */
import type { GlobalEvent } from '@opencode-ai/sdk';
import { logger, logError } from '../../../lib/logger.js';
import type { OpenCodeClientProvider } from './session-mapper.js';

/**
 * Pause between reconnect attempts when the previous connection delivered no
 * events — a spin guard for a stream that dies instantly (the server-manager's
 * backoff ladder already paces genuine crash-restarts inside `getClient()`).
 * A connection that WAS delivering events reconnects immediately.
 */
export const HUB_RECONNECT_DELAY_MS = 250;

/** One registered hub consumer (a turn's demux tap). */
export interface HubListener {
  /** Working directory of the requesting session (forwarded to `getClient`). */
  cwd: string;
  /** Receives every raw GlobalEvent envelope on the live stream. */
  onEvent(event: GlobalEvent): void;
  /**
   * The active stream failed or closed under this listener. In-flight turns
   * must terminate (the restarted sidecar has no memory of them); the hub
   * itself reconnects for future consumers.
   */
  onStreamDrop(error: unknown): void;
}

/** Handle returned by {@link OpenCodeGlobalEventHub.subscribe}. */
export interface HubSubscription {
  /** Detach the listener; the pump stops when the last listener detaches. */
  unsubscribe(): void;
  /**
   * Resolves once the current connection is observably live (first event
   * received — the sidecar sends `server.connected` on stream open) or has
   * terminated. Callers race it with a timeout before triggering work whose
   * events must not be missed.
   */
  live: Promise<void>;
}

/** Sleep helper (real timers; tests advance with fake timers when needed). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Owns the single `/global/event` subscription for the OpenCode runtime.
 * The pump runs only while listeners exist: the first `subscribe()` starts
 * it (booting the sidecar via `getClient()` when needed) and the last
 * `unsubscribe()` aborts the in-flight stream and lets it wind down.
 */
export class OpenCodeGlobalEventHub {
  private readonly listeners = new Set<HubListener>();
  private pumping = false;
  private abort: AbortController | null = null;
  /** Resolvers waiting for the current connection to become observably live. */
  private liveWaiters: (() => void)[] = [];
  /** True once the current connection delivered at least one event. */
  private connectionLive = false;

  constructor(
    private readonly provider: OpenCodeClientProvider,
    private readonly reconnectDelayMs: number = HUB_RECONNECT_DELAY_MS
  ) {}

  /**
   * Register a listener for raw global events and ensure the pump is running.
   *
   * @param listener - Demux tap receiving every envelope on the live stream
   */
  subscribe(listener: HubListener): HubSubscription {
    this.listeners.add(listener);
    const live = this.connectionLive
      ? Promise.resolve()
      : new Promise<void>((resolve) => this.liveWaiters.push(resolve));
    this.ensurePump();
    return {
      live,
      unsubscribe: () => {
        this.listeners.delete(listener);
        // Abort the parked stream so the pump can observe the empty listener
        // set and wind down instead of holding the connection open. The
        // connection is dead the moment we abort it: mark it not-live FIRST,
        // so a subscriber arriving in this same tick queues a live-waiter for
        // a NEW connection instead of trusting the doomed one (a prompt fired
        // on its strength would lose its `session.idle` and hang the turn).
        if (this.listeners.size === 0 && this.abort) {
          this.connectionLive = false;
          this.abort.abort();
        }
      },
    };
  }

  /** Start the pump loop unless one is already running; re-arm after it exits. */
  private ensurePump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void this.pump().finally(() => {
      this.pumping = false;
      // A listener may have subscribed in the same tick the previous pump
      // decided to exit — re-arm so it is never orphaned.
      if (this.listeners.size > 0) this.ensurePump();
    });
  }

  /**
   * The subscription loop: connect (fresh client each attempt), fan events
   * out, and on failure/close notify listeners and reconnect — pacing empty
   * attempts by {@link HUB_RECONNECT_DELAY_MS}.
   */
  private async pump(): Promise<void> {
    while (this.listeners.size > 0) {
      const controller = new AbortController();
      this.abort = controller;
      let delivered = false;
      let streamError: unknown;
      try {
        // getClient() blocks through the server-manager's restart backoff and
        // always reflects the CURRENT sidecar (new URL + password after a
        // restart) — never reuse a client across connection attempts.
        const client = await this.provider.getClient(this.anyListenerCwd());
        const { stream } = await client.global.event({
          signal: controller.signal,
          // The SDK's internal SSE retry reuses the (now stale) client after a
          // sidecar restart; disable it so failures surface here and reconnect
          // with fresh credentials instead.
          sseMaxRetryAttempts: 0,
          onSseError: (error) => {
            streamError = error;
          },
        });
        for await (const event of stream) {
          delivered = true;
          this.markLive();
          this.dispatch(event as GlobalEvent);
        }
        // Stream closed (server shutdown/restart) — treat like a drop below.
      } catch (error) {
        streamError = error;
      } finally {
        this.abort = null;
        this.connectionLive = false;
      }
      if (this.listeners.size === 0) break;

      // WE tore this connection down (last listener left, then a new one
      // arrived in the same tick) — a client-side wind-down, not a sidecar
      // drop. Reconnect immediately for the waiting subscriber.
      if (controller.signal.aborted) continue;

      // The connection ended with listeners still attached: their turns died
      // with the sidecar. Fail them, then reconnect for future consumers.
      const dropError =
        streamError ?? new Error('OpenCode event stream closed while a turn was in flight');
      logger.warn('[OpenCode] global event stream dropped — resubscribing', logError(dropError));
      this.notifyDrop(dropError);

      if (this.listeners.size === 0) break;
      if (!delivered) await delay(this.reconnectDelayMs);
    }
    // Pump exit never settles live-waiters: only an actually-established
    // connection's first event may resolve `live` (markLive above). A waiter
    // whose subscriber arrived after the final size check is re-armed by
    // ensurePump()'s finally, so it always has a pump working on its behalf.
  }

  /** Resolve pending live-waiters and mark the current connection live. */
  private markLive(): void {
    this.connectionLive = true;
    if (this.liveWaiters.length === 0) return;
    const waiters = this.liveWaiters;
    this.liveWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Fan one envelope to all listeners (snapshot — listeners may detach mid-fan). */
  private dispatch(event: GlobalEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener.onEvent(event);
      } catch (error) {
        logger.warn('[OpenCode] event listener threw', logError(error));
      }
    }
  }

  /** Notify all current listeners that the stream dropped (snapshot fan-out). */
  private notifyDrop(error: unknown): void {
    for (const listener of [...this.listeners]) {
      try {
        listener.onStreamDrop(error);
      } catch (err) {
        logger.warn('[OpenCode] stream-drop listener threw', logError(err));
      }
    }
  }

  /** Working directory of any current listener (the manager ignores it today). */
  private anyListenerCwd(): string {
    for (const listener of this.listeners) return listener.cwd;
    return '';
  }
}

/**
 * Single-consumer push queue bridging the hub's callback fan-out to the
 * event-mapper's `AsyncIterable` input: the turn's demux filter `push()`es
 * matching wire events, `fail()` propagates a stream drop as a throw (which
 * {@link mapOpenCodeTurn} turns into a typed error + `done`), and `end()`
 * closes the stream. Buffered events are always drained before a terminal.
 */
export class TurnEventQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private terminal: { error?: unknown } | null = null;
  private waiter: ((result: IteratorResult<T>) => void) | null = null;
  private rejectWaiter: ((error: unknown) => void) | null = null;

  /** Enqueue an event (dropped once the queue is terminated). */
  push(value: T): void {
    if (this.terminal) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.clearWaiter();
      resolve({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  /** Terminate with an error — the consumer's pending/next read throws. */
  fail(error: unknown): void {
    if (this.terminal) return;
    this.terminal = { error };
    if (this.rejectWaiter) {
      const reject = this.rejectWaiter;
      this.clearWaiter();
      reject(error);
    }
  }

  /** Terminate cleanly — the consumer sees `done` after the buffer drains. */
  end(): void {
    if (this.terminal) return;
    this.terminal = {};
    if (this.waiter) {
      const resolve = this.waiter;
      this.clearWaiter();
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.terminal) {
          return this.terminal.error !== undefined
            ? Promise.reject(this.terminal.error)
            : Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiter = resolve;
          this.rejectWaiter = reject;
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }

  private clearWaiter(): void {
    this.waiter = null;
    this.rejectWaiter = null;
  }
}
