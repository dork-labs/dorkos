/**
 * The one numbered pill: how many things are waiting, and for whom.
 *
 * It lives here, not in the app, so the DorkOS client and the Space pages draw
 * the same count. The mention cap, which needs the server's schemas, stays in
 * the client's re-export (`MENTION_COUNT_CAP`) and arrives here as `cap`.
 *
 * @module count-pill
 */
import type { ComponentProps } from 'react';
import { cn } from './cn.js';

/** The largest number an inline pill spells out. Anything above reads `99+`. */
export const COUNT_PILL_CAP = 99;

/** The largest number a corner pill spells out: it sits on a 28px control. */
export const CORNER_COUNT_CAP = 9;

/**
 * What a pill draws for a count: the number itself up to `cap`, `{cap}+` past it.
 *
 * @param count - How many there are.
 * @param cap - The largest number spelled out. Defaults to {@link COUNT_PILL_CAP}.
 */
export function formatPillCount(count: number, cap: number = COUNT_PILL_CAP): string {
  return count > cap ? `${cap}+` : String(count);
}

/**
 * Who a count is for.
 *
 * - `you`: somebody wrote to you, a mention or a direct message. Orange, the
 *   brand's one meaning.
 * - `warning`: something stopped and is waiting on a person. Amber.
 * - `error`: something failed. Red.
 * - `neutral`: activity you asked to see.
 */
export type CountTone = 'you' | 'warning' | 'error' | 'neutral';

/** Where the pill sits: in the row's flow, or over a control's corner. */
export type CountPlacement = 'inline' | 'corner';

const WASH: Record<CountTone, string> = {
  you: 'bg-brand/15 text-brand-text',
  warning: 'bg-status-warning-bg text-status-warning-fg',
  error: 'bg-status-error-bg text-status-error-fg',
  neutral: 'bg-foreground/10 text-foreground',
};

/**
 * The opaque fill, for a pill over a glyph or on a ground the wash cannot
 * clear (the `you` wash is 4.04:1 on a dark modal row; solid is 7.90).
 */
const SOLID: Record<CountTone, string> = {
  you: 'bg-brand-text text-background',
  warning: 'bg-status-warning-fg text-background',
  error: 'bg-status-error-fg text-background',
  neutral: 'bg-foreground text-background',
};

const PLACEMENT: Record<CountPlacement, string> = {
  // 11/16 at 18px, 13/18 at 22px on a phone.
  inline: 'text-2xs h-4.5 min-w-4.5 px-1.5 max-md:h-5.5 max-md:min-w-5.5 max-md:leading-4.5',
  // 10/14 at 16px, 12/16 at 20px on a phone. Out of flow, so it never widens
  // the control it rides; the parent is `relative`.
  corner:
    'text-3xs pointer-events-none absolute -top-1 -right-1 h-4 min-w-4 px-1 leading-3.5 max-md:h-5 max-md:min-w-5 max-md:leading-4',
};

/** Props for {@link CountPill}. */
export interface CountPillProps extends Omit<ComponentProps<'span'>, 'children'> {
  /** How many there are. `0` or less draws nothing. */
  count: number;
  /**
   * What a screen reader hears in place of the drawn number: "3 mentions", or
   * "More than 9 mentions" past the cap. It joins the row's own name, so it
   * never names the row again. Omit it when the parent's own name already says
   * the number, and the pill is hidden from assistive tech.
   */
  label?: string;
  /** Who the count is for. Defaults to `you`. */
  tone?: CountTone;
  /** In the row's flow, or over a control's corner. Defaults to `inline`. */
  placement?: CountPlacement;
  /** The opaque fill. A corner pill is always solid. */
  solid?: boolean;
  /**
   * The largest number spelled out. Defaults to {@link COUNT_PILL_CAP} inline
   * and {@link CORNER_COUNT_CAP} in a corner. Mentions pass the client's
   * `MENTION_COUNT_CAP`.
   */
  cap?: number;
}

/**
 * A count: mentions, a direct message's new messages, things waiting on you.
 *
 * **The tone says who it is for, and orange means you.** Bold already says
 * "something happened here"; a `you` count says "and this much of it was for
 * you". A busy row nobody aimed at you stays bold with no number.
 *
 * **It never moves.** Tabular figures keep the width steady as the number
 * changes, and the number itself is the news, so there is no flip, no
 * crossfade and no pulse.
 */
export function CountPill({
  count,
  label,
  tone = 'you',
  placement = 'inline',
  solid = false,
  cap,
  className,
  ...props
}: CountPillProps) {
  if (count <= 0) return null;
  const limit = cap ?? (placement === 'corner' ? CORNER_COUNT_CAP : COUNT_PILL_CAP);

  return (
    <span
      data-slot="count-pill"
      data-tone={tone}
      data-placement={placement}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full text-center leading-4 font-semibold tabular-nums',
        PLACEMENT[placement],
        solid || placement === 'corner' ? SOLID[tone] : WASH[tone],
        className
      )}
      {...props}
    >
      {formatPillCount(count, limit)}
    </span>
  );
}
