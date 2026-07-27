// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStickToBottom } from '../model/use-stick-to-bottom';

/**
 * A stand-in for the scroll container. jsdom lays nothing out, so `scrollHeight`
 * and `clientHeight` are 0 on every real element — the geometry has to be
 * stated, not rendered.
 */
function scrollContainer(scrollTop: number): HTMLDivElement {
  return { scrollHeight: 1000, clientHeight: 300, scrollTop } as HTMLDivElement;
}

/** Mount the hook against a container already scrolled to `scrollTop`. */
function mountWith(scrollTop: number, roomId = 'room-1') {
  const el = scrollContainer(scrollTop);
  const view = renderHook(
    ({ room, newest }: { room: string; newest: string | null }) => useStickToBottom(room, newest),
    { initialProps: { room: roomId, newest: 'entry-1' as string | null } }
  );
  view.result.current.scrollRef.current = el;
  // The container reports its position the way a browser does: on scroll.
  view.result.current.onScroll();
  return { el, ...view };
}

describe('useStickToBottom', () => {
  it('follows a new entry when the reader is already at the bottom', () => {
    // 1000 - 700 - 300 = 0px from the bottom.
    const { el, rerender } = mountWith(700);

    rerender({ room: 'room-1', newest: 'entry-2' });

    expect(el.scrollTop).toBe(1000);
  });

  it('still follows within the slack — a part-rendered row is not "scrolled up"', () => {
    // 40px from the bottom, inside the 64px slack.
    const { el, rerender } = mountWith(660);

    rerender({ room: 'room-1', newest: 'entry-2' });

    expect(el.scrollTop).toBe(1000);
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

    expect(el.scrollTop).toBe(1000);
  });

  it('scrolls nowhere while a room is still loading its history', () => {
    const { el, rerender } = mountWith(700);

    rerender({ room: 'room-2', newest: null });

    expect(el.scrollTop).toBe(700);
  });
});
