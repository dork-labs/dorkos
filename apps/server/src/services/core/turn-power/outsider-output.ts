/**
 * How much a turn a stranger started may send out: a few room posts and a few
 * notes per turn (DOR-2739).
 *
 * ## Why this survives "agents are not counted"
 *
 * ADR `261006-225605` took every count off our own agents' routine output: no
 * per-turn post cap, no hourly note budget. Those counts were also the only
 * thing bounding a turn a STRANGER started — someone on Telegram or Slack who
 * is not on the team, an outside agent, a connector event. A message written
 * to trick the agent could make that one turn post into a bridged room, which
 * goes straight back out, or send note after note. The ADR keeps every
 * outsider protection (class C), so the count stays for exactly those turns.
 *
 * ## Which turns
 *
 * Decided by who STARTED the turn ({@link startedByOutsider}, the direct reading
 * of the outsider mark), never by the
 * model and never by the broader "read an outsider's words" mark: that mark
 * also lands on our own agents' turns (a post whose level was not kept, a room
 * where somebody outside posted earlier), and counting those would put back
 * the very cap the ADR retired.
 *
 * ## One turn, and what counts
 *
 * Counted per turn on the conversation ({@link turnSerialOf}), so the next
 * turn starts over. A renamed conversation is known by two ids, and a turn may
 * be sent under either; serials only grow, so the newer of the two names the
 * turn. A stranger's turn with no serial on either id (a runtime's own wake
 * whose first turn ran before a restart) shares one count until a turn is sent
 * again: rare, stranger-only, and on the side of counting.
 *
 * Only a post or note that went out counts: {@link reserveOutsiderOutput}
 * takes one before the send, so two sends at once cannot both pass, and
 * {@link releaseOutsiderOutput} gives it back when the send is refused or
 * fails.
 *
 * A caller that names no session is not counted: no stranger's turn can be
 * placed for it. In memory only; a restart forgets the counts.
 *
 * @module services/core/turn-power/outsider-output
 */
import { turnSerialOf } from './turn-levels.js';
import { startedByOutsider } from './turn-marks.js';
import { primaryOf } from '../../session/resolution/session-key-registry.js';

/** What a turn sends out, counted separately. */
export type OutsiderOutputKind = 'post' | 'note';

/** How many of each one turn a stranger started may send. */
export const OUTSIDER_TURN_LIMIT = 3;

/** How many turns' counts are kept, oldest dropped first. */
const MEMORY = 10_000;

/** Turn key → how many of each kind it has sent. */
const counts = new Map<string, Record<OutsiderOutputKind, number>>();

/** The turn a stranger started on this conversation, as a key, or `undefined` for any other turn. */
function strangerTurnKeyOf(sessionId: string | null | undefined): string | undefined {
  if (!sessionId || !startedByOutsider(sessionId)) return undefined;
  const primary = primaryOf(sessionId);
  const serial = Math.max(turnSerialOf(primary) ?? 0, turnSerialOf(sessionId) ?? 0);
  return `${primary}#${serial}`;
}

/**
 * Take one post or note from the calling turn's allowance. Answers `false`,
 * taking nothing, when a stranger started the turn and it has already sent
 * {@link OUTSIDER_TURN_LIMIT}; `true` otherwise, including for every turn no
 * stranger started. Give it back with {@link releaseOutsiderOutput} if the
 * send does not go out.
 *
 * @param kind - What is about to be sent.
 * @param sessionId - The calling session, as the surface verified it.
 */
export function reserveOutsiderOutput(
  kind: OutsiderOutputKind,
  sessionId: string | null | undefined
): boolean {
  const key = strangerTurnKeyOf(sessionId);
  if (key === undefined) return true;
  const current = counts.get(key) ?? { post: 0, note: 0 };
  if (current[kind] >= OUTSIDER_TURN_LIMIT) return false;
  counts.delete(key);
  counts.set(key, { ...current, [kind]: current[kind] + 1 });
  if (counts.size > MEMORY) counts.delete(counts.keys().next().value!);
  return true;
}

/**
 * Give back one post or note a send reserved and did not use.
 *
 * @param kind - What was not sent.
 * @param sessionId - The calling session, as it was given to the reservation.
 */
export function releaseOutsiderOutput(
  kind: OutsiderOutputKind,
  sessionId: string | null | undefined
): void {
  const key = strangerTurnKeyOf(sessionId);
  const current = key === undefined ? undefined : counts.get(key);
  if (key === undefined || current === undefined || current[kind] === 0) return;
  counts.set(key, { ...current, [kind]: current[kind] - 1 });
}

/**
 * Forget every count.
 *
 * @internal Exported for testing only — the counts outlive one test.
 */
export function resetOutsiderOutput(): void {
  counts.clear();
}
