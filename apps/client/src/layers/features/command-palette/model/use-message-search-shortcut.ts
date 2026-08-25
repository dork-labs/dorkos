/**
 * ⌘⇧F / Ctrl+Shift+F — the key that opens the search box (spec `message-search`
 * §8).
 *
 * **A different key from ⌘K, because it is a different question.** ⌘K finds a
 * thing by what it is called; this finds it by what was said in it. Slack keeps
 * the two apart and Teams merged them, which is the example that settled this
 * — a single box that sometimes ranks channels and sometimes ranks sentences
 * teaches nobody what either keystroke does.
 *
 * **Not ⌘F**, which is the browser's own find-on-page and belongs to the
 * browser. Taking it would break finding a word in the transcript on screen,
 * which is a thing people do constantly and a thing this box cannot do.
 *
 * The binding is announced where every other one is (`PaletteFooter`, the
 * shortcuts panel and ⌘K's hand-off row). A shortcut nobody is told about is
 * folklore.
 *
 * @module features/command-palette/model/use-message-search-shortcut
 */
import { useEffect } from 'react';
import { useAppStore } from '@/layers/shared/model';

/** Register ⌘⇧F. Call once, from something always mounted. */
export function useMessageSearchShortcut(): void {
  const toggleMessageSearch = useAppStore((s) => s.toggleMessageSearch);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // `e.code`, not `e.key`: with Shift held, `key` is `'F'` on a US layout
      // and something else entirely on layouts where the shifted character
      // differs. The physical key is what the shortcut means.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyF') {
        e.preventDefault();
        toggleMessageSearch();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [toggleMessageSearch]);
}
