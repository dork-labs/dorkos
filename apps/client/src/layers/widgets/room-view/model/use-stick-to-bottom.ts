/**
 * Follow a room's newest message — unless the reader has scrolled away.
 *
 * @module widgets/room-view/model/use-stick-to-bottom
 */
import { useCallback, useEffect, useRef } from 'react';
import type { PendingPost } from '@/layers/entities/room';

/**
 * How far from the bottom still counts as being at it. A few pixels of rounding
 * (fractional device pixels, a half-rendered row) must not read as "scrolled
 * up"; a screenful must.
 */
const AT_BOTTOM_SLACK_PX = 64;

/**
 * How many frames a freshly attached scroller is given to finish laying out.
 *
 * A room mounts with its history already in the cache, but the ELEMENT can be
 * inserted before it has a height — the phone's thread push lays out its
 * enclosing surface over the following frames. Measured coming back from a
 * thread: the scroller attached at `scrollHeight` 538 against a `clientHeight`
 * of 680, so there was nothing to scroll and the pin was a no-op, and only
 * later did the content settle to 1317. Ten frames is about 160ms — long enough
 * for that, short enough that a reader cannot meaningfully scroll inside it.
 */
const SETTLE_FRAMES = 10;

/**
 * What the rows below the log currently are, as one comparable value.
 *
 * **Why the pin needs this at all.** A message in flight is drawn under the
 * feed, not in it — the server has not accepted it, so it is not one of the
 * feed's numbered articles. That row still takes up height, and height is the
 * only thing the pin cares about: keyed on the newest ENTRY alone, appending a
 * pending row grew the scroller without re-running the effect, so the row landed
 * below the clip region. Measured on a real room: `elementFromPoint` at the
 * row's centre hit the composer. A failed send whose toast had already faded was
 * then invisible with no way to retry it — exactly the state the row exists to
 * make visible.
 *
 * Every row's status, not just the count: `sending` → `failed` swaps a one-line
 * spinner for a wrapped line carrying Try again and Discard, which is a height
 * change with no change in how many rows there are.
 *
 * It does NOT see the Discard a slow row grows on a timer in `RoomPendingRow`,
 * which changes nothing in the store. That row is already on screen and already
 * dismissable; the case worth catching is the one that leaves the reader with
 * nothing.
 *
 * @param posts - The pending rows, oldest first.
 * @returns A value that changes whenever those rows do, or `null` for none.
 */
function pendingTailId(posts: readonly PendingPost[]): string | null {
  if (posts.length === 0) return null;
  return posts.map((post) => `${post.clientId}:${post.status}`).join('\n');
}

/** What the scroll container needs from its host. */
export interface StickToBottom {
  /**
   * Attach to the scrolling element.
   *
   * A callback ref rather than a ref object, and that is load-bearing: the
   * scroller can unmount and come back while this hook stays mounted, and only
   * a callback ref is TOLD when that happens. See {@link useStickToBottom}.
   */
  scrollRef: (el: HTMLDivElement | null) => void;
  /** Attach to that element's `onScroll`. */
  onScroll: () => void;
}

/**
 * Keep a room pinned to its newest entry while the reader is at the bottom, and
 * leave them exactly where they are when they are not.
 *
 * A room opens at its newest message the way every chat surface does. After
 * that, an arriving entry only scrolls a reader who was already at the bottom —
 * reading back through history while an agent replies used to yank the view
 * away on every message.
 *
 * **A message of this reader's own counts as the tail too**, before the server
 * has accepted it: the pending row is drawn under the log and is the last thing
 * in the conversation, so it moves the view on exactly the terms a real entry
 * does — {@link pendingTailId} is what lets the effect see it. Same rule about
 * WHO gets moved: somebody reading back through history is left where they are,
 * and finds the row still there when they return to the bottom.
 *
 * Whether the reader is at the bottom lives in a ref, not state: nothing
 * renders from it, and a scroll handler that re-rendered the timeline on every
 * wheel tick would cost more than the guard saves.
 *
 * **The scroller is restored whenever it re-attaches**, which is not a detail:
 * on a phone the thread panel is a full-screen push, so opening a thread
 * UNMOUNTS the room while this hook — living in the page above — stays mounted
 * with all its refs intact. Coming back mounts a brand new element at
 * `scrollTop` 0, and neither `roomId` nor `newestEntryId` has changed, so the
 * effect below never runs and nothing puts the reader back. Measured on a
 * 390x844 viewport: 1148px before opening a thread, 0px after closing it — the
 * room silently jumped to its oldest message. A callback ref is the only thing
 * that hears an element arrive, which is why this is one rather than the ref
 * object it used to be.
 *
 * It restores the POSITION, not just the bottom: somebody reading back through
 * history who opens a thread and closes it should find the message they were
 * reading, not the newest one.
 *
 * @param roomId - The room on screen, or `null` when none is.
 * @param newestEntryId - Id of the newest entry held, or `null` for an empty or
 *   still-loading room. Keyed on the entry rather than the array so a live
 *   arrival scrolls to itself and a re-render for any other reason does not.
 * @param pendingPosts - What this reader has sent and the room has not echoed
 *   back yet, drawn BELOW the log — see {@link pendingTailId} for why the pin
 *   has to hear about them at all.
 */
export function useStickToBottom(
  roomId: string | null,
  newestEntryId: string | null,
  pendingPosts: readonly PendingPost[]
): StickToBottom {
  const elRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  /** Where the reader had scrolled to, so a remount can put them back. */
  const lastTopRef = useRef(0);
  const lastRoomIdRef = useRef<string | null>(null);

  /**
   * True while a freshly attached scroller is still being pinned.
   *
   * **Scroll events fired during that window are layout, not the reader**, and
   * telling them apart is the whole point of this flag. A scroller that attaches
   * short and then grows emits a scroll event whose geometry says "637px from
   * the bottom" — indistinguishable, to {@link onScroll}, from somebody reading
   * back through history. Believing it recorded the reader as scrolled up, and
   * the restore then faithfully returned them to the top of the room they had
   * never left. That is the bug this flag exists for.
   */
  const pinPendingRef = useRef(false);

  const onScroll = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    // Ignored while pinning: see `pinPendingRef`. The reader has not touched
    // anything yet, so nothing they did can be recorded from it.
    if (pinPendingRef.current) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK_PX;
    lastTopRef.current = el.scrollTop;
  }, []);

  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
    if (!el) return;

    // Runs on the first mount too, where it simply opens the room at its newest
    // message — the same thing the effect below would have done, one commit
    // earlier and without a visible jump.
    const target = atBottomRef.current ? null : lastTopRef.current;
    pinPendingRef.current = true;

    /** Put the scroller where it belongs, and say whether it landed. */
    const apply = (): boolean => {
      // The element may have been swapped again since this was scheduled.
      if (elRef.current !== el) return true;
      el.scrollTop = target ?? el.scrollHeight;
      // **A scroller with nothing to scroll has NOT landed**, and that
      // distinction is the whole fix. An element whose content has not been
      // laid out yet reports `scrollHeight === clientHeight`, which satisfies
      // "you are at the bottom" trivially — so the pin declared success against
      // 680px of content, released the guard, and the room then grew to 1317px
      // and fired the scroll event that recorded the reader as scrolled up.
      // Requiring something to actually scroll is what keeps the guard up until
      // the content is real.
      return target === null
        ? el.scrollHeight > el.clientHeight &&
            el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK_PX
        : el.scrollTop === target;
    };

    // Re-applied across the next few frames rather than once, because the
    // element can attach before it has a height — see {@link SETTLE_FRAMES}. It
    // stops the moment the position takes, so a room that lays out immediately
    // (every case but the push) costs exactly one assignment.
    let frames = 0;
    const settle = () => {
      if (elRef.current !== el) {
        pinPendingRef.current = false;
        return;
      }
      const landed = apply();
      frames += 1;
      if (landed || frames >= SETTLE_FRAMES) {
        pinPendingRef.current = false;
        return;
      }
      requestAnimationFrame(settle);
    };

    if (!apply()) requestAnimationFrame(settle);
    else pinPendingRef.current = false;
  }, []);

  const pendingTail = pendingTailId(pendingPosts);

  useEffect(() => {
    // Room bookkeeping first, and unconditionally: a room you have not scrolled
    // yet opens at the bottom, whether or not it has anything in it yet.
    const roomChanged = lastRoomIdRef.current !== roomId;
    lastRoomIdRef.current = roomId;
    if (roomChanged) {
      atBottomRef.current = true;
      lastTopRef.current = 0;
    }

    const el = elRef.current;
    // Nothing to follow: a room still loading its history, with nothing of this
    // reader's waiting under it either.
    if (!el || (newestEntryId === null && pendingTail === null) || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
  }, [roomId, newestEntryId, pendingTail]);

  return { scrollRef, onScroll };
}
