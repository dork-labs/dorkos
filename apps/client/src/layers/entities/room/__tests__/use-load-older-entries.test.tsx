// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport, mockRoomEntryPage } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { ROOM_ENTRY_PAGE_SIZE_DEFAULT, type RoomEntry } from '@dorkos/shared/room-schemas';
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

/**
 * Exactly the page the client asks for — which is what makes a room look like it
 * has more behind it.
 *
 * A page shorter than the limit is the beginning of the room on this route
 * (`pageReachesTheBeginning`), so every fixture here that needs the control
 * OFFERED has to answer with a full one. Two entries would be a room with two
 * entries in it, and nothing to page back through.
 *
 * @param from - The `seq` the page starts at.
 */
function fullPage(from = 1): RoomEntry[] {
  return Array.from({ length: ROOM_ENTRY_PAGE_SIZE_DEFAULT }, (_, i) => entry(from + i));
}

beforeEach(() => {
  useRoomHistoryPagingStore.setState({ paging: {} });
});

describe('useLoadOlderRoomEntries', () => {
  it('pages from the PAGE’s oldest entry, never the merged history’s', async () => {
    // The bug this exists to prevent, and the reason the wire keeps two arrays.
    // The room opens on a page running from seq 10, and one entry in it answers
    // entry 2 — so the merged history a reader sees starts at 2, eight messages
    // below the page floor. Paging from THAT seq asks for entry 1 and nothing
    // else, and everything between 2 and 10 becomes unreachable for as long as
    // the room exists. There is no error and no empty state; the history simply
    // stops.
    const page = fullPage(10);
    page[1] = entry(11, { threadRootEntryId: 'entry-2' });
    const transport = createMockTransport();
    transport.listRoomEntries = vi
      .fn()
      .mockResolvedValueOnce(mockRoomEntryPage(page, [entry(2)]))
      .mockResolvedValueOnce(mockRoomEntryPage([entry(8), entry(9)]));
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useOpenRoom(), {
      wrapper: wrapperFor(transport, queryClient),
    });
    await waitFor(() => expect(heldSeqs(queryClient)?.[0]).toBe(2));

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
      .mockResolvedValueOnce(mockRoomEntryPage(fullPage(10)))
      .mockResolvedValueOnce(mockRoomEntryPage([entry(8), entry(9)]));
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useOpenRoom(), {
      wrapper: wrapperFor(transport, queryClient),
    });
    await waitFor(() => expect(heldSeqs(queryClient)?.[0]).toBe(10));

    await act(async () => {
      await result.current.older.loadOlder();
    });

    // One array, in `seq` order, with the older page in FRONT — a second cache
    // beside this one would leave every consumer joining two lists, and the two
    // cursors reading the last element of the wrong one.
    const held = heldSeqs(queryClient)!;
    expect(held.slice(0, 3)).toEqual([8, 9, 10]);
    expect(held.at(-1)).toBe(10 + ROOM_ENTRY_PAGE_SIZE_DEFAULT - 1);
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

  it('offers nothing over a room that fitted in its first page', async () => {
    // The overwhelmingly common room, and the reason a short page is the
    // PRIMARY signal rather than a fallback: `GET /:id/entries` is one `WHERE`
    // with an `ORDER BY` and a `LIMIT` and filters nothing afterwards, so two
    // entries back from a read that asked for fifty means there were two. A
    // boundary that waited to be proved by a press instead would hang a dead
    // control over nearly every room in the product.
    const transport = createMockTransport();
    transport.listRoomEntries = vi.fn().mockResolvedValue(mockRoomEntryPage([entry(1), entry(2)]));
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useOpenRoom(), {
      wrapper: wrapperFor(transport, queryClient),
    });
    await waitFor(() => expect(result.current.entries.isSuccess).toBe(true));

    expect(result.current.older.canLoadOlder).toBe(false);
    // And it cost nothing to know: no second read was needed to find out.
    expect(transport.listRoomEntries).toHaveBeenCalledTimes(1);
  });

  it('takes the offer away when an exactly-full last page is followed by nothing', async () => {
    // The one case page-fullness gets wrong, and how it corrects itself. A room
    // holding exactly one page looks identical to a room holding more, so the
    // control is offered once — and the read behind it comes back empty, which
    // is short by any measure.
    const transport = createMockTransport();
    transport.listRoomEntries = vi
      .fn()
      .mockResolvedValueOnce(mockRoomEntryPage(fullPage()))
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
  });

  it('does not let a second press in flight decide the room has ended', async () => {
    // The re-entrancy guard, which is the GATE — the button's `disabled` is an
    // affordance and this callback is reachable without it. Two presses at the
    // same cursor would read the same page twice; the second merge changes
    // nothing, and "this read grew the history by nothing" would then be
    // recorded as the beginning of a room with plenty left.
    const transport = createMockTransport();
    let answerSecondPage!: (page: ReturnType<typeof mockRoomEntryPage>) => void;
    transport.listRoomEntries = vi
      .fn()
      .mockResolvedValueOnce(mockRoomEntryPage(fullPage()))
      .mockReturnValueOnce(
        new Promise<ReturnType<typeof mockRoomEntryPage>>((resolve) => {
          answerSecondPage = resolve;
        })
      );
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useOpenRoom(), {
      wrapper: wrapperFor(transport, queryClient),
    });
    await waitFor(() => expect(result.current.older.canLoadOlder).toBe(true));

    // Two presses, the second while the first read is still in the air.
    let first!: Promise<void>;
    await act(async () => {
      first = result.current.older.loadOlder();
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.older.loadOlder();
    });

    // The second press bought no second read.
    expect(transport.listRoomEntries).toHaveBeenCalledTimes(2);

    await act(async () => {
      answerSecondPage(mockRoomEntryPage(fullPage(51)));
      await first;
    });

    // …and the room is still offering the history it still has.
    expect(result.current.older.canLoadOlder).toBe(true);
  });

  it('keeps offering while there is more, so a reader can walk a room back', async () => {
    // Three full pages, tiling a room 150 entries deep from the newest back.
    const transport = createMockTransport();
    transport.listRoomEntries = vi
      .fn()
      .mockResolvedValueOnce(mockRoomEntryPage(fullPage(101)))
      .mockResolvedValueOnce(mockRoomEntryPage(fullPage(51)))
      .mockResolvedValueOnce(mockRoomEntryPage(fullPage(1)));
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

    // Every entry, once, in the room's own order.
    expect(heldSeqs(queryClient)).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
    // The second read paged from the SECOND page's floor, not the first's — a
    // cursor that failed to move is a reader stuck reading one page forever.
    expect(transport.listRoomEntries).toHaveBeenLastCalledWith(
      ROOM,
      expect.objectContaining({ before: 51 })
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
      .mockResolvedValueOnce(mockRoomEntryPage(fullPage(5)))
      .mockRejectedValueOnce(new Error('offline'));
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useOpenRoom(), {
      wrapper: wrapperFor(transport, queryClient),
    });
    await waitFor(() => expect(result.current.older.canLoadOlder).toBe(true));

    await act(async () => {
      await expect(result.current.older.loadOlder()).resolves.toBeUndefined();
    });

    expect(heldSeqs(queryClient)).toHaveLength(ROOM_ENTRY_PAGE_SIZE_DEFAULT);
    // Still offered: a read that failed is not a room that has ended.
    expect(result.current.older.canLoadOlder).toBe(true);
  });
});
