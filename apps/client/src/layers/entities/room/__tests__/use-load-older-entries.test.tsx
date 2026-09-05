// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport, mockRoomEntryPage } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { useRoomEntries } from '../model/use-room';
import { useLoadOlderRoomEntries } from '../model/use-load-older-entries';
import { useRoomHistoryPagingStore } from '../model/room-history-paging';

const ROOM = 'room-1';

function entry(seq: number, over?: Partial<RoomEntry>): RoomEntry {
  return {
    roomId: ROOM,
    seq,
    id: `entry-${seq}`,
    authorId: 'ana',
    kind: 'post',
    body: { text: `line ${seq}` },
    mentions: [],
    sessionId: null,
    cascadeRoot: `entry-${seq}`,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
    ...over,
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function wrapperFor(transport: Transport, queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** The seqs the room's one history cache entry holds, oldest first. */
function heldSeqs(queryClient: QueryClient): number[] | undefined {
  return queryClient.getQueryData<RoomEntry[]>(roomKeys.entries(ROOM))?.map((held) => held.seq);
}

/**
 * The room open and reading further back, mounted the way it is in production:
 * the history read hydrates the cache, and this writes into the same one.
 */
function useOpenRoom() {
  const entries = useRoomEntries(ROOM);
  const older = useLoadOlderRoomEntries(ROOM);
  return { entries, older };
}

beforeEach(() => {
  useRoomHistoryPagingStore.setState({ paging: {} });
});

describe('useLoadOlderRoomEntries', () => {
  it('pages from the PAGE’s oldest entry, never the merged history’s', async () => {
    // The bug this exists to prevent, and the reason the wire keeps two arrays.
    // The room opens on entries 10 and 11, and one of them answers entry 2 — so
    // the merged history a reader sees starts at 2, sixty messages below the
    // page floor. Paging from THAT seq asks for entries 1 and nothing else, and
    // everything between 2 and 10 becomes unreachable for as long as the room
    // exists. There is no error and no empty state; the history simply stops.
    const transport = createMockTransport();
    transport.listRoomEntries = vi
      .fn()
      .mockResolvedValueOnce(
        mockRoomEntryPage([entry(10), entry(11, { threadRootEntryId: 'entry-2' })], [entry(2)])
      )
      .mockResolvedValueOnce(mockRoomEntryPage([entry(8), entry(9)]));
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useOpenRoom(), {
      wrapper: wrapperFor(transport, queryClient),
    });
    await waitFor(() => expect(heldSeqs(queryClient)).toEqual([2, 10, 11]));

    await act(async () => {
      await result.current.older.loadOlder();
    });

    expect(transport.listRoomEntries).toHaveBeenLastCalledWith(
      ROOM,
      expect.objectContaining({ before: 10 })
    );
  });

  it('prepends the page into the one history the room already holds', async () => {
    const transport = createMockTransport();
    transport.listRoomEntries = vi
      .fn()
      .mockResolvedValueOnce(mockRoomEntryPage([entry(10), entry(11)]))
      .mockResolvedValueOnce(mockRoomEntryPage([entry(8), entry(9)]));
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useOpenRoom(), {
      wrapper: wrapperFor(transport, queryClient),
    });
    await waitFor(() => expect(heldSeqs(queryClient)).toEqual([10, 11]));

    await act(async () => {
      await result.current.older.loadOlder();
    });

    // One array, in `seq` order, with the older page in FRONT — a second cache
    // beside this one would leave every consumer joining two lists, and the two
    // cursors reading the last element of the wrong one.
    expect(heldSeqs(queryClient)).toEqual([8, 9, 10, 11]);
  });

  it('offers nothing over a room whose first page has not landed', () => {
    const transport = createMockTransport();
    transport.listRoomEntries = vi.fn(() => new Promise<never>(() => {}));
    const { result } = renderHook(() => useOpenRoom(), {
      wrapper: wrapperFor(transport, makeQueryClient()),
    });

    // There is nothing to load older THAN yet, and a control saying otherwise
    // would be offering history nobody can name a cursor for.
    expect(result.current.older.canLoadOlder).toBe(false);
  });

  it('offers nothing over a room with nothing in it', async () => {
    const transport = createMockTransport();
    transport.listRoomEntries = vi.fn().mockResolvedValue(mockRoomEntryPage());
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useOpenRoom(), {
      wrapper: wrapperFor(transport, queryClient),
    });
    await waitFor(() => expect(result.current.entries.isSuccess).toBe(true));

    expect(result.current.older.canLoadOlder).toBe(false);
  });

  it('takes the offer away once a read comes back with nothing older', async () => {
    // How a reader learns they have reached the beginning of a room. Measured
    // on what came BACK rather than on how full the page was: a page can be
    // short mid-room and exactly full with nothing behind it, and only "this
    // read grew the history by nothing" is true in both.
    const transport = createMockTransport();
    transport.listRoomEntries = vi
      .fn()
      .mockResolvedValueOnce(mockRoomEntryPage([entry(1), entry(2)]))
      .mockResolvedValueOnce(mockRoomEntryPage());
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useOpenRoom(), {
      wrapper: wrapperFor(transport, queryClient),
    });
    await waitFor(() => expect(result.current.older.canLoadOlder).toBe(true));

    await act(async () => {
      await result.current.older.loadOlder();
    });

    await waitFor(() => expect(result.current.older.canLoadOlder).toBe(false));
    expect(heldSeqs(queryClient)).toEqual([1, 2]);
  });

  it('keeps offering while there is more, so a reader can walk a room back', async () => {
    const transport = createMockTransport();
    transport.listRoomEntries = vi
      .fn()
      .mockResolvedValueOnce(mockRoomEntryPage([entry(5), entry(6)]))
      .mockResolvedValueOnce(mockRoomEntryPage([entry(3), entry(4)]))
      .mockResolvedValueOnce(mockRoomEntryPage([entry(1), entry(2)]));
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useOpenRoom(), {
      wrapper: wrapperFor(transport, queryClient),
    });
    await waitFor(() => expect(result.current.older.canLoadOlder).toBe(true));

    await act(async () => {
      await result.current.older.loadOlder();
    });
    await act(async () => {
      await result.current.older.loadOlder();
    });

    expect(heldSeqs(queryClient)).toEqual([1, 2, 3, 4, 5, 6]);
    // The second read paged from the second page's floor, not from the first's.
    expect(transport.listRoomEntries).toHaveBeenLastCalledWith(
      ROOM,
      expect.objectContaining({ before: 3 })
    );
    expect(result.current.older.canLoadOlder).toBe(true);
  });

  it('leaves the room readable when the read fails', async () => {
    // The failure is reported by the mutation cache's own handler; what must not
    // happen is the rejection escaping into the press that started it, or the
    // history losing what it had.
    const transport = createMockTransport();
    transport.listRoomEntries = vi
      .fn()
      .mockResolvedValueOnce(mockRoomEntryPage([entry(5), entry(6)]))
      .mockRejectedValueOnce(new Error('offline'));
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useOpenRoom(), {
      wrapper: wrapperFor(transport, queryClient),
    });
    await waitFor(() => expect(result.current.older.canLoadOlder).toBe(true));

    await act(async () => {
      await expect(result.current.older.loadOlder()).resolves.toBeUndefined();
    });

    expect(heldSeqs(queryClient)).toEqual([5, 6]);
    // Still offered: a read that failed is not a room that has ended.
    expect(result.current.older.canLoadOlder).toBe(true);
  });
});
