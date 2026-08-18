/**
 * `⌘⇧A` — take me to the next thing waiting on me.
 *
 * @module features/ask/model/use-ask-shortcut
 */
import { useEffect } from 'react';
import { usePendingInteractions } from '@/layers/entities/attention';
import { requestAskTray } from './ask-tray-store';

/** Every Ask card on screen, in document order. */
function askCards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="ask-card"][tabindex]'));
}

/**
 * Move focus to the next unanswered Ask, wherever it is.
 *
 * ## Why this chord is shared, and how
 *
 * `⌘⇧A` already opens the agent's Profile (`SHORTCUTS.AGENT_PROFILE`), and it
 * has since that panel shipped. Rather than take a key away from a working
 * feature or invent a chord nobody would guess, this handler claims the combo
 * **only while something is actually waiting on a person** — the case where
 * "A" unambiguously means Answer — and otherwise does not touch the event at
 * all, so Profile opens exactly as it always has.
 *
 * It listens in the CAPTURE phase so that decision is made before the profile's
 * own document listener sees the key, whichever of the two mounted first.
 * Listener order is otherwise registration order, which is not something a
 * shortcut's behaviour should depend on.
 *
 * ## Where it puts you
 *
 * Focus moves to the next card already on screen — the room's lane, the
 * transcript, the tray, whichever is drawing one — cycling round at the end. If
 * no card is on screen at all, it asks the header tray to open and land on its
 * first card ({@link requestAskTray}), which is the surface that exists on
 * every route.
 *
 * It never moves focus when nothing is waiting, and it is the ONLY thing that
 * moves focus onto a card: an Ask that arrives while somebody is typing sits
 * there quietly.
 */
export function useAskShortcut(): void {
  const { interactions } = usePendingInteractions();
  const waiting = interactions.length;

  useEffect(() => {
    if (waiting === 0) return;
    const handler = (event: KeyboardEvent) => {
      if (!((event.metaKey || event.ctrlKey) && event.shiftKey)) return;
      if (event.key.toLowerCase() !== 'a') return;
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
  }, [waiting]);
}
