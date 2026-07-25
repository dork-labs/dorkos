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
 * How much more width each step down the urgency order gives up.
 *
 * Steep on purpose. Flexbox shares a deficit in proportion to these factors, so a
 * shallow gradient still takes a slice out of the most urgent item, which is the
 * thing being fixed. At 8x per step the quietest item has given up essentially
 * everything before the next one is asked for a pixel, which is the behaviour the
 * budget's own ordering implies.
 */
const SHRINK_STEP = 8;

/**
 * The flex-shrink factor for one item, from its place in its cluster's urgency
 * order: `1` for the loudest, `SHRINK_STEP` for the next, and so on down.
 *
 * @param item - The item being drawn.
 * @param urgencyOrder - The cluster's item keys, most urgent first.
 * @internal
 */
function shrinkFactorFor(item: PromotedStatusItem, urgencyOrder: readonly string[]): number {
  return SHRINK_STEP ** Math.max(0, urgencyOrder.indexOf(item.key));
}

/**
 * One cluster of items. Separator placement is derived from position in the
 * *visible* list, so an item that hides and comes back can never reappear
 * carrying a leading separator.
 *
 * **Numbers keep their pixels; names give them up.** A wrapper is `min-w-0`, so a
 * squeezed cluster pushes the squeeze into the item where a `truncate` turns it
 * into an ellipsis — which is honest for a name (`Bypass permi…` is the same fact
 * in fewer letters) and a lie for a number (`8…` is not 88%). So an item the
 * registry marks {@link StatusBarItemConfig.rigid} is `shrink-0` instead: the row
 * cannot squeeze it, and the deficit lands on the items that can honestly absorb
 * it.
 *
 * **The least urgent item pays first.** Deciding who *may* shrink is only half the
 * question; the other half is who actually does, and flexbox's default answer is
 * "everyone at once, in proportion to their width". That inverted the whole
 * design at the last step: measured at the 438px compact floor, `connection` —
 * `Connection lost`, the loudest signal the line has at severity 100 — was cut to
 * 24px, a glyph and a sliver, while `subagents` at severity 35 kept every pixel
 * because it happened to be rigid. The budget picks by urgency and the layout
 * then took the pixels back from the most urgent thing on the row.
 *
 * So each non-rigid item is handed a shrink factor from its rank in the cluster's
 * own urgency order, {@link SHRINK_STEP}x per step down. The quietest item gives
 * up its width first and the loudest gives up last — and what the quietest item
 * gives up is always one tap away under the `⋯`. Severity is already on the item
 * as data, so nothing new has to be plumbed to know this.
 *
 * Either way the item must be able to give up whatever the row asks of it, all
 * the way down its own tree. One `display: block` wrapper without `min-w-0`
 * anywhere in that chain, or one `shrink-0` on a part that could have given way,
 * and a shrinkable item renders at full width inside a narrower box and paints
 * over its neighbour — that is DOR-461, in three items. And a rigid item that the
 * budget should have dropped overflows its *cluster* instead. Both are caught the
 * same way, by `apps/e2e/tests/chat/status-line-fit.spec.ts`, which measures
 * painted extents rather than the row's `scrollWidth` — an `overflow-hidden` row
 * can never report its own overflow.
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
  // Loudest first. Ties keep registry order — the sort is stable, and the line's
  // positions must not shuffle under the finger reaching for them.
  const urgencyOrder = [...items].sort((a, b) => b.severity - a.severity).map((i) => i.key);

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
            // A number, not a class: the factor is computed from this cluster's
            // urgency order, and Tailwind cannot see a class name it did not read
            // in the source.
            style={item.rigid ? undefined : { flexShrink: shrinkFactorFor(item, urgencyOrder) }}
            className={cn(
              'inline-flex items-center gap-2',
              // `min-w-9`, not `min-w-0`: the separator and the glyph inside the
              // wrapper are `shrink-0`, so an item squeezed below them renders
              // ~23px of content in a 0px box and paints into its neighbour — the
              // very defect this file exists to prevent, reintroduced from the
              // other end. The floor is the width of what cannot shrink anyway.
              item.rigid ? 'shrink-0' : 'min-w-9',
              TAP_TARGET
            )}
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
