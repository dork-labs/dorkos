// @vitest-environment jsdom
/**
 * Finding #team — the room the home tab renders (team-room-home spec D3.2).
 *
 * Four answers, and the difference between them is the whole point: the room is
 * here, the room is put away, the room is not there yet, or the list could not
 * be read. A home surface that cannot tell the last three apart draws a broken
 * room on a fresh install.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TEAM_ROOM_WELL_KNOWN, type RoomSummary } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { useTeamRoom } from '../model/use-team-room';

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
    createdAt: '2026-08-08T10:00:00.000Z',
    lastActivityAt: '2026-08-08T10:00:00.000Z',
    unreadCount: null,
    participants: null,
    ...overrides,
  };
}

/** #team as the server sends it. */
function teamRoom(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return room({
    id: 'team-room',
    slug: 'team',
    title: '#team',
    wellKnown: TEAM_ROOM_WELL_KNOWN,
    ...overrides,
  });
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

describe('useTeamRoom', () => {
  it('finds #team by its well-known key, not by its name', async () => {
    // Renamed and re-slugged, which a person may do: the key is what survives.
    const transport = createMockTransport({
      listRooms: vi.fn().mockResolvedValue([room(), teamRoom({ slug: 'crew', title: '#crew' })]),
    });
    const { result } = renderHook(() => useTeamRoom(), { wrapper: wrapperFor(transport) });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.room?.id).toBe('team-room');
  });

  it('is loading before the list arrives — never "missing"', () => {
    const transport = createMockTransport({
      listRooms: vi.fn<() => Promise<RoomSummary[]>>(() => new Promise(() => {})),
    });
    const { result } = renderHook(() => useTeamRoom(), { wrapper: wrapperFor(transport) });
    expect(result.current.status).toBe('loading');
    expect(result.current.room).toBeNull();
  });

  it('says the list could not be read rather than calling the room missing', async () => {
    const transport = createMockTransport({
      listRooms: vi.fn().mockRejectedValue(new Error('offline')),
    });
    const { result } = renderHook(() => useTeamRoom(), { wrapper: wrapperFor(transport) });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.room).toBeNull();
  });

  it('costs no second request while the room is live', async () => {
    const listRooms = vi.fn().mockResolvedValue([teamRoom()]);
    const transport = createMockTransport({ listRooms });
    const { result } = renderHook(() => useTeamRoom(), { wrapper: wrapperFor(transport) });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    // The live list is the sidebar's own cached read. Only a room that is NOT
    // in it is worth asking about again.
    expect(listRooms).toHaveBeenCalledTimes(1);
    expect(listRooms).toHaveBeenCalledWith();
  });

  it('reports an archived #team as archived, and does not un-archive it', async () => {
    const listRooms = vi.fn(async (query?: { includeArchived?: boolean }) =>
      query?.includeArchived === true ? [teamRoom({ archived: true })] : []
    );
    const transport = createMockTransport({ listRooms });
    const { result } = renderHook(() => useTeamRoom(), { wrapper: wrapperFor(transport) });

    await waitFor(() => expect(result.current.status).toBe('archived'));
    expect(result.current.room?.id).toBe('team-room');
    // Nothing but the two reads: putting the room back is the owner's press,
    // never a side effect of opening the page.
    expect(transport.updateRoom).not.toHaveBeenCalled();
  });

  it('says a failed archived-inclusive read is an error, not a missing room', async () => {
    // The second read has its own failure, and it must not be mistaken for an
    // answer: "the room is not there" and "I could not find out" are the two
    // this hook exists to keep apart, and only one of them offers a retry.
    const transport = createMockTransport({
      listRooms: vi.fn(async (query?: { includeArchived?: boolean }) => {
        if (query?.includeArchived === true) throw new Error('offline');
        return [];
      }),
    });
    const { result } = renderHook(() => useTeamRoom(), { wrapper: wrapperFor(transport) });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.room).toBeNull();
  });

  it('reports a server that has not seeded the room yet as missing', async () => {
    const transport = createMockTransport({ listRooms: vi.fn().mockResolvedValue([room()]) });
    const { result } = renderHook(() => useTeamRoom(), { wrapper: wrapperFor(transport) });

    await waitFor(() => expect(result.current.status).toBe('missing'));
    expect(result.current.room).toBeNull();
  });
});
