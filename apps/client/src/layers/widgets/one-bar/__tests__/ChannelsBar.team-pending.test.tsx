// @vitest-environment jsdom
/**
 * The channel bar on a cold load of `/channels?id=<team>` (DOR-2141).
 *
 * The bar learns which room is open from `GET /api/rooms/:id` and which room is
 * #team from `GET /api/rooms` — two separate requests. When the single room
 * lands first, the bar used to compare it with a team room that was still
 * `null`, decide "not #team", and name `#team` with its chips for the moment
 * before the list arrived and the redirect to Home took over.
 *
 * `ChannelsBar.test.tsx` stubs `useTeamRoom` to a settled answer, so it cannot
 * see that window. This file runs the REAL hook against a transport whose room
 * list is held open, which is the only way to put the bar in the state the bug
 * lived in.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { RoomSummary, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { ChannelsBar } from '../ui/ChannelsBar';
import { BarHarness } from './bar-harness';

// The fixed cluster OneBar renders — real widgets with their own data needs,
// stubbed at the seam because this file is about what the bar NAMES.
vi.mock('@/layers/widgets/inbox-bell', () => ({
  InboxBell: () => <button aria-label="Inbox">Inbox</button>,
}));
vi.mock('@/layers/features/right-panel', () => ({
  RightPanelToggle: () => <button aria-label="Toggle right panel">Panel</button>,
}));

// Only the live presence count and the Stop mutation are stubbed. `useTeamRoom`
// is deliberately the real one: its `loading` answer is the subject here.
vi.mock('@/layers/entities/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/room')>();
  return {
    ...actual,
    useOpenRoomWorking: () => 0,
    useHaltRoom: () => ({ mutate: vi.fn(), isPending: false }),
  };
});
vi.mock('@/layers/features/room-management', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/room-management')>();
  return { ...actual, useRoomFaces: () => new Map() };
});

afterEach(cleanup);

const TEAM: RoomWithRoster = {
  id: 'room-team',
  kind: 'channel',
  slug: 'team',
  title: 'team',
  topic: 'Where the day starts',
  wellKnown: 'team',
  archived: false,
  ambientMaxEntries: 30,
  createdAt: '2026-08-10T09:00:00.000Z',
  lastActivityAt: '2026-08-10T09:00:00.000Z',
  reactionFrequents: [],
  viewerAuthorId: 'author-you',
  members: [],
} as RoomWithRoster;

const GENERAL: RoomWithRoster = {
  ...TEAM,
  id: 'room-general',
  slug: 'general',
  title: 'general',
  topic: null,
  wellKnown: undefined,
} as RoomWithRoster;

/**
 * The same room as the list carries it: no roster, an unread count instead.
 *
 * @param room - The room as `GET /api/rooms/:id` answers it.
 */
function summary(room: RoomWithRoster): RoomSummary {
  const { members: _members, ...rest } = room;
  return { ...rest, unreadCount: 0, participants: null };
}

/**
 * Render the bar over `open`, with `GET /api/rooms` held until the test says.
 *
 * @param open - The room `GET /api/rooms/:id` has already answered with.
 */
function renderWithPendingList(open: RoomWithRoster) {
  let resolveList: (rooms: RoomSummary[]) => void = () => {};
  const transport = createMockTransport({
    listRooms: vi.fn(
      () =>
        new Promise<RoomSummary[]>((resolve) => {
          resolveList = resolve;
        })
    ),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  render(
    <BarHarness room={open}>
      <ChannelsBar />
    </BarHarness>,
    { wrapper }
  );
  return {
    listRooms: transport.listRooms,
    settle: async (rooms: RoomSummary[]) => {
      await act(async () => resolveList(rooms));
    },
  };
}

/** Whether the bar is naming a room, by the title every room identity carries. */
function namesRoom(slug: string): boolean {
  return screen.queryByTitle(`#${slug}`) !== null;
}

describe('ChannelsBar while the room list is still loading', () => {
  it('never names #team before the list says which room #team is', async () => {
    const { listRooms, settle } = renderWithPendingList(TEAM);

    // The window the bug lived in: the open room is known, the list is not.
    expect(listRooms).toHaveBeenCalled();
    expect(screen.getByText('Channels')).toBeInTheDocument();
    expect(namesRoom('team')).toBe(false);
    expect(screen.queryByText('Where the day starts')).not.toBeInTheDocument();

    // And once it lands, it is #team — the redirect's room, so still no bar.
    await settle([summary(TEAM)]);
    expect(screen.getByText('Channels')).toBeInTheDocument();
    expect(namesRoom('team')).toBe(false);
  });

  it('names an ordinary room once the list has settled that it is not #team', async () => {
    // The other half, and what keeps the first test from passing on a bar that
    // simply never names anything: the same wait ends in the room's own bar.
    const { settle } = renderWithPendingList(GENERAL);
    expect(namesRoom('general')).toBe(false);

    await settle([summary(TEAM), summary(GENERAL)]);
    await waitFor(() => expect(namesRoom('general')).toBe(true));
    expect(screen.queryByText('Channels')).not.toBeInTheDocument();
  });
});
