/**
 * Guard against Radix menu focus-restore killing menu-launched inline editors
 * (DOR-329).
 *
 * When a menu item opens an inline editor (group create, group rename), the
 * editor mounts and focuses in the item's own commit — but Radix closes the
 * menu in a SECOND commit whose close sequence restores focus to the menu
 * trigger (`onCloseAutoFocus`). That steals focus from the editor, its
 * blur-cancel fires, and the editor self-destructs before the user ever sees it.
 *
 * The fix is the standard Radix pattern: `event.preventDefault()` on the menu
 * Content's `onCloseAutoFocus` — but only when the selected action opened an
 * inline editor (armed via {@link MenuCloseFocusGuard.arm}), so normal menu
 * dismissal still returns focus to the trigger for keyboard users.
 *
 * @module features/dashboard-sidebar/model/use-menu-close-focus-guard
 */
import { useCallback, useRef } from 'react';

/** API returned by {@link useMenuCloseFocusGuard}. */
export interface MenuCloseFocusGuard {
  /** Arm the guard: the NEXT menu close skips its focus restore (one-shot). */
  arm: () => void;
  /** Pass to the menu Content's `onCloseAutoFocus`. */
  onCloseAutoFocus: (event: Event) => void;
}

/**
 * One-shot suppression of a Radix menu's close-time focus restore.
 *
 * Call `arm()` from the menu item that opens an inline editor; wire
 * `onCloseAutoFocus` onto every Content the item can appear in. Unarmed closes
 * behave normally (focus returns to the trigger).
 */
export function useMenuCloseFocusGuard(): MenuCloseFocusGuard {
  const armedRef = useRef(false);

  const arm = useCallback(() => {
    armedRef.current = true;
  }, []);

  const onCloseAutoFocus = useCallback((event: Event) => {
    if (armedRef.current) {
      armedRef.current = false;
      event.preventDefault();
    }
  }, []);

  return { arm, onCloseAutoFocus };
}
