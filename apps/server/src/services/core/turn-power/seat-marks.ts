/**
 * Carrying a session's marks to the fresh session that replaces it, for a room
 * seat moved to another account or restarted after its transcript expired.
 *
 * Marks are keyed by session id (`turn-levels.ts`), so a fresh id starts
 * unmarked. Marks only add up here: nothing is taken from either session.
 *
 * @module services/core/turn-power/seat-marks
 */
import { carryTurnLevel } from './turn-levels.js';

/**
 * Give `to` every mark `from` carries: its recorded level, merged stricter.
 *
 * @param from - The session being replaced.
 * @param to - The fresh session replacing it.
 */
export function carrySessionMarks(from: string, to: string): void {
  carryTurnLevel(from, to);
}
