// @vitest-environment jsdom
/**
 * The one contract this hook exists to keep: an activity event must not produce
 * a new `SidebarState` (spec §H, Risk R1).
 *
 * A fleet of thirty agents emits a `session_status` roughly every two seconds
 * per working session. A new state object rebuilds every section and every row — so "the values did not change" has to become "the object did not
 * change", or the whole design's performance claim is a comment.
 *
 * **`useAgentAttentionMap` is deliberately NOT mocked.** It is the hook that
 * hands back a structurally identical record with a fresh identity on every
 * store tick, and it is the reason the guard exists. Stubbing it with a stable
 * object would make this file pass with the guard deleted.
 *
 * @module features/dashboard-sidebar/model/__tests__/use-sidebar-state
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import type { Session } from '@dorkos/shared/types';
import { agentAuthorRef } from '@dorkos/shared/room-schemas';
import { setSessionRouteContext, useSessionListStore } from '@/layers/entities/session';

const FIXED_NOW = 1_786_000_000_000;

// A settled panel, so these cases are about what they are named after rather
// than about the boot gate. The gate's own behaviour is covered in
// `model/boot/__tests__` (spec `sidebar-simplification` D6).
vi.mock('../boot/use-boot-state', () => ({
  useBootState: () => ({ phase: 'settled', settled: true, fleetKnown: true, startedWarm: false }),
}));

// Where the router is, switchable per test; Home with no search by default.
const route = { pathname: '/', search: {} as Record<string, string> };

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: route.pathname } }),
  useSearch: () => route.search,
}));

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useNow: () => FIXED_NOW,
}));

// The three query-backed reads, answered from constants that never change
// identity — so anything that DOES change identity across a rerender came from
// the store, which is exactly what is under test.
const AGENT_PATHS = [{ id: 'm1', name: 'alpha', projectPath: '/projects/alpha' }];
const MANIFESTS = { '/projects/alpha': null };
// Mutable on purpose: one test fills the window and puts it back.
const RECENT = { sessions: [] as Session[], agentActivity: {}, warnings: [] };
// Hoisted, and that matters: a mock that answered with a fresh `[]` per call
// would move the snapshot's identity by itself and make this suite pass or fail
// for a reason that has nothing to do with the hook. A real `useQuery` hands
// back the same `data` reference until the query refetches.
const ROOMS: unknown[] = [];

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => ({ data: { agents: AGENT_PATHS }, isSuccess: true }),
}));


vi.mock('@/layers/entities/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/agent')>()),
  useResolvedAgents: () => ({ data: MANIFESTS, isSuccess: true }),
  useExecutionExceptions: () => ({
    exceptions: [],
    brokenPaths: [],
    defaultRuntime: 'claude-code',
  }),
}));

// The SUBMODULE, not the barrel: `agent-attention.ts` imports
// `useRecentSessions` from './use-recent-sessions' directly, so a barrel mock
// would leave the real hook reaching for a transport this suite does not mount.
vi.mock('@/layers/entities/session/model/query/use-recent-sessions', () => ({
  useRecentSessions: () => ({ data: RECENT, isLoading: false, isSuccess: true }),
}));

vi.mock('@/layers/entities/room', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/room')>()),
  useRooms: () => ({ data: ROOMS, isLoading: false }),
}));

vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  const PREFS = {
    pinned: [],
    groups: [],
    muted: [],
    sections: {},
    gettingStarted: { retired: [] },
    digest: {},
  };
  return { ...actual, useSidebarPrefs: () => PREFS };
});

import { useSidebarState } from '../use-sidebar-state';
// Imported after the mocks like the hook itself, so the rules see the same
// mocked module graph the hook does.
import { buildSections } from '../rules/build-sections';
import type { SidebarState } from '../sidebar-state';

/**
 * The hook's snapshot with alpha given a direct message — so alpha is a row in
 * Direct messages — and that section folded.
 *
 * @param state - The real hook's snapshot.
 */
function withFoldedAlphaDm(state: SidebarState): SidebarState {
  return {
    ...state,
    rooms: [
      {
        id: 'dm-alpha',
        kind: 'dm',
        slug: null,
        title: 'alpha',
        topic: null,
        archived: false,
        ambientMaxEntries: 50,
        wellKnown: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        lastActivityAt: '2026-10-01T00:00:00.000Z',
        unreadCount: 0,
        participants: [
          { id: 'person:me', kind: 'human', displayName: 'Me', handle: null },
          {
            id: 'agent:alpha',
            kind: 'agent',
            displayName: 'alpha',
            handle: null,
            agentRef: agentAuthorRef('/projects/alpha'),
          },
        ],
      },
    ],
    prefs: { ...state.prefs, sections: { dms: { collapsed: true } } },
  };
}

/** A `session_status` projection with a lifecycle and, optionally, a verb. */
function status(lifecycle: SessionStatus['lifecycle'], toolName?: string): SessionStatus {
  return {
    lifecycle,
    ...(toolName === undefined
      ? {}
      : { activity: { kind: 'tool' as const, toolName, at: new Date(FIXED_NOW).toISOString() } }),
  } as SessionStatus;
}

describe('useSidebarState — referential stability (spec §H)', () => {
  beforeEach(() => {
    useSessionListStore.getState().resetStatuses();
  });
  afterEach(() => cleanup());

  it('produces NO new state object when an activity event arrives', () => {
    act(() => {
      useSessionListStore.getState().setSessionStatus('s1', status('streaming', 'Read'));
    });
    const { result, rerender } = renderHook(() => useSidebarState());
    const before = result.current;

    // The same turn, a different tool — exactly what a fleet emits every couple
    // of seconds per working session.
    act(() => {
      useSessionListStore.getState().setSessionStatus('s1', status('streaming', 'Edit'));
    });
    rerender();

    // Named rather than counted: `toBe` alone says "a new object", and the
    // first question anyone asks is which field moved.
    const fieldsOf = (state: typeof before) => state as unknown as Record<string, unknown>;
    const changed = Object.keys(before).filter(
      (key) => fieldsOf(before)[key] !== fieldsOf(result.current)[key]
    );
    expect(changed).toEqual([]);
    expect(result.current).toBe(before);
  });

  it('survives a hundred of them', () => {
    act(() => {
      useSessionListStore.getState().setSessionStatus('s1', status('streaming', 'Read'));
    });
    const { result, rerender } = renderHook(() => useSidebarState());
    const before = result.current;
    for (let i = 0; i < 100; i += 1) {
      act(() => {
        useSessionListStore.getState().setSessionStatus('s1', status('streaming', `Tool${i}`));
      });
      rerender();
    }
    expect(result.current).toBe(before);
  });

  it('DOES produce a new state object when the lifecycle changes', () => {
    // The other half of the guard, and the half that proves it is not simply
    // returning a frozen object: layout comes from lifecycle, so a lifecycle
    // change has to reach the model.
    act(() => {
      useSessionListStore.getState().setSessionStatus('s1', status('streaming', 'Read'));
    });
    const { result, rerender } = renderHook(() => useSidebarState());
    const before = result.current;
    expect(before.workingSessionIds).toEqual(['s1']);

    act(() => {
      useSessionListStore.getState().setSessionStatus('s1', status('idle'));
    });
    rerender();

    expect(result.current).not.toBe(before);
    expect(result.current.workingSessionIds).toEqual([]);
  });

  it('carries each live session’s DIRECTORY out of the store, not just its id', () => {
    // The one line Defect C rests on (`liveSessionCwds ← statusCwds`), which
    // shipped with no coverage at all: every model test builds its own
    // `SidebarState` literal, so replacing this selector with a stable empty
    // record left 10,809 tests green (DOR-1137 review, B1).
    act(() => {
      useSessionListStore.getState().setSessionStatus('s1', status('streaming'), '/projects/alpha');
    });
    const { result } = renderHook(() => useSidebarState());
    expect(result.current.liveSessionCwds).toEqual({ s1: '/projects/alpha' });
  });

  it('closes the folding gap end to end — store, hook, rules', () => {
    // The field arriving is necessary and not sufficient: what BC-31 promises is
    // that a folded section still says a member is working, and the only proof
    // of that is the real hook's snapshot going through the real rules. The
    // session is deliberately absent from the recent-sessions window (`RECENT`
    // is empty above), which is precisely the 30-second state the fix is about.
    act(() => {
      useSessionListStore.getState().setSessionStatus('s1', status('streaming'), '/projects/alpha');
    });
    const { result } = renderHook(() => useSidebarState());
    expect(result.current.sessions).toEqual([]);

    const dms = buildSections(withFoldedAlphaDm(result.current)).find(
      (entry) => entry.id === 'dms'
    );

    expect(dms?.collapsed).toBe(true);
    expect(dms?.rollup?.workingCount).toBe(1);
  });

  it('says nothing about a live session the server could not place', () => {
    // The sibling that stops the pair above from passing on an inert path: same
    // streaming status, no directory on the event, so no entry — omission
    // rather than a guess — and no section can claim it.
    act(() => {
      useSessionListStore.getState().setSessionStatus('s2', status('streaming'));
    });
    const { result } = renderHook(() => useSidebarState());
    expect(result.current.workingSessionIds).toEqual(['s2']);
    expect(result.current.liveSessionCwds).toEqual({});

    const dms = buildSections(withFoldedAlphaDm(result.current)).find(
      (entry) => entry.id === 'dms'
    );
    expect(dms?.rollup?.workingCount ?? 0).toBe(0);
  });

  it('carries which sessions are live and nothing about what they are doing', () => {
    act(() => {
      useSessionListStore.getState().setSessionStatus('s1', status('streaming', 'Read'));
    });
    const { result } = renderHook(() => useSidebarState());
    // A verb in the snapshot is the one thing the whole design forbids.
    expect(result.current.workingSessionIds).toEqual(['s1']);
    expect(JSON.stringify(result.current)).not.toContain('Read');
  });
});

describe('useSidebarState — the whole recent window (your-activity-first D10)', () => {
  afterEach(() => {
    RECENT.sessions = [];
    cleanup();
  });

  it('reads every session the window carries, so ten newer agent chats cannot push yours out', () => {
    // Twelve newer agent chats, then a chat you used on another device. The
    // sidebar once sliced the window to ten BEFORE deciding whose each chat
    // was, which is exactly what dropped this one.
    const at = new Date(FIXED_NOW - 2 * 3_600_000).toISOString();
    RECENT.sessions = [
      ...Array.from({ length: 12 }, (_, index): Session => ({
        id: `agent-${index}`,
        title: `Agent ${index}`,
        createdAt: at,
        updatedAt: new Date(FIXED_NOW - index * 1000).toISOString(),
        permissionMode: 'default',
        runtime: 'claude-code',
        origin: 'agent',
      })),
      {
        id: 'mine',
        title: 'Mine',
        createdAt: at,
        updatedAt: at,
        permissionMode: 'default',
        runtime: 'claude-code',
        lastTouchedByYouAt: at,
      },
    ];
    const { result } = renderHook(() => useSidebarState());
    expect(result.current.sessions.map((entry) => entry.id)).toContain('mine');
  });
});

describe('useSidebarState — what is open (DOR-2845)', () => {
  afterEach(() => {
    route.pathname = '/';
    route.search = {};
    cleanup();
  });

  it('places an open chat from its route context, since links no longer carry ?dir=', () => {
    // A brand-new chat the session list has not caught up with: the only thing
    // that knows its agent is what the route loader resolved. Without it the
    // sidebar row named the chat "Session".
    route.pathname = '/session';
    route.search = { session: 'ses-brand-new' };
    setSessionRouteContext('ses-brand-new', { cwd: '/projects/alpha', draft: true });

    const { result } = renderHook(() => useSidebarState());

    expect(result.current.activeTarget).toEqual({
      kind: 'session',
      sessionId: 'ses-brand-new',
      agentPath: '/projects/alpha',
      cwd: '/projects/alpha',
    });
  });

  it('names the Threads page and the Directory as open, so their doors light', () => {
    route.pathname = '/threads';
    const threads = renderHook(() => useSidebarState());
    expect(threads.result.current.activeTarget).toEqual({
      kind: 'command',
      commandId: 'open-threads',
    });
    threads.unmount();

    route.pathname = '/team';
    const directory = renderHook(() => useSidebarState());
    expect(directory.result.current.activeTarget).toEqual({
      kind: 'command',
      commandId: 'open-directory',
    });
  });
});

describe('useSidebarState — @mentions come from the room list (BC-40)', () => {
  afterEach(() => {
    ROOMS.length = 0;
    cleanup();
  });

  /** A channel as the room list carries it. */
  function listed(id: string, extra: Record<string, unknown>) {
    return {
      id,
      kind: 'channel',
      slug: id,
      title: id,
      topic: null,
      archived: false,
      createdAt: '2026-10-01T00:00:00.000Z',
      lastActivityAt: '2026-10-01T00:00:00.000Z',
      participants: null,
      ...extra,
    };
  }

  it('carries each room’s server-counted mentions, and leaves out rooms with none', () => {
    ROOMS.push(
      listed('named', { unreadCount: 5, mentionCount: 2 }),
      listed('busy', { unreadCount: 40, mentionCount: 0 }),
      // A room the viewer is not in has no cursor, so the server sends no count.
      listed('outside', { unreadCount: null })
    );
    const { result } = renderHook(() => useSidebarState());
    expect(result.current.mentions).toEqual({ named: 2 });
  });
});
