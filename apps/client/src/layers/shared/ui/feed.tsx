/**
 * The container half of the WAI-ARIA feed pattern.
 *
 * @module shared/ui/feed
 */
import type { ReactNode } from 'react';
import { useFeedKeyboardNav } from '../model/feed/use-feed-keyboard-nav';
import type { FeedBeyondRenderedHandler } from '../model/feed/use-feed-keyboard-nav';

export interface FeedProps {
  /**
   * What this feed is a history OF, in the reader's words — "general", not
   * "messages". A page can hold two of these at once, so an unnamed one leaves
   * a screen reader unable to say which was landed in.
   */
  label: string;
  /**
   * True while the feed is loading articles into itself. Written on every
   * render rather than only while true: the APG asks for `aria-busy` to be set
   * back to false when the update finishes, and an attribute that is only ever
   * added leaves a feed stuck announcing a wait that is over.
   */
  busy?: boolean;
  /** The articles, and whatever rules and dividers sit between them. */
  children: ReactNode;
  /** Layout, supplied by the surface — a feed has no look of its own. */
  className?: string;
  /** Test hook for the surface that owns this feed. */
  'data-testid'?: string;
  /**
   * What to do when the reader asks for an article the feed has not rendered.
   *
   * Only a VIRTUALIZED feed needs this — see `FeedBeyondRenderedHandler` in
   * `@/layers/shared/model`, which is where the type and its contract live.
   * Omitted, the feed stops at the last article in the DOM, which for a feed
   * that renders all of them is the end of its history.
   */
  onBeyondRendered?: FeedBeyondRenderedHandler;
}

/**
 * A long history a reader crosses: `role="feed"`, plus the keys that make it
 * one.
 *
 * **Built to be adopted more than once.** The room timeline is the first feed
 * in this app; the session transcript and the thread panel are the same shape
 * of thing and are meant to reach for this rather than grow their own. So
 * nothing in here knows what an article IS — the surface renders its own rows
 * and each row says where it sits with {@link feedArticleProps}.
 *
 * Page Down and Page Up move between articles and Ctrl+Home/End leave the feed
 * entirely; {@link useFeedKeyboardNav} owns that and explains why it is worth
 * the keys it takes.
 */
export function Feed({
  label,
  busy,
  children,
  className,
  'data-testid': testId,
  onBeyondRendered,
}: FeedProps) {
  const { containerRef, handleKeyDown } = useFeedKeyboardNav({ onBeyondRendered });

  return (
    // A feed is a container of articles, not a control: it hears keys so that
    // the articles inside it do not each have to, and it is never focused
    // itself. `role="feed"` is the whole point of the element, so the generic
    // "static element with a handler" rule is answered by the role.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above
    <div
      data-slot="feed"
      ref={containerRef}
      role="feed"
      aria-label={label}
      aria-busy={busy === true}
      data-testid={testId}
      onKeyDown={handleKeyDown}
      className={className}
    >
      {children}
    </div>
  );
}
