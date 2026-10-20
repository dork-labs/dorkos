// @vitest-environment jsdom
/**
 * Which DM the right panel sits beside (DOR-3075): none while the DM view is
 * off, a chat with one agent drawn as a DM, or a group DM, and never the
 * session view behind a DM or an ordinary channel.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { agentAuthorRef } from '@dorkos/shared/room-schemas';
import { useDirectMessagePanel } from '../model/use-direct-message-panel';

const state = vi.hoisted(() => ({
  enabled: false,
  showSessions: false,
  pathname: '/session',
  search: {} as { id?: string },
  mode: 'off' as 'off' | 'dm' | 'session' | 'pending',
  rooms: [] as unknown[],
  roomsAsked: [] as boolean[],
}));

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSafePathname: () => state.pathname,
  useSafeSearch: () => state.search,
}));
vi.mock('@/layers/entities/config', () => ({
  useDmViewEnabled: () => state.enabled,
  useShowSessions: () => state.showSessions,
}));
vi.mock('@/layers/entities/session', () => ({
  useSessionId: () => ['scout-direct', () => {}],
}));
vi.mock('@/layers/entities/room', () => ({
  routeShowsRoom: (pathname: string) => pathname === '/channels' || pathname === '/',
  useRooms: ({ enabled }: { enabled: boolean }) => {
    state.roomsAsked.push(enabled);
    return { data: enabled ? state.rooms : undefined };
  },
}));
vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => ({ data: { agents: [{ id: 'm-qa', projectPath: '/agents/qa' }] } }),
}));
vi.mock('../model/use-direct-message-view', () => ({
  useDirectMessageView: (sessionId: string | null) => ({
    mode: sessionId === null ? 'off' : state.mode,
    chat:
      sessionId !== null && (state.mode === 'dm' || state.mode === 'session')
        ? { sessionId, sessionIds: [sessionId], roomId: 'dm-1', agentPath: '/agents/scout' }
        : null,
  }),
}));

afterEach(() => {
  cleanup();
  Object.assign(state, {
    enabled: false,
    showSessions: false,
    pathname: '/session',
    search: {},
    mode: 'off',
    rooms: [],
    roomsAsked: [],
  });
});

const GROUP = {
  id: 'g1',
  kind: 'dm',
  bridge: null,
  working: 1,
  participants: [
    { id: 'h1', kind: 'human', displayName: 'Dorian', handle: null },
    { id: 'h2', kind: 'human', displayName: 'Maya', handle: null },
    {
      id: 'a1',
      kind: 'agent',
      displayName: 'qa',
      handle: 'qa',
      agentRef: agentAuthorRef('/agents/qa'),
    },
  ],
};

describe('useDirectMessagePanel', () => {
  it('is null, and reads no rooms, with the DM view off', () => {
    state.mode = 'dm';
    expect(renderHook(() => useDirectMessagePanel()).result.current).toBeNull();
    state.pathname = '/channels';
    state.search = { id: 'g1' };
    state.rooms = [GROUP];
    expect(renderHook(() => useDirectMessagePanel()).result.current).toBeNull();
    expect(state.roomsAsked.every((asked) => !asked)).toBe(true);
  });

  it('names a chat with one agent drawn as a DM, and whether Show sessions is on', () => {
    state.enabled = true;
    state.mode = 'dm';
    state.showSessions = true;
    expect(renderHook(() => useDirectMessagePanel()).result.current).toEqual({
      kind: 'one-to-one',
      sessionId: 'scout-direct',
      agentPath: '/agents/scout',
      showSessions: true,
    });
  });

  it('is null on the session view behind a DM, and beside an ordinary session', () => {
    state.enabled = true;
    state.mode = 'session';
    expect(renderHook(() => useDirectMessagePanel()).result.current).toBeNull();
    state.mode = 'off';
    expect(renderHook(() => useDirectMessagePanel()).result.current).toBeNull();
  });

  it('names a group DM with the agents its picker offers', () => {
    state.enabled = true;
    state.pathname = '/channels';
    state.search = { id: 'g1' };
    state.rooms = [GROUP, { id: 'c1', kind: 'channel', bridge: null, participants: null }];
    expect(renderHook(() => useDirectMessagePanel()).result.current).toEqual({
      kind: 'group',
      roomId: 'g1',
      members: [{ authorId: 'a1', agentPath: '/agents/qa', displayName: 'qa' }],
      working: true,
      showSessions: false,
    });
    state.search = { id: 'c1' };
    expect(renderHook(() => useDirectMessagePanel()).result.current).toBeNull();
  });
});
