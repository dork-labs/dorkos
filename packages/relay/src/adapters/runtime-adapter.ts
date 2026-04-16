/**
 * Abstract base class for agent-runtime adapters in the relay layer.
 *
 * A `RuntimeAdapter` subclass knows how to speak to a single agent runtime
 * (built-in, Codex, a test double, etc.). The base owns concerns that are
 * the same regardless of runtime:
 *
 * - Per-session serial queueing of message dispatches
 * - Orchestration of the openSession -> stream -> closeSession lifecycle
 * - Timeout / abort enforcement
 * - Event normalization pipeline hand-off
 * - Retry policy hook
 *
 * Runtime-specific concerns (SDK calls, native event shapes, teardown
 * specifics) are declared as abstract hooks and implemented by subclasses.
 *
 * NOTE: This is distinct from `BaseRelayAdapter`. `BaseRelayAdapter`
 * bridges Relay to *external* channels (e.g., chat platforms, webhooks).
 * `RuntimeAdapter` bridges Relay to *internal* agent runtimes.
 *
 * @module relay/adapters/runtime-adapter
 */

import type { RelayLogger } from '../types.js';
import { noopLogger } from '../types.js';

/**
 * Generic outbound event emitted by a runtime.
 *
 * Intentionally structural and runtime-agnostic: subclasses choose the
 * concrete event-type vocabulary. The base never inspects `type` values
 * beyond shuttling them through `deliver`.
 */
export interface RuntimeOutboundEvent {
  readonly type: string;
  readonly data?: unknown;
}

/**
 * Inbound message handed to `streamMessage()`.
 *
 * The base requires only enough to pick a queue key, a timeout, and a
 * payload to forward. Subclasses extend as needed.
 */
export interface RuntimeInboundMessage {
  /** Session key used for per-session serialization. */
  readonly sessionId: string;
  /** Raw content handed to the runtime (prompt text, structured payload, etc.). */
  readonly content: string;
  /** Optional absolute deadline (ms since epoch). If omitted, `retryPolicy().timeoutMs` is used. */
  readonly deadlineMs?: number;
}

/**
 * Opaque runtime-native session handle.
 *
 * Subclasses define the shape; the base treats it as an opaque token
 * returned by `openSession` and passed to `closeSession`.
 */
export type RuntimeSessionHandle = { readonly sessionId: string } & Record<string, unknown>;

/**
 * Retry / timeout policy for `streamMessage()`.
 *
 * Subclasses override `retryPolicy()` to tune behavior. The base ships
 * a conservative default: no retry, 5-minute timeout.
 */
export interface RetryPolicy {
  /** Maximum total attempts (1 = no retry). */
  readonly maxAttempts: number;
  /** Base backoff delay in ms between attempts. */
  readonly baseDelayMs: number;
  /** Fallback timeout in ms when `RuntimeInboundMessage.deadlineMs` is absent. */
  readonly timeoutMs: number;
}

/** Default retry policy — single attempt, 5-minute timeout. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 100,
  timeoutMs: 300_000,
};

/**
 * Shared construction context for runtime adapters.
 *
 * Subclasses add runtime-specific dependencies (SDK clients, runtime
 * wrappers) to their own constructor signatures. Fields here are
 * runtime-agnostic concerns the base uses directly.
 */
export interface RuntimeAdapterContext {
  /** Stable runtime type identifier (e.g., `'codex'`, `'test'`). */
  readonly runtimeType: string;
  /** Optional structured logger. Defaults to the silent no-op logger. */
  readonly logger?: RelayLogger;
}

/**
 * Outcome of a single `streamMessage()` invocation.
 *
 * Deliberately minimal — adapter subclasses map this into their
 * transport-specific `DeliveryResult`. Keeping the base return type
 * narrow avoids coupling to `@dorkos/shared/relay-schemas`.
 */
export interface StreamMessageResult {
  readonly success: boolean;
  readonly eventCount: number;
  readonly aborted: boolean;
  readonly error?: string;
  readonly durationMs: number;
}

/**
 * Abstract base class for runtime adapters.
 *
 * Subclasses implement three abstract hooks:
 *
 * - `openSession(sessionId)` — establish or resume a runtime-native session.
 * - `streamEvents(handle, message)` — iterate raw runtime events.
 * - `closeSession(handle)` — runtime-specific teardown.
 *
 * Subclasses also override `normalizeEvent(raw)` to map runtime-native
 * events onto `RuntimeOutboundEvent`. The base never constructs these
 * events; it only passes them to `deliver()`.
 *
 * The base class is abstract by virtue of its abstract methods; attempts
 * to `new RuntimeAdapter(...)` directly fail to compile.
 */
export abstract class RuntimeAdapter {
  /** Injected context (runtime type, logger, etc.). */
  protected readonly ctx: RuntimeAdapterContext;
  /** Logger — either the injected one or the silent no-op. */
  protected readonly logger: RelayLogger;

  /** Per-session promise chains for serializing concurrent dispatch. */
  private readonly sessionQueues = new Map<string, Promise<void>>();

  protected constructor(ctx: RuntimeAdapterContext) {
    this.ctx = ctx;
    this.logger = ctx.logger ?? noopLogger;
  }

  // =========================================================================
  // Concrete behavior — shared across all runtimes.
  // =========================================================================

  /**
   * Stream a message through the runtime.
   *
   * Runs inside the per-session serial queue so concurrent calls for the
   * same `sessionId` execute one at a time (avoids "already connected"
   * style errors seen on streaming SDKs). Calls for different sessions
   * run in parallel.
   *
   * Subclass event iteration happens through `streamEvents()`; each raw
   * event is passed through `normalizeEvent()` and then to `deliver()`.
   * `closeSession()` is guaranteed to be called exactly once — on clean
   * completion, on thrown error, and on abort.
   *
   * @param message - Inbound message describing what to send.
   * @returns Outcome including event count, duration, and error details.
   */
  async streamMessage(message: RuntimeInboundMessage): Promise<StreamMessageResult> {
    return this.enqueueForSession(message.sessionId, () => this.runOnce(message));
  }

  /**
   * Serialize `fn` against prior invocations for the same `sessionId`.
   *
   * Exposed as `protected` so subclasses can queue auxiliary work
   * (e.g. a sidecar approval dispatch) under the same lock.
   */
  protected async enqueueForSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    let result!: T;
    const next = previous.then(() =>
      fn().then((r) => {
        result = r;
      })
    );
    this.sessionQueues.set(
      sessionId,
      next.catch(() => {})
    );
    await next;
    return result;
  }

  /**
   * Deliver a single normalized event.
   *
   * Default implementation is a no-op — subclasses that actually need to
   * forward events onto the relay (e.g. publishing to `envelope.replyTo`)
   * override this. Kept concrete (not abstract) so minimal subclasses
   * and test doubles can ignore delivery entirely.
   */
  protected async deliver(_event: RuntimeOutboundEvent): Promise<void> {
    // Default: no delivery. Subclasses override when they need it.
  }

  /** Return the retry policy for this adapter. Subclasses may override. */
  protected retryPolicy(): RetryPolicy {
    return DEFAULT_RETRY_POLICY;
  }

  /** Current number of sessions with pending queue entries (diagnostic). */
  protected get queuedSessionCount(): number {
    return this.sessionQueues.size;
  }

  /** Clear all per-session queues. Called by subclasses during teardown. */
  protected clearSessionQueues(): void {
    this.sessionQueues.clear();
  }

  // =========================================================================
  // Internal: runs a single attempt inside the queue.
  // =========================================================================

  /** Orchestrate one open -> stream -> close cycle with abort/timeout. */
  private async runOnce(message: RuntimeInboundMessage): Promise<StreamMessageResult> {
    const startTime = Date.now();
    const policy = this.retryPolicy();
    const timeoutMs = this.resolveTimeoutMs(message, policy);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let handle: RuntimeSessionHandle | null = null;
    let eventCount = 0;
    let streamError: string | undefined;
    let aborted = false;

    try {
      handle = await this.openSession(message.sessionId);
      for await (const raw of this.streamEvents(handle, message, controller.signal)) {
        if (controller.signal.aborted) {
          aborted = true;
          break;
        }
        eventCount++;
        const normalized = this.normalizeEvent(raw);
        await this.deliver(normalized);
      }
    } catch (err) {
      streamError = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[${this.ctx.runtimeType}] streamMessage error: ${streamError}`);
    } finally {
      clearTimeout(timer);
      if (controller.signal.aborted) aborted = true;
      if (handle) {
        try {
          await this.closeSession(handle);
        } catch (err) {
          const closeErr = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[${this.ctx.runtimeType}] closeSession error: ${closeErr}`);
          streamError ??= closeErr;
        }
      }
    }

    return {
      success: !streamError && !aborted,
      eventCount,
      aborted,
      error: streamError ?? (aborted ? 'timeout' : undefined),
      durationMs: Date.now() - startTime,
    };
  }

  /** Derive the effective timeout for a single attempt. */
  private resolveTimeoutMs(message: RuntimeInboundMessage, policy: RetryPolicy): number {
    if (message.deadlineMs !== undefined) {
      const remaining = message.deadlineMs - Date.now();
      return remaining > 0 ? remaining : 0;
    }
    return policy.timeoutMs;
  }

  // =========================================================================
  // Abstract runtime hooks — subclasses MUST implement.
  // =========================================================================

  /**
   * Establish or resume a runtime-native session.
   *
   * Called exactly once per `streamMessage()` invocation, before any
   * event iteration. Throwing here skips the stream loop and triggers
   * the same cleanup path as a mid-stream failure (no `closeSession`,
   * since no handle was produced).
   *
   * @param sessionId - The logical session key from the inbound message.
   */
  protected abstract openSession(sessionId: string): Promise<RuntimeSessionHandle>;

  /**
   * Yield raw runtime-native events for a single dispatch.
   *
   * Implementations MUST respect `signal`: if the signal aborts, they
   * should exit their own loop promptly (the base drops events after
   * abort regardless). Implementations MAY throw — the base records
   * the error and still calls `closeSession` on the handle.
   *
   * @param handle - The session handle produced by `openSession`.
   * @param message - The inbound message being processed.
   * @param signal - Abort signal tied to the attempt's timeout.
   */
  protected abstract streamEvents(
    handle: RuntimeSessionHandle,
    message: RuntimeInboundMessage,
    signal: AbortSignal
  ): AsyncIterable<unknown>;

  /**
   * Convert a runtime-native event to a normalized relay event.
   *
   * Called for every event yielded by `streamEvents()`. The default
   * implementation performs a structural cast for runtimes whose
   * native events already satisfy `RuntimeOutboundEvent`; subclasses
   * typically override to translate more exotic shapes.
   *
   * @param raw - A single element yielded by `streamEvents()`.
   */
  protected normalizeEvent(raw: unknown): RuntimeOutboundEvent {
    if (raw && typeof raw === 'object' && 'type' in raw) {
      return raw as RuntimeOutboundEvent;
    }
    return { type: 'unknown', data: raw };
  }

  /**
   * Tear down a runtime-native session handle.
   *
   * Always invoked when `openSession` returned a handle — on success,
   * on mid-stream error, or on timeout. Implementations SHOULD be
   * idempotent; the base never double-closes within a single attempt.
   *
   * @param handle - The handle originally returned by `openSession`.
   */
  protected abstract closeSession(handle: RuntimeSessionHandle): Promise<void>;
}
