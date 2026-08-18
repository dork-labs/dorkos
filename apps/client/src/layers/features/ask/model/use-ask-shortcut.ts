/**
 * `⌘⇧Y` — take me to the next thing waiting on me.
 *
 * @module features/ask/model/use-ask-shortcut
 */
import { useEffect } from 'react';
import { requestAskTray } from './ask-tray-store';

/** Every Ask card on screen, in document order. */
function askCards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="ask-card"][tabindex]'));
}

/**
 * Move focus to the next unanswered Ask, wherever it is.
 *
 * ## Its own chord, and why not `⌘⇧A`
 *
 * `⌘⇧A` has opened the agent's Profile since that panel shipped. Sharing it —
 * "Answer while something is waiting, Profile otherwise" — was tried and
 * rejected: the `?` panel is a promise about what a key does, and it cannot
 * make that promise for a combo with two labels, while a reader would discover
 * which meaning they got by watching the screen. `⌘⇧Y` is its own key, listed
 * once, doing one thing.
 *
 * It still listens in the CAPTURE phase, so nothing downstream can swallow it
 * first — listener order is otherwise registration order, which is not
 * something a shortcut's behaviour should depend on.
 *
 * ## Where it puts you
 *
 * Focus moves to the next card already on screen — the room's lane, the
 * transcript, the tray, whichever is drawing one — cycling round at the end. If
 * no card is on screen at all, it asks the header tray to open and land on its
 * first card ({@link requestAskTray}), which is the surface that exists on
 * every route.
 *
 * With nothing waiting it opens the tray on its empty state, which is a true
 * answer to "show me what needs me". It is the ONLY thing that moves focus onto
 * a card: an Ask that arrives while somebody is typing sits there quietly.
 */
export function useAskShortcut(): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!((event.metaKey || event.ctrlKey) && event.shiftKey)) return;
      if (event.key.toLowerCase() !== 'y') return;
      event.preventDefault();
      event.stopPropagation();
      const cards = askCards();
      if (cards.length === 0) {
        requestAskTray();
        return;
      }
      const active = document.activeElement;
      const at = cards.findIndex((card) => card === active || card.contains(active));
      const next = cards[(at + 1) % cards.length];
      next?.focus();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, []);
}
