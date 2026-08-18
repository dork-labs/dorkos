/**
 * What a room row tells a screen reader about ITSELF: its name, its
 * description, and its place in the feed.
 *
 * One function because the three answers constrain each other. The name has to
 * come from what is already on screen, which decides what the description may
 * be; and the position is only meaningful once the row has a name to attach it
 * to. Spread onto the row in `RoomMessage`, the same way `feedArticleProps`
 * is spread onto any article of a feed.
 *
 * @module widgets/room-view/lib/entry-row-article
 */
import { feedArticleProps, type FeedArticleProps, type FeedPosition } from '@/layers/shared/model';

interface EntryRowArticleOptions {
  /** True on a group start, which HAS an author line to be named from. */
  showAuthorHeader: boolean;
  /** The DOM id of that author line. */
  headerId: string;
  /** Who wrote the entry — a continuation row's name is built from this. */
  displayName: string;
  /** The clock reading, already formatted; empty when there is none to show. */
  time: string;
  /** The line describing the message, or `null` when the words describe themselves. */
  summary: string | null;
  /** The DOM id of the rendered message body. */
  contentId: string;
  /** The DOM id of that description line. */
  summaryId: string;
  /** Where the row sits in its feed, or undefined outside one. */
  feedPosition: FeedPosition | undefined;
}

/** The attributes a room row spreads onto itself to be a named article. */
type EntryRowArticleProps = Partial<FeedArticleProps> & {
  /** Set on a group start: the visible author line IS the row's name. */
  'aria-labelledby'?: string;
  /** Set on a continuation, which has no author line to point at. */
  'aria-label'?: string;
  /** What the article is about — the words, or a line about them. */
  'aria-describedby': string;
};

/**
 * Name and describe one room row, and place it in its feed.
 *
 * A row shipped unnamed on purpose once, and the reason it changed is worth
 * keeping. "Message from Ana" over a row that visibly says "Ana" is a second
 * sentence invented for screen readers — the DOR-583 double-speak. The answer
 * is not to stay silent but to stop inventing: the name is the author line
 * ALREADY ON SCREEN, pointed at with `aria-labelledby`, so what repeats is the
 * visible line and never a string written for the purpose. The APG's own feed
 * example resolves it the same way.
 *
 * A continuation row is the exception and gets an `aria-label` instead: it has
 * no author line to point at, because the design deliberately drops one for a
 * run of messages from the same person. Sighted readers get that from the
 * grouping; a name is how everyone else gets the same fact. Either way it is
 * who spoke and when, never a sentence about the row itself.
 *
 * **What the article is ABOUT: the words**, where they are short enough to BE
 * the description, and a line about them where they are not. See
 * `entrySummary`, which decides which of those a message is.
 *
 * `feedPosition` is a CONSUMER of that name rather than its cause. It adds
 * where the row sits in the set, which is what makes Page Down say "12 of 30,
 * Ana" — so a row outside a feed is named but unnumbered, and the same row is
 * numbered differently in the room's flow and in an open thread's panel, which
 * are two feeds and two sets.
 *
 * **No `aria-keyshortcuts`, and that is a change rather than an omission.** It
 * said "Enter" on every row, so crossing a room of fifty messages announced the
 * same shortcut fifty times to say one thing once — and it was carrying the
 * whole of the capsule's discoverability, because a roving group is invisible
 * until you are standing in it. That job now belongs to a named control (the
 * "Message actions" button below the reactions), which says what it is rather
 * than which key to press, and which a finger can reach.
 *
 * @param options - The row's grouping, the ids it has minted, and its feed.
 */
export function entryRowArticleProps({
  showAuthorHeader,
  headerId,
  displayName,
  time,
  summary,
  contentId,
  summaryId,
  feedPosition,
}: EntryRowArticleOptions): EntryRowArticleProps {
  return {
    ...(showAuthorHeader
      ? { 'aria-labelledby': headerId }
      : { 'aria-label': time.length > 0 ? `${displayName}, ${time}` : displayName }),
    'aria-describedby': summary === null ? contentId : summaryId,
    ...feedArticleProps(feedPosition),
  };
}
