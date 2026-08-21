// @vitest-environment jsdom
/**
 * Home's bar: the shared home-surface strip, plus the one thing that is Home's
 * own — #team's head count (spec `one-bar-header` §3.4, phase H1).
 *
 * The strip itself is proven in `HomeSurfaceBar.test.tsx`; what this file
 * asserts is the chip, because the chip is where a wrong number would be
 * believed. Home IS #team, so it is the count of the room the page below is
 * already showing, read from the same query — never a second request and never
 * a placeholder that corrects itself a moment later.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/layers/shared/ui';

// The shared half of the bar has its own suite; here it would only drag a router
// and a health query into a file about a chip.
vi.mock('../ui/HomeSurfaceBar', () => ({
  HomeSurfaceBar: ({ chips }: { chips?: React.ReactNode }) => <div>{chips}</div>,
}));

/** #team as `useTeamRoom` answers, and its roster as `useRoom` answers. */
const { room, roster } = vi.hoisted(() => ({
  room: {
    current: {
      id: 'team-room',
      kind: 'channel',
      slug: 'team',
      title: '#team',
      topic: null,
      archived: false,
      createdAt: '2026-08-21T00:00:00.000Z',
      bridge: null,
    } as Record<string, unknown> | null,
  },
  roster: { members: undefined as { members: { authorId: string }[] } | undefined },
}));

vi.mock('@/layers/entities/room', () => ({
  useTeamRoom: () => ({ status: room.current ? 'ready' : 'missing', room: room.current }),
  useRoom: () => ({ data: roster.members }),
  roomDisplayTitle: () => '#team',
}));

const detailsDialog = vi.fn();
vi.mock('@/layers/features/room-management', () => ({
  RoomDetailsDialog: (props: { focus: string }) => {
    detailsDialog(props);
    return <div data-testid="room-details">{props.focus}</div>;
  },
}));

import { DashboardHeader } from '../ui/DashboardHeader';

/** Four agents and you, which is what a real #team looks like early on. */
function members(count: number) {
  return { members: Array.from({ length: count }, (_, i) => ({ authorId: `author-${i}` })) };
}

function renderHomeBar() {
  return render(
    <TooltipProvider>
      <DashboardHeader />
    </TooltipProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  roster.members = members(5);
  room.current = {
    id: 'team-room',
    kind: 'channel',
    slug: 'team',
    title: '#team',
    topic: null,
    archived: false,
    createdAt: '2026-08-21T00:00:00.000Z',
    bridge: null,
  };
});

afterEach(() => {
  cleanup();
});

describe('DashboardHeader — the members chip', () => {
  it('says how many are in #team, and says it as a name a screen reader can use', () => {
    renderHomeBar();

    const chip = screen.getByRole('button', { name: '5 members' });
    expect(chip).toHaveTextContent('5');
  });

  it('counts one member in the singular', () => {
    roster.members = members(1);
    renderHomeBar();

    expect(screen.getByRole('button', { name: '1 member' })).toBeInTheDocument();
  });

  it('draws nothing until the roster has actually arrived', () => {
    // A chip that opens on `0` and corrects itself has told the reader something
    // false about their own team, and a wrong number is not one people re-check.
    roster.members = undefined;
    renderHomeBar();

    expect(screen.queryByTestId('bar-members-chip')).not.toBeInTheDocument();
  });

  it('draws nothing when there is no team room to count', () => {
    room.current = null;
    renderHomeBar();

    expect(screen.queryByTestId('bar-members-chip')).not.toBeInTheDocument();
  });

  it('opens the room’s members when pressed, not some other part of it', async () => {
    // The focus is the part of this that survives phase R2, when the same press
    // opens the room right panel instead of the sheet.
    const user = userEvent.setup();
    renderHomeBar();

    expect(screen.queryByTestId('room-details')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '5 members' }));

    await waitFor(() => expect(screen.getByTestId('room-details')).toBeInTheDocument());
    expect(detailsDialog).toHaveBeenCalledWith(expect.objectContaining({ focus: 'members' }));
  });
});
