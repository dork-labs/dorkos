/**
 * Global session-list broadcaster.
 *
 * Bridges the active runtime's {@link AgentRuntime.subscribeSessionList} contract
 * onto the existing unified `GET /api/events` SSE fan-out. It iterates the
 * runtime's discovery + liveness stream and re-broadcasts every
 * {@link SessionListEvent} to all connected clients using the event's `type` as
 * the SSE `event:` name (`session_upserted`, `session_removed`,
 * `session_status`), so the client sidebar/status views subscribe to the same
 * names the schema constrains.
 *
 * This is ALWAYS ON (ADR-0265/0266): it is the primary mechanism that replaces
 * the client's legacy 5s sessions poll. Emission is transition-driven — the
 * runtime watcher is already debounced and diff-suppressed, so there is no timer
 * poll here. Each event is validated against {@link SessionListEventSchema}
 * before it reaches the wire; an invalid event is dropped and logged rather than
 * crashing the iteration loop.
 *
 * @module services/session/session-list-broadcaster
 */
import type { AgentRuntime, SessionOpts } from '@dorkos/shared/agent-runtime';
import { SessionListEventSchema } from '@dorkos/shared/session-stream';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import { eventFanOut } from '../core/event-fan-out.js';
import { onProjectorStatusChange } from './session-state-projector.js';
import { DEFAULT_CWD } from '../../lib/resolve-root.js';
import { logger } from '../../lib/logger.js';

/**
 * Permission mode used to build the global subscription context. The
 * session-list stream is discovery-only and the adapter reads only `cwd` from
 * `ctx`, but {@link SessionOpts} requires a `permissionMode`; `'default'` is the
 * portable, side-effect-free choice (mirrors the durable events route).
 */
const GLOBAL_CTX_PERMISSION_MODE = 'default' as const;

/**
 * Subscribes to the active runtime's global session-list stream and fans every
 * validated {@link SessionListEvent} onto the unified `/api/events` SSE stream.
 * Lifecycle is `start()`/`stop()`; `stop()` closes the underlying runtime
 * iterator (and therefore its directory watcher) via `.return()`.
 */
export class SessionListBroadcaster {
  private iterator: AsyncIterator<SessionListEvent> | undefined;
  private running = false;
  private unsubscribeStatus: (() => void) | undefined;

  /**
   * Begin consuming the runtime's session-list stream and broadcasting it. Safe
   * to call once after the runtime is registered; a second call while already
   * running is a no-op. The consume loop runs detached so `start()` returns
   * immediately and never blocks server startup.
   *
   * Also wires projector-driven liveness: every lifecycle transition any
   * {@link onProjectorStatusChange | projector} reports fans out as a
   * `session_status` event. This path is cwd-agnostic (a DorkOS-triggered turn
   * in ANY working directory has a projector), unlike the discovery watcher
   * below, which only covers the default workspace — so sidebar liveness works
   * fleet-wide even where discovery does not.
   *
   * @param runtime - The active runtime, e.g. `runtimeRegistry.getDefault()`.
   */
  start(runtime: AgentRuntime): void {
    if (this.running) return;
    this.running = true;

    // Installed before (and independent of) the watcher: liveness must survive
    // a watcher construction failure. Guarded so a failed start() followed by a
    // retry cannot stack a second subscription.
    this.unsubscribeStatus ??= onProjectorStatusChange(
      ({ sessionId, cwd, retiredSessionId, status }) =>
        this.broadcast({ type: 'session_status', sessionId, cwd, retiredSessionId, status })
    );

    // Global discovery context: the default workspace root, NOT a per-session
    // cwd. The adapter reads only `cwd` from `ctx` for the session-list watch.
    const ctx: SessionOpts = {
      cwd: DEFAULT_CWD,
      permissionMode: GLOBAL_CTX_PERMISSION_MODE,
    };

    // Constructing the iterator can throw SYNCHRONOUSLY (e.g. the watcher's
    // chokidar.watch fails). `start()` is called from `index.ts` with no
    // try/catch, so an uncaught throw here would crash boot — contradicting the
    // "never blocks startup" guarantee. Catch it, log, and leave discovery off:
    // the server stays up and the client falls back to its opt-in polling.
    try {
      this.iterator = runtime.subscribeSessionList(ctx)[Symbol.asyncIterator]();
    } catch (err) {
      this.running = false;
      this.iterator = undefined;
      logger.error('[SessionListBroadcaster] failed to start session-list subscription', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    void this.consume();
  }

  /**
   * Stop broadcasting and close the underlying runtime iterator (which closes
   * its directory watcher). Idempotent.
   */
  async stop(): Promise<void> {
    // Unsubscribe unconditionally: the status fan-out outlives a failed
    // watcher start (running=false), so it cannot hide behind the guard below.
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = undefined;
    if (!this.running) return;
    this.running = false;
    const iterator = this.iterator;
    this.iterator = undefined;
    await iterator?.return?.();
  }

  /**
   * Drain the runtime iterator, validating and broadcasting each event. One
   * malformed event is dropped and logged; an iterator-level throw or
   * unexpected end is logged and ends the loop without taking down the server.
   */
  private async consume(): Promise<void> {
    const iterator = this.iterator;
    if (!iterator) return;
    try {
      for (;;) {
        const { value, done } = await iterator.next();
        if (done || !this.running) break;
        this.broadcast(value);
      }
    } catch (err) {
      logger.error('[SessionListBroadcaster] session-list subscription failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // The stream ended (cleanly or via error). Discovery stops until the next
      // start(); the server stays up regardless.
      this.running = false;
    }
  }

  /** Validate an event against the schema and broadcast it, or drop+log if invalid. */
  private broadcast(event: SessionListEvent): void {
    const parsed = SessionListEventSchema.safeParse(event);
    if (!parsed.success) {
      logger.warn('[SessionListBroadcaster] dropping invalid session-list event', {
        error: parsed.error.message,
      });
      return;
    }
    // The SSE event name is the schema-constrained discriminator, so there is no
    // stringly-typed drift: clients filter on the same `type` values.
    eventFanOut.broadcast(parsed.data.type, parsed.data);
  }
}

/** Singleton session-list broadcaster wired in `index.ts` after runtime registration. */
export const sessionListBroadcaster = new SessionListBroadcaster();
