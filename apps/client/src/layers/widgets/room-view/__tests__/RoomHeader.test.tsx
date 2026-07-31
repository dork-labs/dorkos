// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { RoomSummary, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { roomKeys, useRoomWorkingStore } from '@/layers/entities/room';
import { TransportProvider } from '@/layers/shared/model';
import { RoomHeader } from '../ui/RoomHeader';

const ROOM_ID = 'room-1';

const ROOM: RoomWithRoster = {
  id: ROOM_ID,
  kind: 'channel',
  slug: 'general',
  title: 'general',
  topic: null,
  workspaceId: null,
  archived: false,
  createdAt: '2026-07-30T10:00:00.000Z',
  lastActivityAt: '2026-07-30T10:00:00.000Z',
  reactionFrequents: [],
  viewerAuthorId: 'author-you',
  members: [
    {
      roomId: ROOM_ID,
      authorId: 'kai',
      responseMode: 'engaged',
      joinedAt: '2026-07-30T10:00:00.000Z',
      lastReadSeq: 0,
      author: { id: 'kai', kind: 'agent', displayName: 'Kai' },
    },
  ],
};

/** The room list this cockpit has already fetched, as the sidebar left it. */
function listedRoom(working: number | undefined): RoomSummary {
  return { ...ROOM, unreadCount: 0, participants: null, working } as unknown as RoomSummary;
}

function renderHeader(listed: RoomSummary | undefined) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  // The sidebar's own read, which is the only reason a count is in the cache at
  // all — the header never fetches one.
  if (listed) queryClient.setQueryData(roomKeys.list(), [listed]);
  const transport = createMockTransport();
  transport.listRooms = vi.fn();

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }

  render(<RoomHeader room={ROOM} onOpenMembers={() => {}} />, { wrapper: Wrapper });
  return { transport };
}

afterEach(() => {
  cleanup();
  useRoomWorkingStore.setState({ rooms: {} });
});

describe('RoomHeader — the working chip', () => {
  it('says nothing at all when nobody is working', () => {
    renderHeader(listedRoom(0));

    expect(screen.queryByTestId('room-header-working')).not.toBeInTheDocument();
  });

  it('says so from the moment the room opens, before any signal arrives', () => {
    // The case that had no answer: opening a room mid-turn. The room's own
    // stream republishes presence every ten seconds, so for those ten seconds
    // a reader was told nothing was happening. The count the room list already
    // carried fills exactly that gap.
    renderHeader(listedRoom(2));

    expect(screen.getByTestId('room-header-working')).toHaveTextContent('2 agents working');
  });

  it('says one agent in the singular', () => {
    renderHeader(listedRoom(1));

    expect(screen.getByTestId('room-header-working')).toHaveTextContent('1 agent working');
  });

  it('hands over to the stream, which outranks the list it was seeded from', () => {
    // The list is a snapshot from whenever it was fetched; the fan-out is now.
    renderHeader(listedRoom(2));
    expect(screen.getByTestId('room-header-working')).toHaveTextContent('2 agents working');

    act(() => useRoomWorkingStore.getState().observe({ roomId: ROOM_ID, working: 0 }));

    expect(screen.queryByTestId('room-header-working')).not.toBeInTheDocument();
  });

  it('never asks the server for the count itself', () => {
    // A masthead chip is not worth a request, and a second fetching observer on
    // a stale room list would start a background refetch to decorate it.
    const { transport } = renderHeader(undefined);

    expect(transport.listRooms).not.toHaveBeenCalled();
    expect(screen.queryByTestId('room-header-working')).not.toBeInTheDocument();
  });
});
