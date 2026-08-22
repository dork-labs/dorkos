// @vitest-environment jsdom
/**
 * The server half of Today's order key, carried from the wire to the row order
 * (BC-16, DOR-1081).
 *
 * `order-today.ts` already proves what `max(userLastMessageAt, userLastOpenedAt)`
 * DOES with a hand-built `SidebarState`. This file proves the first half is
 * CONNECTED: a real `GET /api/sessions/recent` payload, through the real
 * `useSidebarState`, through the real rules, ending at which row Today draws
 * first. The mapping is four lines and every model test builds its own state
 * literal — so deleting it leaves the whole sidebar suite green, which is
 * exactly the shape of failure this programme keeps catching.
 *
 * It also pins the SOURCE. The live session-list stream carries session records
 * too, and it is the wrong one: `SessionListBroadcaster` applies only the
 * stored-settings overlay, not the room and task origin overlays that suppress
 * this field for turns a person did not start. A room turn's prompt is plain
 * user text no content rule can tell from something you typed, so trusting the
 * stream would reorder Today for work an agent did.
 *
 * @module features/dashboard-sidebar/model/__tests__/user-last-message-seam
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Session } from '@dorkos/shared/types';
import { useInteractionStore } from '@/layers/entities/interactions';
import { useSessionListStore } from '@/layers/entities/session';

const FIXED_NOW = Date.parse('2026-08-11T15:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const AGENT = '/projects/alpha';

/** The recent-sessions payload this test controls, replaced per case. */
const RECENT: { sessions: Session[]; agentActivity: Record<string, string>; warnings: unknown[] } =
  {
    sessions: [],
    agentActivity: {},
    warnings: [],
  };

function makeSession(overrides: Partial<Session> & { id: string; title: string }): Session {
  return {
    createdAt: new Date(FIXED_NOW - 100 * HOUR).toISOString(),
    updatedAt: new Date(FIXED_NOW - HOUR).toISOString(),
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: AGENT,
    ...overrides,
  } as Session;
}

// A settled panel, so these cases are about what they are named after rather
// than about the boot gate. The gate's own behaviour is covered in
// `model/boot/__tests__` (spec `sidebar-simplification` D6).
vi.mock('../boot/use-boot-state', () => ({
  useBootState: () => ({ phase: 'settled', settled: true, fleetKnown: true, startedWarm: false }),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/' } }),
  useSearch: () => ({}),
}));

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useNow: () => FIXED_NOW,
}));

const AGENT_PATHS = [{ id: 'm1', name: 'alpha', projectPath: AGENT }];
const MANIFESTS = { [AGENT]: null };
const ROOMS: unknown[] = [];
const THREADS = { data: [] as unknown[], isLoading: false, error: null };
const ATTENTION: unknown[] = [];
const UPDATE_PREFS = { update: vi.fn(), updateAsync: vi.fn(), isPending: false, isError: false };
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

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => ({ data: { agents: AGENT_PATHS }, isSuccess: true }),
}));

vi.mock('@/layers/entities/attention', () => ({
  useAttentionSignals: () => ATTENTION,
  usePendingInteractions: () => ({ interactions: [], isLoading: false }),
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

// The SUBMODULE, not the barrel — same reason as `use-sidebar-state.test.tsx`.
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
  return {
    ...actual,
    useSidebarPrefs: () => PREFS,
    useUpdateSidebarPrefs: () => UPDATE_PREFS,
    useWelcomeBack: () => WELCOME_BACK,
  };
});

import { useSidebarState } from '../use-sidebar-state';
import { buildSidebarModel } from '../build-sidebar-model';

/**
 * The two conversations the whole file turns on.
 *
 * `written` was OPENED five hours ago and WRITTEN IN twenty minutes ago.
 * `opened` was opened one hour ago and never written in. Interaction recency
 * alone puts `opened` first; only the server field can invert it — which is why
 * removing the mapping reds this and nothing else.
 */
function seedTwoConversations(): void {
  RECENT.sessions = [
    makeSession({ id: 'written', title: 'Written recently' }),
    makeSession({ id: 'opened', title: 'Opened recently' }),
  ] as Session[];
  const { recordOpened } = useInteractionStore.getState();
  recordOpened('session', 'written', FIXED_NOW - 5 * HOUR);
  recordOpened('session', 'opened', FIXED_NOW - HOUR);
}

/** Put the server's answer on a session the way DOR-1081's route does. */
function withUserLastMessageAt(id: string, at: number): void {
  RECENT.sessions = RECENT.sessions.map((session) =>
    session.id === id ? { ...session, userLastMessageAt: new Date(at).toISOString() } : session
  );
}

/** Today's row keys, in the order the sidebar draws them. */
function todayOrder(state: ReturnType<typeof useSidebarState>): string[] {
  const zone = buildSidebarModel(state).zones.find((entry) => entry.id === 'today');
  return (zone?.sections ?? []).flatMap((section) => section.rows.map((row) => row.key));
}

describe('userLastMessageAt reaches Today, from the recent-sessions route', () => {
  beforeEach(() => {
    useSessionListStore.getState().resetStatuses();
    useInteractionStore.getState().reset();
    RECENT.sessions = [];
    RECENT.agentActivity = {};
  });
  afterEach(() => cleanup());

  it('orders by when you last OPENED when the server says nothing', () => {
    // The control. Without it, the case below could pass because `written` was
    // already first for a reason that has nothing to do with the wire.
    seedTwoConversations();
    const { result } = renderHook(() => useSidebarState());

    expect(result.current.userLastMessageAt).toEqual({});
    expect(todayOrder(result.current)).toEqual(['session:opened', 'session:written']);
  });

  it('lifts the one you WROTE in over the one you merely opened later', () => {
    seedTwoConversations();
    withUserLastMessageAt('written', FIXED_NOW - 20 * 60_000);

    const { result } = renderHook(() => useSidebarState());

    // The map carries it, keyed the way the rules read it…
    expect(result.current.userLastMessageAt).toEqual({
      'session:written': new Date(FIXED_NOW - 20 * 60_000).toISOString(),
    });
    // …and the order inverted, which is the claim.
    expect(todayOrder(result.current)).toEqual(['session:written', 'session:opened']);
  });

  it('leaves a session out of the map entirely when the field is absent', () => {
    // Omission, never a guess (BC-16). A zero or an epoch here would parse and
    // rank, which is worse than saying nothing.
    seedTwoConversations();
    withUserLastMessageAt('opened', FIXED_NOW - 30 * 60_000);

    const { result } = renderHook(() => useSidebarState());

    expect(Object.keys(result.current.userLastMessageAt)).toEqual(['session:opened']);
  });
});

describe('the live stream is not a source for it', () => {
  beforeEach(() => {
    useSessionListStore.getState().resetStatuses();
    useInteractionStore.getState().reset();
    RECENT.sessions = [];
  });
  afterEach(() => cleanup());

  it('ignores a stream-delivered record carrying the field', () => {
    // A room turn as the broadcaster sends it: it never ran through the room
    // origin overlay, so it still carries `userLastMessageAt` for a prompt no
    // person typed. It must not reach the order key.
    seedTwoConversations();
    act(() => {
      useSessionListStore.getState().upsertSession({
        ...makeSession({ id: 'opened', title: 'Opened recently', origin: 'room' }),
        userLastMessageAt: new Date(FIXED_NOW).toISOString(),
      });
    });

    const { result } = renderHook(() => useSidebarState());

    expect(result.current.userLastMessageAt).toEqual({});
    // And the positive control in the same test: the REST list CAN say it, so
    // "nothing got through" is a fact about the source and not about the map
    // being dead.
    withUserLastMessageAt('written', FIXED_NOW - 20 * 60_000);
    const { result: afterRest } = renderHook(() => useSidebarState());
    expect(Object.keys(afterRest.current.userLastMessageAt)).toEqual(['session:written']);
  });
});
