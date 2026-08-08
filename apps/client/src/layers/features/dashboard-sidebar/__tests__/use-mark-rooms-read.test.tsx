// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { useMarkRoomsRead } from '../model/use-mark-rooms-read';

function entry(roomId: string, seq: number): RoomEntry {
  return {
    roomId,
    seq,
    id: `${roomId}-entry-${seq}`,
    authorId: 'ana',
    kind: 'post',
    body: { text: `line ${seq}` },
    mentions: [],
    sessionId: null,
    cascadeRoot: `${roomId}-entry-${seq}`,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-08-04T10:00:00.000Z',
  };
}

/**
 * A transport whose reads resolve only when the test says so, so a sweep can be
 * inspected while it is still in flight — which is the whole subject here.
 */
function pendingTransport() {
  const releases: (() => void)[] = [];
  const transport = createMockTransport({
    listRoomEntries: vi.fn((roomId: string) => {
      return new Promise<RoomEntry[]>((resolve) => {
        releases.push(() => resolve([entry(roomId, 4)]));
      });
    }),
    setReadCursor: vi.fn().mockResolvedValue(undefined),
  });
  return {
    transport,
    /** Let every read that has been started so far resolve. */
    releaseAll: async () => {
      const pending = releases.splice(0, releases.length);
      await act(async () => {
        pending.forEach((release) => release());
      });
    },
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

describe('useMarkRoomsRead', () => {
  it('runs the per-room path once per room handed in', async () => {
    const transport = createMockTransport({
      listRoomEntries: vi.fn((roomId: string) => Promise.resolve([entry(roomId, 4)])),
      setReadCursor: vi.fn().mockResolvedValue(undefined),
    });
    const { result } = renderHook(() => useMarkRoomsRead(), {
      wrapper: wrapperFor(transport),
    });

    await act(async () => {
      result.current(['room-a', 'room-b', 'room-c']);
    });

    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledTimes(3));
    expect(transport.listRoomEntries).toHaveBeenCalledTimes(3);
    expect(transport.setReadCursor).toHaveBeenCalledWith('room', 'room-a', 4);
    expect(transport.setReadCursor).toHaveBeenCalledWith('room', 'room-b', 4);
    expect(transport.setReadCursor).toHaveBeenCalledWith('room', 'room-c', 4);
  });

  it('ignores a second click while the sweep is still running', async () => {
    // The measured defect: the menu stays open long enough to be clicked twice
    // and no badge clears until the writes land, so an impatient second click
    // used to send the whole sweep again — 12 requests over three rooms, all of
    // them re-doing work already in flight.
    const { transport, releaseAll } = pendingTransport();
    const { result } = renderHook(() => useMarkRoomsRead(), {
      wrapper: wrapperFor(transport),
    });

    await act(async () => {
      result.current(['room-a', 'room-b', 'room-c']);
    });
    expect(transport.listRoomEntries).toHaveBeenCalledTimes(3);

    // Clicked again while every read is still open.
    await act(async () => {
      result.current(['room-a', 'room-b', 'room-c']);
    });
    expect(transport.listRoomEntries).toHaveBeenCalledTimes(3);

    await releaseAll();
    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledTimes(3));
  });

  it('frees the gesture again once the sweep has settled', async () => {
    const { transport, releaseAll } = pendingTransport();
    const { result } = renderHook(() => useMarkRoomsRead(), {
      wrapper: wrapperFor(transport),
    });

    await act(async () => {
      result.current(['room-a', 'room-b']);
    });
    await releaseAll();
    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledTimes(2));

    await act(async () => {
      result.current(['room-a', 'room-b']);
    });
    expect(transport.listRoomEntries).toHaveBeenCalledTimes(4);
  });

  it('sends nothing when no room is behind', async () => {
    const transport = createMockTransport({
      listRoomEntries: vi.fn(),
      setReadCursor: vi.fn(),
    });
    const { result } = renderHook(() => useMarkRoomsRead(), {
      wrapper: wrapperFor(transport),
    });

    await act(async () => {
      result.current([]);
    });

    expect(transport.listRoomEntries).not.toHaveBeenCalled();
  });
});
