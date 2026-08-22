// @vitest-environment jsdom
/**
 * "Say hi in #team" is REACHABLE — the server's answer, carried from the wire to
 * the suggestion a person actually sees (BC-12, DOR-1112).
 *
 * `getting-started.test.ts` already proves what the rule DOES with a hand-built
 * `JourneyFacts`. It cannot prove the fact is connected to anything: for its
 * whole life `hasPostedInTeam` was hardcoded `true` in `useJourneyFacts`, so
 * every one of those tests passed while the suggestion could not reach a single
 * real operator. This file starts one layer earlier — at a `RoomSummary` shaped
 * like the one `GET /api/rooms` returns — and ends at the row Getting started
 * draws, so the hardcode cannot come back unnoticed.
 *
 * It also pins the two directions separately, because they fail differently: a
 * field stuck `false` shows the suggestion to somebody who has been talking in
 * #team for months, and a field stuck `true` is the bug this replaced.
 *
 * @module features/dashboard-sidebar/model/__tests__/say-hi-team-seam
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { TEAM_ROOM_WELL_KNOWN, type RoomSummary } from '@dorkos/shared/room-schemas';
import type { Session } from '@dorkos/shared/types';
import { useInteractionStore } from '@/layers/entities/interactions';
import { useSessionListStore } from '@/layers/entities/session';

const FIXED_NOW = Date.parse('2026-08-11T15:00:00.000Z');
const AGENT = '/projects/alpha';

/** The room list this test controls, replaced per case. */
const ROOMS: RoomSummary[] = [];

/** The recent-sessions payload, so the roster resolves and the facts are real. */
const RECENT: { sessions: Session[]; agentActivity: Record<string, string>; warnings: unknown[] } =
  { sessions: [], agentActivity: {}, warnings: [] };

/**
 * #team as `GET /api/rooms` returns it.
 *
 * `viewerHasPosted` is the only field any case here varies, and it is passed
 * through `Partial` rather than defaulted so a case can leave it ABSENT — which
 * is a third state on the wire, not a synonym for `false`.
 *
 * @param overrides - What this particular case says about the room.
 */
function teamRoom(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'room-team',
    kind: 'channel',
    slug: 'team',
    title: '#team',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 50,
    wellKnown: TEAM_ROOM_WELL_KNOWN,
    createdAt: new Date(FIXED_NOW - 86_400_000).toISOString(),
    lastActivityAt: new Date(FIXED_NOW - 3_600_000).toISOString(),
    unreadCount: 0,
    participants: null,
    working: 0,
    ...overrides,
  };
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

/** What Getting started is currently suggesting, by reason. */
function suggestions(state: ReturnType<typeof useSidebarState>): string[] {
  const zone = buildSidebarModel(state).zones.find((entry) => entry.id === 'getting-started');
  return (zone?.sections ?? []).flatMap((section) => section.rows.map((row) => row.reason ?? ''));
}

/** Put a room list on the wire, as the server would answer it. */
function serverSays(...rooms: RoomSummary[]): void {
  ROOMS.length = 0;
  ROOMS.push(...rooms);
}

describe('the #team suggestion is driven by the server, not by a constant', () => {
  beforeEach(() => {
    useSessionListStore.getState().resetStatuses();
    useInteractionStore.getState().reset();
    ROOMS.length = 0;
    RECENT.sessions = [];
    RECENT.agentActivity = {};
  });
  afterEach(() => cleanup());

  it('offers "Say hi in #team" to an operator who has never posted there', () => {
    serverSays(teamRoom({ viewerHasPosted: false }));

    const { result } = renderHook(() => useSidebarState());

    expect(result.current.journey.hasPostedInTeam).toBe(false);
    expect(suggestions(result.current)).toContain('suggestion:say-hi-team');
  });

  it('drops it the moment the server says they have posted', () => {
    serverSays(teamRoom({ viewerHasPosted: true }));

    const { result } = renderHook(() => useSidebarState());

    expect(result.current.journey.hasPostedInTeam).toBe(true);
    expect(suggestions(result.current)).not.toContain('suggestion:say-hi-team');
  });

  it('stays quiet when the field is absent — "cannot say" is not "never posted"', () => {
    // An install that predates the field, and the reason the client reads it as
    // `true`: nudging somebody who has been talking in #team for months is the
    // failure this suggestion must never produce.
    serverSays(teamRoom());

    const { result } = renderHook(() => useSidebarState());

    expect(suggestions(result.current)).not.toContain('suggestion:say-hi-team');
  });

  it('stays quiet when #team is not in the list at all', () => {
    // Archived, or a list that has not answered yet. Same rule, different cause.
    serverSays(teamRoom({ wellKnown: null, id: 'room-other', slug: 'backend' }));

    const { result } = renderHook(() => useSidebarState());

    expect(suggestions(result.current)).not.toContain('suggestion:say-hi-team');
  });

  it('finds #team by its key, so renaming the channel does not silence the suggestion', () => {
    // The owner renamed it. A lookup on `#team` would find nothing here and go
    // quiet, which is exactly the bug `useTeamRoom` documents.
    serverSays(teamRoom({ title: 'The Crew', slug: 'the-crew', viewerHasPosted: false }));

    const { result } = renderHook(() => useSidebarState());

    expect(suggestions(result.current)).toContain('suggestion:say-hi-team');
  });
});
