/**
 * @vitest-environment jsdom
 */
/**
 * Holding a follow claim, and letting it go (spec `canvas-agent-seat` §6).
 *
 * Three properties:
 *
 * - **Leaving the room forgets the choice.** Following is off by default and
 *   never persisted, so coming back must be coming back to "Follow", not to a
 *   follow nobody re-chose. The Browser tab's own cleanup cannot do this: it
 *   runs on a tab switch, which is not leaving.
 * - **The claim is restated on the beat**, because the server drops one nobody
 *   has restated inside the TTL — which is what makes a closed tab, a crashed
 *   browser and a lost network the same event.
 * - **Looking away is not following.** A blurred window stops.
 *
 * Seeded defects: removing the `forgetRoom` cleanup reddens the first case;
 * removing the interval reddens the second; removing the `blur` listener
 * reddens the third.
 *
 * @module entities/room/tests/use-room-follow-claim
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { ROOM_FOLLOW_REFRESH_MS, useRoomFollowStore } from '../model/live/use-room-follow';
import {
  useForgetRoomFollowOnLeave,
  useRoomFollowClaim,
} from '../model/live/use-room-follow-claim';

const ROOM = 'room-1';
const KAI = 'author-kai';

let transport: Transport;

/** The Browser tab's hook — mounted and unmounted by a TAB switch. */
function renderPanel() {
  return renderHook(() => useRoomFollowClaim(ROOM), {
    wrapper: ({ children }) => (
      <TransportProvider transport={transport}>{children}</TransportProvider>
    ),
  });
}

/** The room view's hook — mounted and unmounted by LEAVING the room. */
function renderRoomView() {
  return renderHook(() => useForgetRoomFollowOnLeave(ROOM));
}

beforeEach(() => {
  vi.useFakeTimers();
  transport = createMockTransport();
  useRoomFollowStore.setState({ intent: {}, claims: {}, positions: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('holding a follow claim', () => {
  it('says so again on the beat, so the server does not drop it', () => {
    const panel = renderPanel();
    act(() => panel.result.current.follow(KAI));
    expect(transport.followRoomMember).toHaveBeenCalledWith(ROOM, KAI);

    act(() => vi.advanceTimersByTime(3 * ROOM_FOLLOW_REFRESH_MS));
    expect(transport.followRoomMember).toHaveBeenCalledTimes(4);
  });

  it('lets the claim go when the window is looked away from', () => {
    const panel = renderPanel();
    act(() => panel.result.current.follow(KAI));

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(useRoomFollowStore.getState().intent[ROOM]).toBeUndefined();
  });
});

describe('leaving the room', () => {
  it('does not resume a follow when the reader comes straight back', () => {
    const room = renderRoomView();
    const panel = renderPanel();
    act(() => panel.result.current.follow(KAI));
    expect(useRoomFollowStore.getState().intent[ROOM]?.leaderId).toBe(KAI);

    // The panel goes first — every unmount does that — and then the ROOM does.
    act(() => {
      panel.unmount();
      room.unmount();
    });
    expect(useRoomFollowStore.getState().intent[ROOM]).toBeUndefined();

    // Straight back in, well inside the thirty seconds a claim would have
    // survived. The toggle reads "Follow", because nobody chose otherwise.
    act(() => vi.advanceTimersByTime(1_000));
    renderRoomView();
    const again = renderPanel();
    expect(again.result.current.following).toBeNull();
  });

  it('keeps a tab switch from being mistaken for leaving', () => {
    // The panel alone unmounting is somebody looking at the Canvas tab. The
    // server claim goes (it is restated from the panel), and the CHOICE stays,
    // so switching back does not make them pick again.
    renderRoomView();
    const panel = renderPanel();
    act(() => panel.result.current.follow(KAI));
    act(() => panel.unmount());

    expect(useRoomFollowStore.getState().intent[ROOM]?.leaderId).toBe(KAI);
  });
});
