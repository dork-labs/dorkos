/**
 * How the panel's boot phase moves (spec `sidebar-simplification` D6).
 *
 * Every entity barrel this hook reads is mocked, because the subject is the
 * hook's ARBITRATION of ten query states and not the queries themselves —
 * standing up ten real queries would test TanStack.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/** One query's state, as the gate reads it. */
interface FakeQuery {
  status: 'pending' | 'success' | 'error';
  dataUpdatedAt: number;
  data?: unknown;
}

const pending: FakeQuery = { status: 'pending', dataUpdatedAt: 0 };
const settled = (data?: unknown): FakeQuery => ({ status: 'success', dataUpdatedAt: 0, data });
/** Settled AND hydrated at mount — what a persisted cache looks like (task 3.2). */
const hydrated = (data?: unknown): FakeQuery => ({ status: 'success', dataUpdatedAt: 1, data });

const queries: Record<string, FakeQuery> = {
  config: pending,
  rooms: pending,
  threads: pending,
  mesh: pending,
  manifests: pending,
  recents: pending,
  roster: pending,
};

/**
 * Heads up's three sources, which hide their query behind an `isLoading`.
 *
 * Settled by default so the cases below can move one variable at a time; the
 * gate's own truth table covers each of them individually.
 */
const attention = { approvals: false, interactions: false, scheduleApprovals: false };

vi.mock('@/layers/entities/config', () => ({ useConfig: () => queries.config }));
vi.mock('@/layers/entities/room', () => ({
  useRooms: () => queries.rooms,
  useThreads: () => queries.threads,
}));
vi.mock('@/layers/entities/mesh', () => ({ useMeshAgentPaths: () => queries.mesh }));
vi.mock('@/layers/entities/agent', () => ({ useResolvedAgents: () => queries.manifests }));
vi.mock('@/layers/entities/session', () => ({
  RECENT_SESSIONS_WINDOW: 24,
  useRecentSessions: () => queries.recents,
}));
vi.mock('@/layers/entities/team', () => ({ useTeamRoster: () => queries.roster }));
vi.mock('@/layers/entities/attention', () => ({
  usePendingApprovals: () => ({ isLoading: attention.approvals }),
  usePendingInteractions: () => ({ isLoading: attention.interactions }),
  usePendingScheduleApprovals: () => ({ isLoading: attention.scheduleApprovals }),
}));

const { useBootState } = await import('../use-boot-state');
const { BOOT_GATE_TIMEOUT_MS } = await import('../boot-gate');

/** An install with one agent directory, so manifests are part of the gate. */
const ONE_AGENT = { agents: [{ projectPath: '/work/scout' }] };

/** Every gate member answered, on an install with one agent. */
const ALL_ANSWERED = {
  config: settled(),
  rooms: settled(),
  threads: settled(),
  mesh: settled(ONE_AGENT),
  manifests: settled(),
  recents: settled(),
  roster: settled(),
};

function seed(overrides: Partial<Record<keyof typeof queries, FakeQuery>>) {
  for (const key of Object.keys(queries)) queries[key] = pending;
  Object.assign(queries, overrides);
}

beforeEach(() => {
  vi.useFakeTimers();
  seed({});
  attention.approvals = false;
  attention.interactions = false;
  attention.scheduleApprovals = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useBootState', () => {
  it('starts cold when nothing is known', () => {
    const { result } = renderHook(() => useBootState());
    expect(result.current.phase).toBe('cold');
    expect(result.current.settled).toBe(false);
    expect(result.current.startedWarm).toBe(false);
  });

  it('settles once every source has answered', () => {
    const { result, rerender } = renderHook(() => useBootState());
    expect(result.current.phase).toBe('cold');

    seed(ALL_ANSWERED);
    rerender();
    expect(result.current.phase).toBe('settled');
    expect(result.current.fleetKnown).toBe(true);
  });

  it('still holds while one source is pending', () => {
    const { result, rerender } = renderHook(() => useBootState());
    // The roster is the one the header's team name waits for.
    seed({ ...ALL_ANSWERED, roster: pending });
    rerender();
    expect(result.current.phase).toBe('cold');
  });

  it('still holds while Heads up’s approvals are pending', () => {
    // Added to the gate after review: a zone arriving at the TOP of the panel a
    // beat late pushes every row below it down, which is the second beat the
    // gate exists to remove.
    const { result, rerender } = renderHook(() => useBootState());
    seed(ALL_ANSWERED);
    attention.approvals = true;
    rerender();
    expect(result.current.phase).toBe('cold');

    attention.approvals = false;
    rerender();
    expect(result.current.phase).toBe('settled');
  });

  it('gives up after the timeout and paints what it has', () => {
    // Per-query degradation: a source that never answers must not be able to
    // hold the panel at a skeleton forever.
    const { result } = renderHook(() => useBootState());
    expect(result.current.settled).toBe(false);

    act(() => {
      vi.advanceTimersByTime(BOOT_GATE_TIMEOUT_MS);
    });
    expect(result.current.settled).toBe(true);
    expect(result.current.phase).toBe('settled');
  });

  it('never goes back to cold once it has settled', () => {
    // A background refetch is not a boot. Without the latch the panel would
    // flash its skeleton every time a query went pending again.
    seed(ALL_ANSWERED);
    const { result, rerender } = renderHook(() => useBootState());
    expect(result.current.settled).toBe(true);

    seed({ ...ALL_ANSWERED, rooms: pending });
    rerender();
    expect(result.current.settled).toBe(true);
  });

  it('reads a fully hydrated mount as warm — the seam task 3.2 fills', () => {
    seed({
      config: hydrated(),
      rooms: hydrated(),
      threads: hydrated(),
      mesh: hydrated(ONE_AGENT),
      manifests: hydrated(),
      recents: hydrated(),
      roster: hydrated(),
    });
    const { result } = renderHook(() => useBootState());
    expect(result.current.startedWarm).toBe(true);
    // And it is already settled, so no skeleton ever renders and the reveal is
    // never owed — which is the whole point of a warm boot.
    expect(result.current.phase).toBe('settled');
  });

  it('does not call a mount warm when one source was missing from the cache', () => {
    seed({
      config: hydrated(),
      rooms: hydrated(),
      threads: hydrated(),
      mesh: hydrated(ONE_AGENT),
      manifests: hydrated(),
      recents: hydrated(),
      roster: pending,
    });
    const { result } = renderHook(() => useBootState());
    expect(result.current.startedWarm).toBe(false);
  });

  it('counts a fleet-less install as warm without waiting for manifests', () => {
    // The manifests query is disabled with no paths, so it reports
    // `dataUpdatedAt: 0` forever — reading that as cold would deny a returning
    // operator with no agents the warm paint their cache earned.
    seed({
      config: hydrated(),
      rooms: hydrated(),
      threads: hydrated(),
      mesh: hydrated({ agents: [] }),
      manifests: pending,
      recents: hydrated(),
      roster: hydrated(),
    });
    const { result } = renderHook(() => useBootState());
    expect(result.current.startedWarm).toBe(true);
  });
});

describe('useBootState — the fleet does not degrade with the rest (DOR-1143)', () => {
  it('paints on the timeout while still withholding the fleet', () => {
    // The regression this exists to stop: mesh and manifests are two SERIAL
    // round trips, so a slow install reaches 1500 ms with the directories known
    // and their manifests still in flight. Opening the gate there is right —
    // the panel should paint — but drawing the agent rows there is not, because
    // their faces would be hashed from the directory and change on arrival.
    seed({ ...ALL_ANSWERED, manifests: pending });
    const { result, rerender } = renderHook(() => useBootState());
    expect(result.current.settled).toBe(false);

    act(() => {
      vi.advanceTimersByTime(BOOT_GATE_TIMEOUT_MS);
    });
    expect(result.current.settled).toBe(true);
    expect(result.current.fleetKnown).toBe(false);

    seed(ALL_ANSWERED);
    rerender();
    expect(result.current.fleetKnown).toBe(true);
  });

  it('never withdraws a fleet it has already shown', () => {
    // A refetch of the manifests must not blank the agent rows mid-session.
    seed(ALL_ANSWERED);
    const { result, rerender } = renderHook(() => useBootState());
    expect(result.current.fleetKnown).toBe(true);

    seed({ ...ALL_ANSWERED, manifests: pending });
    rerender();
    expect(result.current.fleetKnown).toBe(true);
  });

  it('knows the fleet immediately on an install with no agents', () => {
    seed({ ...ALL_ANSWERED, mesh: settled({ agents: [] }), manifests: pending });
    const { result } = renderHook(() => useBootState());
    expect(result.current.fleetKnown).toBe(true);
  });
});
