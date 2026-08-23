/**
 * Close out the asks a restart left behind — the boot sweep for DOR-1439.
 *
 * ## What a restart actually does to a parked ask
 *
 * An ask parks: the agent has stopped and is waiting for a person, for up to
 * four hours (`ask-parks-on-timeout`). Everything holding that wait is in
 * memory — the promise the runtime is blocked on, the two timers, the
 * fleet-wide pending list — and every bit of it belongs to a process. So a
 * restart ends the wait, and it ends the TURN with it: the claude-code SDK
 * subprocess is a child of the server, and the codex/opencode pumps are the
 * server. There is nothing left to hand an answer to.
 *
 * **That is the limit, and it is a real one: a parked ask cannot be revived.**
 * Persisting the promise is not a thing that can be done — what would be
 * restored is a closure over a dead process. Anyone reading this looking for
 * "resume the ask after a restart" should read that as out of reach without
 * resumable turns, which is a different and much larger piece of work.
 *
 * ## So what this does instead
 *
 * It makes the ask END somewhere a person can see, instead of disappearing.
 * Before DOR-1439 a parked ask left NOTHING durable at all: the prompt row was
 * flushed at `turn_end`, and a turn parked on an ask never reaches one. After
 * the restart the fleet-wide list was empty (it lives in memory) and the
 * transcript showed a gated tool with no sign anybody had ever been asked —
 * the exact gap `interaction_resolved` rows were introduced to close for
 * answered asks.
 *
 * Now the prompt is durable the moment it is raised
 * ({@link EAGERLY_RECORDED_EVENT_TYPES}), and this sweep — run once, at boot,
 * before anything can raise a new one — writes each still-open ask an
 * `interaction_resolved` / `expired`. Which means:
 *
 * - a reopened **claude-code** conversation says **"Nobody answered in time"**
 *   on that tool, through the same receipt overlay every other ended ask uses;
 * - nothing offers a button that could not work, because the resolution is
 *   final and the fleet-wide list never had the entry to begin with;
 * - the four-hour park cannot outlive the process that armed it — its timers
 *   died with that process, and now the durable record agrees.
 *
 * **The visible receipt is claude-code's alone, and that is a limit worth
 * knowing.** Its history is SDK JSONL, so the tool call exists to annotate. A
 * log-backed runtime's history is folded from these very rows, and the parked
 * turn's `turn_start` and `tool_call` were never flushed (that mode flushes at
 * `turn_end`, which is exactly what did not happen), so the resolution lands on
 * a turn that is not there and renders nothing. The row is still written, and
 * still worth writing: it is what stops the NEXT boot from re-closing the same
 * ask, and what a person reading the durable record directly can see.
 *
 * **What counts as still-open is decided by the turn, not by the missing
 * answer** — see {@link SessionEventStore.readUnresolvedInteractions}. The
 * distinction is the difference between closing an ask nobody could answer and
 * overwriting a decision somebody made.
 *
 * `expired` rather than a new "the server restarted" outcome, deliberately.
 * It is what actually happened from the person's side — nobody answered, and
 * the ask ended — and inventing a fourth resolution would put a word on the
 * wire that every client, the history fold and the log-backed reconstruction
 * would each have to learn in order to say something the existing word already
 * says. The log line below is where the RESTART is named, for whoever is
 * debugging rather than reading their own transcript.
 *
 * @module services/session/expire-orphaned-asks
 */
import { logger } from '../../lib/logger.js';
import type { SessionEventStore } from './session-event-store.js';

/**
 * Resolve every ask that outlived the process that raised it, as expired.
 *
 * Idempotent: an ask it closes has a resolution row afterwards, so a second run
 * (or the next boot) finds nothing. Never throws — this runs on the boot path,
 * and a locked or unreadable database must cost the sweep and not the server.
 *
 * **Call it only at boot, and only behind the instance lock.** It assumes no
 * other process is holding an ask against this database, which is exactly what
 * `lib/instance-lock.ts` guarantees a few lines earlier in `index.ts` — one
 * server per `DORK_HOME`. `DORKOS_SKIP_INSTANCE_LOCK` is the escape hatch that
 * removes the guarantee, and two servers sharing a home would let one boot
 * close the other's live asks. The flag exists for tests, which point at their
 * own temp homes; this is the dependency it would be paid for elsewhere.
 *
 * @param store - The durable session-event store.
 * @param now - Epoch ms to stamp the resolutions with; injected for tests.
 * @returns How many asks were closed.
 */
export function expireOrphanedAsks(store: SessionEventStore, now = Date.now()): number {
  let closed = 0;
  try {
    for (const ask of store.readUnresolvedInteractions()) {
      store.appendResolution(ask.sessionId, {
        type: 'interaction_resolved',
        id: ask.id,
        resolution: 'expired',
        // Carried because the three kinds share this resolution: without it a
        // timed-out question renders as a permission prompt nobody approved.
        kind: ask.kind,
        at: now,
        startedAt: ask.startedAt,
      });
      closed += 1;
    }
  } catch (err) {
    logger.warn('[expire-orphaned-asks] could not close the asks left by the last run', {
      error: err instanceof Error ? err.message : String(err),
    });
    return closed;
  }
  if (closed > 0) {
    logger.warn('[expire-orphaned-asks] the server restarted while agents were waiting on you', {
      asks: closed,
      // Said plainly because this is the only place the restart is named: the
      // transcript can only say nobody answered in time.
      outcome: 'each was recorded as unanswered; those turns are over, so ask again',
    });
  }
  return closed;
}
