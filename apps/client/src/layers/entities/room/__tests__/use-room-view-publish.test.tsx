/**
 * @vitest-environment jsdom
 */
/**
 * The debounce and the gate on sharing a position (spec `canvas-agent-seat` §6).
 *
 * Two properties this is the only place that can prove:
 *
 * - **Coalesced at 250 ms.** A burst of moves is one send, carrying the LATEST
 *   position rather than the one that armed the timer. A queue of positions is
 *   a queue of wrong answers.
 * - **Nothing at all while nobody is following**, whatever moves.
 *
 * Seeded defects: sending on every move reddens the burst case; dropping the
 * `followed` gate reddens the silence case.
 *
 * @module entities/room/tests/use-room-view-publish
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { ROOM_FOLLOW_PUBLISH_MS, useRoomFollowStore } from '../model/live/use-room-follow';
import { useRoomViewPublish } from '../model/live/use-room-view-publish';

const ROOM = 'room-1';
const VIEWER = 'author-you';
const KAI = 'author-kai';

let transport: Transport;
/** The move callback the hook handed to `subscribe`, so a test can drive it. */
let moved: (() => void) | null;

/** Render the hook with a subscription a test can fire. */
function renderPublish(url: string) {
  const subscribe = (onMoved: () => void) => {
    moved = onMoved;
    return () => {
      moved = null;
    };
  };
  return renderHook(
    ({ href }: { href: string }) =>
      useRoomViewPublish({
        roomId: ROOM,
        viewerAuthorId: VIEWER,
        documentId: 'page',
        url: href,
        subscribe,
      }),
    {
      initialProps: { href: url },
      wrapper: ({ children }) => (
        <TransportProvider transport={transport}>{children}</TransportProvider>
      ),
    }
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  transport = createMockTransport();
  moved = null;
  useRoomFollowStore.setState({ intent: {}, claims: {}, positions: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sharing a position', () => {
  it('sends nothing at all while nobody is following', () => {
    renderPublish('http://localhost:5173/a');
    act(() => {
      moved?.();
      vi.advanceTimersByTime(ROOM_FOLLOW_PUBLISH_MS * 10);
    });
    expect(transport.publishRoomView).not.toHaveBeenCalled();
  });

  it('coalesces a burst into one send carrying the latest position', () => {
    useRoomFollowStore.setState({ claims: { [ROOM]: { [KAI]: { leaderId: VIEWER, at: 0 } } } });
    const view = renderPublish('http://localhost:5173/a');

    // The first position goes out at once: waiting a quarter second to say where
    // somebody already is would make turning the toggle on look broken.
    expect(transport.publishRoomView).toHaveBeenCalledTimes(1);

    // A burst, all inside one window, with the page changing under it.
    act(() => {
      moved?.();
      vi.advanceTimersByTime(20);
      view.rerender({ href: 'http://localhost:5173/b' });
      moved?.();
      vi.advanceTimersByTime(20);
      view.rerender({ href: 'http://localhost:5173/c' });
      moved?.();
    });
    expect(transport.publishRoomView).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(ROOM_FOLLOW_PUBLISH_MS));
    expect(transport.publishRoomView).toHaveBeenCalledTimes(2);
    expect(transport.publishRoomView).toHaveBeenLastCalledWith(ROOM, {
      documentId: 'page',
      url: 'http://localhost:5173/c',
    });
  });
});
