/**
 * What a warm process's session carries from one turn to the next, and what
 * starts clean, cleared when a dispatched turn really starts.
 *
 * Split out of `../persistent-dispatch.ts`, which is over the file-size limit.
 *
 * @module services/runtimes/claude-code/sessions/dispatch/per-turn-state
 */
import type { AgentSession } from '../../agent-types.js';
import { keptAsks } from './asks-between-turns.js';

/**
 * Clear what one turn leaves on the session, so the next starts clean. Run when
 * a turn really starts, never for an attempt held for background work.
 *
 * @param session - The session about to run a turn
 */
export function resetPerTurnState(session: AgentSession): void {
  // An ask no turn has shown yet stays on the new queue for this turn to show
  // (DOR-2698); the rest of the old queue belonged to the turn before.
  Object.assign(session, { eventQueue: keptAsks(session), eventQueueNotify: undefined });
  // Clear last turn's breakdown so a failed fetch this turn never shows stale
  // data, and a stop stamped in a PREVIOUS turn must not blind this turn's
  // phantom detector (DOR-1087).
  session.contextBreakdown = undefined;
  // The turn's own background work starts empty too, for a Stop to end (DOR-3285).
  Object.assign(session, { interruptRequestedAt: undefined, turnTaskIds: new Map() });
  // A usage limit is reported once per turn (spec claude-account-fleet D4).
  session.priorServerFailure = undefined;
  session.serverErrorEvidence = undefined;
  session.limitReportedThisTurn = false;
  session.rejectedLimitThisTurn = undefined;
  // And a Stop belongs to the turn it was pressed during, which the stop
  // RECORD only gets right if this path says so (DOR-1320). On the resume
  // path one query is one turn, so `stoppedQueries` is per-turn by
  // construction; a pump runs many turns on ONE query object, so a single
  // Stop would otherwise mark every later turn on that warm process as
  // stopped — and the error-frame suppression it gates would swallow a
  // genuine failure three turns later. Both slots, because the pump's
  // `running` edge moves the live query between them (see below).
  //
  // The blast radius of getting this wrong GREW with DOR-1681. The record no
  // longer only suppresses an error frame: it now rides the wire as
  // `stopWasRequested` and settles the turn's LIFECYCLE, so a stale `true`
  // three turns later would report a genuinely failed turn as one the operator
  // stopped, which is the exact confusion that work removed. This loop is what
  // keeps it per-turn, and the session write-lock is what makes the clearing
  // safe to do here: one dispatch drives a session at a time and holds the
  // lock for the whole of its stream, so no other turn's `result` can be
  // reading the record while this clears it.
  for (const spent of [session.activeQuery, session.lastQuery]) {
    if (spent !== undefined) session.stoppedQueries?.delete(spent);
  }
}
