// @vitest-environment jsdom
/**
 * Which room the panel is about, on every route that can answer.
 *
 * The panel holds no selection of its own — it reads the route (spec
 * `one-bar-header` §3.6) — so this hook is the whole of "which room", and every
 * branch of it decides what a person sees in the panel beside their room.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { routeShowsRoom, useRouteRoom } from '../model/use-route-room';

const route = { pathname: '/', search: {} as { id?: string } };
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useSafePathname: () => route.pathname,
    useSafeSearch: () => route.search,
  };
});

/** What `useTeamRoom` is answering with, per test. */
const team = { current: { status: 'ready', room: { id: 'team-room' }, retry: vi.fn() } as unknown };
vi.mock('@/layers/entities/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/room')>();
  return { ...actual, useTeamRoom: () => team.current };
});

beforeEach(() => {
  route.pathname = '/';
  route.search = {};
  team.current = { status: 'ready', room: { id: 'team-room' }, retry: vi.fn() };
});

describe('routeShowsRoom', () => {
  it('names the two routes that put a room on screen, and no others', () => {
    // The predicate the Room tab's `visibleWhen` uses. It and `useRouteRoom`
    // have to agree, or the tab is offered where the panel has nothing to
    // describe — which is why they live in one file.
    expect(routeShowsRoom('/channels')).toBe(true);
    expect(routeShowsRoom('/')).toBe(true);
    expect(routeShowsRoom('/session')).toBe(false);
    expect(routeShowsRoom('/team')).toBe(false);
    expect(routeShowsRoom('/marketplace')).toBe(false);
  });
});

describe('useRouteRoom', () => {
  it('reads the open channel off the address', () => {
    route.pathname = '/channels';
    route.search = { id: 'room-1' };

    expect(renderHook(() => useRouteRoom()).result.current).toEqual({
      status: 'ready',
      roomId: 'room-1',
    });
  });

  it('has no room for /channels with no id, which is the route before you pick one', () => {
    route.pathname = '/channels';

    expect(renderHook(() => useRouteRoom()).result.current).toEqual({ status: 'none' });
  });

  it('takes an unknown id at its word, because the id IS the address', () => {
    // A room that has been deleted, or a link that was always wrong, is not
    // something this hook can tell apart from one still being read — only the
    // room read can. So it resolves, and the panel says "that room isn't here"
    // when the read comes back empty (`RoomPanelBody`). Red if this ever starts
    // guessing: a real room would be reported missing while its read is still
    // in flight.
    route.pathname = '/channels';
    route.search = { id: 'no-such-room' };

    expect(renderHook(() => useRouteRoom()).result.current).toEqual({
      status: 'ready',
      roomId: 'no-such-room',
    });
  });

  it('is #team on Home, found by its well-known key rather than by name', () => {
    expect(renderHook(() => useRouteRoom()).result.current).toEqual({
      status: 'ready',
      roomId: 'team-room',
    });
  });

  it('waits rather than guessing while #team is still being looked up', () => {
    team.current = { status: 'loading', room: null, retry: vi.fn() };

    expect(renderHook(() => useRouteRoom()).result.current).toEqual({ status: 'loading' });
  });

  it.each([['archived'], ['missing'], ['error']])(
    'shows no room for a #team that is %s',
    (status) => {
      // Home draws no conversation for any of these — it offers to bring the
      // room back, or says it cannot find it — so a panel about one would be
      // settings for something that is not on screen.
      team.current = { status, room: status === 'archived' ? { id: 'team-room' } : null, retry: vi.fn() };

      expect(renderHook(() => useRouteRoom()).result.current).toEqual({ status: 'none' });
    }
  );

  it('shows no room on a route that has none, whatever the search params say', () => {
    // `?id=` is only an address on `/channels`. A stray one elsewhere — a
    // marketplace filter, say — must not be read as a room.
    route.pathname = '/marketplace';
    route.search = { id: 'room-1' };

    expect(renderHook(() => useRouteRoom()).result.current).toEqual({ status: 'none' });
  });
});
