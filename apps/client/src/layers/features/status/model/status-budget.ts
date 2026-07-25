/**
 * The measured width budget for the status line — how much the bar may say at the
 * width it actually has.
 *
 * The line never scrolls and never wraps, so something has to give when a
 * degraded session promotes more than fits. And every promotion rule fires under
 * stress, which is exactly when the person is on their phone trying to find out
 * what broke. So: fill the right cluster by urgency until the budget runs out and
 * report the remainder as a count on the `⋯`. Nothing is lost — it is one tap
 * away, and the count is the honesty.
 *
 * Width comes from a `ResizeObserver` on the bar itself, never from a viewport
 * breakpoint. A 767px tablet and a 320px phone are the same boolean, and no
 * breakpoint can see browser zoom, Dynamic Type, or the sidebar opening.
 *
 * ## Why the budget counts slots instead of adding up pixels
 *
 * A count assumes the things counted are about the same size, and that
 * assumption is the one this module has to buy. It buys it in
 * `features/status/lib/status-labels`: every value a right-cluster item renders
 * is bounded to `STATUS_VALUE_MAX_CHARS`, and every item drops its verbose parts
 * below the `full` tier. Without that, one item can eat the whole bar — a
 * `"Default (recommended)"` beside a `"78%"` is a 5× spread, and a count budget
 * cannot see it (DOR-452).
 *
 * Charging real pixels instead would mean either measuring each item — which
 * needs a second, hidden render of every item to have a width to measure, with
 * duplicated tooltips, popovers, and `role="status"` nodes — or charging a
 * per-item estimate, which is a hardcoded guess wearing a budget's clothes. The
 * text is 1.25× larger below 768px and scales again with `--user-font-scale`, so
 * any px estimate is wrong at exactly the widths that matter.
 *
 * So the counts stay, and the honesty comes from two places instead: bounded
 * values keep the slots comparable, and the line itself can shrink — anything
 * the count still gets wrong ends as an ellipsis, never as clipped, unreachable
 * content. See {@link module:features/status/ui/StatusLine}.
 *
 * @module features/status/model/status-budget
 */
import { STATUS_VALUE_MAX_CHARS } from '@dorkos/shared/constants';
import type { PromotedStatusItem } from './promoted-items';
import type { StatusBarItemKey } from './status-bar-registry';

/**
 * How much the line may say at the width it has.
 *
 * - `full` — every promoted item, full labels, the inline Compact action included.
 * - `compact` — glyph and value only; the directory drops off the left cluster.
 * - `identity` — who you are talking to, and the two or three loudest signals.
 * - `avatar` — the agent's avatar alone, its name carried by assistive text.
 */
export type StatusDensity = 'full' | 'compact' | 'identity' | 'avatar';

/** What one measured width affords. */
export interface StatusBudget {
  /** How much each item may say. */
  density: StatusDensity;
  /** How many right-cluster items may render. */
  rightBudget: number;
  /** Left-cluster keys this width cannot afford. */
  dropped: readonly StatusBarItemKey[];
}

/** The result of fitting the promoted set into a budget. */
export interface BudgetedStatusLine {
  /** What the line draws, in registry order. */
  items: PromotedStatusItem[];
  /** How many promoted right-cluster items the width could not afford. */
  overflow: number;
}

/**
 * Tier floors in CSS pixels of measured bar width, per spec
 * composer-status-redesign §6.1. A realistic degraded state needs ~568px of bar,
 * and a 375px phone offers ~343px — hence four tiers rather than one breakpoint.
 */
const TIER_FULL_MIN_PX = 640;
const TIER_COMPACT_MIN_PX = 440;
const TIER_IDENTITY_MIN_PX = 340;

/** Right-cluster slots at each tier. Three at `identity`: two problems plus one item of context. */
const BUDGET_COMPACT = 4;
const BUDGET_IDENTITY = 3;
const BUDGET_AVATAR = 2;

/**
 * The `full` tier's floor — the spec's "4+", which grows with the width above it.
 *
 * This was briefly cut to three while fixing DOR-461, on the argument that the
 * floor could not afford a fourth full-label item. Measurement says otherwise, and
 * says something worse: the cut was hiding a broken item rather than paying for a
 * real one. `UsageStatusItem` could neither shrink nor be shrunk, and three slots
 * kept it under the `⋯` in the fixtures being measured; at four it came back into
 * the visible set and painted over its neighbour. With that item fixed, four is
 * overlap-free at every tier floor, so the reduction bought nothing it claimed to.
 *
 * Nor did it buy legibility. Measured on the crowded 640px row, four slots leave
 * five values truncated and three slots leave five values truncated — the same
 * five, 1.1x to 1.4x wider each (permission 41 → 58, connection 51 → 72, git
 * 168 → 183). The pressure at that floor comes from the LEFT cluster
 * (identity + directory + a 20-character branch is ~320px of a 630px content
 * box), which no right-cluster count can relieve. Whole readings at the `full`
 * floor are a density question, not a budget one.
 */
const BUDGET_FULL_BASE = 4;

/**
 * Measured advance width of one bounded status character in the composer's
 * `text-xs`, in Chromium at the desktop text scale.
 */
const VALUE_CHAR_PX = 8;

/** The item's 12px glyph, its 8px gap, and the middot separator with its own gaps. */
const SLOT_CHROME_PX = 20;

/**
 * Measured cost of one more full-label right-cluster item — the glyph, its gap,
 * the widest value the bound allows, and the separator. This is what turns the
 * spec's "4+" into a real number instead of a guess.
 *
 * Derived from `STATUS_VALUE_MAX_CHARS` rather than written as a literal: the
 * budget's whole claim is that a bounded value fits the slot it is charged for, so
 * raising the character bound has to raise the price of a slot in the same edit.
 */
const FULL_SLOT_COST_PX = STATUS_VALUE_MAX_CHARS * VALUE_CHAR_PX + SLOT_CHROME_PX;

/** No cap — the line has not been measured yet, so draw everything and clamp on the first observation. */
const UNMEASURED_BUDGET = Number.POSITIVE_INFINITY;

/** Left-cluster keys each tier gives up, cheapest information first. */
const DROPPED_NONE: readonly StatusBarItemKey[] = [];
const DROPPED_CWD: readonly StatusBarItemKey[] = ['cwd'];
const DROPPED_CWD_AND_GIT: readonly StatusBarItemKey[] = ['cwd', 'git'];

/**
 * Resolve what a measured bar width affords.
 *
 * An unmeasured width (`null`, or the `0` a detached or not-yet-laid-out element
 * reports) is treated as "not known yet", not as a 0px screen: the line draws
 * everything for that first frame and the `ResizeObserver` clamps it before paint.
 * Guessing narrow instead would flash a two-item bar on every desktop mount.
 *
 * @param width - Measured inline size of the bar container in CSS pixels.
 */
export function resolveStatusBudget(width: number | null): StatusBudget {
  if (width === null || width <= 0) {
    return { density: 'full', rightBudget: UNMEASURED_BUDGET, dropped: DROPPED_NONE };
  }
  if (width >= TIER_FULL_MIN_PX) {
    const extra = Math.floor((width - TIER_FULL_MIN_PX) / FULL_SLOT_COST_PX);
    return { density: 'full', rightBudget: BUDGET_FULL_BASE + extra, dropped: DROPPED_NONE };
  }
  if (width >= TIER_COMPACT_MIN_PX) {
    return { density: 'compact', rightBudget: BUDGET_COMPACT, dropped: DROPPED_CWD };
  }
  if (width >= TIER_IDENTITY_MIN_PX) {
    return { density: 'identity', rightBudget: BUDGET_IDENTITY, dropped: DROPPED_CWD_AND_GIT };
  }
  return { density: 'avatar', rightBudget: BUDGET_AVATAR, dropped: DROPPED_CWD_AND_GIT };
}

/**
 * Rank two promoted items for a contested slot: urgency first, then the pin.
 *
 * A pin raises priority without buying immunity — an item that is in the line
 * only because someone pinned it ranks quiet, so it loses its slot to anything
 * that is actually news. A pin says "show me", not "shout at me".
 *
 * @internal
 */
function byUrgency(a: PromotedStatusItem, b: PromotedStatusItem): number {
  if (b.severity !== a.severity) return b.severity - a.severity;
  return Number(b.pinned) - Number(a.pinned);
}

/**
 * Fit the promoted set into a measured budget.
 *
 * Slots are won by urgency but rendered in registry order: what survives is what
 * is most likely to be a real problem, while positions stay put as numbers cross
 * their thresholds — nothing shuffles under the finger that is reaching for it.
 *
 * The left cluster is trimmed by density rather than by count, and those drops are
 * deliberately **not** counted in `overflow`. Saying less about where you are is
 * not the same as withholding news, and a permanent `+1` beside the `⋯` on every
 * tablet would be exactly the wallpaper this redesign removes.
 *
 * @param items - Everything that promoted, in registry order.
 * @param budget - What the measured width affords.
 */
export function applyStatusBudget(
  items: readonly PromotedStatusItem[],
  budget: StatusBudget
): BudgetedStatusLine {
  const dropped = new Set<StatusBarItemKey>(budget.dropped);
  const right = items.filter((item) => item.cluster === 'right');
  const kept = new Set(
    [...right]
      .sort(byUrgency)
      .slice(0, budget.rightBudget)
      .map((item) => item.key)
  );

  return {
    items: items.filter((item) =>
      item.cluster === 'right' ? kept.has(item.key) : !dropped.has(item.key)
    ),
    overflow: right.length - kept.size,
  };
}
