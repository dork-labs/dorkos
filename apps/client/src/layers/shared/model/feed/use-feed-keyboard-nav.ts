/**
 * The keyboard half of the WAI-ARIA feed pattern.
 *
 * **Written for more than one surface on purpose.** A room's timeline is the
 * first feed in this app and is meant to be the first of several — the session
 * transcript and the thread panel are the same shape of thing, a long history a
 * reader crosses — so the pattern lives in `shared` where any layer can reach
 * it, rather than inside the room widget where the second adopter would have to
 * either import across the layer rule or copy it. Nothing here knows what a
 * message is.
 *
 * @module shared/model/feed/use-feed-keyboard-nav
 */
import { useCallback, useRef, type KeyboardEvent } from 'react';

/**
 * The marker an element carries to be one of the feed's articles.
 *
 * A data attribute rather than a ref registry because the articles are rendered
 * by a component the feed does not own — a row decides for itself whether it is
 * an article this render — and a registry would have to be threaded through
 * every one of them to say the same thing the DOM already knows.
 */
export const FEED_ARTICLE_ATTR = 'data-feed-article';

/**
 * What counts as "the first focusable element before/after the feed".
 *
 * Tab STOPS, so `tabindex="-1"` is excluded: everything inside this app's
 * roving groups is focusable by script and none of it is a place Ctrl+End
 * should land — a reader leaving the feed wants the composer, not a button
 * belonging to the message they just left.
 */
const TAB_STOP_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * The tab stop nearest the feed on one side of it, or null when there is none.
 *
 * @param container - The feed element.
 * @param side - Which side of the feed to look on.
 */
function tabStopOutside(container: HTMLElement, side: 'before' | 'after'): HTMLElement | null {
  const stops = Array.from(document.querySelectorAll<HTMLElement>(TAB_STOP_SELECTOR)).filter(
    (node) => !container.contains(node)
  );
  if (side === 'after') {
    return (
      stops.find(
        (node) => (container.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      ) ?? null
    );
  }
  const before = stops.filter(
    (node) => (container.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
  );
  return before[before.length - 1] ?? null;
}

/** What the feed container needs to be a feed. */
export interface FeedKeyboardNav {
  /** Attach to the `role="feed"` element. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the same element's `onKeyDown`. */
  handleKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Article-to-article movement inside a feed, exactly as the APG defines it.
 *
 * Page Down and Page Up move to the next and previous article; Ctrl+End and
 * Ctrl+Home leave the feed for the first tab stop after and before it. Nothing
 * wraps: a feed is a stretch of history, and silently jumping from its end back
 * to its beginning would tell a reader they had arrived somewhere they had not.
 *
 * **This is what a long history actually costs to cross.** Tab steps item by
 * item, and an item with anything tabbable of its own costs a stop for each —
 * so a busy room is dozens of presses deep before its composer. Page Down is
 * the way past all of it: one press per item however much that item carries,
 * because it moves between ARTICLES and everything else is inside one.
 *
 * The handler sits on the container rather than on each article, so it works
 * from wherever focus happens to be inside the feed — a button belonging to an
 * article, a control between two of them — and not only from an article itself.
 * A roving group inside an article must therefore leave Page Up/Down and
 * Ctrl+Home/End alone, so they can bubble up to here.
 *
 * **It never moves focus on its own.** Positions are derived at render, so a
 * feed that prepends older history renumbers every `aria-posinset` without
 * touching what the reader is standing on — the article they focused is the
 * same element, still focused, now further down the set.
 */
export function useFeedKeyboardNav(): FeedKeyboardNav {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const container = containerRef.current;
    if (container === null) return;

    if (event.key === 'Home' || event.key === 'End') {
      // Ctrl (or Cmd, which is the same press on a Mac) is what makes this a
      // feed command rather than the ordinary "top of the document".
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      tabStopOutside(container, event.key === 'End' ? 'after' : 'before')?.focus();
      return;
    }

    if (event.key !== 'PageDown' && event.key !== 'PageUp') return;

    const articles = Array.from(container.querySelectorAll<HTMLElement>(`[${FEED_ARTICLE_ATTR}]`));
    if (articles.length === 0) return;

    const active = document.activeElement;
    const current = articles.findIndex(
      (article) => article === active || (active !== null && article.contains(active))
    );

    // Focus somewhere in the feed but in none of its articles — a divider has
    // no focus to take, but a room's thread reply row does. Page Down means
    // the article after the one it belongs to, which is where DOM order puts
    // the next `[data-feed-article]` anyway, so `-1` walking forward from the
    // start is wrong. Fall back to the nearest article ABOVE the focus.
    const from =
      current !== -1
        ? current
        : articles.reduce(
            (nearest, article, index) =>
              active !== null &&
              (article.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
                ? index
                : nearest,
            -1
          );

    const next = event.key === 'PageDown' ? from + 1 : from - 1;
    const target = articles[Math.min(Math.max(next, 0), articles.length - 1)];
    if (target === undefined) return;
    event.preventDefault();
    target.focus();
  }, []);

  return { containerRef, handleKeyDown };
}
