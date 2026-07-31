/**
 * The words the presence line says.
 *
 * Pure, and separate from the component, because the copy is the feature: it is
 * the only thing a person waiting on an agent actually reads, and it has to be
 * true at one agent and at four without a special case creeping in.
 *
 * It always says **working**, never **typing**. Agents do not type, and if a
 * human typing indicator ever ships it gets its own row rather than sharing this
 * one (room-presence spec §5.2).
 *
 * The elapsed time this line prints is NOT here: the room sheet prints it too,
 * so it lives on the entity as `presenceElapsed` and both read the one copy.
 *
 * @module widgets/room-view/lib/presence-copy
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
type PresenceCopyState = 'working' | 'working_late';

/** The long-wait clause, written once so every surface says it identically. */
const TAKING_LONGER = 'this is taking longer than usual';

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
 * One agent's row in the list behind the count.
 *
 * It carries state, which the list used to drop: four agents with one of them
 * twenty minutes late read exactly like four healthy ones — and the list is
 * precisely where a person goes to find out which one to chase.
 *
 * @param name - The agent's display name.
 * @param state - Where that agent's own claim is.
 * @param elapsed - How long it has been running, already in words.
 */
export function presenceListRow(name: string, state: PresenceCopyState, elapsed: string): string {
  const row = `${name} · ${elapsed}`;
  return state === 'working_late' ? `${row} · taking longer than usual` : row;
}
