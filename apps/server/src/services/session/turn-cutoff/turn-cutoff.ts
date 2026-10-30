/**
 * What DorkOS says when the stall guard ends a turn the agent went quiet in
 * (DOR-3307), to the person and to the agent, and the one-time note it owes the
 * agent's next turn.
 *
 * ## Why this exists
 *
 * The stall guard ends a quiet turn by interrupting the runtime, and the
 * runtime records the interrupt in a person's voice: Claude Code writes
 * `[Request interrupted by user]`, and over a tool that was still running,
 * "The user doesn't want to proceed with this tool use … STOP what you are
 * doing and wait for the user". Agents read both as a person's stop. On
 * 2026-10-26 three of them held all their work and waited hours for a person
 * who had done nothing. Those lines are the runtime's own, so they cannot be
 * changed where they are written. What DorkOS can do is say who really stopped
 * the turn: in the chat ({@link turnCutoffMessage}, read by the stall guard and
 * the history overlay) and to the agent, on its next turn
 * ({@link formatTurnCutoff}).
 *
 * ## The owed note
 *
 * Held in memory and keyed by the primary session id, on the same terms as the
 * context warning (`agent-compaction/context-warning.ts`). A note owed when the
 * server restarts is lost, and the cost is the old behavior for that one turn;
 * the chat still shows the cutoff, because the history overlay reads the
 * durable record instead.
 *
 * @module services/session/turn-cutoff/turn-cutoff
 */
import type { TurnCutoffData } from '@dorkos/shared/additional-context';
import { primaryOf } from '../resolution/session-key-registry.js';

/** Notes owed to each session's next turn, keyed by primary session id. */
const owed = new Map<string, TurnCutoffData>();

/** Human form of the inactivity window: whole minutes, or seconds below one. */
function formatWindow(windowMs: number): string {
  if (windowMs >= 60_000) {
    const minutes = Math.round(windowMs / 60_000);
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }
  const seconds = Math.round(windowMs / 1000);
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

/**
 * The sentence a person reads where a cutoff ended a turn: in the live chat,
 * in the room, and in the reopened conversation. Names DorkOS as the one that
 * stopped it, never "the user".
 *
 * @param cutoff - How long the turn was quiet, and whether it ever started.
 */
export function turnCutoffMessage(cutoff: TurnCutoffData): string {
  const window = formatWindow(cutoff.windowMs);
  return cutoff.neverStarted
    ? `DorkOS ended this turn: the agent didn't start within ${window}.`
    : `DorkOS stopped this turn after ${window} with no activity.`;
}

/**
 * The note the agent's next turn carries, rendered by every runtime.
 *
 * Quotes the two lines Claude Code writes on purpose, so the agent can match
 * them in its own context and set them aside. Other runtimes word their
 * interrupt differently, and the quotes read there as what to ignore if seen.
 *
 * @param cutoff - How long the turn was quiet, and whether it ever started.
 */
export function formatTurnCutoff(cutoff: TurnCutoffData): string {
  const window = formatWindow(cutoff.windowMs);
  const what = cutoff.neverStarted
    ? `DorkOS ended your last turn because it didn't start within ${window}.`
    : `DorkOS stopped your last turn after ${window} with no activity.`;
  return (
    `${what} No person stopped it, and nobody declined anything. ` +
    'Any "[Request interrupted by user]" or "The user doesn\'t want to proceed with this tool use" ' +
    'at the end of that turn was written by this cutoff, not by a person. ' +
    'Carry on with your work; check on anything that was running when it stopped.'
  );
}

/**
 * Record that the stall guard ended a turn, so the session's next turn is told.
 * A second cutoff before that turn replaces the first: the latest is what the
 * agent needs.
 *
 * @param sessionId - Any id the session is known by.
 * @param cutoff - How long the turn was quiet, and whether it ever started.
 */
export function noteTurnCutoff(sessionId: string, cutoff: TurnCutoffData): void {
  owed.set(primaryOf(sessionId), cutoff);
}

/**
 * Take the note owed to this session's next turn, if any. Taken, not peeked,
 * so it rides exactly one dispatch.
 *
 * @param sessionId - Any id the session is known by.
 */
export function takeTurnCutoff(sessionId: string): TurnCutoffData | null {
  const key = primaryOf(sessionId);
  const cutoff = owed.get(key);
  if (cutoff === undefined) return null;
  owed.delete(key);
  return cutoff;
}

/**
 * Hand back a note a dispatch took but never delivered, unless a newer cutoff
 * has been noted since.
 *
 * @param sessionId - Any id the session is known by.
 * @param cutoff - The note that was taken.
 */
export function restoreTurnCutoff(sessionId: string, cutoff: TurnCutoffData): void {
  const key = primaryOf(sessionId);
  if (!owed.has(key)) owed.set(key, cutoff);
}

/**
 * Drop a session's owed note, for a session that is going away.
 *
 * @param sessionId - Any id the session is known by.
 */
export function forgetTurnCutoff(sessionId: string): void {
  owed.delete(primaryOf(sessionId));
}

/** Clear every owed note. For tests. */
export function resetTurnCutoffs(): void {
  owed.clear();
}
