import {
  useCallback,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';

/**
 * cmdk's own answer to "which rows can be picked", copied from its `Command`
 * root so this file and cmdk cannot disagree about what the leading row is.
 */
const SELECTABLE_ROW = '[cmdk-item=""]:not([aria-disabled="true"])';

/** The keys cmdk's root handles by moving the highlight (its `onKeyDown` switch). */
const HIGHLIGHT_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End']);

/** The same, for cmdk's vim bindings — Ctrl+n/p/j/k. */
const HIGHLIGHT_VIM_KEYS = new Set(['n', 'p', 'j', 'k']);

/** The handlers {@link useLeadingRowPin} hands back for the `Command` root. */
export interface LeadingRowPin {
  /** Goes on the `Command` root's `onKeyDown`, alongside anything else it does. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** Goes on the `Command` root's `onPointerMove`. */
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
}

/** What {@link useLeadingRowPin} needs to know. */
export interface LeadingRowPinOptions {
  /**
   * The cmdk `Command` root, whose rendered rows are the only honest answer to
   * which row is on top. Owned by the caller so it goes onto the element as a
   * plain `ref=`, rather than being handed back out of this hook.
   */
  rootRef: RefObject<HTMLDivElement | null>;
  /**
   * The page whose rows may be pinned, matched against the `data-palette-page`
   * attribute each page wrapper carries. During the palette's page transition
   * (`AnimatePresence mode="wait"`) the departing page's rows are still in the
   * DOM under the OLD page name for ~150ms; without this scope the pin re-armed
   * one of those rows and a quick second Enter fired it (DOR-699 review).
   */
  activePage: string;
  /** Called with the leading row's value when the highlight should move there. */
  onPin: (value: string) => void;
  /**
   * Changes whenever the list is starting over — a new query, a different page,
   * the palette opening. Each change forgets that the operator moved the
   * highlight, so the next list leads with a highlighted row again.
   */
  resetKey: string;
}

/**
 * Keep the highlight on the row you are looking at when the list moves under you.
 *
 * The palette's leading rows are live: an arriving message re-sorts Recent
 * (which leads with what is waiting), so the row on top a moment ago is not the
 * row on top now. cmdk does not follow that. It re-selects the first row when a
 * row mounts *only if nothing is
 * selected yet* (`state.value || selectFirstItem()`), and a reorder of already
 * mounted, React-keyed rows mounts nothing at all — so the highlight stays on
 * whatever it was on while a different row slides above it. Enter then opens a
 * row you are not looking at (DOR-699).
 *
 * The rule here is: until the operator moves the highlight themselves, it belongs
 * to whichever row leads the list. Once they move it, it is theirs.
 *
 * Two things make that work:
 *
 * - **Operator intent comes from input events, not from the selection changing.**
 *   cmdk drives its own automatic re-selections through the same `onValueChange`
 *   the operator's arrow keys do, so the callback cannot tell them apart. Arrow
 *   keys and a pointer landing on a row can, and they are the only two ways a
 *   person moves this highlight.
 * - **The leading row is read from the DOM.** Which row is on top depends on
 *   which groups rendered, in an order that lives in `PaletteRootPage`; asking
 *   the rendered list is the one answer that cannot drift from what is on
 *   screen. It is also exactly how cmdk itself picks a first row.
 *
 * The check runs after every render on purpose. Nothing in this component's
 * props says "the groups reordered" — the room list can change without any row
 * being added or removed — and a `querySelector` on an open palette is cheap.
 * A reorder typically produces two runs before cmdk's store re-render catches
 * up, so the second run can still read a stale `aria-selected`; what actually
 * stops the cycle is React bailing out of a same-value `setState` in `onPin`.
 * The `aria-selected` early-return below is only a shortcut for the settled
 * common case, not the loop's safety.
 */
export function useLeadingRowPin({
  rootRef,
  activePage,
  onPin,
  resetKey,
}: LeadingRowPinOptions): LeadingRowPin {
  const operatorMovedRef = useRef(false);

  // Declared before the pin below so that on a reset render the flag is already
  // cleared by the time the pin looks at it.
  useLayoutEffect(() => {
    operatorMovedRef.current = false;
  }, [resetKey]);

  useLayoutEffect(() => {
    if (operatorMovedRef.current) return;
    // Scoped to the active page's wrapper: an exiting page's rows are still
    // mounted (under their own page name) during the transition, and pinning
    // one of those aimed Enter at a page the operator had already left.
    const leading = rootRef.current?.querySelector(
      `[data-palette-page="${CSS.escape(activePage)}"] ${SELECTABLE_ROW}`
    );
    // Already the highlighted row: the settled common case (see module TSDoc).
    if (!leading || leading.getAttribute('aria-selected') === 'true') return;
    const value = leading.getAttribute('data-value');
    if (value) onPin(value);
  });

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    // cmdk's root bails on composing input before its own switch, so an
    // ArrowDown that picks an IME candidate never moves the highlight — it
    // must not count as the operator moving it either.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (HIGHLIGHT_KEYS.has(event.key) || (event.ctrlKey && HIGHLIGHT_VIM_KEYS.has(event.key))) {
      operatorMovedRef.current = true;
    }
  }, []);

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    // cmdk selects a row when the pointer moves over *that row*, so a move
    // across the padding around the list is not somebody choosing anything.
    if (event.target instanceof Element && event.target.closest(SELECTABLE_ROW)) {
      operatorMovedRef.current = true;
    }
  }, []);

  return { onKeyDown, onPointerMove };
}
