// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { useMarkRoomRead } from '../model/use-mark-room-read';

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
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
  };
}

function roomWith(members: RoomWithRoster['members']): RoomWithRoster {
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
    createdAt: '2026-07-26T09:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    members,
  };
}

function human(lastReadSeq: number): RoomWithRoster['members'][number] {
  return {
    roomId: 'room-1',
    authorId: 'me',
    responseMode: 'always',
    joinedAt: '2026-07-26T09:00:00.000Z',
    lastReadSeq,
    author: { id: 'me', kind: 'human', displayName: 'You' },
  };
}

function agent(): RoomWithRoster['members'][number] {
  return {
    roomId: 'room-1',
    authorId: 'ana',
    responseMode: 'always',
    joinedAt: '2026-07-26T09:00:00.000Z',
    lastReadSeq: 0,
    author: { id: 'ana', kind: 'agent', displayName: 'Ana' },
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
    await waitFor(() => expect(transport.setRoomReadCursor).toHaveBeenCalledWith('room-1', 4));
  });

  it('says nothing when the reader is already caught up', async () => {
    const transport = createMockTransport();
    renderHook(() => useMarkRoomRead(roomWith([human(4)]), [entry(4)]), {
      wrapper: wrapperFor(transport),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(transport.setRoomReadCursor).not.toHaveBeenCalled();
  });

  it('says nothing for a reader who is not a member — they have no cursor', async () => {
    const transport = createMockTransport();
    renderHook(() => useMarkRoomRead(roomWith([agent()]), [entry(1)]), {
      wrapper: wrapperFor(transport),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(transport.setRoomReadCursor).not.toHaveBeenCalled();
  });

  it('says nothing while the room is still loading', async () => {
    const transport = createMockTransport();
    renderHook(() => useMarkRoomRead(undefined, []), { wrapper: wrapperFor(transport) });
    await new Promise((r) => setTimeout(r, 20));
    expect(transport.setRoomReadCursor).not.toHaveBeenCalled();
  });

  it('sends one write per (room, seq), so a stale refetch cannot start a loop', async () => {
    const transport = createMockTransport();
    const { rerender } = renderHook(
      ({ room }: { room: RoomWithRoster }) => useMarkRoomRead(room, [entry(4)]),
      { wrapper: wrapperFor(transport), initialProps: { room: roomWith([human(1)]) } }
    );
    await waitFor(() => expect(transport.setRoomReadCursor).toHaveBeenCalledTimes(1));
    // A refetch that has not yet reflected the write re-renders with the old cursor.
    rerender({ room: roomWith([human(1)]) });
    await new Promise((r) => setTimeout(r, 20));
    expect(transport.setRoomReadCursor).toHaveBeenCalledTimes(1);
  });
});
