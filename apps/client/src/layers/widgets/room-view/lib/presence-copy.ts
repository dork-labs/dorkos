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
 * The taking-longer wording is the single-agent case only. With two or three
 * names the sentence is about the group, and the elapsed time beside it — the
 * oldest of them — already says how long the wait has been; spelling out which
 * one of them is late would be a sentence nobody could act on.
 *
 * @param names - The agents to name, oldest claim first.
 * @param state - Where the named agent is in its work. Read only when there is
 *   exactly one name.
 */
export function presenceSentence(
  names: readonly string[],
  state: 'working' | 'working_late'
): string {
  if (names.length === 1) {
    return state === 'working_late'
      ? `${names[0]} is still working — this is taking longer than usual`
      : `${names[0]} is working on it`;
  }
  return `${readAsList(names)} are working on it`;
}
