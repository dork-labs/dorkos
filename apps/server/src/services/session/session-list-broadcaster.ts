/**
 * Global session-list broadcaster.
 *
 * Bridges every registered runtime's {@link AgentRuntime.subscribeSessionList}
 * contract onto the existing unified `GET /api/events` SSE fan-out (ADR-0310).
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
 * A stream of transitions is only complete for a client that was connected when
 * each one fired, so this module also owns the other half:
 * {@link sendSessionStatusSnapshot} tells a client that has JUST connected what
 * state the transitions it missed left behind (DOR-1136).
 *
 * @module services/session/session-list-broadcaster
 */
import type { AgentRuntime, SessionOpts } from '@dorkos/shared/agent-runtime';
import { SessionListEventSchema } from '@dorkos/shared/session-stream';
import type { SessionLifecycle, SessionListEvent } from '@dorkos/shared/session-stream';
import { SSE } from '../../config/constants.js';
import { eventFanOut, encodeBroadcast, type FanOutClient } from '../core/event-fan-out.js';
import { listProjectorStatuses, onProjectorStatusChange } from './session-state-projector.js';
import {
  overlayStoredSettings,
  type SessionSettingsOverlayPort,
} from './session-settings-overlay.js';
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
 * Validate one session-list event, or drop it.
 *
 * Module-level rather than a method so the connect snapshot below and the live
 * broadcast above pass through the SAME gate. A snapshot that skipped it would
 * be the one path on which a malformed status reached a client, and the two
 * would be free to disagree about what a valid event is.
 *
 * @param event - The candidate event.
 * @returns The parsed event, or `undefined` when it failed the schema.
 */
function validateListEvent(event: SessionListEvent): SessionListEvent | undefined {
  const parsed = SessionListEventSchema.safeParse(event);
  if (!parsed.success) {
    logger.warn('[SessionListBroadcaster] dropping invalid session-list event', {
      error: parsed.error.message,
    });
    return undefined;
  }
  return parsed.data;
}

/**
 * Lifecycles worth telling a newly connected client about.
 *
 * `idle` says nothing — it is the absence of a signal, and the client's list
 * store prunes it on arrival anyway. `interrupted` is pruned by the same rule:
 * it settles a turn, and a settled turn is not something waiting on anybody.
 * What remains is the three states an operator can act on, and the three the
 * sidebar's Now zone is built from: work in flight, work waiting on a person,
 * and work that stopped badly.
 */
const SNAPSHOT_LIFECYCLES: ReadonlySet<SessionLifecycle> = new Set<SessionLifecycle>([
  'streaming',
  'blocked',
  'error',
]);

/**
 * Send a newly connected client the fleet's current lifecycles, as ordinary
 * `session_status` events.
 *
 * ## Why this exists
 *
 * The global stream carries transitions and nothing else — it opens with
 * `connected` and then relays only what happens NEXT. That is complete for a
 * client that was attached when each transition fired and empty for one that
 * was not, so every page load forgot every session that had already errored or
 * already blocked. The sidebar's Now zone reads exactly those lifecycles, so
 * "open the app with something waiting" showed nothing at all until the session
 * moved again — which, for a session that has stopped, is never (DOR-1136).
 *
 * ## Why it is not stale
 *
 * These are not remembered events being replayed; they are read from the live
 * projector registry at the instant of the connect, which is the same object
 * the live fan-out reports transitions from. A `streaming` here means the
 * projector believes that turn is open right now — the identical claim the live
 * path makes — so this adds no class of staleness the stream did not already
 * have, and the next real transition overwrites it exactly as it would any
 * other `session_status`.
 *
 * Sent to ONE client rather than broadcast: every other reader either already
 * holds these lifecycles or does not want them re-asserted.
 *
 * ## What bounds it
 *
 * One frame per non-idle projector, and a projector lives until its session is
 * evicted or the server restarts. **Only claude-code evicts on a timer**
 * (`SESSIONS.TIMEOUT_MS`, 30 minutes idle). Codex, opencode and test-mode all
 * implement `checkSessionHealth` as a no-op — none of them holds a per-session
 * process — so their projectors are dropped only by an explicit act
 * (test-mode's `/api/test/reset`) or by a restart. On a codex- or
 * opencode-heavy machine this set therefore only grows. It is small in every
 * realistic fleet, but "small" is not a guarantee, and this is the one place in
 * the stream that writes N frames in a row.
 *
 * So it stops at the same buffer ceiling the fan-out's own broadcast enforces
 * (`SSE.MAX_BUFFERED_BYTES`), rather than filling process memory for a client
 * that is not reading. It STOPS rather than dropping the client, which is the
 * opposite of what a broadcast does and deliberately so: a broadcast drops a
 * slow client because it cannot wait for one reader, and the recovery is a
 * reconnect that re-baselines. A client dropped here would reconnect straight
 * back into this same function and hit the same ceiling. A partial preamble
 * degrades to the old behaviour for the sessions it did not reach, which is the
 * honest floor.
 *
 * @param client - The client that has just registered with the fan-out.
 */
export function sendSessionStatusSnapshot(client: FanOutClient): void {
  for (const update of listProjectorStatuses()) {
    if (!SNAPSHOT_LIFECYCLES.has(update.status.lifecycle)) continue;
    if (client.bufferedBytes > SSE.MAX_BUFFERED_BYTES) {
      logger.warn(
        '[SessionListBroadcaster] connect snapshot truncated (client buffer over limit)',
        {
          bufferedBytes: client.bufferedBytes,
        }
      );
      return;
    }
    const event = validateListEvent({
      type: 'session_status',
      sessionId: update.sessionId,
      cwd: update.cwd,
      status: update.status,
    });
    if (event) client.send(encodeBroadcast(event.type, event));
  }
}

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
  private settings: SessionSettingsOverlayPort | undefined;

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
   * @param settings - Persisted-settings store used to overlay operator choices
   *   onto every broadcast session (ADR-0260). Omit only where no store exists;
   *   without it, upserts carry runtime-derived values and clients that refresh
   *   their list from this stream will disagree with `GET /api/sessions`.
   */
  start(runtimes: AgentRuntime[], settings?: SessionSettingsOverlayPort): void {
    if (this.running) return;
    this.running = true;
    this.settings = settings;

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
      void this.consume(runtime, iterator);
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
    runtime: AgentRuntime,
    iterator: AsyncIterator<SessionListEvent>
  ): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await iterator.next();
        if (done || !this.running) break;
        this.broadcast(value, runtime);
      }
    } catch (err) {
      logger.error('[SessionListBroadcaster] session-list subscription failed', {
        runtime: runtime.type,
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

  /**
   * Overlay persisted settings onto a `session_upserted` before it goes out.
   *
   * This stream — not `GET /api/sessions` — is what keeps a client's session
   * list current: the cold-load query has no poll, so every later refresh of a
   * row arrives here. An un-overlaid upsert therefore OVERWRITES the operator's
   * stored permission mode in the client's cache with the runtime-derived one,
   * which is the same disagreement DOR-463 fixed on the HTTP endpoints.
   *
   * Copies the session first. Adapters emit the object they hold — the Claude
   * watcher pushes the very instance in its diff map (and in the transcript
   * reader's mtime cache) — so overlaying in place would write display values
   * into a runtime's own cached state and defeat its change suppression.
   */
  private withStoredSettings(event: SessionListEvent): SessionListEvent {
    if (event.type !== 'session_upserted' || !this.settings) return event;
    const session = { ...event.session };
    try {
      overlayStoredSettings([session], this.settings);
    } catch (err) {
      // Discovery must survive a settings-store failure: an un-overlaid row is
      // stale, a dropped row is invisible. Prefer stale.
      logger.warn('[SessionListBroadcaster] settings overlay failed; broadcasting as-is', {
        sessionId: event.session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return event;
    }
    return { ...event, session };
  }

  /**
   * Validate an event against the schema and broadcast it, or drop+log if
   * invalid.
   *
   * Validation runs FIRST and everything after it works on `parsed.data`. That
   * ordering is load-bearing, not stylistic: a malformed event (e.g. a
   * `session_upserted` with no `session`) reaches this method, and any step that
   * touched the raw event's shape ahead of the gate would throw out of the
   * caller's loop and kill that runtime's whole subscription — the exact failure
   * the "one malformed event is dropped and logged" contract exists to prevent.
   *
   * @param event - The event to validate and fan out.
   * @param runtime - The runtime that produced it, when it came from a
   *   subscription. Absent for internally-minted events (the projector status
   *   fan-out), which have no owning runtime and need no retirement check.
   */
  private broadcast(event: SessionListEvent, runtime?: AgentRuntime): void {
    const validated = validateListEvent(event);
    if (!validated) return;
    // Suppress an upsert for an id the runtime has RETIRED, matching
    // `aggregateSessionList`'s drop. Both produce client-visible session rows,
    // so if only one applied the rule they would disagree about whether a
    // retired id may appear — the split derivation this change exists to close,
    // one layer up. A `session_removed` for such an id is deliberately still
    // forwarded: telling a client to drop a row it should not be holding is
    // always safe.
    if (validated.type === 'session_upserted' && runtime) {
      const canonical = runtime.getInternalSessionId(validated.session.id);
      if (canonical !== undefined && canonical !== validated.session.id) return;
    }
    // The SSE event name is the schema-constrained discriminator, so there is no
    // stringly-typed drift: clients filter on the same `type` values.
    const outgoing = this.withStoredSettings(validated);
    if (outgoing.type === 'session_removed') notifySessionRemoved(outgoing.sessionId);
    eventFanOut.broadcast(outgoing.type, outgoing);
  }
}

/** A subscriber notified when a runtime reports a session gone for good. */
type SessionRemovedListener = (sessionId: string) => void;

/** Observers of `session_removed`; see {@link onSessionRemoved}. */
const sessionRemovedListeners = new Set<SessionRemovedListener>();

/**
 * Subscribe to a session VANISHING — a runtime reporting that the conversation
 * no longer exists at all.
 *
 * This is the orphaning signal, and it is deliberately not the same thing as
 * eviction. A session evicted from memory is still perfectly real and comes
 * back the moment somebody opens it; a removed one is gone. Server-side state
 * that outlives a session — the durable message queue is the first — reclaims
 * itself from here.
 *
 * @param listener - Invoked with the id of each removed session.
 * @returns An unsubscribe function.
 */
export function onSessionRemoved(listener: SessionRemovedListener): () => void {
  sessionRemovedListeners.add(listener);
  return () => {
    sessionRemovedListeners.delete(listener);
  };
}

/** Tell every removal observer, without letting one of them break the fan-out. */
function notifySessionRemoved(sessionId: string): void {
  for (const listener of sessionRemovedListeners) {
    try {
      listener(sessionId);
    } catch (err) {
      logger.warn('[SessionListBroadcaster] a session-removed observer threw', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Singleton session-list broadcaster wired in `index.ts` after runtime registration. */
export const sessionListBroadcaster = new SessionListBroadcaster();
