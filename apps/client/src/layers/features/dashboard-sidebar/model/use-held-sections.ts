/**
 * Hold rows in their sections while the person is in the panel, and let the
 * moves land when they leave (`rules/hold-section-moves.ts`).
 *
 * @module features/dashboard-sidebar/model/use-held-sections
 */
import { useCallback, useMemo, useState, type FocusEvent } from 'react';
import type { SidebarSectionModel } from './build-sidebar-model';
import { holdSectionMoves, membershipOf, type SectionMembership } from './rules/hold-section-moves';

/** Spread onto the element the hold is about — the panel's list. */
export interface InsideHandlers {
  /** The pointer crossed into the panel. */
  onPointerEnter: () => void;
  /** …and back out of it. */
  onPointerLeave: () => void;
  /** Something inside took focus. */
  onFocus: () => void;
  /** Focus moved; only leaving the panel counts. */
  onBlur: (event: FocusEvent<HTMLElement>) => void;
}

/**
 * Whether the person is in an element, by pointer or by keyboard focus.
 *
 * Pointer and focus both, because a keyboard has no pointer and the promise is
 * about neither device: it is about not moving what somebody is aiming at. On
 * touch the browser fires `pointerleave` once the finger lifts, so a phone has
 * no hold that never lets go.
 */
export function useInside(): { inside: boolean; handlers: InsideHandlers } {
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  const onPointerEnter = useCallback(() => setPointer(true), []);
  const onPointerLeave = useCallback(() => setPointer(false), []);
  const onFocus = useCallback(() => setFocus(true), []);
  // React's blur bubbles, so this fires for every row focus leaves — including
  // moving from one row to the next. Only focus that lands outside the panel
  // (or nowhere) ends the hold.
  const onBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next === null || !event.currentTarget.contains(next)) setFocus(false);
  }, []);
  return {
    inside: pointer || focus,
    handlers: { onPointerEnter, onPointerLeave, onFocus, onBlur },
  };
}

/**
 * The sections to draw: `live`, with section moves held while `inside`.
 *
 * **Only moves the rules make are held.** The snapshot is retaken whenever
 * `resetKey` changes — the stored sidebar prefs — so a move the person made
 * themselves (a drag, "Move to section", a pin) lands at once even with the
 * pointer right there. What is held is an agent drifting between "Active now"
 * and Direct messages on its own.
 *
 * @param live - This frame's sections.
 * @param inside - Whether the person is in the panel.
 * @param resetKey - Changes whenever the person changed the sidebar themselves.
 */
export function useHeldSections(
  live: readonly SidebarSectionModel[],
  inside: boolean,
  resetKey: unknown
): readonly SidebarSectionModel[] {
  const [snapshot, setSnapshot] = useState<{ held: SectionMembership; key: unknown } | null>(null);
  // Adjusted during RENDER, not in an effect: React re-runs this component
  // before committing anything, so the first frame drawn inside already holds,
  // and the frame after leaving already shows every move that waited.
  if (!inside && snapshot !== null) setSnapshot(null);
  if (inside && (snapshot === null || snapshot.key !== resetKey)) {
    setSnapshot({ held: membershipOf(live), key: resetKey });
  }
  const held = inside ? (snapshot?.held ?? null) : null;
  return useMemo(() => (held === null ? live : holdSectionMoves(live, held)), [live, held]);
}
