/**
 * What a sidebar count pill is read out as.
 *
 * @module features/dashboard-sidebar/ui/rooms/directed-count-label
 */

/**
 * What a count pill counts. A direct message counts every new message, since
 * each one is addressed to you; anywhere else it counts the @mentions of you.
 */
export type DirectedCountKind = 'mentions' | 'messages';

/**
 * The words a screen reader hears for a count pill, with the real number in
 * them even where the pill draws `9+`.
 *
 * It joins the row's own name, so it never names the row again: the row reads
 * "#general 3 mentions", not "#general 3 mentions in #general".
 *
 * @param count - How many.
 * @param kind - What is being counted.
 */
export function directedCountLabel(count: number, kind: DirectedCountKind): string {
  if (kind === 'messages') return count === 1 ? '1 new message' : `${count} new messages`;
  return count === 1 ? '1 mention' : `${count} mentions`;
}
