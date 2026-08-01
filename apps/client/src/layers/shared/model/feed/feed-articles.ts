/**
 * The bookkeeping half of the WAI-ARIA feed pattern: what makes a row an
 * article of a set, rather than a box that happens to be in a list.
 *
 * Split from the keyboard half because the two are reached from different
 * places — the container owns the keys, each row owns its own position — and
 * shared for the same reason: the room timeline is the first feed in this app,
 * and the session transcript and thread panel are the same shape of thing.
 *
 * @module shared/model/feed/feed-articles
 */
import { FEED_ARTICLE_ATTR } from './use-feed-keyboard-nav';

/** Where one article sits in the feed that holds it. */
export interface FeedPosition {
  /** 1-based position, as `aria-posinset` counts. */
  index: number;
  /**
   * How many articles the feed holds. `-1` where that is genuinely unknown —
   * a feed still paging in older history knows how many it has LOADED, not how
   * many there are, and the APG says to say so rather than guess.
   */
  total: number;
}

/** What a row spreads onto itself to be one article of a feed. */
export interface FeedArticleProps {
  /** The marker {@link useFeedKeyboardNav} navigates between. */
  [FEED_ARTICLE_ATTR]: string;
  /** Focusable, because an article is where Page Down puts the reader. */
  tabIndex: 0;
  /**
   * Where this article sits — omitted entirely when the set's size is unknown.
   *
   * The two travel together or not at all. A feed showing the trailing page of
   * a long history knows the row is the first one IT rendered, and does not
   * know that it is the 471st message; announcing "item 1" beside a set size of
   * "unknown" states the first of those as though it were the second.
   */
  'aria-posinset': number;
  'aria-setsize': number;
}

/**
 * The attributes one article of a feed carries.
 *
 * Deliberately does NOT include `role="article"` or the article's name: a row
 * is an article whether or not it is in a feed today, and how it is named is
 * the row's own business — the name has to come from what is already on screen,
 * which only the row can know.
 *
 * @param position - Where this article sits, or undefined when the row is
 *   rendering outside a feed — in which case nothing is contributed, so a row
 *   can spread the result unconditionally.
 */
export function feedArticleProps(position: FeedPosition | undefined): Partial<FeedArticleProps> {
  if (position === undefined) return {};
  return {
    [FEED_ARTICLE_ATTR]: '',
    tabIndex: 0,
    // Both, or neither — see {@link FeedArticleProps}. A position counted over
    // what happens to be loaded is not a position in the set, and paired with
    // an unknown size it reads as one.
    ...(position.total >= 0 && {
      'aria-posinset': position.index,
      'aria-setsize': position.total,
    }),
    ...(position.total < 0 && { 'aria-setsize': -1 }),
  };
}
