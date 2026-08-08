// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { PendingPost } from '@/layers/entities/room';
import { useStickToBottom } from '../model/use-stick-to-bottom';

/** Total content height and viewport height of the stand-in container. */
const SCROLL_HEIGHT = 1000;
const CLIENT_HEIGHT = 300;
/** The largest `scrollTop` a browser will hold for that geometry. */
const MAX_SCROLL_TOP = SCROLL_HEIGHT - CLIENT_HEIGHT;
/** How much taller a pending row makes the content, and its failed form again. */
const PENDING_ROW_PX = 40;
const FAILED_LINE_PX = 20;

/** The stand-in scroller, plus the one thing jsdom cannot do: grow. */
interface ScrollFixture extends HTMLDivElement {
  /** Add content below, the way an appended row does. */
  grow: (px: number) => void;
}

/**
 * A stand-in for the scroll container. jsdom lays nothing out, so `scrollHeight`
 * and `clientHeight` are 0 on every real element — the geometry has to be
 * stated, not rendered.
 *
 * The setter clamps, because a browser does: `scrollTop = scrollHeight` is the
 * idiom for "go to the bottom" only because the assignment is clamped to the
 * scrollable extent. A fixture that stored 1000 verbatim would let these tests
 * assert a position no browser ever reports.
 *
 * `grow` is what makes an appended row testable at all: a fixture of fixed
 * height is already at its own bottom, so "did the pin run?" would read the same
 * whether it ran or not.
 */
function scrollContainer(initialScrollTop: number): ScrollFixture {
  let scrollTop = initialScrollTop;
  let scrollHeight = SCROLL_HEIGHT;
  return {
    get scrollHeight() {
      return scrollHeight;
    },
    clientHeight: CLIENT_HEIGHT,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(next: number) {
      scrollTop = Math.max(0, Math.min(next, scrollHeight - CLIENT_HEIGHT));
    },
    grow(px: number) {
      scrollHeight += px;
    },
  } as unknown as ScrollFixture;
}

/** One message of this reader's own, waiting under the log. */
function pendingPost(overrides: Partial<PendingPost> = {}): PendingPost {
  return {
    clientId: 'attempt-1',
    roomId: 'room-1',
    threadRootId: null,
    text: 'ok',
    attachmentNames: [],
    attachmentIds: [],
    status: 'sending',
    entryId: null,
    at: 0,
    ...overrides,
  };
}

/** What the hook is told on every render. */
interface Props {
  room: string;
  newest: string | null;
  pending: readonly PendingPost[];
}

/**
 * Mount the hook, then scroll the reader to `scrollTop`.
 *
 * In that order, because that is the order a browser does it in: an element
 * mounts at the top, the hook takes it to the newest message, and only then
 * can somebody scroll away. Setting the position BEFORE attaching would be a
 * state no browser produces — and would quietly hide the fact that attaching
 * is itself one of the moments this hook acts on.
 */
function mountWith(scrollTop: number, roomId = 'room-1') {
  const el = scrollContainer(0);
  const view = renderHook(
    ({ room, newest, pending }: Props) => useStickToBottom(room, newest, pending),
    { initialProps: { room: roomId, newest: 'entry-1' as string | null, pending: [] } as Props }
  );
  view.result.current.scrollRef(el);
  el.scrollTop = scrollTop;
  // The container reports its position the way a browser does: on scroll.
  view.result.current.onScroll();
  return { el, ...view };
}

describe('useStickToBottom', () => {
  it('puts the reader back where they were when the scroller remounts', () => {
    // The phone's thread panel is a full-screen push, so opening a thread
    // unmounts the room while this hook stays mounted. Coming back mounts a
    // BRAND NEW element at scrollTop 0, and no dependency has changed — so
    // nothing else in the hook would ever put the reader back. Measured on a
    // real 390x844 viewport before this was fixed: 1148px before, 0px after.
    const { result } = mountWith(200);

    // The room unmounts, then a fresh scroller arrives at the top.
    result.current.scrollRef(null);
    const remounted = scrollContainer(0);
    result.current.scrollRef(remounted);

    expect(remounted.scrollTop).toBe(200);
  });

  it('returns a remounted scroller to the bottom for a reader who was at it', () => {
    const { result } = mountWith(MAX_SCROLL_TOP);

    result.current.scrollRef(null);
    const remounted = scrollContainer(0);
    result.current.scrollRef(remounted);

    expect(remounted.scrollTop).toBe(MAX_SCROLL_TOP);
  });

  it('follows a new entry when the reader is already at the bottom', () => {
    // 1000 - 700 - 300 = 0px from the bottom.
    const { el, rerender } = mountWith(MAX_SCROLL_TOP);

    rerender({ room: 'room-1', newest: 'entry-2', pending: [] });

    expect(el.scrollTop).toBe(MAX_SCROLL_TOP);
  });

  it('still follows within the slack — a part-rendered row is not "scrolled up"', () => {
    // 40px from the bottom, inside the 64px slack.
    const { el, rerender } = mountWith(660);

    rerender({ room: 'room-1', newest: 'entry-2', pending: [] });

    expect(el.scrollTop).toBe(MAX_SCROLL_TOP);
  });

  it('leaves a reader who has scrolled up exactly where they are', () => {
    // 500px from the bottom: reading back through history.
    const { el, rerender } = mountWith(200);

    rerender({ room: 'room-1', newest: 'entry-2', pending: [] });

    expect(el.scrollTop).toBe(200);
  });

  it('does not move a scrolled-up reader however many entries arrive', () => {
    const { el, rerender } = mountWith(200);

    rerender({ room: 'room-1', newest: 'entry-2', pending: [] });
    rerender({ room: 'room-1', newest: 'entry-3', pending: [] });
    rerender({ room: 'room-1', newest: 'entry-4', pending: [] });

    expect(el.scrollTop).toBe(200);
  });

  it('opens the next room at its newest message, however the last one was left', () => {
    const { el, rerender } = mountWith(200);

    rerender({ room: 'room-2', newest: 'entry-9', pending: [] });

    expect(el.scrollTop).toBe(MAX_SCROLL_TOP);
  });

  it('scrolls nowhere while a room is still loading its history', () => {
    const { el, rerender } = mountWith(MAX_SCROLL_TOP);

    rerender({ room: 'room-2', newest: null, pending: [] });

    expect(el.scrollTop).toBe(MAX_SCROLL_TOP);
  });

  it('follows a message of your own into the space below the log', () => {
    // The row is drawn under the feed, so nothing about the server's entries
    // changes when it appears — only the height does. Keyed on the newest entry
    // alone, this is the render the pin slept through and the row landed under
    // the composer.
    const { el, rerender } = mountWith(MAX_SCROLL_TOP);
    el.grow(PENDING_ROW_PX);

    rerender({ room: 'room-1', newest: 'entry-1', pending: [pendingPost()] });

    expect(el.scrollTop).toBe(MAX_SCROLL_TOP + PENDING_ROW_PX);
  });

  it('keeps a refused message in view when its row grows to say so', () => {
    // The point of DOR-799: the failure toast fades, and the row explaining it —
    // with Try again and Discard on it — is the only lasting sign anything went
    // wrong. Failing makes the row taller, so a pin that only counted rows would
    // leave those controls clipped.
    const { el, rerender } = mountWith(MAX_SCROLL_TOP);
    el.grow(PENDING_ROW_PX);
    rerender({ room: 'room-1', newest: 'entry-1', pending: [pendingPost()] });

    el.grow(FAILED_LINE_PX);
    rerender({ room: 'room-1', newest: 'entry-1', pending: [pendingPost({ status: 'failed' })] });

    expect(el.scrollTop).toBe(MAX_SCROLL_TOP + PENDING_ROW_PX + FAILED_LINE_PX);
  });

  it('does not yank a reader out of history when their own message is sent', () => {
    // Same rule as an arriving entry: reading back is left alone. The row is
    // waiting at the bottom whenever they return to it.
    const { el, rerender } = mountWith(200);
    el.grow(PENDING_ROW_PX);

    rerender({ room: 'room-1', newest: 'entry-1', pending: [pendingPost()] });
    el.grow(FAILED_LINE_PX);
    rerender({ room: 'room-1', newest: 'entry-1', pending: [pendingPost({ status: 'failed' })] });

    expect(el.scrollTop).toBe(200);
  });
});
