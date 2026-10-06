/**
 * The early warning a session's agent gets when its conversation fills past
 * {@link SESSIONS.CONTEXT_WARNING_PERCENT} of the context window (DOR-2732).
 *
 * An agent can see how full its conversation is and, without this, has nothing
 * to prompt it to act before the runtime compacts on its own terms. So the turn
 * AFTER the crossing carries one short `context_warning` entry: how full it is,
 * and that the agent can save what matters and ask for a summary.
 *
 * ## Once per crossing
 *
 * The note is owed when a turn ends at or above the line and the session was
 * below it before (or was never measured). It is TAKEN by the next turn that
 * starts, so it rides exactly one turn. It re-arms only when a reading falls
 * back below the line — after a summary, normally — so a conversation that
 * stays at 85% for twenty turns is told once, not twenty times.
 *
 * A compaction clears an owed note without re-arming: the reading that put the
 * session over the line is stale the moment the conversation is summarized, and
 * telling the agent "you are at 89%" on the turn after a summary would be false.
 * The next real reading below the line re-arms it as usual.
 *
 * ## Where the reading comes from
 *
 * The projector's `contextUsage`, the same figure the context gauge shows,
 * read at `turn_end` — the moment every runtime has reported the turn's last
 * reading. Runtime-neutral by construction: a runtime that reports no reading,
 * or no window size, never crosses and is never told.
 *
 * State is in memory, keyed by the session's primary id, and swept with the
 * dispatcher's other per-session state when a session goes away. A restart
 * forgets it, which costs at most one repeated note on a session that is still over the
 * line — the right side to err on.
 *
 * @module services/session/agent-compaction/context-warning
 */
import type { SessionContextUsage } from '@dorkos/shared/session-stream';
import { SESSIONS } from '../../../config/constants.js';
import { peekProjector } from '../session-state-projector.js';
import { primaryOf } from '../session-key-registry.js';

/** One session's place relative to the line. */
interface WarningState {
  /** The last reading was at or above the line, so the note has been owed or sent. */
  over: boolean;
  /** The percentage the next turn should be told, until a turn takes it. */
  owed?: number;
}

const states = new Map<string, WarningState>();

/**
 * The share of the context window a reading fills, rounded to a whole percent,
 * or `null` when the reading cannot say (no reading, or no window size).
 *
 * @param usage - The session's context reading.
 */
export function percentOfContext(
  usage: Pick<SessionContextUsage, 'totalTokens' | 'maxTokens'> | null | undefined
): number | null {
  if (!usage || usage.maxTokens <= 0 || usage.totalTokens < 0) return null;
  return Math.min(100, Math.round((usage.totalTokens / usage.maxTokens) * 100));
}

/**
 * Record a session's reading at the end of a turn, owing the note on a crossing
 * and re-arming it on a fall back below the line.
 *
 * @param sessionId - The session, by any id it answers to.
 * @param usage - The reading the turn ended with.
 */
export function noteContextReading(
  sessionId: string,
  usage: Pick<SessionContextUsage, 'totalTokens' | 'maxTokens'> | null | undefined
): void {
  const percent = percentOfContext(usage);
  if (percent === null) return;
  const key = primaryOf(sessionId);
  const state = states.get(key) ?? { over: false };
  if (percent < SESSIONS.CONTEXT_WARNING_PERCENT) {
    states.set(key, { over: false });
    return;
  }
  if (!state.over) {
    states.set(key, { over: true, owed: percent });
  }
}

/**
 * Take the note a session is owed, if any. The caller is the turn that will
 * carry it; once taken it is gone, so it rides exactly one turn.
 *
 * @param sessionId - The session, by any id it answers to.
 * @returns The percentage to report, or `null` when nothing is owed.
 */
export function takeContextWarning(sessionId: string): number | null {
  const state = states.get(primaryOf(sessionId));
  if (state?.owed === undefined) return null;
  const owed = state.owed;
  delete state.owed;
  return owed;
}

/**
 * Put back a note a turn took and then did not run with (a dispatch that was
 * held rather than started), so the next turn that does run carries it.
 *
 * @param sessionId - The session, by any id it answers to.
 * @param percent - The percentage that was taken.
 */
export function restoreContextWarning(sessionId: string, percent: number): void {
  const key = primaryOf(sessionId);
  const state = states.get(key);
  if (state?.over === true && state.owed === undefined) state.owed = percent;
}

/**
 * The conversation is being summarized: drop any owed note, because the
 * reading behind it no longer describes the conversation. Does not re-arm —
 * the next reading below the line does that.
 *
 * @param sessionId - The session, by any id it answers to.
 */
export function clearOwedContextWarning(sessionId: string): void {
  const state = states.get(primaryOf(sessionId));
  if (state) delete state.owed;
}

/**
 * Forget one session's state, for a session that has gone for good — called
 * from the dispatcher's orphan sweep beside its own per-session maps, so the
 * map does not keep an entry for every session the server ever saw.
 *
 * @param sessionId - The session, by any id it answers to.
 */
export function forgetContextWarning(sessionId: string): void {
  states.delete(primaryOf(sessionId));
}

/**
 * Forget every session's state.
 *
 * @internal Exported for testing only.
 */
export function resetContextWarnings(): void {
  states.clear();
}

/**
 * The projector's turn-boundary listener: record the reading a turn ENDED with.
 *
 * Wired by the dispatcher beside its own boundary listener rather than on this
 * module's import, so a test that mocks the projector module and imports
 * `trigger-turn` (which takes the note) is not made to mock this wiring too.
 *
 * @param sessionId - The session whose boundary was reached.
 * @param kind - Which boundary; only `turn_end` carries a final reading.
 */
export function noteContextWarningBoundary(sessionId: string, kind: string): void {
  if (kind !== 'turn_end') return;
  noteContextReading(sessionId, peekProjector(sessionId)?.getStatus().contextUsage);
}
