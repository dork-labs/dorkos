/**
 * Whether a room read handed an agent a line from outside the owner's circle, which marks the
 * reading turn (DOR-3291).
 *
 * @module server/services/rooms/room-read-outsider
 */
import type { CapabilityDeps } from '../core/capabilities/index.js';
import { entryHeldToDefault, entryMarksOf } from '../core/turn-power/turn-levels.js';
import { isEntryAuthorExternal } from './limits/turn-ceiling.js';

/** A projected message as a read result carries it, with its room when the result spans rooms. */
interface ReadMessage {
  entryId?: unknown;
  authorId?: unknown;
  kind?: unknown;
  roomId?: unknown;
}

/**
 * Whether a room read's result shows a line from outside the owner's circle, by the rule a room
 * turn's view is read with (`outsiderInViewOf`): a stranger's line, a post held to the runtime's
 * default (a Wi-Fi sign-in's), or a post kept with the outsider mark (our own agent's, written in
 * a turn that read outside words, or a person's a mini app sent). The owner, the team's agents and
 * the room's own notices mark nothing.
 *
 * @param input - The read's input, for the room a single-room result is from (a cross-room
 *   search names each match's room instead).
 * @param output - The read's result: `entries`, `matches`, or the `newMessages` a held post hands
 *   back, each a projected message.
 * @param deps - The registry's service bag, for the author registry.
 */
export function roomReadShowsOutsider(
  input: unknown,
  output: unknown,
  deps: CapabilityDeps
): boolean {
  const rooms = deps.roomDeps?.rooms;
  if (!rooms || output === null || typeof output !== 'object') return false;
  const result = output as { entries?: unknown; matches?: unknown; newMessages?: unknown };
  const asked = (input ?? {}) as { roomId?: unknown };
  const inputRoom = typeof asked.roomId === 'string' ? asked.roomId : undefined;
  const shown = [result.entries, result.matches, result.newMessages].flatMap((list) =>
    Array.isArray(list) ? (list as ReadMessage[]) : []
  );
  return shown.some((message) => {
    if (typeof message.entryId !== 'string' || typeof message.authorId !== 'string') return false;
    // The room's own notices are DorkOS's voice.
    if (message.kind === 'notice') return false;
    const roomId = typeof message.roomId === 'string' ? message.roomId : inputRoom;
    if (isEntryAuthorExternal(rooms.authorRegistry, message.authorId)) return true;
    if (entryHeldToDefault(message.entryId, roomId)) return true;
    return entryMarksOf(message.entryId, roomId)?.outsider === true;
  });
}
