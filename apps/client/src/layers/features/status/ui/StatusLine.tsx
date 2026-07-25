import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import type { PromotedStatusItem } from '../model/promoted-items';

const ITEM_TRANSITION = { duration: 0.2, ease: [0.4, 0, 0.2, 1] } as const;

/**
 * Grow every tappable thing in an item to a 44px-tall hit area on touch (Apple
 * HIG; WCAG 2.5.8 asks 24px). Padding on the control itself, not an overlay on the
 * wrapper — an absolutely-positioned strip would sit *above* the button it was
 * meant to enlarge and swallow the tap instead of passing it on.
 *
 * Vertical only, deliberately. Four 44px-wide targets plus the `⋯` do not fit
 * across a 320px phone, and widening them would push content out of the very
 * budget that decides what the line may hold. Horizontal separation comes from the
 * row's 8px gaps; most items are already 44px wide once their value is rendered.
 *
 * @internal
 */
const TAP_TARGET = 'pointer-coarse:[&_button]:py-3';

interface StatusLineProps {
  /**
   * The items to show, already promoted, budgeted, and in order. Visibility is
   * decided upstream by `selectPromotedItems` and `applyStatusBudget`, so this
   * component never asks whether an item belongs — it draws what it is given.
   */
  items: readonly PromotedStatusItem[];
  /**
   * The fixed trailing anchor — the Session `⋯`. Rendered outside the clipped
   * region and outside the budget, so it is always reachable, always last, and
   * never dropped.
   */
  trailing?: ReactNode;
}

/**
 * The composer status line — one row, two clusters, never scrolled and never
 * wrapped.
 *
 * Left is who and where; right is state and numbers. A single flexible gap
 * separates them, and separators only ever sit *between* items inside a cluster,
 * so no middot is ever left floating in the gap.
 *
 * **Both clusters can shrink**, and that is load-bearing. The width budget
 * upstream keeps the line legible, but a budget is a prediction; a right cluster
 * that could not shrink turned every mis-predicted pixel into silently clipped,
 * unreachable content — worse than the scroller this replaced, because at least
 * the old fade advertised that something was there. Now the row's total can
 * always be made to fit, and anything the prediction got wrong degrades into an
 * ellipsis: a cosmetic regression instead of invisible data.
 *
 * The one thing that never gives up a pixel is the trailing `⋯`. It is
 * `shrink-0` and sits outside both clusters, so every dropped item stays one tap
 * away at any width.
 *
 * @param props - The budgeted items and the trailing anchor.
 */
export function StatusLine({ items, trailing }: StatusLineProps) {
  const left = items.filter((item) => item.cluster === 'left');
  const right = items.filter((item) => item.cluster === 'right');

  return (
    <div
      role="toolbar"
      aria-label="Session status"
      aria-live="polite"
      data-testid="status-line"
      className="text-muted-foreground flex items-center gap-2 overflow-hidden px-1 text-xs whitespace-nowrap pointer-coarse:min-h-11"
    >
      {/* `flex-auto`, not `flex-1`: both grow into the slack, but a `flex-1`
          basis of 0 collapses the left cluster to zero width the moment the row
          overflows, hiding the agent instead of truncating its name. */}
      <StatusCluster items={left} className="min-w-0 flex-auto" />
      <StatusCluster items={right} className="min-w-0 shrink" />
      {/* The anchor's `shrink-0` lives here, not in whatever is passed in: "the `⋯`
          is never dropped" is the line's invariant to keep, not the caller's. */}
      {trailing !== undefined && <span className="flex shrink-0 items-center">{trailing}</span>}
    </div>
  );
}

/**
 * One cluster of items. Separator placement is derived from position in the
 * *visible* list, so an item that hides and comes back can never reappear
 * carrying a leading separator.
 *
 * @internal
 */
function StatusCluster({
  items,
  className,
}: {
  items: readonly PromotedStatusItem[];
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <AnimatePresence initial={false} mode="popLayout">
        {items.map((item, index) => (
          <motion.div
            key={item.key}
            data-testid={`status-item-${item.key}`}
            layout="position"
            initial={{ opacity: 0, scale: 0.8, filter: 'blur(4px)' }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 0.8, filter: 'blur(4px)' }}
            transition={ITEM_TRANSITION}
            className={cn('inline-flex min-w-0 items-center gap-2', TAP_TARGET)}
          >
            {index > 0 && <StatusLineSeparator />}
            {item.node}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * Middot separator between status items.
 *
 * @internal
 */
function StatusLineSeparator() {
  return (
    <span className="text-muted-foreground/30 shrink-0" aria-hidden="true">
      &middot;
    </span>
  );
}
