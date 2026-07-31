// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { HANDOFF_WINDOW_MS, useThreadArrivals } from '../model/use-thread-arrivals';

afterEach(cleanup);

function reply(seq: number, authorId = 'ana'): RoomEntry {
  return {
    roomId: 'room-1',
    seq,
    id: `reply-${seq}`,
    authorId,
    kind: 'post',
    body: { text: `line ${seq}` },
    mentions: [],
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 1,
    parentEntryId: 'entry-1',
    threadRootEntryId: 'entry-1',
    signature: null,
    createdAt: '2026-07-30T10:00:00.000Z',
  } as RoomEntry;
}

describe('useThreadArrivals', () => {
  it('draws a thread that was already there at rest', () => {
    // Opening a panel onto ten replies must not replay ten arrivals: mounting
    // and arriving are different events, and only the second one is motion.
    const { result } = renderHook(() => useThreadArrivals([reply(1), reply(2)], [], true));

    expect([...result.current.values()]).toEqual(['at-rest', 'at-rest']);
  });

  it('drops in a reply that lands while the panel is open', () => {
    const { result, rerender } = renderHook(({ replies }) => useThreadArrivals(replies, [], true), {
      initialProps: { replies: [reply(1)] },
    });

    rerender({ replies: [reply(1), reply(2)] });

    expect(result.current.get('reply-1')).toBe('at-rest');
    expect(result.current.get('reply-2')).toBe('dropped');
  });

  it('hands off when the author was on the presence line a moment ago', () => {
    // The line goes and the words appear. Those are one gesture, not two
    // things happening near each other (design record §5.4).
    const { result, rerender } = renderHook(
      ({ replies, working }) => useThreadArrivals(replies, working, true),
      { initialProps: { replies: [reply(1)], working: ['bo'] } }
    );

    rerender({ replies: [reply(1), reply(2, 'bo')], working: [] });

    expect(result.current.get('reply-2')).toBe('handed-off');
  });

  it('drops in a reply from somebody who was not working', () => {
    const { result, rerender } = renderHook(
      ({ replies, working }) => useThreadArrivals(replies, working, true),
      { initialProps: { replies: [reply(1)], working: ['bo'] } }
    );

    rerender({ replies: [reply(1), reply(2, 'ana')], working: [] });

    expect(result.current.get('reply-2')).toBe('dropped');
  });

  it('never changes its mind about a reply it has already placed', () => {
    // An animation is a one-shot about a moment. A value that could flip on a
    // later render would replay it — a reply re-bouncing because a reaction
    // landed on its neighbour.
    const { result, rerender } = renderHook(
      ({ replies, working }) => useThreadArrivals(replies, working, true),
      { initialProps: { replies: [reply(1)], working: [] as string[] } }
    );

    rerender({ replies: [reply(1), reply(2)], working: [] });
    expect(result.current.get('reply-2')).toBe('dropped');

    rerender({ replies: [reply(1), reply(2), reply(3)], working: [] });
    expect(result.current.get('reply-2')).toBe('dropped');
  });

  it('draws a deep-linked thread at rest, not as ten arrivals', () => {
    // The panel mounts before the room's history loads, so the first commit
    // sees NO replies — which is not the same as a thread that has none.
    // Seeding on that empty pass made every already-existing reply look like an
    // arrival and bounce in, on every single `?thread=` load.
    const { result, rerender } = renderHook(
      ({ replies, loaded }) => useThreadArrivals(replies, [], loaded),
      { initialProps: { replies: [] as RoomEntry[], loaded: false } }
    );

    rerender({ replies: [reply(1), reply(2)], loaded: true });

    expect([...result.current.values()]).toEqual(['at-rest', 'at-rest']);
  });

  it('hands off even when the presence clear lands on an earlier render', () => {
    // The shape the running app actually produces: the room's stream writes the
    // presence clear and the reply from outside React, so they arrive as two
    // separate external-store notifications and React commits the clear FIRST.
    // Comparing against the previous render's working list saw an empty one and
    // called a genuine answer an ordinary drop.
    const { result, rerender } = renderHook(
      ({ replies, working }) => useThreadArrivals(replies, working, true),
      { initialProps: { replies: [reply(1)], working: ['bo'] } }
    );

    // Commit one: presence clears, no reply yet.
    rerender({ replies: [reply(1)], working: [] });
    // Commit two: the reply appears, with nobody working any more.
    rerender({ replies: [reply(1), reply(2, 'bo')], working: [] });

    expect(result.current.get('reply-2')).toBe('handed-off');
  });

  /**
   * The window is pinned from BOTH sides, on an injected clock.
   *
   * With only a floor test, `HANDOFF_WINDOW_MS` could be raised to ten minutes
   * and every test still passed — so the bound was not really being checked.
   *
   * The times below are LITERAL milliseconds, deliberately, and not expressed
   * against the constant. A test that ticks to `HANDOFF_WINDOW_MS - 1` moves
   * with whatever the constant becomes and compares it with itself — which is
   * how a ten-minute window passed a suite that appeared to bound it. These say
   * where the window actually is; changing the policy has to change them too.
   */
  describe('the hand-off window', () => {
    /** Drive the hook on a clock the test moves by hand. */
    function onClock(startWorking: string[]) {
      let clock = 0;
      const view = renderHook(
        ({ replies, working }) => useThreadArrivals(replies, working, true, () => clock),
        { initialProps: { replies: [reply(1)], working: startWorking } }
      );
      return { view, tick: (to: number) => (clock = to) };
    }

    it('is three seconds — the number the tests below are written against', () => {
      expect(HANDOFF_WINDOW_MS).toBe(3_000);
    });

    it('still calls a reply an answer just inside the window', () => {
      const { view, tick } = onClock(['bo']);

      view.rerender({ replies: [reply(1)], working: [] });
      tick(2_900);
      view.rerender({ replies: [reply(1), reply(2, 'bo')], working: [] });

      expect(view.result.current.get('reply-2')).toBe('handed-off');
    });

    it('stops calling it one once the window has passed', () => {
      // An agent that finished, went quiet, and said something else much later
      // is not answering the wait the presence line was about.
      const { view, tick } = onClock(['bo']);

      view.rerender({ replies: [reply(1)], working: [] });
      tick(3_100);
      view.rerender({ replies: [reply(1), reply(2, 'bo')], working: [] });

      expect(view.result.current.get('reply-2')).toBe('dropped');
    });
  });

  it('forgets a reply that is no longer on screen', () => {
    // A map that only grows is a leak across every thread opened in a session.
    const { result, rerender } = renderHook(({ replies }) => useThreadArrivals(replies, [], true), {
      initialProps: { replies: [reply(1), reply(2)] },
    });

    rerender({ replies: [reply(9)] });

    expect(result.current.has('reply-1')).toBe(false);
    expect(result.current.has('reply-9')).toBe(true);
  });
});
