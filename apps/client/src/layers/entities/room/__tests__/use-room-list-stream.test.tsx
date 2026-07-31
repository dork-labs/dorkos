// @vitest-environment jsdom
/**
 * The global-stream half of the sidebar's freshness (ADR-0265).
 *
 * A room the reader does not have open sends nothing to this client except
 * through `/api/events`, so what this hook subscribes to IS the mechanism —
 * a row that is not refreshed here is a row that stays wrong until something
 * unrelated happens to refetch it. Both lists it feeds are asserted, because
 * the thread list rides the same events and was added to them later.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRoomListStream } from '../model/use-room-list-stream';

/** Handlers registered by the hook, keyed by the event they wait for. */
const handlers = new Map<string, () => void>();

vi.mock('@/layers/shared/model', () => ({
  useEventSubscription: (event: string, handler: () => void) => {
    handlers.set(event, handler);
  },
}));

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidated: unknown[] = [];
  const spy = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
    invalidated.push(filters?.queryKey);
    return spy(filters as Parameters<typeof spy>[0]);
  }) as typeof queryClient.invalidateQueries;

  renderHook(() => useRoomListStream(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  return invalidated;
}

describe('useRoomListStream', () => {
  beforeEach(() => handlers.clear());

  it('refreshes the Threads list when somebody speaks in a room', () => {
    // `room_activity` fires for a thread reply exactly as it does for a
    // top-level post — a reply IS an entry in the room's log
    // (ADR 260728-022013) — so there is no second event to wait for, and this
    // is the only thing that moves a thread row for a room nobody has open.
    const invalidated = setup();
    handlers.get('room_activity')!();
    expect(invalidated).toContainEqual(['rooms', 'threads']);
    expect(invalidated).toContainEqual(['rooms', 'list']);
  });

  it('subscribes to every event that changes what a row says', () => {
    setup();
    expect([...handlers.keys()].sort()).toEqual([
      'room_activity',
      'room_created',
      'room_member_added',
      'room_member_removed',
      'room_updated',
    ]);
  });

  it('refreshes both lists when a member is removed', () => {
    // Not cosmetic for threads: the aggregation joins on the roster, so losing
    // a membership removes that room's threads from this reader's list
    // entirely. The row has to go on the same event that took the room away.
    const invalidated = setup();
    handlers.get('room_member_removed')!();
    expect(invalidated).toContainEqual(['rooms', 'threads']);
    expect(invalidated).toContainEqual(['rooms', 'list']);
  });

  it('never invalidates the bare root key, which would sweep the histories', () => {
    const invalidated = setup();
    handlers.get('room_activity')!();
    // `['rooms']` prefix-matches `['rooms','entries',id]`, and a room's history
    // belongs to its own stream.
    expect(invalidated).not.toContainEqual(['rooms']);
  });
});
