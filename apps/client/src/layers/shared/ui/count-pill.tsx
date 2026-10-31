/**
 * The small numbered pill a row wears when something was aimed at you.
 *
 * @module shared/ui/count-pill
 */
import type { ComponentProps } from 'react';
import { cn } from '@/layers/shared/lib/utils';

/** The largest number a pill spells out. Anything above reads `9+`. */
export const COUNT_PILL_CAP = 9;

/**
 * What a pill draws for a count: the number itself up to
 * {@link COUNT_PILL_CAP}, and `9+` past it.
 *
 * @param count - How many there are.
 */
export function formatPillCount(count: number): string {
  return count > COUNT_PILL_CAP ? `${COUNT_PILL_CAP}+` : String(count);
}

/** Props for {@link CountPill}. */
export interface CountPillProps extends Omit<ComponentProps<'span'>, 'children'> {
  /** How many there are. Drawn capped at `9+`. */
  count: number;
  /**
   * What a screen reader hears in place of the drawn number — "3 mentions", or
   * "More than 9 mentions" past the cap. It joins the row's own name, so it
   * never names the row again.
   */
  label: string;
}

/**
 * A count of things addressed to you: mentions, or a direct message's new
 * messages.
 *
 * **Orange, because orange means you.** Bold already says "something happened
 * here"; this says "and this much of it was for you". A busy row nobody aimed at
 * you stays bold with no number, so the orange only ever marks your own.
 *
 * Capped at `9+` so the pill never grows wider than two characters and a busy
 * row's name is never squeezed by its own count.
 */
export function CountPill({ count, label, className, ...props }: CountPillProps) {
  return (
    <span
      data-slot="count-pill"
      aria-label={label}
      className={cn(
        'bg-brand/15 text-brand-text text-3xs min-w-4 shrink-0 rounded-full px-1.5 py-0.5 text-center font-medium tabular-nums',
        className
      )}
      {...props}
    >
      {formatPillCount(count)}
    </span>
  );
}
