// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { REACTION_FREQUENTS_DEFAULT } from '@dorkos/shared/room-schemas';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { useMarkRoomRead, useMarkRoomReadNow } from '../model/use-mark-room-read';

function entry(seq: number): RoomEntry {
  return {
    roomId: 'room-1',
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

function roomWith(members: RoomWithRoster['members'], viewerAuthorId = 'me'): RoomWithRoster {
  return {
    id: 'room-1',
    kind: 'channel',
    slug: 'general',
    title: '#general',
    topic: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-26T09:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    members,
    viewerAuthorId,
    reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
  };
}

function human(
  lastReadSeq: number,
  id = 'me',
  displayName = 'You'
): RoomWithRoster['members'][number] {
  return {
    roomId: 'room-1',
    authorId: id,
    responseMode: 'always',
    joinedAt: '2026-07-26T09:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq,
    author: { id, kind: 'human', displayName, handle: null },
    origin: 'local',
  };
}

function agent(): RoomWithRoster['members'][number] {
  return {
    roomId: 'room-1',
    authorId: 'ana',
    responseMode: 'always',
    joinedAt: '2026-07-26T09:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    author: { id: 'ana', kind: 'agent', displayName: 'Ana', handle: null },
    origin: 'local',
  };
}

function wrapperFor(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useMarkRoomRead', () => {
  it('advances the cursor to the newest entry on read', async () => {
    const transport = createMockTransport();
    renderHook(() => useMarkRoomRead(roomWith([human(1), agent()]), [entry(1), entry(4)]), {
      wrapper: wrapperFor(transport),
    });
    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledWith('room', 'room-1', 4));
  });

  it('reads the viewer’s own cursor when two people are in the room', async () => {
    // Dorian is ahead (9) and sorts first; Priya, the viewer, is behind (1).
    // `find(kind === 'human')` returned Dorian, read his cursor as caught up,
    // and said nothing — leaving Priya’s badge sitting there with nothing
    // in the product able to clear it.
    const transport = createMockTransport();
    renderHook(
      () =>
        useMarkRoomRead(
          roomWith([human(9, 'dorian', 'Dorian'), human(1, 'priya', 'Priya')], 'priya'),
          [entry(1), entry(4)]
        ),
      { wrapper: wrapperFor(transport) }
    );
    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledWith('room', 'room-1', 4));
  });

  it('stays quiet when the viewer is caught up and the OTHER person is behind', async () => {
    // The same bug in the other direction: reading Priya’s cursor would have
    // sent a write on Dorian’s behalf that he did not need.
    const transport = createMockTransport();
    renderHook(
      () =>
        useMarkRoomRead(
          roomWith([human(1, 'priya', 'Priya'), human(9, 'dorian', 'Dorian')], 'dorian'),
          [entry(4)]
        ),
      { wrapper: wrapperFor(transport) }
    );
    await act(async () => {});
    expect(transport.setReadCursor).not.toHaveBeenCalled();
  });

  it('says nothing when the reader is already caught up', async () => {
    const transport = createMockTransport();
    renderHook(() => useMarkRoomRead(roomWith([human(4)]), [entry(4)]), {
      wrapper: wrapperFor(transport),
    });
    await act(async () => {});
    expect(transport.setReadCursor).not.toHaveBeenCalled();
  });

  it('says nothing for a reader who is not a member — they have no cursor', async () => {
    const transport = createMockTransport();
    renderHook(() => useMarkRoomRead(roomWith([agent()]), [entry(1)]), {
      wrapper: wrapperFor(transport),
    });
    await act(async () => {});
    expect(transport.setReadCursor).not.toHaveBeenCalled();
  });

  it('says nothing while the room is still loading', async () => {
    const transport = createMockTransport();
    renderHook(() => useMarkRoomRead(undefined, []), { wrapper: wrapperFor(transport) });
    await act(async () => {});
    expect(transport.setReadCursor).not.toHaveBeenCalled();
  });

  it('never invalidates the history the stream owns', async () => {
    // `roomKeys.all` is `['rooms']`, which prefix-matches `['rooms','entries',id]`.
    // Invalidating it would refetch the open room's history on every cursor
    // write, and an entry delivered by SSE mid-flight would be overwritten by the
    // older snapshot the in-flight GET returns — lost, because the stream resumes
    // from cache and never re-delivers it.
    const transport = createMockTransport();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    const invalidated: unknown[] = [];
    const spy = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
      invalidated.push(filters?.queryKey);
      return spy(filters as never);
    }) as typeof queryClient.invalidateQueries;

    renderHook(() => useMarkRoomRead(roomWith([human(1)]), [entry(4)]), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    });

    await waitFor(() => expect(invalidated.length).toBeGreaterThan(0));
    expect(invalidated).toContainEqual(['rooms', 'list']);
    expect(invalidated).toContainEqual(['rooms', 'detail', 'room-1']);
    // The Threads list is measured against this very cursor — one per
    // `(member, room)`, shared with the room's threads — so moving it and not
    // refreshing that list leaves an unread count beside a room just read.
    expect(invalidated).toContainEqual(['rooms', 'threads']);
    // The bare root key would sweep the entries cache with it.
    expect(invalidated).not.toContainEqual(['rooms']);
  });

  it('retries a failed write rather than writing that (room, seq) off', async () => {
    const transport = createMockTransport({
      setReadCursor: vi.fn().mockRejectedValue(new Error('offline')),
    });
    const { rerender } = renderHook(
      ({ cursor }: { cursor: number }) => useMarkRoomRead(roomWith([human(cursor)]), [entry(4)]),
      { wrapper: wrapperFor(transport), initialProps: { cursor: 1 } }
    );
    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledTimes(1));
    // The failure released the marker, so the next thing that moves in the room
    // — here a refetch showing another client had read up to 2 — retries the
    // write instead of treating seq 4 as already sent.
    rerender({ cursor: 2 });
    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledTimes(2));
    expect(transport.setReadCursor).toHaveBeenLastCalledWith('room', 'room-1', 4);
  });

  it('does not re-send when a refetch returns the same facts in new objects', async () => {
    // A room refetch hands back fresh object identities. Keying the effect on
    // those would send a write per refetch — and, after a failure released the
    // marker, would do it in a loop.
    const transport = createMockTransport();
    const { rerender } = renderHook(
      ({ tick }: { tick: number }) =>
        useMarkRoomRead(roomWith([human(1), agent()]), [entry(4), entry(4 + tick * 0)]),
      { wrapper: wrapperFor(transport), initialProps: { tick: 0 } }
    );
    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledTimes(1));
    rerender({ tick: 1 });
    rerender({ tick: 2 });
    await act(async () => {});
    expect(transport.setReadCursor).toHaveBeenCalledTimes(1);
  });

  it('sends one write per (room, seq), so a stale refetch cannot start a loop', async () => {
    const transport = createMockTransport();
    const { rerender } = renderHook(
      ({ room }: { room: RoomWithRoster }) => useMarkRoomRead(room, [entry(4)]),
      { wrapper: wrapperFor(transport), initialProps: { room: roomWith([human(1)]) } }
    );
    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledTimes(1));
    // A refetch that has not yet reflected the write re-renders with the old cursor.
    rerender({ room: roomWith([human(1)]) });
    await act(async () => {});
    expect(transport.setReadCursor).toHaveBeenCalledTimes(1);
  });
});

describe('useMarkRoomReadNow', () => {
  /** Collect the keys a run of the hook invalidates. */
  function recordingWrapper() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    const invalidated: unknown[] = [];
    const spy = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
      invalidated.push(filters?.queryKey);
      return spy(filters as Parameters<typeof spy>[0]);
    }) as typeof queryClient.invalidateQueries;
    return { queryClient, invalidated };
  }

  it('refreshes the Threads list, so "Mark as read" clears a thread badge too', async () => {
    // The menu action, not the automatic cursor above it — a separate mutation
    // with a separate onSuccess, so it needs its own assertion. Without this
    // the row's count survives the very action named "Mark as read".
    const transport = createMockTransport({
      listRoomEntries: vi.fn().mockResolvedValue([entry(7)]),
    });
    const { queryClient, invalidated } = recordingWrapper();
    const { result } = renderHook(() => useMarkRoomReadNow(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    });

    await act(async () => {
      result.current.mutate('room-1');
    });

    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledWith('room', 'room-1', 7));
    await waitFor(() => expect(invalidated).toContainEqual(['rooms', 'threads']));
    expect(invalidated).toContainEqual(['rooms', 'list']);
    expect(invalidated).toContainEqual(['rooms', 'detail', 'room-1']);
  });

  it('marks the NEWEST entry read, not the thread root riding in front of it', async () => {
    // A one-entry page is not a one-entry answer any more (DOR-690): when the
    // room's newest line is a reply to something older than the window, the root
    // comes back with it and history arrives oldest-first. Reading the first
    // element would move the cursor BACKWARDS onto that root and leave the badge
    // exactly where the reader just pressed to clear it.
    const transport = createMockTransport({
      listRoomEntries: vi.fn().mockResolvedValue([entry(1), entry(204)]),
    });
    const { queryClient } = recordingWrapper();
    const { result } = renderHook(() => useMarkRoomReadNow(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    });

    await act(async () => {
      result.current.mutate('room-1');
    });

    await waitFor(() =>
      expect(transport.setReadCursor).toHaveBeenCalledWith('room', 'room-1', 204)
    );
  });
});
