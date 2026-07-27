// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomSummary, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { useRoomDocumentTitle } from '../use-room-document-title';

// ---------------------------------------------------------------------------
// Mocks — the route, which is the only thing here that needs a live router
// ---------------------------------------------------------------------------

let pathname = '/session';
let search: Record<string, unknown> = {};

vi.mock('@/layers/shared/model', async () => {
  const actual =
    await vi.importActual<typeof import('@/layers/shared/model')>('@/layers/shared/model');
  return {
    ...actual,
    useSafePathname: () => pathname,
    useSafeSearch: () => search,
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function summary(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'room-1',
    kind: 'channel',
    parentId: null,
    slug: 'general',
    title: 'General',
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

function withRoster(overrides: Partial<RoomSummary> = {}): RoomWithRoster {
  return { ...summary(overrides), members: [] };
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

beforeEach(() => {
  pathname = '/session';
  search = {};
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useRoomDocumentTitle', () => {
  it('names the open channel the way it is spoken', async () => {
    pathname = '/channels';
    search = { id: 'room-1' };
    const transport = createMockTransport({
      getRoom: vi.fn().mockResolvedValue(withRoster()),
      listRooms: vi.fn().mockResolvedValue([summary()]),
    });

    const { result } = renderHook(() => useRoomDocumentTitle(), { wrapper: wrapperFor(transport) });

    // `#general`, not `general` — this string goes in a browser tab, where no
    // mark is drawn beside it.
    await waitFor(() => expect(result.current.roomTitle).toBe('#general'));
  });

  it('reads a thread over the room it hangs off, as ChannelsPage does', async () => {
    pathname = '/channels';
    search = { id: 'room-1', thread: 'thread-1' };
    const getRoom = vi
      .fn()
      .mockResolvedValue(
        withRoster({ id: 'thread-1', kind: 'thread', slug: null, title: 'Side note' })
      );
    const transport = createMockTransport({ getRoom, listRooms: vi.fn().mockResolvedValue([]) });

    const { result } = renderHook(() => useRoomDocumentTitle(), { wrapper: wrapperFor(transport) });

    await waitFor(() => expect(result.current.roomTitle).toBe('Side note'));
    expect(getRoom).toHaveBeenCalledWith('thread-1');
  });

  it('names no room anywhere but /channels, even with a stale id in the URL', async () => {
    pathname = '/session';
    search = { id: 'room-1' };
    const transport = createMockTransport({
      getRoom: vi.fn().mockResolvedValue(withRoster()),
      listRooms: vi.fn().mockResolvedValue([summary()]),
    });

    const { result } = renderHook(() => useRoomDocumentTitle(), { wrapper: wrapperFor(transport) });

    await waitFor(() => expect(result.current.unreadRoomCount).toBe(0));
    expect(result.current.roomTitle).toBeNull();
    expect(transport.getRoom).not.toHaveBeenCalled();
  });

  it('counts rooms that are unread, not the messages in them', async () => {
    const transport = createMockTransport({
      listRooms: vi.fn().mockResolvedValue([
        summary({ id: 'a', slug: 'busy', unreadCount: 40 }),
        summary({ id: 'b', slug: 'quiet', unreadCount: 1 }),
        summary({ id: 'c', slug: 'read', unreadCount: 0 }),
        // Not a member: `null` is "not applicable", never zero.
        summary({ id: 'd', slug: 'never-joined', unreadCount: null }),
      ]),
    });

    const { result } = renderHook(() => useRoomDocumentTitle(), { wrapper: wrapperFor(transport) });

    // Two conversations want you — not the 41 messages they are holding.
    await waitFor(() => expect(result.current.unreadRoomCount).toBe(2));
  });

  it('counts nothing while the list is still loading', () => {
    const pending = new Promise<RoomSummary[]>(() => {});
    const transport = createMockTransport({ listRooms: vi.fn().mockReturnValue(pending) });

    const { result } = renderHook(() => useRoomDocumentTitle(), { wrapper: wrapperFor(transport) });

    expect(result.current).toEqual({ roomTitle: null, unreadRoomCount: 0 });
  });
});
