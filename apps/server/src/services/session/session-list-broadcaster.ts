/**
 * Global session-list broadcaster.
 *
 * Bridges every registered runtime's {@link AgentRuntime.subscribeSessionList}
 * contract onto the existing unified `GET /api/events` SSE fan-out (ADR-0308).
 * It iterates each runtime's discovery + liveness stream and re-broadcasts
 * every {@link SessionListEvent} to all connected clients using the event's
 * `type` as the SSE `event:` name (`session_upserted`, `session_removed`,
 * `session_status`), so the client sidebar/status views subscribe to the same
 * names the schema constrains.
 *
 * This is ALWAYS ON (ADR-0265/0266): it is the primary mechanism that replaces
 * the client's legacy 5s sessions poll. Emission is transition-driven — each
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
 * session-list stream is discovery-only and the adapters read only `cwd` from
 * `ctx`, but {@link SessionOpts} requires a `permissionMode`; `'default'` is the
 * portable, side-effect-free choice (mirrors the durable events route).
 */
const GLOBAL_CTX_PERMISSION_MODE = 'default' as const;

/**
 * Subscribes to every registered runtime's global session-list stream and fans
 * each validated {@link SessionListEvent} onto the unified `/api/events` SSE
 * stream. Lifecycle is `start()`/`stop()`; `stop()` closes every underlying
 * runtime iterator (and therefore its directory watcher) via `.return()`.
 */
export class SessionListBroadcaster {
  private iterators = new Set<AsyncIterator<SessionListEvent>>();
  private running = false;
  private unsubscribeStatus: (() => void) | undefined;

  /**
   * Begin consuming every runtime's session-list stream and broadcasting the
   * merged events. Safe to call once after all runtimes are registered; a
   * second call while already running is a no-op. Runtimes registered AFTER
   * `start()` are not picked up — the composition root must register every
   * runtime first, then call `start(runtimeRegistry.listRuntimes())`. Each
   * consume loop runs detached so `start()` returns immediately and never
   * blocks server startup.
   *
   * Also wires projector-driven liveness: every lifecycle transition any
   * {@link onProjectorStatusChange | projector} reports fans out as a
   * `session_status` event. Both paths are fleet-wide: the projector fan-out
   * covers a DorkOS-triggered turn in ANY working directory, and each runtime's
   * discovery watcher covers every session that runtime can observe (SRV-I4).
   *
   * @param runtimes - All registered runtimes, e.g. `runtimeRegistry.listRuntimes()`.
   */
  start(runtimes: AgentRuntime[]): void {
    if (this.running) return;
    this.running = true;

    // Installed before (and independent of) the watchers: liveness must survive
    // watcher construction failures. Guarded so a failed start() followed by a
    // retry cannot stack a second subscription.
    this.unsubscribeStatus ??= onProjectorStatusChange(
      ({ sessionId, cwd, retiredSessionId, status }) =>
        this.broadcast({ type: 'session_status', sessionId, cwd, retiredSessionId, status })
    );

    // Global discovery context. The contract is fleet-wide ("ALL sessions the
    // adapter can observe") — the Claude adapter watches the whole projects
    // root and ignores `ctx` — but SessionOpts requires both fields, so pass
    // the portable defaults for adapters that do scope by cwd.
    const ctx: SessionOpts = {
      cwd: DEFAULT_CWD,
      permissionMode: GLOBAL_CTX_PERMISSION_MODE,
    };

    for (const runtime of runtimes) {
      // Constructing an iterator can throw SYNCHRONOUSLY (e.g. the watcher's
      // chokidar.watch fails). `start()` is called from `index.ts` with no
      // try/catch, so an uncaught throw here would crash boot — contradicting
      // the "never blocks startup" guarantee — and must not kill the sibling
      // runtimes' discovery either. Catch per-runtime, log, and continue: the
      // server stays up and the other runtimes keep broadcasting.
      let iterator: AsyncIterator<SessionListEvent>;
      try {
        iterator = runtime.subscribeSessionList(ctx)[Symbol.asyncIterator]();
      } catch (err) {
        logger.error('[SessionListBroadcaster] failed to start session-list subscription', {
          runtime: runtime.type,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      this.iterators.add(iterator);
      void this.consume(runtime.type, iterator);
    }

    // Every subscription failed at construction (or no runtimes were given):
    // discovery is fully off, so reset `running` to allow a later retry. The
    // status fan-out stays installed — liveness survives watcher failure.
    if (this.iterators.size === 0) {
      this.running = false;
    }
  }

  /**
   * Stop broadcasting and close every underlying runtime iterator (which closes
   * its directory watcher). Idempotent.
   */
  async stop(): Promise<void> {
    // Unsubscribe unconditionally: the status fan-out outlives a failed
    // watcher start (running=false), so it cannot hide behind the guard below.
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = undefined;
    if (!this.running) return;
    this.running = false;
    const iterators = [...this.iterators];
    this.iterators.clear();
    // allSettled: one runtime's failing close must not skip closing the others.
    const results = await Promise.allSettled(iterators.map((iterator) => iterator.return?.()));
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn('[SessionListBroadcaster] error closing session-list iterator', {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  /**
   * Drain one runtime's iterator, validating and broadcasting each event. One
   * malformed event is dropped and logged; an iterator-level throw or
   * unexpected end is logged and ends that runtime's loop without taking down
   * the server or the sibling runtimes' loops.
   */
  private async consume(
    runtimeType: string,
    iterator: AsyncIterator<SessionListEvent>
  ): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await iterator.next();
        if (done || !this.running) break;
        this.broadcast(value);
      }
    } catch (err) {
      logger.error('[SessionListBroadcaster] session-list subscription failed', {
        runtime: runtimeType,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // This runtime's stream ended (cleanly or via error): its discovery stops
      // until the next start(). Sibling runtimes keep broadcasting; only when
      // the LAST stream ends does the broadcaster go idle (enabling a retry).
      this.iterators.delete(iterator);
      if (this.iterators.size === 0) this.running = false;
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
