// @vitest-environment jsdom
/**
 * The one contract this hook exists to keep: an activity event must not produce
 * a new `SidebarState` (spec §H, Risk R1).
 *
 * A fleet of thirty agents emits a `session_status` roughly every two seconds
 * per working session. A new state object rebuilds every zone, every section and
 * every row — so "the values did not change" has to become "the object did not
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
import { useSessionListStore } from '@/layers/entities/session';

const FIXED_NOW = 1_786_000_000_000;

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/' } }),
  useSearch: () => ({}),
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
const RECENT = { sessions: [], agentActivity: {}, warnings: [] };
const ROOMS: unknown[] = [];
// Hoisted, and that matters: a mock that answered with a fresh `[]` per call
// would move the snapshot's identity by itself and make this suite pass or fail
// for a reason that has nothing to do with the hook. A real `useQuery` hands
// back the same `data` reference until the query refetches.
const THREADS = { data: [] as unknown[], isLoading: false, error: null };

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => ({ data: { agents: AGENT_PATHS }, isSuccess: true }),
}));

// Hoisted for the same reason `THREADS` is: `useAttentionSignals` is a real
// hook over real queries, and mounting it here would need a transport this
// suite does not stand up. Its OWN identity-stability contract — the one that
// matters for this file's claim — is asserted where the hook lives, in
// `entities/attention/__tests__/use-attention-signals.test.tsx`, against the
// same hundred injected activity events.
const ATTENTION: unknown[] = [];
vi.mock('@/layers/entities/attention', () => ({ useAttentionSignals: () => ATTENTION }));

/** The prefs writer, hoisted so its identity never moves the snapshot's. */
const UPDATE_PREFS = { update: vi.fn(), updateAsync: vi.fn(), isPending: false, isError: false };

/**
 * The welcome-back setting, hoisted for the same reason.
 *
 * The real hook reads the shared config query, which needs a transport this
 * suite does not stand up. Only the digest reads it (BC-22), and the digest's
 * own gates are asserted where they live, in `use-digest-facts.test.tsx`.
 */
const WELCOME_BACK = {
  enabled: false,
  absenceThresholdMinutes: 240,
  maxPosts: 3,
  offersEnabled: false,
  setEnabled: vi.fn(),
  setOffersEnabled: vi.fn(),
  isAvailable: true,
  isPending: false,
};

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
vi.mock('@/layers/entities/session/model/use-recent-sessions', () => ({
  useRecentSessions: () => ({ data: RECENT, isLoading: false, isSuccess: true }),
}));

vi.mock('@/layers/entities/room', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/room')>()),
  useRooms: () => ({ data: ROOMS, isLoading: false }),
  useThreads: () => THREADS,
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
  // The prefs WRITER is stubbed, not the readers: `useUpdateSidebarPrefs` is a
  // TanStack mutation over the transport, and Getting started's retirement
  // (BC-13) calls it from inside the hook under test. Its behaviour has its own
  // suite; here it only has to exist.
  return {
    ...actual,
    useSidebarPrefs: () => PREFS,
    useUpdateSidebarPrefs: () => UPDATE_PREFS,
    useWelcomeBack: () => WELCOME_BACK,
  };
});

import { useSidebarState } from '../use-sidebar-state';
// Imported after the mocks like the hook itself, so the rules see the same
// mocked module graph the hook does.
import { buildLibrarySections } from '../rules/build-library-sections';

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

    const agents = buildLibrarySections({
      ...result.current,
      prefs: { ...result.current.prefs, sections: { agents: { collapsed: true } } },
    }).find((entry) => entry.id === 'agents');

    expect(agents?.collapsed).toBe(true);
    expect(agents?.rollup?.workingCount).toBe(1);
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

    const agents = buildLibrarySections({
      ...result.current,
      prefs: { ...result.current.prefs, sections: { agents: { collapsed: true } } },
    }).find((entry) => entry.id === 'agents');
    expect(agents?.rollup?.workingCount ?? 0).toBe(0);
  });

  it('carries lifecycle and nothing else out of the status map', () => {
    act(() => {
      useSessionListStore.getState().setSessionStatus('s1', status('streaming', 'Read'));
    });
    const { result } = renderHook(() => useSidebarState());
    // A verb in the snapshot is the one thing the whole design forbids.
    expect(result.current.sessionStatuses).toEqual({ s1: 'streaming' });
    expect(JSON.stringify(result.current.sessionStatuses)).not.toContain('Read');
  });
});
