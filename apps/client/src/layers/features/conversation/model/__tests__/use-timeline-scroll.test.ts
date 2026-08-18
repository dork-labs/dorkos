// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { forgetTimelinePosition, useTimelineScroll } from '../use-timeline-scroll';

/** Total content height and viewport height of the stand-in container. */
const SCROLL_HEIGHT = 1000;
const CLIENT_HEIGHT = 300;
/** The largest `scrollTop` a browser will hold for that geometry. */
const MAX_SCROLL_TOP = SCROLL_HEIGHT - CLIENT_HEIGHT;

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
 * `scrollTo` is here because the hook uses it for the jump-to-latest control,
 * and jsdom's own implementation is a no-op that would make every one of those
 * assertions vacuous.
 */
function scrollContainer(initialScrollTop: number): HTMLDivElement {
  let scrollTop = initialScrollTop;
  const el = {
    scrollHeight: SCROLL_HEIGHT,
    clientHeight: CLIENT_HEIGHT,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(next: number) {
      scrollTop = Math.max(0, Math.min(next, SCROLL_HEIGHT - CLIENT_HEIGHT));
    },
    scrollTo(options: { top: number }) {
      el.scrollTop = options.top;
    },
  };
  return el as unknown as HTMLDivElement;
}

/** What the hook is told on every render. */
interface Props {
  conversationId: string | null;
  rowCount: number;
}

/**
 * Mount the hook, attach a scroller, then scroll the reader to `scrollTop`.
 *
 * In that order, because that is the order a browser does it in: an element
 * mounts, the timeline lands it, and only then can somebody scroll away.
 */
function mountWith(scrollTop: number, conversationId = 'room-1', rowCount = 10) {
  const el = scrollContainer(0);
  const view = renderHook((props: Props) => useTimelineScroll(props), {
    initialProps: { conversationId, rowCount } as Props,
  });
  act(() => view.result.current.scrollRef(el));
  el.scrollTop = scrollTop;
  // The container reports its position the way a browser does: on scroll.
  act(() => view.result.current.onScroll());
  return { el, ...view };
}

describe('useTimelineScroll', () => {
  beforeEach(() => {
    // The remembered positions outlive any one component on purpose (the
    // phone's thread push unmounts the whole timeline), so they outlive a test
    // too unless it says otherwise.
    for (const id of ['room-1', 'room-2', 'session-1']) forgetTimelinePosition(id);
  });

  it('reports the reader as away from the bottom once they scroll up', () => {
    const { result } = mountWith(200);

    expect(result.current.isAtBottom).toBe(false);
  });

  it('counts a part-rendered row as still at the bottom', () => {
    // 40px from the bottom, inside the room's 64px slack. Rounding and a
    // half-drawn row must not read as "scrolled up" — that is the threshold the
    // merge kept verbatim.
    const { result } = mountWith(660);

    expect(result.current.isAtBottom).toBe(true);
  });

  it('raises the new-messages pill when a row arrives while the reader is away', () => {
    const { result, rerender } = mountWith(200);

    rerender({ conversationId: 'room-1', rowCount: 11 });

    expect(result.current.hasNewRows).toBe(true);
  });

  it('raises no pill for a row that arrives while the reader is at the bottom', () => {
    const { result, rerender } = mountWith(MAX_SCROLL_TOP);

    rerender({ conversationId: 'room-1', rowCount: 11 });

    expect(result.current.hasNewRows).toBe(false);
  });

  it('drops the pill once the reader goes back to the bottom', () => {
    const { el, result, rerender } = mountWith(200);
    rerender({ conversationId: 'room-1', rowCount: 11 });

    act(() => {
      el.scrollTop = MAX_SCROLL_TOP;
      result.current.onScroll();
    });

    expect(result.current.hasNewRows).toBe(false);
  });

  it('takes the reader to the bottom and clears the pill on demand', () => {
    const { el, result, rerender } = mountWith(200);
    rerender({ conversationId: 'room-1', rowCount: 11 });

    act(() => result.current.scrollToBottom());

    expect(el.scrollTop).toBe(MAX_SCROLL_TOP);
    expect(result.current.hasNewRows).toBe(false);
  });

  it('puts the reader back where they were when the scroller remounts', () => {
    // The phone's thread panel is a full-screen push, so opening a thread
    // UNMOUNTS the room column, timeline and all. Coming back mounts a brand
    // new element at scrollTop 0, and no prop has changed — so nothing else
    // would ever put the reader back. Measured on a real 390x844 viewport
    // before the room's retired hook existed: 1148px before, 0px after.
    const { result } = mountWith(200);

    act(() => result.current.scrollRef(null));
    const remounted = scrollContainer(0);
    act(() => result.current.scrollRef(remounted));

    expect(remounted.scrollTop).toBe(200);
  });

  it('tells the timeline when it has restored a position, so the landing stands down', () => {
    mountWith(200);

    // A second mount of the same conversation — what a returning thread panel
    // produces. The timeline's own landing effect reads this and does nothing.
    const second = renderHook((props: Props) => useTimelineScroll(props), {
      initialProps: { conversationId: 'room-1', rowCount: 10 } as Props,
    });

    expect(second.result.current.restoredPosition).toBe(true);
  });

  it('reports no restored position on a first landing', () => {
    const { result } = mountWith(200, 'session-1');

    expect(result.current.restoredPosition).toBe(false);
  });

  it('leaves a first landing alone, so the timeline can put it on the unread rule', () => {
    // Nothing is remembered for this conversation, so attaching must write no
    // `scrollTop` at all: the timeline scrolls to the unread rule one frame
    // later, and a pin here would fight it.
    const el = scrollContainer(0);
    const view = renderHook((props: Props) => useTimelineScroll(props), {
      initialProps: { conversationId: 'session-1', rowCount: 10 } as Props,
    });

    act(() => view.result.current.scrollRef(el));

    expect(el.scrollTop).toBe(0);
  });

  it('opens the next conversation at its newest message, however the last was left', () => {
    const { el, rerender } = mountWith(200);

    rerender({ conversationId: 'room-2', rowCount: 10 });

    expect(el.scrollTop).toBe(MAX_SCROLL_TOP);
  });

  it('forgets a conversation that was switched away from and back to', () => {
    // Switching rooms is a request to go somewhere else, and every chat surface
    // opens at the newest message. Only a REMOUNT of the same conversation is a
    // return.
    const { el, rerender } = mountWith(200);
    rerender({ conversationId: 'room-2', rowCount: 10 });
    rerender({ conversationId: 'room-1', rowCount: 10 });

    act(() => {
      el.scrollTop = 0;
    });
    const remounted = scrollContainer(0);
    renderHook((props: Props) => useTimelineScroll(props), {
      initialProps: { conversationId: 'room-1', rowCount: 10 } as Props,
    }).result.current.scrollRef(remounted);

    expect(remounted.scrollTop).toBe(0);
  });
});
