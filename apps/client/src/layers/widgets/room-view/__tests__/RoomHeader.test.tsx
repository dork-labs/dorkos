// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  ambientMaxEntries: 30,
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
      joinedSeq: 0,
      lastReadSeq: 0,
      author: { id: 'kai', kind: 'agent', displayName: 'Kai', handle: null },
      origin: 'local',
    },
  ],
};

/** The room list this cockpit has already fetched, as the sidebar left it. */
function listedRoom(working: number | undefined): RoomSummary {
  return { ...ROOM, unreadCount: 0, participants: null, working } as unknown as RoomSummary;
}

function renderHeader(listed: RoomSummary | undefined, room: RoomWithRoster = ROOM) {
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

  render(<RoomHeader room={room} onOpenMembers={() => {}} />, { wrapper: Wrapper });
  return { transport };
}

afterEach(() => {
  cleanup();
  useRoomWorkingStore.setState({ rooms: {} });
});

describe('RoomHeader — the stop control', () => {
  it('is not offered when nothing is running', () => {
    // A button that would do nothing is a button that teaches its reader to
    // distrust every other one on the screen.
    renderHeader(listedRoom(0));

    expect(screen.queryByTestId('room-header-halt')).not.toBeInTheDocument();
  });

  it('stops the room when pressed, and never by anything anyone typed', async () => {
    // The whole reason this is a button. In the Hermes loop incident an
    // operator typed "you are in a loop, stop" and the bot answered it like any
    // other turn, because to a model in a conversation that is what it is. So
    // stopping reaches the runtimes through a route, and nothing in this
    // product reads message text for it (room-participation spec §10.4).
    const { transport } = renderHeader(listedRoom(1));

    await userEvent.click(screen.getByTestId('room-header-halt'));

    await waitFor(() => expect(transport.haltRoom).toHaveBeenCalledWith(ROOM_ID));
  });

  it('goes when the work goes', () => {
    renderHeader(listedRoom(1));
    expect(screen.getByTestId('room-header-halt')).toBeInTheDocument();

    act(() => useRoomWorkingStore.getState().observe({ roomId: ROOM_ID, working: 0 }));

    expect(screen.queryByTestId('room-header-halt')).not.toBeInTheDocument();
  });
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

describe('RoomHeader — the bridge visibility badge (chats-as-channels spec §8, DOR-879)', () => {
  it('A8.1: a bridged group room shows "sees mentions only", sourced from room.bridge.visibility', () => {
    const bridgedGroup: RoomWithRoster = {
      ...ROOM,
      bridge: { visibility: 'partial', platformTitle: 'Ops Team' },
    };
    renderHeader(listedRoom(0), bridgedGroup);

    const badge = screen.getByTestId('bridge-visibility-badge');
    expect(badge).toHaveTextContent('sees mentions only');
  });

  it('A8.1: a bridged group room shows "sees everything" when the bridge reports full visibility', () => {
    const bridgedGroup: RoomWithRoster = {
      ...ROOM,
      bridge: { visibility: 'full', platformTitle: 'Ops Team' },
    };
    renderHeader(listedRoom(0), bridgedGroup);

    expect(screen.getByTestId('bridge-visibility-badge')).toHaveTextContent('sees everything');
  });

  it('A8.2: a bridged DM room shows no badge — privacy mode is a group concept', () => {
    const bridgedDm: RoomWithRoster = {
      ...ROOM,
      kind: 'dm',
      bridge: { visibility: null, platformTitle: null },
    };
    renderHeader(listedRoom(0), bridgedDm);

    expect(screen.queryByTestId('bridge-visibility-badge')).not.toBeInTheDocument();
  });

  it('shows no badge on a room with no bridge at all', () => {
    renderHeader(listedRoom(0), ROOM);
    expect(screen.queryByTestId('bridge-visibility-badge')).not.toBeInTheDocument();
  });

  it("A8.3: expanding it names Telegram as the switch's owner, the re-add ritual, and the reply-setting gate", async () => {
    const bridgedGroup: RoomWithRoster = {
      ...ROOM,
      bridge: { visibility: 'full', platformTitle: 'Ops Team' },
    };
    renderHeader(listedRoom(0), bridgedGroup);

    await userEvent.click(screen.getByTestId('bridge-visibility-badge'));

    // Telegram owns the switch, not DorkOS.
    expect(await screen.findByText(/Telegram's own privacy switch/i)).toBeInTheDocument();
    // The re-add ritual: leave the group and rejoin it.
    expect(
      screen.getByText(/removing the bot from this group and\s+adding it back/i)
    ).toBeInTheDocument();
    // The bot-wide-not-per-group honesty gap, in the task's own words.
    expect(screen.getByText(/groups where it was added after this was set/i)).toBeInTheDocument();
    // The second gate: DorkOS's own reply setting narrows things further.
    expect(screen.getByText(/reply setting of its own/i)).toBeInTheDocument();
  });

  it('is a disclosure, never a toggle — no switch role, no pressed state', () => {
    const bridgedGroup: RoomWithRoster = {
      ...ROOM,
      bridge: { visibility: 'partial', platformTitle: 'Ops Team' },
    };
    renderHeader(listedRoom(0), bridgedGroup);

    const badge = screen.getByTestId('bridge-visibility-badge');
    expect(badge).not.toHaveAttribute('role', 'switch');
    expect(badge).not.toHaveAttribute('aria-pressed');
    expect(badge.tagName).toBe('BUTTON');
  });
});
