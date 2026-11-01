/**
 * What a sidebar count pill is read out as, and where it caps.
 *
 * @module features/dashboard-sidebar/ui/rooms/directed-count-label
 */
import { COUNT_PILL_CAP, MENTION_COUNT_CAP } from '@/layers/shared/ui';

/**
 * What a count pill counts. A direct message counts every new message, since
 * each one is addressed to you; anywhere else it counts the @mentions of you.
 */
export type DirectedCountKind = 'mentions' | 'messages';

/**
 * The largest number a pill spells out for a kind. Mentions cap at 9 because
 * the server stops counting them at ten, so a bigger number would be a claim
 * nobody measured; messages are counted in full and cap at 99.
 *
 * @param kind - What is being counted.
 */
export function directedCountCap(kind: DirectedCountKind): number {
  return kind === 'mentions' ? MENTION_COUNT_CAP : COUNT_PILL_CAP;
}

/**
 * The words a screen reader hears for a count pill.
 *
 * Up to the cap it is the number; past it, "More than 9" (mentions) or "More
 * than 99" (messages), which is what the pill's `9+` or `99+` says.
 *
 * It joins the row's own name, so it never names the row again: the row reads
 * "#general 3 mentions", not "#general 3 mentions in #general".
 *
 * @param count - How many.
 * @param kind - What is being counted.
 */
export function directedCountLabel(count: number, kind: DirectedCountKind): string {
  const cap = directedCountCap(kind);
  const amount = count > cap ? `More than ${cap}` : String(count);
  if (kind === 'messages') return count === 1 ? '1 new message' : `${amount} new messages`;
  return count === 1 ? '1 mention' : `${amount} mentions`;
}
