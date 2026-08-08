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
import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';

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
 * Tab STOPS, so `tabindex="-1"` is excluded from EVERY clause and not only from
 * the `[tabindex]` one: everything inside this app's roving groups is focusable
 * by script and none of it is a place Ctrl+End should land — a reader leaving
 * the feed wants the composer, not a button belonging to the message they just
 * left. The composer's own dropzone input is the case that proved the narrower
 * reading wrong: it is a real `<input>`, visually hidden and `tabindex="-1"`,
 * and it sits before the text field, so Ctrl+End landed on nothing a person
 * could see.
 *
 * A file input is excluded outright, tab stop or not. Every one in this app is
 * the invisible half of a visible affordance — the paperclip button, or the
 * composer card's dropzone — and both of those are reachable in their own
 * right.
 */
const TAB_STOP_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([type="file"]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[contenteditable="true"]:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * A composer is ONE destination, not a row of separate controls.
 *
 * `Composer.Root` stamps `data-composer-card` on its card. A tab stop inside one
 * therefore resolves to that card's text field, whichever control the walk
 * happened to reach first — the paperclip sits before the box in the markup, so
 * without this Ctrl+End puts a reader on "Attach file" when what they asked for
 * was somewhere to type.
 *
 * @param stop - The tab stop the walk found.
 */
function composerFieldOf(stop: HTMLElement): HTMLElement {
  const card = stop.closest<HTMLElement>('[data-composer-card]');
  return card?.querySelector<HTMLElement>('textarea, [contenteditable="true"]') ?? stop;
}

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
    const next = stops.find(
      (node) => (container.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    );
    return next === undefined ? null : composerFieldOf(next);
  }
  const before = stops.filter(
    (node) => (container.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
  );
  const previous = before[before.length - 1];
  return previous === undefined ? null : composerFieldOf(previous);
}

/**
 * What a feed does when the article it is asked for has not been rendered.
 *
 * Only a VIRTUALIZED feed needs this. A feed that renders all of its articles
 * runs out of them exactly when it runs out of history, and stopping at the end
 * of history is correct. A feed that renders a window over its history runs out
 * of them constantly — at message 9 of 30 — and stopping there strands a reader
 * mid-transcript with nothing but the mouse to get further.
 *
 * @param direction - Which way the reader was moving.
 * @param edge - The last rendered article in that direction. Its
 *   `aria-posinset` says which one it is; the article wanted is the one after
 *   (or before) it.
 */
export type FeedBeyondRenderedHandler = (direction: 'next' | 'previous', edge: HTMLElement) => void;

/** Optional behaviour a surface can add to the feed's keys. */
export interface FeedKeyboardNavOptions {
  /**
   * Called instead of stopping at the edge of what is rendered, when the set
   * says there is more. Omit for a feed that renders all of its articles.
   */
  onBeyondRendered?: FeedBeyondRenderedHandler;
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
export function useFeedKeyboardNav(options?: FeedKeyboardNavOptions): FeedKeyboardNav {
  const containerRef = useRef<HTMLDivElement>(null);
  // Read through a ref so the handler stays stable: the surface's callback
  // closes over its own render state (a virtualizer, a row list) and would
  // otherwise re-identify this handler on every token that arrives.
  const beyondRef = useRef(options?.onBeyondRendered);
  useEffect(() => {
    beyondRef.current = options?.onBeyondRendered;
  }, [options?.onBeyondRendered]);

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

    // Off the end of what is RENDERED, which in a virtualized feed is not the
    // end of the history. `aria-posinset`/`aria-setsize` are the only things
    // that know the difference — they count the whole set, while the DOM holds
    // a window over it — so they decide whether there is anywhere left to go.
    if (next < 0 || next > articles.length - 1) {
      const forward = event.key === 'PageDown';
      const edge = articles[forward ? articles.length - 1 : 0]!;
      const position = Number(edge.getAttribute('aria-posinset'));
      const total = Number(edge.getAttribute('aria-setsize'));
      const more = forward ? position < total : position > 1;
      const beyond = beyondRef.current;
      if (more && Number.isFinite(position) && beyond !== undefined) {
        event.preventDefault();
        beyond(forward ? 'next' : 'previous', edge);
        return;
      }
    }

    const target = articles[Math.min(Math.max(next, 0), articles.length - 1)];
    if (target === undefined) return;
    event.preventDefault();
    target.focus();
  }, []);

  return { containerRef, handleKeyDown };
}
