/**
 * How long a room has been waiting, in words.
 *
 * Lives on the entity rather than beside the composer's presence line, because
 * two surfaces now print it — the line under the composer and each member's row
 * in the room sheet — and a room that says `4m` in one place and `4m 12s` in the
 * other is telling a person two different things about one turn.
 *
 * @module entities/room/lib/presence-copy
 */

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
