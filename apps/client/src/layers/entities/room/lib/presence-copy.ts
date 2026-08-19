/**
 * The words every surface says about who is working.
 *
 * Pure, and on the entity rather than beside any one of the surfaces that print
 * it, because the copy is the feature: it is the only thing a person waiting on
 * an agent actually reads, and it has to be true at one agent and at four
 * without a special case creeping in. Three surfaces print from it today — the
 * line under a room's composer, each member's row in the room sheet, and the
 * presence strip in the home header — and a cockpit that says "still working"
 * in one place and nothing in another is telling a person two different things
 * about one turn.
 *
 * It always says **working**, never **typing**. Agents do not type, and if a
 * human typing indicator ever ships it gets its own row rather than sharing
 * this one (room-presence spec §5.2).
 *
 * **It lives here because the strip could not reach it where it was.** The copy
 * started in `widgets/room-view/lib/`, which a feature may not import (FSD:
 * features never reach into widgets) — so the home header's presence strip had
 * the choice of a second vocabulary or a lift. `presenceElapsed` was already
 * here for the same reason, one surface earlier.
 *
 * @module entities/room/lib/presence-copy
 */

/**
 * How many agents the line names before it starts counting.
 *
 * Past this it reads "4 agents are working on it" and the names move behind a
 * tap — three names is the most that fits a line under the composer, and a
 * fourth is what would wrap it.
 */
export const PRESENCE_NAME_LIMIT = 3;

/** Where a room's wait is: still ordinary, or longer than it should be. */
export type PresenceCopyState = 'working' | 'working_late';

/** The long-wait clause, written once so every surface says it identically. */
const TAKING_LONGER = 'this is taking longer than usual';

/** The same clause as a row's trailing note, where there is no sentence to end. */
const TAKING_LONGER_NOTE = 'taking longer than usual';

/** What separates the parts of a one-line row. */
const ROW_SEPARATOR = ' · ';

/**
 * Join names the way a person would say them out loud.
 *
 * @param names - Up to {@link PRESENCE_NAME_LIMIT} names, in the order to read.
 */
function readAsList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What the line says about the agents it names.
 *
 * **The long wait is said at any count.** It used to be the single-agent case
 * only, on the theory that with two or three names the sentence is about the
 * group — but the effect was that a second agent picking something up silently
 * withdrew the one statement a waiting person can act on. Two agents twelve
 * minutes in is more worth saying than one, not less.
 *
 * @param names - The agents to name, oldest claim first.
 * @param state - Where the room's wait is. Taken from the OLDEST claim: it is
 *   the one the elapsed time beside this sentence measures, and the one that
 *   crosses the server's late threshold first.
 */
export function presenceSentence(names: readonly string[], state: PresenceCopyState): string {
  const who = readAsList(names);
  const be = names.length === 1 ? 'is' : 'are';
  if (state === 'working_late') return `${who} ${be} still working — ${TAKING_LONGER}`;
  return `${who} ${be} working on it`;
}

/**
 * What the line says once there are more agents than it will name.
 *
 * The same two sentences as {@link presenceSentence}, counted rather than
 * named — so crossing the naming limit changes who is listed, never whether the
 * room admits it is slow.
 *
 * @param count - How many agents are working. Above {@link PRESENCE_NAME_LIMIT}
 *   wherever this is called from.
 * @param state - Where the room's wait is, from the oldest claim.
 */
export function presenceCountSentence(count: number, state: PresenceCopyState): string {
  if (state === 'working_late') return `${count} agents are still working — ${TAKING_LONGER}`;
  return `${count} agents are working on it`;
}

/**
 * What the line says when the room knows what one agent is doing.
 *
 * The plainest true sentence: a name, "is", and the clause the tool table
 * produced. No ellipsis and no "on it" — "Kai is reading standup.md" is already
 * a complete thought, and the elapsed time follows it the way it follows every
 * other form here.
 *
 * @param name - The agent's display name.
 * @param clause - What it is doing, as a clause that follows "is".
 */
export function presenceActivitySentence(name: string, clause: string): string {
  return `${name} is ${clause}`;
}

/**
 * Everything a one-line row says EXCEPT the name — what this claim is bound to,
 * and whether it has outrun the room.
 *
 * The general form behind both row shapes the cockpit prints: the room sheet's
 * `4m`, and the presence strip's `replying in #release-train`. Both are the
 * same sentence with a different middle, and writing them twice is how one of
 * them silently stops mentioning a long wait.
 *
 * @param detail - What the claim is bound to, already in words, or `null` when
 *   nothing can truthfully say. `null` is not a gap to fill with a guess — a
 *   row that cannot name the binding says only the name and the state.
 * @param state - Where this claim's own wait is.
 * @returns The detail clause, or `null` when there is nothing true to add.
 */
export function presenceDetail(detail: string | null, state: PresenceCopyState): string | null {
  const parts: string[] = [];
  if (detail !== null && detail.length > 0) parts.push(detail);
  if (state === 'working_late') parts.push(TAKING_LONGER_NOTE);
  return parts.length === 0 ? null : parts.join(ROW_SEPARATOR);
}

/**
 * One agent's row, in full: the name, what it is bound to, and the long-wait
 * note when the wait has gone long.
 *
 * It carries state, which the room sheet's list used to drop: four agents with
 * one of them twenty minutes late read exactly like four healthy ones — and the
 * list is precisely where a person goes to find out which one to chase.
 *
 * @param name - The agent's display name.
 * @param detail - What it is bound to, already in words (`3m` for the room
 *   sheet, `replying in #release-train` for the strip), or `null` when nothing
 *   can truthfully say.
 * @param state - Where that agent's own claim is.
 */
export function presenceRow(name: string, detail: string | null, state: PresenceCopyState): string {
  const rest = presenceDetail(detail, state);
  return rest === null ? name : `${name}${ROW_SEPARATOR}${rest}`;
}

/**
 * How long something has been running, in the shortest true form.
 *
 * Seconds while it is quick, then minutes, then hours. No decimals and no
 * seconds-past-the-minute: this is a number a person glances at to decide
 * whether to keep waiting, and "1m 23s" reads slower than "1m" without telling
 * them anything they would act on differently.
 *
 * @param ms - Elapsed milliseconds. Anything negative reads as `0s`.
 */
export function presenceElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
