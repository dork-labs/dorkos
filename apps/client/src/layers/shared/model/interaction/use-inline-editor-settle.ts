/**
 * Keep a menu-launched inline editor alive through the teardown of the menu
 * that opened it (DOR-1371).
 *
 * ## The situation this exists for
 *
 * An inline editor — the sidebar's "New section…" name field, a section's
 * rename field — is opened by a menu item and then closes on blur, which is the
 * right behaviour for a field nobody is typing in. But the menu is still coming
 * apart at that moment: Radix restores focus at each Content it closes, a
 * submenu and its root are two of those, and the last of them lands on an
 * element that is itself unmounting. Focus falls to `<body>`, the editor reads
 * that as "the reader clicked away", and cancels itself in the same frame the
 * reader was supposed to start typing in.
 *
 * Measured in a browser rather than reasoned about:
 * `focusin INPUT` → `focusout INPUT` → `endNewGroup`, with no other element
 * gaining focus in between, and no paint at all. jsdom sees none of it, which
 * is why the item passed its unit tests while doing nothing in the product.
 *
 * ## The rule
 *
 * **A blur that hands focus back to the menu, or to nothing at all, in the first
 * moments after the editor opened, is the menu rather than the reader** — so the
 * editor takes its focus back instead of closing. Everything else is a real
 * blur: clicking another control hands focus to that control, and a blur after
 * the settle window is a person who has had time to look at the field.
 *
 * Both halves were measured. The submenu case blurs with `relatedTarget` set to
 * the menu's own content element — Radix restoring focus into a surface that is
 * one frame from unmounting — and the root case blurs with `relatedTarget` null,
 * straight to `<body>`. A guard that only knew about one of them fixed one path
 * and left the other reading as inert.
 *
 * Every bound is load-bearing. Without the `relatedTarget` test a click on any
 * other control would be swallowed; without the window, an editor on a page
 * whose focus is lost for some unrelated reason would grab it back for ever; and
 * without the once-only latch a menu that kept reclaiming would loop.
 *
 * @module shared/model/use-inline-editor-settle
 */
import { useCallback, useRef, useState, type FocusEvent } from 'react';

/**
 * How long after opening a blur can still belong to the menu.
 *
 * Radix's exit animations here are 150 ms and the restore happens at the end of
 * them, so this covers the sequence with room to spare while staying far below
 * the time it takes a person to read the field and click elsewhere.
 */
const SETTLE_MS = 400;

/**
 * What a menu surface looks like from the outside.
 *
 * `role="menu"` covers every Radix menu Content and SubContent — dropdown,
 * context and their nested lists — without this file having to know which
 * family opened the editor. The popper wrapper is the portalled box they sit
 * in, which is what a focus restore lands on when the content itself has
 * already begun unmounting.
 */
const MENU_SURFACE = '[role="menu"],[data-radix-popper-content-wrapper]';

/** What {@link useInlineEditorSettle} hands back. */
export interface InlineEditorSettle {
  /**
   * Whether this blur should be acted on.
   *
   * Returns `false` for the menu's own teardown — and takes the focus back
   * before it does, so the reader is left in the field they asked for.
   */
  shouldHandleBlur: (event: FocusEvent<HTMLElement>) => boolean;
}

/**
 * Guard an inline editor against the blur its own menu causes on the way out.
 *
 * @param elementRef - The editor's input, so the guard can reclaim focus.
 */
export function useInlineEditorSettle(elementRef: {
  current: HTMLElement | null;
}): InlineEditorSettle {
  // A lazy state initializer, not a ref initializer: the clock is read once when
  // the editor opens, and render itself may not read it.
  const [openedAt] = useState(() => Date.now());
  const reclaimedRef = useRef(false);

  const shouldHandleBlur = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      // Focus went somewhere real that is NOT the menu on its way out: the
      // reader moved on, whatever the clock says.
      const next = event.relatedTarget;
      const wentToMenu =
        next === null || (next instanceof Element && next.closest(MENU_SURFACE) !== null);
      if (!wentToMenu) return true;
      if (reclaimedRef.current) return true;
      if (Date.now() - openedAt > SETTLE_MS) return true;
      reclaimedRef.current = true;
      // After the current task, so the menu finishes unmounting first —
      // reclaiming inside its own restore just loses the race again.
      setTimeout(() => elementRef.current?.focus(), 0);
      return false;
    },
    [elementRef, openedAt]
  );

  return { shouldHandleBlur };
}
