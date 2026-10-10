/**
 * Keep keyboard focus somewhere useful when the control that held it goes away.
 *
 * Managed remote access swaps whole views under the person (setup becomes the
 * status once approved; "Close now" disappears once the address closes). The
 * button they pressed is unmounted, and the browser drops focus on `<body>`,
 * which sends a keyboard or screen-reader user back to the top of the page.
 *
 * @module features/settings/model/use-rescue-focus
 */

import { useEffect, type RefObject } from 'react';

/**
 * Move focus to `target` whenever `key` changes and focus has fallen to the
 * page body. Focus that is still on a real control is left exactly where it is.
 *
 * @param target - The element to land on: a heading with `tabIndex={-1}`.
 * @param key - What changing means the view moved (a state, a status).
 */
export function useRescueFocus(target: RefObject<HTMLElement | null>, key: string): void {
  useEffect(() => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    target.current?.focus({ preventScroll: true });
  }, [target, key]);
}
