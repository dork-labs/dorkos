// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTimelineScroll } from '../use-timeline-scroll';

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

  it('opens the next conversation at its newest message, however the last was left', () => {
    const { el, rerender } = mountWith(200);

    rerender({ conversationId: 'room-2', rowCount: 10 });

    expect(el.scrollTop).toBe(MAX_SCROLL_TOP);
  });

  it('reports where the reader is from a ref, so an unmount can read it', () => {
    // The timeline forgets a conversation left at the bottom, and it does that
    // from a cleanup — where state is whatever the last render closed over, and
    // the last render is not the moment the reader left.
    const { el, result } = mountWith(200);
    expect(result.current.atBottomRef.current).toBe(false);

    act(() => {
      el.scrollTop = MAX_SCROLL_TOP;
      result.current.onScroll();
    });

    expect(result.current.atBottomRef.current).toBe(true);
  });
});
