import { useEffect } from 'react';

const POPOVER_SELECTOR = '.reactour__popover';
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function focusablesIn(container: Element): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Trap keyboard focus inside the spotlight caption while a step is active.
 *
 * The spotlight library (`@reactour/tour` 3.8.0) ships no focus lock — its
 * `disableFocusLock` prop is inert — so the trap is ours, like the announcer.
 * The `inert` background already removes the app from the tab order; this moves
 * focus into the caption on open and wraps Tab / Shift+Tab at its edges so focus
 * never escapes to browser chrome. Re-runs on `key` so each step re-focuses.
 *
 * @param active - Whether a step is currently spotlighted.
 * @param key - Changes per step so focus moves to each new caption.
 */
export function useFocusTrap(active: boolean, key: number): void {
  useEffect(() => {
    if (!active) return;
    const popover = document.querySelector(POPOVER_SELECTOR);
    if (!popover) return;

    focusablesIn(popover)[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusablesIn(popover);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement;

      if (!popover.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [active, key]);
}
