/**
 * Rows never move under a cursor that is about to click them (BC-17).
 *
 * The model's own promise is that no AGENT can reorder Today (BC-16). This is
 * the second half of it: even a legitimate reorder — one the operator's own
 * earlier act earned — is withheld while they are reading, and applied the
 * moment they look away.
 *
 * @module features/dashboard-sidebar/model/use-today-order-hold
 */
import { useCallback, useState } from 'react';
import type { SidebarRowModel } from './build-sidebar-model';

/**
 * `rows`, in the order `heldKeys` last saw them.
 *
 * **The order is held; the rows are not.** Every row is the fresh one from this
 * frame, so a badge clearing, a verb starting and a title changing all still
 * land while the hold is on — what is frozen is which line each row is on.
 * Freezing the row objects instead would be a stale panel rather than a still
 * one.
 *
 * A row the held order has never seen goes to the end rather than being
 * withheld: the operator opening a conversation is exactly the act that creates
 * one, and refusing to draw it would look like the click did nothing.
 *
 * @param rows - This frame's rows, in the order the model wants.
 * @param heldKeys - The row keys in the order the panel is currently showing.
 */
function applyHeldOrder(
  rows: readonly SidebarRowModel[],
  heldKeys: readonly string[]
): SidebarRowModel[] {
  const place = new Map(heldKeys.map((key, index) => [key, index]));
  const known: { row: SidebarRowModel; at: number }[] = [];
  const fresh: SidebarRowModel[] = [];
  for (const row of rows) {
    const at = place.get(row.key);
    if (at === undefined) fresh.push(row);
    else known.push({ row, at });
  }
  known.sort((a, b) => a.at - b.at);
  return [...known.map((entry) => entry.row), ...fresh];
}

/** What {@link useTodayOrderHold} hands back. */
export interface TodayOrderHold {
  /** The rows to draw — this frame's, in the order the operator is looking at. */
  rows: SidebarRowModel[];
  /**
   * Spread onto the element that wraps the zone. Pointer and focus both,
   * because a keyboard has no pointer and the promise is about neither device
   * in particular: it is about not moving what somebody is aiming at.
   */
  handlers: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onFocus: () => void;
    onBlur: () => void;
  };
}

/**
 * Hold Today's order still while the operator is inside the zone.
 *
 * **The anchor releases it, and that is not an exception to the rule but the
 * rule's own boundary.** BC-17 defers reorders the operator did not ask for. A
 * conversation switch IS the ask — BC-21 puts the open conversation first and
 * BC-36 scrolls to it — so the held order is dropped whenever the anchor
 * changes, and the new order is what the next frame freezes.
 *
 * `onFocus`/`onBlur` rather than the DOM's `focusin`/`focusout`: React's
 * synthetic versions of these two bubble, so one pair on the wrapper covers
 * every row inside it.
 *
 * @param rows - Today's rows, in the order the model wants them.
 * @param anchorKey - The open conversation's row key, or `null`.
 */
export function useTodayOrderHold(
  rows: readonly SidebarRowModel[],
  anchorKey: string | null
): TodayOrderHold {
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const holding = pointerInside || focusInside;

  // The order the panel is currently showing, or `null` when nothing is held.
  //
  // Adjusted DURING render against the previous value, which is React's own
  // pattern for state that follows a prop (`react.dev/learn/you-might-not-need-
  // an-effect`). A ref would read more directly and is what this was written as
  // first, but reading `ref.current` in render is exactly what
  // `react-hooks/refs` is there to stop; an effect would let one frame paint at
  // the wrong order before correcting it.
  const [held, setHeld] = useState<readonly string[] | null>(null);
  const [wasHolding, setWasHolding] = useState(holding);
  if (wasHolding !== holding) {
    setWasHolding(holding);
    setHeld(holding ? rows.map((row) => row.key) : null);
  }
  const [lastAnchor, setLastAnchor] = useState(anchorKey);
  if (lastAnchor !== anchorKey) {
    setLastAnchor(anchorKey);
    // The operator switched conversations, which is an order they asked for.
    // Re-freeze on the new one when they are still in the zone, so the next
    // reorder nobody asked for is deferred as usual.
    setHeld(holding ? rows.map((row) => row.key) : null);
  }

  const ordered = held === null ? [...rows] : applyHeldOrder(rows, held);

  const onPointerEnter = useCallback(() => setPointerInside(true), []);
  const onPointerLeave = useCallback(() => setPointerInside(false), []);
  const onFocus = useCallback(() => setFocusInside(true), []);
  const onBlur = useCallback(() => setFocusInside(false), []);

  return {
    rows: ordered,
    handlers: { onPointerEnter, onPointerLeave, onFocus, onBlur },
  };
}
