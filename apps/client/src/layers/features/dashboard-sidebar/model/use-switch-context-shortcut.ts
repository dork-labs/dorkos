/**
 * `⌘⇧K` / `Ctrl+Shift+K` — open the context switcher from anywhere (spec
 * `community-switcher-navigation`, Shell surfaces → Desktop).
 *
 * **Anywhere includes a message box.** Opening a channel puts the cursor in its
 * composer, so a chord that stood down for text fields would be dead exactly
 * where people switch from. Nothing else binds it, so it takes nothing from the
 * field. A key an input method is still composing belongs to that composition,
 * not to us.
 *
 * A hook rather than an effect inside the switcher so the chord can be mounted —
 * and fired — without the switcher's router, query client and transport around
 * it, which is how `shortcuts-registered.test.tsx` proves it.
 *
 * @module features/dashboard-sidebar/model/use-switch-context-shortcut
 */
import { useEffect, useRef } from 'react';

/**
 * Listen for `⌘⇧K` and open the switcher with it.
 *
 * @param onOpen - Runs on the chord, before the menu opens, with whatever held
 *   focus when it was pressed (so closing without a choice can put focus back).
 */
export function useSwitchContextShortcut(onOpen: (focused: HTMLElement | null) => void): void {
  const latest = useRef(onOpen);
  useEffect(() => {
    latest.current = onOpen;
  }, [onOpen]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      const active = document.activeElement;
      latest.current(active instanceof HTMLElement && active !== document.body ? active : null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
