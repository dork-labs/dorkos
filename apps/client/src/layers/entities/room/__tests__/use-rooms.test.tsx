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
    parentId: null,
    slug: 'general',
    title: '#general',
    topic: null,
    workspaceId: null,
    rootEntryId: null,
    archived: false,
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
});

describe('useRoomsByKind', () => {
  it('splits channels from direct messages and drops threads', () => {
    const { result } = renderHook(() =>
      useRoomsByKind([
        room({ id: 'a', kind: 'channel' }),
        room({ id: 'b', kind: 'dm', slug: null, title: 'Ana' }),
        room({ id: 'c', kind: 'thread', parentId: 'a', slug: null, title: 'Side note' }),
      ])
    );
    expect(result.current.channels.map((r) => r.id)).toEqual(['a']);
    expect(result.current.dms.map((r) => r.id)).toEqual(['b']);
  });

  it('reads an unloaded list as two empty sections', () => {
    const { result } = renderHook(() => useRoomsByKind(undefined));
    expect(result.current).toEqual({ channels: [], dms: [] });
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
    await result.current.mutateAsync('General');
    expect(transport.createRoom).toHaveBeenCalledWith({
      kind: 'channel',
      title: 'General',
      members: [],
      agentPaths: [],
    });
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
    await result.current.mutateAsync({ agentPath: '/repo/ana', title: 'Ana' });
    expect(transport.createRoom).toHaveBeenCalledWith({
      kind: 'dm',
      title: 'Ana',
      members: [],
      agentPaths: ['/repo/ana'],
    });
    // The second call is what left a DM with nobody in it when it failed.
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
