// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry, RoomEvent } from '@dorkos/shared/room-schemas';
import { isStreamOwnedQuery } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { useCreateChannel } from '../model/use-create-room';
import { useRoomEntries } from '../model/use-room';
import { useRoomStream } from '../model/use-room-stream';

const ROOM = 'room-1';

function entry(seq: number): RoomEntry {
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
  };
}

/** The trailing page the server answers a history read with. */
const SERVER_PAGE = [entry(1), entry(2)];

function makeQueryClient(): QueryClient {
  // `staleTime: 0` is the app's own 30s default with the clock wound forward:
  // the app refetches a room's history on the first focus more than half a
  // minute after it loaded, which is nearly every alt-tab back into one. Left at
  // 30s this file would assert nothing at all — the query would still be fresh
  // when the focus fires, so no refetch would happen with or without the fix.
  //
  // `gcTime: Infinity` because the hook's whole job is a cache; the usual test
  // default of 0 collects it out from under the assertions.
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
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

/**
 * The room as it is actually mounted: the history read that hydrates the cache
 * and the live stream that owns it from then on.
 *
 * Both, deliberately — seeding the cache key by hand would build the world in
 * which the code works. The entry beyond the server's page has to get there the
 * way a real one does, off the socket.
 */
function useOpenRoom() {
  const entries = useRoomEntries(ROOM);
  useRoomStream(ROOM, entries.isSuccess);
  return entries;
}

/** The seqs the cache holds, which is what the room would draw. */
function heldSeqs(queryClient: QueryClient): number[] | undefined {
  return queryClient.getQueryData<RoomEntry[]>(roomKeys.entries(ROOM))?.map((held) => held.seq);
}

/** A transport whose room read answers with the trailing page, once. */
function openRoomTransport(): Transport {
  const transport = createMockTransport();
  transport.listRoomEntries = vi.fn().mockResolvedValue(SERVER_PAGE);
  transport.subscribeRoom = vi
    .fn()
    .mockImplementation((_id: string, _cursor: number, signal: AbortSignal) =>
      (async function* (): AsyncIterable<RoomEvent> {
        // The message that arrives after the page — the one a refetch would
        // silently take away, because the read that would replace it predates
        // it and nothing re-delivers it.
        yield { type: 'entry', seq: 3, entry: entry(3) } satisfies RoomEvent;
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      })()
    );
  return transport;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

describe('useRoomEntries — the stream owns this cache', () => {
  it('does not re-read the history when the window comes back into focus', async () => {
    const transport = openRoomTransport();
    const queryClient = makeQueryClient();

    const { unmount } = renderHook(() => useOpenRoom(), {
      wrapper: wrapperFor(transport, queryClient),
    });

    try {
      await waitFor(() => expect(heldSeqs(queryClient)).toEqual([1, 2, 3]));

      // Alt-tab away and back, which is all it used to take.
      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });

      expect(transport.listRoomEntries).toHaveBeenCalledTimes(1);
      // Still three. A refocus refetch answers with the trailing page — [1, 2] —
      // and seq 3 would be gone for as long as the tab stayed open, because the
      // stream only recomputes its cursor when it reconnects.
      expect(heldSeqs(queryClient)).toEqual([1, 2, 3]);
    } finally {
      unmount();
    }
  });

  it('does not re-read the history when the browser comes back online', async () => {
    const transport = openRoomTransport();
    const queryClient = makeQueryClient();

    const { unmount } = renderHook(() => useOpenRoom(), {
      wrapper: wrapperFor(transport, queryClient),
    });

    try {
      await waitFor(() => expect(heldSeqs(queryClient)).toEqual([1, 2, 3]));

      await act(async () => {
        onlineManager.setOnline(false);
        onlineManager.setOnline(true);
      });

      expect(transport.listRoomEntries).toHaveBeenCalledTimes(1);
      expect(heldSeqs(queryClient)).toEqual([1, 2, 3]);
    } finally {
      unmount();
    }
  });

  it('survives creating a channel while the room is open', async () => {
    // The reviewer executed this one: `useCreateChannel` invalidated
    // `roomKeys.all`, which is the PREFIX ['rooms'] — so it matched
    // ['rooms','entries',<id>] as well, and making a channel from the sidebar
    // discarded the open room's history and refetched the trailing page. Every
    // entry the stream had merged beyond that page was gone, with nothing that
    // would ever re-send it. The `meta.streamOwned` flag does not help here:
    // an explicit `queryKey` filter never consults it.
    const transport = openRoomTransport();
    transport.createRoom = vi.fn().mockResolvedValue({ id: 'room-2' });
    const queryClient = makeQueryClient();

    const { result, unmount } = renderHook(
      () => ({
        room: useOpenRoom(),
        create: useCreateChannel({ isInlineErrorVisible: () => false }),
      }),
      { wrapper: wrapperFor(transport, queryClient) }
    );

    try {
      await waitFor(() => expect(heldSeqs(queryClient)).toEqual([1, 2, 3]));

      await act(async () => {
        await result.current.create.mutateAsync({ title: 'somewhere else', agentPaths: [] });
      });

      expect(transport.listRoomEntries).toHaveBeenCalledTimes(1);
      expect(heldSeqs(queryClient)).toEqual([1, 2, 3]);
    } finally {
      unmount();
    }
  });

  it('is left alone by the sweep the global stream fires on recovery', async () => {
    const transport = openRoomTransport();
    const queryClient = makeQueryClient();

    const { unmount } = renderHook(() => useOpenRoom(), {
      wrapper: wrapperFor(transport, queryClient),
    });

    try {
      await waitFor(() => expect(heldSeqs(queryClient)).toEqual([1, 2, 3]));

      // The same predicate `installReconnectInvalidation` passes — one shared
      // definition, so this cannot pass while production sweeps the room away.
      await act(async () => {
        await queryClient.invalidateQueries({ predicate: (query) => !isStreamOwnedQuery(query) });
      });

      expect(transport.listRoomEntries).toHaveBeenCalledTimes(1);
      expect(heldSeqs(queryClient)).toEqual([1, 2, 3]);
    } finally {
      unmount();
    }
  });
});
