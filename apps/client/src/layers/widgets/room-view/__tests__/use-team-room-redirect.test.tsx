// @vitest-environment jsdom
/**
 * One door to #team (spec `one-bar-header` §3.5, B1).
 *
 * The redirect's whole job is to be invisible: the reader presses a link and
 * lands on Home, and never sees the room drawn twice or drawn wrong on the way.
 * So what this file pins is the ORDER — nothing is shown until the answer is
 * known — as much as the destination.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTeamRoomRedirect } from '../model/use-team-room-redirect';

const { team } = vi.hoisted(() => ({
  team: {
    status: 'ready' as 'ready' | 'loading' | 'missing' | 'archived',
    room: { id: 'team-room' } as { id: string } | null,
  },
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@/layers/entities/room', () => ({
  useTeamRoom: () => ({ status: team.status, room: team.room }),
}));

afterEach(() => {
  vi.clearAllMocks();
  team.status = 'ready';
  team.room = { id: 'team-room' };
});

describe('useTeamRoomRedirect', () => {
  it('sends the team room’s id to Home, replacing the address it came from', () => {
    const { result } = renderHook(() => useTeamRoomRedirect('team-room', undefined));

    expect(result.current).toBe('redirecting');
    expect(navigate).toHaveBeenCalledWith({ to: '/', search: {}, replace: true });
  });

  it('carries an open thread across with it', () => {
    // A shared link to a reply has to land on the reply, not on the room's
    // newest message (spec §5 case 7).
    renderHook(() => useTeamRoomRedirect('team-room', 'entry-9'));

    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      search: { thread: 'entry-9' },
      replace: true,
    });
  });

  it('carries the message a search hit picked across with it', () => {
    // A hit in #team is addressed at `/channels?id=<team>&entry=<seq>` (DOR-687),
    // and the redirect is the only thing between that link and Home. Dropping
    // the coordinate here would land the reader at the bottom of Home with the
    // message they clicked nowhere in sight — the failure looks like the room
    // opening normally, which is why it needs pinning.
    renderHook(() => useTeamRoomRedirect('team-room', undefined, 412));

    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      search: { entry: 412 },
      replace: true,
    });
  });

  it('carries a thread and a message together', () => {
    renderHook(() => useTeamRoomRedirect('team-room', 'entry-9', 412));

    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      search: { thread: 'entry-9', entry: 412 },
      replace: true,
    });
  });

  it('leaves every other channel exactly where it is', () => {
    const { result } = renderHook(() => useTeamRoomRedirect('room-other', 'entry-9'));

    expect(result.current).toBe('show');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves the empty route alone, so "Pick a conversation" still shows', () => {
    const { result } = renderHook(() => useTeamRoomRedirect(undefined, undefined));

    expect(result.current).toBe('show');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('withholds its answer until it knows, rather than naming a room that may be about to move', () => {
    // The flash this exists to prevent: rendering the channel view first and
    // correcting a frame later shows #team without Home's chrome, then swaps it.
    //
    // **`pending` is not `redirecting`, and the page must tell them apart.**
    // EVERY room takes this branch on a cold load — the answer comes from the
    // room list, and until it lands nobody can say which room this id is — so a
    // caller that drew nothing here would blank every deep link for as long as
    // the list took. `ChannelsPage` draws the room's loading state instead; only
    // `redirecting` earns a blank.
    team.status = 'loading';
    team.room = null;
    const { result } = renderHook(() => useTeamRoomRedirect('room-other', undefined));

    expect(result.current).toBe('pending');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('still sends an archived #team home, where the offer to bring it back lives', () => {
    // `/channels` would draw the room the owner deliberately put away. Home is
    // the surface that reports the archive instead of quietly overruling it.
    team.status = 'archived';
    const { result } = renderHook(() => useTeamRoomRedirect('team-room', undefined));

    expect(result.current).toBe('redirecting');
    expect(navigate).toHaveBeenCalledWith({ to: '/', search: {}, replace: true });
  });

  it('shows an unknown id rather than stalling on it', () => {
    // A dead link gets "That conversation isn't here" from the page below —
    // never a blank screen waiting for a room that is never coming.
    team.status = 'missing';
    team.room = null;
    const { result } = renderHook(() => useTeamRoomRedirect('room-gone', undefined));

    expect(result.current).toBe('show');
  });
});
