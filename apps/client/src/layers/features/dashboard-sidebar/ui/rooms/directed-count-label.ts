/**
 * What a sidebar count pill is read out as.
 *
 * @module features/dashboard-sidebar/ui/rooms/directed-count-label
 */
import { COUNT_PILL_CAP } from '@/layers/shared/ui';

/**
 * What a count pill counts. A direct message counts every new message, since
 * each one is addressed to you; anywhere else it counts the @mentions of you.
 */
export type DirectedCountKind = 'mentions' | 'messages';

/**
 * The words a screen reader hears for a count pill.
 *
 * Up to nine it is the number; past it, "More than 9", which is what the pill's
 * `9+` says. The server stops counting mentions at ten, so a bigger number
 * here would be a claim nobody measured.
 *
 * It joins the row's own name, so it never names the row again: the row reads
 * "#general 3 mentions", not "#general 3 mentions in #general".
 *
 * @param count - How many.
 * @param kind - What is being counted.
 */
export function directedCountLabel(count: number, kind: DirectedCountKind): string {
  const amount = count > COUNT_PILL_CAP ? `More than ${COUNT_PILL_CAP}` : String(count);
  if (kind === 'messages') return count === 1 ? '1 new message' : `${amount} new messages`;
  return count === 1 ? '1 mention' : `${amount} mentions`;
}
