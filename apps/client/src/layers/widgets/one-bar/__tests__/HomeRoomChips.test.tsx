// @vitest-environment jsdom
/**
 * What Home's bar says about the room Home IS (spec `one-bar-header` §3.4).
 *
 * Home is #team, so it wears the same chips a channel wears — what is running,
 * and who is in it. Phase H1 shipped the head count; phase R1 adds the working
 * count and the room-wide Stop, which had gone with the masthead and had no
 * replacement in between.
 *
 * The bar itself is proven in `HomeSurfaceBar.test.tsx`; what this file asserts
 * is the chips, because a chip is where a wrong number would be believed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@/layers/shared/ui';

const { room, roster, status, roomAsked, working } = vi.hoisted(() => ({
  room: {
    current: {
      id: 'team-room',
      kind: 'channel',
      slug: 'team',
      title: 'team',
      topic: null,
      archived: false,
      createdAt: '2026-08-21T00:00:00.000Z',
      bridge: null,
    } as Record<string, unknown> | null,
  },
  roster: { members: undefined as { members: { authorId: string }[] } | undefined },
  // What `useTeamRoom` is answering on this render. `ready` unless a test says
  // otherwise — the archived case is the one that must draw no chips at all.
  status: { current: 'ready' as 'ready' | 'archived' },
  // Every id `useRoom` is asked for, so a test can prove a request was NOT made.
  roomAsked: vi.fn(),
  working: { count: 0 },
}));
const halt = vi.hoisted(() => vi.fn());

vi.mock('@/layers/entities/room', () => ({
  useTeamRoom: () => ({
    status: room.current ? status.current : 'missing',
    room: room.current,
  }),
  useRoom: (roomId: string | null) => {
    roomAsked(roomId);
    // The real hook is `enabled` on the id: a `null` room is never fetched, so
    // it has no data either.
    return { data: roomId === null ? undefined : roster.members };
  },
  roomDisplayTitle: () => '#team',
  useOpenRoomWorking: () => working.count,
  useHaltRoom: () => ({ mutate: halt, isPending: false }),
}));

// The panel is mounted by the shell, not by the chips. What Home's bar owes is
// the press: the door, and the part of the panel it asks for.
const openRoomPanel = vi.fn();
vi.mock('@/layers/features/room-management', () => ({
  openRoomPanel: (focus: string, roomId: string) => openRoomPanel(focus, roomId),
}));

import { HomeRoomChips } from '../ui/HomeRoomChips';

function members(count: number) {
  return { members: Array.from({ length: count }, (_, i) => ({ authorId: `author-${i}` })) };
}

function renderChips() {
  return render(
    <TooltipProvider>
      <HomeRoomChips />
    </TooltipProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  status.current = 'ready';
  working.count = 0;
  roster.members = members(5);
  room.current = {
    id: 'team-room',
    kind: 'channel',
    slug: 'team',
    title: 'team',
    topic: null,
    archived: false,
    createdAt: '2026-08-21T00:00:00.000Z',
    bridge: null,
  };
});

afterEach(cleanup);

describe('HomeRoomChips', () => {
  it('says how many are in #team, as a name a screen reader can use', () => {
    renderChips();
    expect(screen.getByRole('button', { name: '5 members' })).toHaveTextContent('5');
  });

  it('counts one member in the singular', () => {
    roster.members = members(1);
    renderChips();
    expect(screen.getByRole('button', { name: '1 member' })).toBeInTheDocument();
  });

  it('draws nothing until the roster has actually arrived', () => {
    // A chip that opens on `0` and corrects itself has told the reader something
    // false about their own team, and a wrong number is not one people re-check.
    roster.members = undefined;
    renderChips();
    expect(screen.queryByTestId('bar-members-chip')).not.toBeInTheDocument();
  });

  it('draws nothing for an archived #team, and does not ask for its roster', () => {
    // Home draws no conversation at all when #team is archived — it offers to
    // bring the room back instead. Chips beside that offer would be controls for
    // something that is not on screen, including a Stop for a room nobody can
    // post to.
    status.current = 'archived';
    renderChips();

    expect(screen.queryByTestId('bar-members-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('room-run-state')).not.toBeInTheDocument();
    // And the roster read never runs: the hook is asked for `null`, which is
    // what disables it. Asserting the request's ABSENCE, not just the chip's,
    // because a guard that filtered the result afterwards would look identical
    // on screen while still costing a fetch on every archived load.
    expect(roomAsked).toHaveBeenCalledWith(null);
    expect(roomAsked).not.toHaveBeenCalledWith('team-room');
  });

  it('draws nothing when there is no team room to describe', () => {
    room.current = null;
    renderChips();
    expect(screen.queryByTestId('bar-members-chip')).not.toBeInTheDocument();
  });

  it('opens the room’s members when the count is pressed, not some other part of it', async () => {
    // Since phase R2 the press opens the right panel's Room tab on the roster —
    // and names #team, so the panel can tell this press from one made about a
    // room the reader is navigating away from.
    const user = userEvent.setup();
    renderChips();

    expect(openRoomPanel).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '5 members' }));

    expect(openRoomPanel).toHaveBeenCalledWith('members', 'team-room');
  });

  it('shows what is running in #team, which Home could not say between H1 and R1', () => {
    working.count = 2;
    renderChips();
    expect(screen.getByLabelText('2 agents working')).toHaveTextContent('2');
  });

  it('stops #team from Home, by the room’s own id', async () => {
    const user = userEvent.setup();
    working.count = 2;
    renderChips();

    await user.click(screen.getByRole('button', { name: 'Stop all agents in #team' }));
    expect(halt).toHaveBeenCalledWith({ roomId: 'team-room' });
  });

  it('reserves the run state’s space on Home too, so the health dot never shifts', () => {
    // Home's chips are left-anchored and the health dot is right-anchored in the
    // bar's actions, so the dot's x is fixed by the right edge either way — but
    // the slot is still mounted while idle, which is what keeps the members chip
    // beside it from moving when an agent starts (I3).
    renderChips();
    expect(screen.getByTestId('room-run-state')).toHaveAttribute('data-idle', 'true');
  });
});
