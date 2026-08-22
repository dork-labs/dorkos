/**
 * The continuity layer's numbers, in one place (spec `sidebar-simplification`
 * D5).
 *
 * **Motion here explains a state change the operator did not cause.** A section
 * folding, a row arriving in Today, a list reordering after the hold releases, a
 * row lifting under a drag — each of those moves something the eye was already
 * tracking, and the movement is what keeps it tracked. Nothing here decorates,
 * nothing loops, and every duration is ≤200 ms except the fold spring.
 *
 * **Separated from the components for the same reason `sidebar-reveal.ts` is:**
 * the promise "reduced motion is instant" has to be assertable as a VALUE. jsdom
 * runs no animation and reports no geometry, so a test that rendered a folded
 * section and found its rows gone would pass whether the transition lasted 0 ms
 * or 2 s.
 *
 * @module features/dashboard-sidebar/ui/motion/sidebar-motion
 */
import type { Transition } from 'motion/react';
import type { SidebarRowMotion } from '@/layers/shared/ui';

/** The fold spring's stiffness — D5's number, which lands it in ≈180 ms. */
export const FOLD_STIFFNESS = 400;

/** The fold spring's damping. High enough that a section never overshoots. */
export const FOLD_DAMPING = 36;

/** How long a row takes to arrive, in seconds. */
export const ARRIVE_SECONDS = 0.16;

/** How far above its place a row starts, in pixels. It falls from its header. */
export const ARRIVE_RISE_PX = 6;

/** How long a row that is leaving takes to fade out, in seconds. */
export const LEAVE_SECONDS = 0.12;

/**
 * How long the one-shot arrival tint burns, in milliseconds.
 *
 * The tint is CSS (`animate-sidebar-row-arrived`, gated `motion-safe:`) and this
 * is how long the attribute that triggers it stays on the row. The two are the
 * same 200 ms on purpose: the attribute going away is what makes the tint a
 * one-shot rather than a state a row can sit in.
 */
export const ARRIVED_TINT_MS = 200;

/** How much the drag overlay lifts off the panel. */
export const DRAG_LIFT_SCALE = 1.02;

/**
 * How long the lift takes, in seconds.
 *
 * Short even by this file's standards: the lift is the answer to "did the drag
 * start?", and an answer that takes longer than a tenth of a second reads as
 * lag rather than as feedback.
 */
export const DRAG_LIFT_SECONDS = 0.1;

/** Where a row starts when it arrives after boot. */
export const ARRIVE_FROM = { opacity: 0, y: -ARRIVE_RISE_PX } as const;

/** Where an arriving row lands — and where a row that was already there sits. */
export const ARRIVE_TO = { opacity: 1, y: 0 } as const;

/**
 * How a row leaves.
 *
 * Opacity only: a row on its way out has already stopped being a place the
 * operator can aim at, and sliding it would move every row under it twice — once
 * for the exit and again for the `layout` collapse.
 */
export const LEAVE_TO = { opacity: 0 } as const;

/**
 * How a section's body opens and closes for this reader.
 *
 * A spring rather than a duration because a fold is a physical act — the header
 * was pressed and the body follows the press — and instant under a reduced-motion
 * preference, which means no animation rather than a shorter one. `null` is
 * `useReducedMotion`'s "not asked yet", which is not a preference.
 *
 * @param reducedMotion - What `useReducedMotion()` answered.
 */
export function foldTransition(reducedMotion: boolean | null): Transition {
  if (reducedMotion === true) return { duration: 0 };
  return { type: 'spring', stiffness: FOLD_STIFFNESS, damping: FOLD_DAMPING };
}

/**
 * How long a row's arrival takes for this reader.
 *
 * @param reducedMotion - What `useReducedMotion()` answered.
 */
export function arriveTransition(reducedMotion: boolean | null): Transition {
  return { duration: reducedMotion === true ? 0 : ARRIVE_SECONDS };
}

/**
 * How long a row's departure takes for this reader.
 *
 * @param reducedMotion - What `useReducedMotion()` answered.
 */
export function leaveTransition(reducedMotion: boolean | null): Transition {
  return { duration: reducedMotion === true ? 0 : LEAVE_SECONDS };
}

/**
 * What joins one row id to the next in a layout key.
 *
 * A NUL rather than a comma or a space, because a row key is built from titles
 * and paths and may contain either — and a separator a key can contain is a
 * separator that eventually splits one row into two.
 */
export const LAYOUT_KEY_SEPARATOR = '\u0000';

/**
 * What a section's rows measure their FLIP against — its row ids, in order.
 *
 * **Per section, and never per panel** (D5). `layoutDependency` is what tells
 * motion when to re-measure, and handing every row in the sidebar one whole-panel
 * key would make a channel arriving in Today re-measure thirty agent rows that
 * did not move. Scoped to the section, a list only re-measures when its OWN
 * membership or order changed.
 *
 * It is deliberately a string of row keys and nothing else: a rebuild that
 * changes what a row SAYS — the 60 s clock tick refreshing every "2 minutes ago"
 * — leaves this identical, so the rows do not re-animate for a change the
 * operator cannot see as movement.
 *
 * @param rows - The section's rows, in the order they will be drawn.
 */
export function sectionLayoutKey(rows: readonly { key: string }[]): string {
  return rows.map((row) => row.key).join(LAYOUT_KEY_SEPARATOR);
}

/** Everything {@link buildRowMotion} needs, and every bit of it a primitive. */
export interface RowMotionInputs {
  /** The section's row ids, from {@link sectionLayoutKey}. */
  layoutKey: string | undefined;
  /** The section announces arrivals — Heads up and Today, and nothing else. */
  arrives: boolean;
  /** This row is one of them, so it enters and tints once. */
  arrived: boolean;
  /** What `useReducedMotion()` answered. */
  reducedMotion: boolean | null;
}

/**
 * One row's motion, from four primitives.
 *
 * **A function rather than three inline object literals**, because the object it
 * returns is a prop of a `React.memo` row: the caller memoizes it on exactly
 * these four values, and a second copy of the shape that drifted would be a
 * fresh object on a render nothing changed — which defeats the memo for every
 * room in the panel (`RoomRow.render-count.test.tsx` is what catches it). The
 * Dev Playground's demos call this too, so what the page shows is what the panel
 * does.
 *
 * @param inputs - The four facts about this row's motion.
 */
export function buildRowMotion({
  layoutKey,
  arrives,
  arrived,
  reducedMotion,
}: RowMotionInputs): SidebarRowMotion {
  return {
    layout: true,
    layoutDependency: layoutKey,
    // A row that was already there has no entrance. `false` is motion's "start
    // where you are", and it is what every row wears on the frame the panel
    // first paints — warm boot and cold reveal alike.
    initial: arrives && arrived ? ARRIVE_FROM : false,
    animate: arrives ? ARRIVE_TO : undefined,
    exit: arrives ? LEAVE_TO : undefined,
    transition: arrived ? arriveTransition(reducedMotion) : leaveTransition(reducedMotion),
    arrived,
  };
}
