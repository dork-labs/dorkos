/**
 * How a conversation's latest turn STARTED (DOR-4693): with the outsider mark (a stranger's hold,
 * a Wi-Fi sign-in's, a mark carried on from earlier work, a continuation of a held turn) or clean.
 * A read during the turn adds the mark later (`markRunningTurnOutsider`) and never writes here, so
 * a check can tell a page the agent read from a turn somebody outside started. Written only as a
 * turn starts, under the id it was sent with and the conversation's first id; kept in memory and
 * bounded, oldest first, as the levels are.
 *
 * Fails closed: only a start recorded clean reads as clean. An id with no record, a restart or a
 * second id nobody linked, reads as started marked.
 *
 * @module services/core/turn-power/turn-start-marks
 */
import { primaryOf } from '../../session/resolution/session-key-registry.js';

/** How many conversations are remembered. */
const MEMORY = 10_000;

/** Each conversation's latest start: `true` started marked, `false` started clean. */
const starts = new Map<string, boolean>();

/**
 * Record how a turn started. Called by the level seam as each turn starts.
 *
 * @param sessionId - The id the turn was sent under.
 * @param outsider - Whether the turn started marked.
 */
export function noteTurnStart(sessionId: string, outsider: boolean): void {
  for (const id of new Set([sessionId, primaryOf(sessionId)])) {
    starts.delete(id);
    starts.set(id, outsider);
  }
  while (starts.size > MEMORY) starts.delete(starts.keys().next().value!);
}

/**
 * Carry how a turn started to the id its session goes by next. A marked start always carries;
 * a clean one only fills an id with no record of its own.
 *
 * @param from - The id the turn was noted under.
 * @param to - The id the session is known by now.
 */
export function aliasTurnStart(from: string, to: string): void {
  if (from === to || !starts.has(from)) return;
  if (starts.get(from) === true || !starts.has(to)) starts.set(to, starts.get(from)!);
}

/** How a conversation's latest turn started, as this process recorded it. */
export type TurnStart = 'marked' | 'clean' | 'unknown';

/**
 * How the conversation's latest turn started, under the id in hand or its first id. A marked
 * record under either wins; `unknown` when neither has one.
 *
 * @param sessionId - The conversation, by any id it answers to here.
 */
export function turnStart(sessionId: string): TurnStart {
  const ids = [sessionId, primaryOf(sessionId)];
  if (ids.some((id) => starts.get(id) === true)) return 'marked';
  return ids.some((id) => starts.get(id) === false) ? 'clean' : 'unknown';
}

/**
 * Whether the conversation's latest turn started marked: `false` only for a start recorded clean.
 *
 * @param sessionId - The conversation, by any id it answers to here.
 */
export function turnStartedMarked(sessionId: string): boolean {
  return turnStart(sessionId) !== 'clean';
}
