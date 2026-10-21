// @vitest-environment jsdom
/**
 * The Threads page draws a page at a time and never takes a drawn card away
 * from under the reader (DOR-3078).
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ThreadSummary } from '@dorkos/shared/room-schemas';
import { THREADS_PAGE_SIZE, useShownThreads } from '../model/use-shown-threads';

/** `count` threads, `t0` newest. */
function threads(count: number): ThreadSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    roomId: 'room-design',
    roomKind: 'channel',
    roomSlug: 'design',
    roomTitle: 'design',
    rootEntryId: `t${index}`,
    rootAuthorId: 'ana',
    rootPreview: `thread ${index}`,
    replyCount: 1,
    unreadCount: 0,
    lastActivityAt: '2026-07-30T10:00:00.000Z',
  }));
}

const ids = (list: readonly ThreadSummary[]) => list.map((thread) => thread.rootEntryId);

describe('useShownThreads', () => {
  it('draws one page, then one more per press', () => {
    const { result } = renderHook(() => useShownThreads(threads(20)));
    expect(result.current.visible).toHaveLength(THREADS_PAGE_SIZE);
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.showMore());
    expect(result.current.visible).toHaveLength(20);
    expect(result.current.hasMore).toBe(false);
  });

  it('keeps a drawn card when a reply lower down pushes it past the cutoff', () => {
    const initial = threads(20);
    const { result, rerender } = renderHook(({ list }) => useShownThreads(list), {
      initialProps: { list: initial },
    });
    expect(ids(result.current.visible)).toContain('t11');

    // A reply lands in t15, which moves to the top; t11 is now thirteenth.
    const reordered = [initial[15]!, ...initial.filter((thread) => thread.rootEntryId !== 't15')];
    rerender({ list: reordered });
    expect(ids(result.current.visible)).toContain('t11');
    expect(ids(result.current.visible)[0]).toBe('t15');
    expect(result.current.visible).toHaveLength(THREADS_PAGE_SIZE + 1);
  });

  it('asks for focus on the first new card only when the last page is shown', () => {
    const { result } = renderHook(() => useShownThreads(threads(30)));
    act(() => result.current.showMore());
    expect(result.current.focusId).toBeNull();
    act(() => result.current.showMore());
    expect(result.current.focusId).toBe('t24');
    act(() => result.current.focused());
    expect(result.current.focusId).toBeNull();
  });
});
