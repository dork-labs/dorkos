// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStickToBottom } from '../model/use-stick-to-bottom';

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
 * idiom for "go to the bottom" only because the assignment is clamped to
 * {@link MAX_SCROLL_TOP}. A fixture that stored 1000 verbatim would let these
 * tests assert a position no browser ever reports.
 */
function scrollContainer(initialScrollTop: number): HTMLDivElement {
  let scrollTop = initialScrollTop;
  return {
    scrollHeight: SCROLL_HEIGHT,
    clientHeight: CLIENT_HEIGHT,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(next: number) {
      scrollTop = Math.max(0, Math.min(next, MAX_SCROLL_TOP));
    },
  } as HTMLDivElement;
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
    ({ room, newest }: { room: string; newest: string | null }) => useStickToBottom(room, newest),
    { initialProps: { room: roomId, newest: 'entry-1' as string | null } }
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

    rerender({ room: 'room-1', newest: 'entry-2' });

    expect(el.scrollTop).toBe(MAX_SCROLL_TOP);
  });

  it('still follows within the slack — a part-rendered row is not "scrolled up"', () => {
    // 40px from the bottom, inside the 64px slack.
    const { el, rerender } = mountWith(660);

    rerender({ room: 'room-1', newest: 'entry-2' });

    expect(el.scrollTop).toBe(MAX_SCROLL_TOP);
  });

  it('leaves a reader who has scrolled up exactly where they are', () => {
    // 500px from the bottom: reading back through history.
    const { el, rerender } = mountWith(200);

    rerender({ room: 'room-1', newest: 'entry-2' });

    expect(el.scrollTop).toBe(200);
  });

  it('does not move a scrolled-up reader however many entries arrive', () => {
    const { el, rerender } = mountWith(200);

    rerender({ room: 'room-1', newest: 'entry-2' });
    rerender({ room: 'room-1', newest: 'entry-3' });
    rerender({ room: 'room-1', newest: 'entry-4' });

    expect(el.scrollTop).toBe(200);
  });

  it('opens the next room at its newest message, however the last one was left', () => {
    const { el, rerender } = mountWith(200);

    rerender({ room: 'room-2', newest: 'entry-9' });

    expect(el.scrollTop).toBe(MAX_SCROLL_TOP);
  });

  it('scrolls nowhere while a room is still loading its history', () => {
    const { el, rerender } = mountWith(MAX_SCROLL_TOP);

    rerender({ room: 'room-2', newest: null });

    expect(el.scrollTop).toBe(MAX_SCROLL_TOP);
  });
});
