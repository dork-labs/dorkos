// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry, RoomSummary } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { useRooms, useRoomsByKind } from '../model/use-rooms';
import { useRoom, useRoomEntries } from '../model/use-room';
import { useCreateChannel, useStartDirectMessage } from '../model/use-create-room';
import { mergeRoomEntry } from '../model/use-room-stream';

function room(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'room-1',
    kind: 'channel',
    slug: 'general',
    title: '#general',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-26T10:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    unreadCount: null,
    participants: null,
    ...overrides,
  };
}

function entry(seq: number, overrides: Partial<RoomEntry> = {}): RoomEntry {
  return {
    roomId: 'room-1',
    seq,
    id: `entry-${seq}`,
    authorId: 'author-1',
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
    ...overrides,
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

describe('useRooms', () => {
  it('reads the room list through the Transport port', async () => {
    const transport = createMockTransport({
      listRooms: vi.fn().mockResolvedValue([room()]),
    });
    const { result } = renderHook(() => useRooms(), { wrapper: wrapperFor(transport) });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(transport.listRooms).toHaveBeenCalled();
  });

  it('leaves archived rooms out unless a caller asks for them', async () => {
    const transport = createMockTransport({ listRooms: vi.fn().mockResolvedValue([]) });
    const { result } = renderHook(() => useRooms(), { wrapper: wrapperFor(transport) });
    await waitFor(() => expect(result.current.data).toBeDefined());

    // The sidebar, the room view, the presence strip and everything else read
    // this hook. Asking for archived rooms by default would put a closed
    // channel back in every one of those lists.
    //
    // And the flag is OMITTED rather than sent as `false`. The route parses it
    // with `z.coerce.boolean()`, and a query string carries `false` as the
    // four-character string `"false"` — which coerces to `true`. Spelling out
    // the negative here would turn archived rooms on everywhere.
    expect(transport.listRooms).toHaveBeenCalledWith();
  });

  it('asks for them when one does', async () => {
    const transport = createMockTransport({ listRooms: vi.fn().mockResolvedValue([]) });
    const { result } = renderHook(() => useRooms({ includeArchived: true }), {
      wrapper: wrapperFor(transport),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(transport.listRooms).toHaveBeenCalledWith({ includeArchived: true });
  });

  it('keeps the two answers in separate cache entries', async () => {
    // The whole risk in making archived rooms findable: one cache key for both
    // questions means whichever consumer fetched last decides what the SIDEBAR
    // shows. Two readers, one client, two fetches, two different lists.
    const live = room({ id: 'live', slug: 'live' });
    const closed = room({ id: 'closed', slug: 'closed', archived: true });
    const transport = createMockTransport({
      listRooms: vi.fn(async (query?: { includeArchived?: boolean }) =>
        query?.includeArchived ? [live, closed] : [live]
      ),
    });
    const wrapper = wrapperFor(transport);

    const plain = renderHook(() => useRooms(), { wrapper });
    const withArchived = renderHook(() => useRooms({ includeArchived: true }), { wrapper });

    await waitFor(() => expect(plain.result.current.data).toBeDefined());
    await waitFor(() => expect(withArchived.result.current.data).toBeDefined());

    expect(plain.result.current.data?.map((r) => r.id)).toEqual(['live']);
    expect(withArchived.result.current.data?.map((r) => r.id)).toEqual(['live', 'closed']);
  });
});

describe('useRoomsByKind', () => {
  it('splits channels from direct messages', () => {
    const { result } = renderHook(() =>
      useRoomsByKind([
        room({ id: 'a', kind: 'channel' }),
        room({ id: 'b', kind: 'dm', slug: null, title: 'Ana' }),
      ])
    );
    expect(result.current.channels.map((r) => r.id)).toEqual(['a']);
    expect(result.current.dms.map((r) => r.id)).toEqual(['b']);
  });

  it('reads an unloaded list as two empty sections', () => {
    const { result } = renderHook(() => useRoomsByKind(undefined));
    expect(result.current).toEqual({ channels: [], dms: [] });
  });

  it('orders channels by name, not by the recency the server sent', () => {
    // Handed over in recency order, which is what `GET /api/rooms` answers with.
    const { result } = renderHook(() =>
      useRoomsByKind([
        room({ id: 'c1', slug: 'zulu', lastActivityAt: '2026-07-26T13:00:00.000Z' }),
        room({ id: 'c2', slug: 'room-10', lastActivityAt: '2026-07-26T12:00:00.000Z' }),
        room({ id: 'c3', slug: 'alpha', lastActivityAt: '2026-07-26T11:00:00.000Z' }),
        room({ id: 'c4', slug: 'room-2', lastActivityAt: '2026-07-26T10:00:00.000Z' }),
      ])
    );

    // Alphabetical, so a quiet channel keeps its place — and `room-2` sorts
    // before `room-10` the way a person reads them, not the way bytes do.
    expect(result.current.channels.map((r) => r.slug)).toEqual([
      'alpha',
      'room-2',
      'room-10',
      'zulu',
    ]);
  });

  it('orders direct messages by recency — the opposite call, on purpose', () => {
    /** A DM last spoken in at `at`. */
    const dm = (id: string, title: string, at: string) =>
      room({ id, kind: 'dm', slug: null, title, lastActivityAt: at });

    const { result } = renderHook(() =>
      useRoomsByKind([
        dm('d1', 'Ana', '2026-07-26T10:00:00.000Z'),
        dm('d2', 'Bo', '2026-07-26T13:00:00.000Z'),
        dm('d3', 'Cy', '2026-07-26T11:00:00.000Z'),
      ])
    );

    expect(result.current.dms.map((r) => r.title)).toEqual(['Bo', 'Cy', 'Ana']);
  });

  it('breaks a tie on the room id, so tied rows never swap places', () => {
    // Two channels that cannot be told apart by name (no slug, same title), and
    // two DMs created in the same millisecond — the seeded shape exactly. Ids
    // are ULID-shaped here, so `02` is the later-minted room.
    const tied = '2026-07-26T10:00:00.000Z';
    const { result } = renderHook(() =>
      useRoomsByKind([
        room({ id: 'c02', kind: 'channel', slug: null, title: 'Ops' }),
        room({ id: 'c01', kind: 'channel', slug: null, title: 'Ops' }),
        room({ id: 'd01', kind: 'dm', slug: null, title: 'Ana', lastActivityAt: tied }),
        room({ id: 'd02', kind: 'dm', slug: null, title: 'Bo', lastActivityAt: tied }),
      ])
    );

    // Channels ascend with their sort; DMs descend with theirs, so the newer
    // room stays on top of a tie rather than under it.
    expect(result.current.channels.map((r) => r.id)).toEqual(['c01', 'c02']);
    expect(result.current.dms.map((r) => r.id)).toEqual(['d02', 'd01']);
  });

  it('leaves the cached array it was handed exactly as it found it', () => {
    // The list belongs to the query cache; sorting it in place would reorder
    // every other reader's copy of it.
    const cached = [room({ id: 'c1', slug: 'zulu' }), room({ id: 'c2', slug: 'alpha' })];
    renderHook(() => useRoomsByKind(cached));
    expect(cached.map((r) => r.slug)).toEqual(['zulu', 'alpha']);
  });
});

describe('useRoom / useRoomEntries', () => {
  it('stays idle until a room is selected', () => {
    const transport = createMockTransport();
    renderHook(() => useRoom(null), { wrapper: wrapperFor(transport) });
    renderHook(() => useRoomEntries(null), { wrapper: wrapperFor(transport) });
    expect(transport.getRoom).not.toHaveBeenCalled();
    expect(transport.listRoomEntries).not.toHaveBeenCalled();
  });

  it('reads one room and its history once selected', async () => {
    const transport = createMockTransport({
      getRoom: vi.fn().mockResolvedValue({ ...room(), members: [] }),
      listRoomEntries: vi.fn().mockResolvedValue([entry(1)]),
    });
    const wrapper = wrapperFor(transport);
    const roomHook = renderHook(() => useRoom('room-1'), { wrapper });
    const entriesHook = renderHook(() => useRoomEntries('room-1'), { wrapper });
    await waitFor(() => expect(roomHook.result.current.data?.id).toBe('room-1'));
    await waitFor(() => expect(entriesHook.result.current.data).toHaveLength(1));
  });
});

describe('useCreateChannel', () => {
  it('creates a channel from a plain name', async () => {
    const created = { ...room(), members: [] };
    const transport = createMockTransport({ createRoom: vi.fn().mockResolvedValue(created) });
    const { result } = renderHook(() => useCreateChannel(), { wrapper: wrapperFor(transport) });
    await result.current.mutateAsync({ title: 'General', agentPaths: [] });
    expect(transport.createRoom).toHaveBeenCalledWith({
      kind: 'channel',
      title: 'General',
      members: [],
      agentPaths: [],
    });
  });

  it('puts the chosen agents in the channel on the SAME call that makes it', async () => {
    // Not create-then-add-N. The server resolves every path before it writes,
    // so the channel and its roster land together — which is what stops a
    // failed second call leaving a named, empty channel holding the #slug that
    // the obvious retry would then collide with.
    const created = { ...room(), members: [] };
    const transport = createMockTransport({
      createRoom: vi.fn().mockResolvedValue(created),
      addRoomMember: vi.fn().mockResolvedValue({}),
    });
    const { result } = renderHook(() => useCreateChannel(), { wrapper: wrapperFor(transport) });
    await result.current.mutateAsync({ title: 'General', agentPaths: ['/w/ana', '/w/kai'] });

    expect(transport.createRoom).toHaveBeenCalledTimes(1);
    expect(transport.createRoom).toHaveBeenCalledWith({
      kind: 'channel',
      title: 'General',
      members: [],
      agentPaths: ['/w/ana', '/w/kai'],
    });
    expect(transport.addRoomMember).not.toHaveBeenCalled();
  });
});

describe('useStartDirectMessage', () => {
  it('creates the room and joins the agent in one call', async () => {
    const created = { ...room({ id: 'dm-1', kind: 'dm', slug: null, title: 'Ana' }), members: [] };
    const transport = createMockTransport({
      createRoom: vi.fn().mockResolvedValue(created),
      addRoomMember: vi.fn().mockResolvedValue({}),
    });
    const { result } = renderHook(() => useStartDirectMessage(), {
      wrapper: wrapperFor(transport),
    });
    await result.current.mutateAsync({ agentPaths: ['/repo/ana'], title: 'Ana' });
    expect(transport.createRoom).toHaveBeenCalledWith({
      kind: 'dm',
      title: 'Ana',
      members: [],
      agentPaths: ['/repo/ana'],
    });
    // The second call is what left a DM with nobody in it when it failed.
    expect(transport.addRoomMember).not.toHaveBeenCalled();
  });

  it('takes several agents into one conversation, still in one call', async () => {
    const created = {
      ...room({ id: 'dm-1', kind: 'dm', slug: null, title: 'Ana and Kai' }),
      members: [],
    };
    const transport = createMockTransport({
      createRoom: vi.fn().mockResolvedValue(created),
      addRoomMember: vi.fn().mockResolvedValue({}),
    });
    const { result } = renderHook(() => useStartDirectMessage(), {
      wrapper: wrapperFor(transport),
    });
    await result.current.mutateAsync({
      agentPaths: ['/repo/ana', '/repo/kai'],
      title: 'Ana and Kai',
    });

    expect(transport.createRoom).toHaveBeenCalledWith({
      kind: 'dm',
      title: 'Ana and Kai',
      members: [],
      agentPaths: ['/repo/ana', '/repo/kai'],
    });
    // A group is one atomic create too — not a create followed by N joins, any
    // of which could fail and leave a half-assembled conversation.
    expect(transport.addRoomMember).not.toHaveBeenCalled();
  });
});

describe('mergeRoomEntry', () => {
  it('appends an entry that follows the last one held', () => {
    expect(mergeRoomEntry([entry(1)], entry(2)).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('drops a replayed entry without disturbing the cached array', () => {
    const cached = [entry(1), entry(2)];
    expect(mergeRoomEntry(cached, entry(2))).toBe(cached);
  });

  it('sorts an out-of-order arrival back into place', () => {
    expect(mergeRoomEntry([entry(1), entry(3)], entry(2)).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('starts a history from nothing', () => {
    expect(mergeRoomEntry(undefined, entry(1)).map((e) => e.seq)).toEqual([1]);
  });
});
