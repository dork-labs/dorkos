/**
 * Carrying a session's marks to the fresh session that replaces it, for a room
 * seat moved to another account or restarted after its transcript expired.
 *
 * Marks are keyed by session id (`turn-levels.ts`, `outsider-turns.ts`), so a
 * fresh id starts unmarked. The summary a moved seat starts from holds the old
 * chat's words, strangers' included, so it must start with every mark the old
 * one carried, before its first turn. Marks only add up here: nothing is taken
 * from either session.
 *
 * What is read per ROOM rather than per session (a bridged room, an outside
 * author's post, a post held to the runtime's default) needs no carrying: the
 * new session sits in the same seat, and `chat-launch-marks.ts` reads the room.
 *
 * @module services/core/turn-power/seat-marks
 */
import { carryTurnLevel } from './turn-levels.js';
import { chatHeardOutsider, noteChatHeardOutsider } from '../../session/origin/outsider-turns.js';

/**
 * Give `to` every mark `from` carries: its recorded level (outsider and
 * teammate marks, merged stricter) and whether a stranger's words reached it.
 *
 * @param from - The session being replaced.
 * @param to - The fresh session replacing it.
 */
export function carrySessionMarks(from: string, to: string): void {
  carryTurnLevel(from, to);
  if (chatHeardOutsider(from)) noteChatHeardOutsider(to);
}
