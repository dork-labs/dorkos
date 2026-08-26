// @vitest-environment jsdom
/**
 * What a `/channels` deep link draws before anyone knows which room it names.
 *
 * **The bug this pins is a blank page, not a wrong one.** The one-door guard
 * (spec §3.5) has to know whether `?id=` is #team before the page commits to
 * drawing it, and that answer comes from the room list — so on a cold load EVERY
 * room is briefly unresolved, not just #team. Returning nothing for that window
 * meant a shared link opened onto an empty pane for as long as the list took,
 * which reads as a dead link rather than a loading one.
 *
 * The three states are deliberately distinct and only one of them is blank.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { redirect, params } = vi.hoisted(() => ({
  redirect: { state: 'show' as 'show' | 'pending' | 'redirecting' },
  params: { current: { id: 'room-1' } as Record<string, unknown> },
}));

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => params.current,
}));

const redirectArgs = vi.hoisted(() => vi.fn());
vi.mock('../model/use-team-room-redirect', () => ({
  useTeamRoomRedirect: (...args: unknown[]) => {
    redirectArgs(...args);
    return redirect.state;
  },
}));

// The room itself is proven in `ChannelsPage.test.tsx`; this file is about which
// of the three shapes the page picks, so the surface is stubbed at its seam —
// and about what the address hands it, so the stub publishes its props.
vi.mock('../ui/RoomSurface', () => ({
  RoomSurface: ({ roomId, threadId, entrySeq }: Record<string, unknown>) => (
    <div
      data-testid="room-surface"
      data-room-id={String(roomId)}
      data-thread-id={String(threadId)}
      data-entry-seq={String(entrySeq)}
    />
  ),
}));

vi.mock('../ui/RoomFlow', () => ({
  RoomHistorySkeleton: () => <div data-testid="room-history-skeleton" />,
}));

import { ChannelsPage } from '../ui/ChannelsPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  redirect.state = 'show';
  params.current = { id: 'room-1' };
});

describe('ChannelsPage deep link', () => {
  it('draws the room’s own loading state while the id is still unresolved', () => {
    // Not a blank pane, and not the room either — the skeleton is what
    // `RoomSurface` would be drawing at this exact moment anyway, so the
    // handover to the real room is invisible.
    redirect.state = 'pending';
    const { container } = render(<ChannelsPage />);

    expect(screen.getByTestId('room-history-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('room-surface')).not.toBeInTheDocument();
    expect(container.querySelector('[aria-busy]')).not.toBeNull();
  });

  it('draws nothing at all while it is on its way to Home', () => {
    // The one state that earns a blank: the navigation is already in flight, so
    // this room has stopped being the answer. Drawing it for those frames is the
    // flash the redirect exists to prevent.
    redirect.state = 'redirecting';
    render(<ChannelsPage />);

    expect(screen.queryByTestId('room-history-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByTestId('room-surface')).not.toBeInTheDocument();
  });

  it('draws the room once the id is settled and is not #team', () => {
    render(<ChannelsPage />);

    expect(screen.getByTestId('room-surface')).toBeInTheDocument();
  });

  it('hands the room the message a search hit asked it to open on', () => {
    // DOR-687. The page is the address and nothing else, so what it has to get
    // right is that `?entry=` reaches the room at all — the landing itself is
    // `useEntryLanding`'s and `Timeline`'s.
    params.current = { id: 'room-1', entry: 412 };
    render(<ChannelsPage />);

    expect(screen.getByTestId('room-surface')).toHaveAttribute('data-entry-seq', '412');
  });

  it('hands the room nothing when the address names no message', () => {
    // The positive control: without it, a page hard-coding any seq would pass.
    render(<ChannelsPage />);

    expect(screen.getByTestId('room-surface')).toHaveAttribute('data-entry-seq', 'undefined');
  });

  it('offers the message to the team-room redirect too, so #team keeps it', () => {
    // The one room `/channels` does not draw. If the coordinate stopped here it
    // would be dropped for exactly the room most people search in.
    params.current = { id: 'room-1', thread: 'entry-9', entry: 412 };
    render(<ChannelsPage />);

    expect(redirectArgs).toHaveBeenCalledWith('room-1', 'entry-9', 412);
  });
});
