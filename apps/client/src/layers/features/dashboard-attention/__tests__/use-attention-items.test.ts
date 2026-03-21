/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Session } from '@dorkos/shared/types';
import type { PulseRun } from '@dorkos/shared/types';
import type { AggregatedDeadLetter } from '@dorkos/shared/transport';
import type { MeshStatus } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Mocks — must be before imports
// ---------------------------------------------------------------------------

const mockSessions = vi.fn<() => { sessions: Session[] }>(() => ({ sessions: [] }));
vi.mock('@/layers/entities/session', () => ({
  useSessions: () => mockSessions(),
}));

const mockUseRuns = vi.fn<() => { data: PulseRun[] | undefined }>(() => ({ data: undefined }));
vi.mock('@/layers/entities/pulse', () => ({
  useRuns: () => mockUseRuns(),
}));

const mockUseAggregatedDeadLetters = vi.fn<() => { data: AggregatedDeadLetter[] | undefined }>(
  () => ({ data: undefined })
);
vi.mock('@/layers/entities/relay', () => ({
  useAggregatedDeadLetters: () => mockUseAggregatedDeadLetters(),
}));

const mockUseMeshStatus = vi.fn<() => { data: MeshStatus | undefined }>(() => ({
  data: undefined,
}));
vi.mock('@/layers/entities/mesh', () => ({
  useMeshStatus: () => mockUseMeshStatus(),
}));

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

const mockSetRelayOpen = vi.fn();
const mockSetMeshOpen = vi.fn();
const mockSetPulseOpen = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setRelayOpen: mockSetRelayOpen,
      setMeshOpen: mockSetMeshOpen,
      setPulseOpen: mockSetPulseOpen,
    };
    return selector(state);
  },
}));

import { useAttentionItems } from '../model/use-attention-items';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    title: 'Test Session',
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(), // 45 min ago
    permissionMode: 'default',
    ...overrides,
  };
}

function makeRun(overrides: Partial<PulseRun> = {}): PulseRun {
  return {
    id: 'run-1',
    scheduleId: 'sched-1',
    status: 'failed',
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    outputSummary: null,
    error: 'Something went wrong',
    sessionId: null,
    trigger: 'scheduled',
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    ...overrides,
  };
}

function makeDeadLetterGroup(overrides: Partial<AggregatedDeadLetter> = {}): AggregatedDeadLetter {
  return {
    source: 'telegram-adapter',
    reason: 'hop_limit',
    count: 3,
    firstSeen: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    lastSeen: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function makeMeshStatus(unreachableCount: number): MeshStatus {
  return {
    totalAgents: 5,
    activeCount: 5 - unreachableCount,
    inactiveCount: 0,
    staleCount: 0,
    unreachableCount,
    byRuntime: {},
    byProject: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAttentionItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessions.mockReturnValue({ sessions: [] });
    mockUseRuns.mockReturnValue({ data: undefined });
    mockUseAggregatedDeadLetters.mockReturnValue({ data: undefined });
    mockUseMeshStatus.mockReturnValue({ data: undefined });
  });

  it('returns empty array when no issues exist', () => {
    const { result } = renderHook(() => useAttentionItems());
    expect(result.current).toHaveLength(0);
  });

  it('returns failed Pulse runs from last 24h with severity error', () => {
    const recentRun = makeRun({
      id: 'recent-run',
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    });
    mockUseRuns.mockReturnValue({ data: [recentRun] });

    const { result } = renderHook(() => useAttentionItems());

    expect(result.current).toHaveLength(1);
    expect(result.current[0].type).toBe('failed-run');
    expect(result.current[0].severity).toBe('error');
  });

  it('excludes failed Pulse runs older than 24h', () => {
    const oldRun = makeRun({
      id: 'old-run',
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
    });
    mockUseRuns.mockReturnValue({ data: [oldRun] });

    const { result } = renderHook(() => useAttentionItems());

    expect(result.current).toHaveLength(0);
  });

  it('returns dead letter groups with count > 0 with severity warning', () => {
    mockUseAggregatedDeadLetters.mockReturnValue({
      data: [makeDeadLetterGroup({ count: 3 })],
    });

    const { result } = renderHook(() => useAttentionItems());

    expect(result.current).toHaveLength(1);
    expect(result.current[0].type).toBe('dead-letter');
    expect(result.current[0].severity).toBe('warning');
  });

  it('excludes dead letter groups with count of 0', () => {
    mockUseAggregatedDeadLetters.mockReturnValue({
      data: [makeDeadLetterGroup({ count: 0 })],
    });

    const { result } = renderHook(() => useAttentionItems());

    expect(result.current).toHaveLength(0);
  });

  it('returns offline mesh agents when unreachableCount > 0 with severity error', () => {
    mockUseMeshStatus.mockReturnValue({ data: makeMeshStatus(2) });

    const { result } = renderHook(() => useAttentionItems());

    expect(result.current).toHaveLength(1);
    expect(result.current[0].type).toBe('offline-agent');
    expect(result.current[0].severity).toBe('error');
    expect(result.current[0].title).toContain('2 agents offline');
  });

  it('uses singular "agent" when exactly 1 agent is offline', () => {
    mockUseMeshStatus.mockReturnValue({ data: makeMeshStatus(1) });

    const { result } = renderHook(() => useAttentionItems());

    expect(result.current[0].title).toContain('1 agent offline');
  });

  it('returns stalled sessions where updatedAt is >30min ago', () => {
    const stalledSession = makeSession({
      updatedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(), // 45 min ago
    });
    mockSessions.mockReturnValue({ sessions: [stalledSession] });

    const { result } = renderHook(() => useAttentionItems());

    expect(result.current).toHaveLength(1);
    expect(result.current[0].type).toBe('stalled-session');
    expect(result.current[0].severity).toBe('warning');
  });

  it('excludes sessions updated less than 30 minutes ago', () => {
    const recentSession = makeSession({
      updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    });
    mockSessions.mockReturnValue({ sessions: [recentSession] });

    const { result } = renderHook(() => useAttentionItems());

    expect(result.current).toHaveLength(0);
  });

  it('excludes stalled sessions older than 24 hours', () => {
    const veryOldSession = makeSession({
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
    });
    mockSessions.mockReturnValue({ sessions: [veryOldSession] });

    const { result } = renderHook(() => useAttentionItems());

    expect(result.current).toHaveLength(0);
  });

  it('sorts items by timestamp most recent first', () => {
    const olderRun = makeRun({
      id: 'older',
      createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5h ago
    });
    const newerRun = makeRun({
      id: 'newer',
      createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1h ago
    });
    mockUseRuns.mockReturnValue({ data: [olderRun, newerRun] });

    const { result } = renderHook(() => useAttentionItems());

    expect(result.current[0].id).toBe('failed-newer');
    expect(result.current[1].id).toBe('failed-older');
  });

  it('caps results at 8 items', () => {
    // 3 failed runs + 3 dead letter groups + 1 offline + many stalled sessions
    const runs = Array.from({ length: 5 }, (_, i) =>
      makeRun({
        id: `run-${i}`,
        createdAt: new Date(Date.now() - (i + 1) * 60 * 60 * 1000).toISOString(),
      })
    );
    mockUseRuns.mockReturnValue({ data: runs });

    const deadLetterGroups = Array.from({ length: 5 }, (_, i) =>
      makeDeadLetterGroup({ source: `adapter-${i}`, reason: 'hop_limit', count: i + 1 })
    );
    mockUseAggregatedDeadLetters.mockReturnValue({ data: deadLetterGroups });

    const { result } = renderHook(() => useAttentionItems());

    expect(result.current.length).toBeLessThanOrEqual(8);
  });

  it('each item has a valid action.onClick function', () => {
    mockUseRuns.mockReturnValue({
      data: [makeRun()],
    });
    mockUseAggregatedDeadLetters.mockReturnValue({
      data: [makeDeadLetterGroup()],
    });
    mockUseMeshStatus.mockReturnValue({ data: makeMeshStatus(1) });

    const { result } = renderHook(() => useAttentionItems());

    for (const item of result.current) {
      expect(typeof item.action.onClick).toBe('function');
    }
  });

  it('failed run action opens Pulse panel', () => {
    mockUseRuns.mockReturnValue({ data: [makeRun()] });

    const { result } = renderHook(() => useAttentionItems());
    result.current[0].action.onClick();

    expect(mockSetPulseOpen).toHaveBeenCalledWith(true);
  });

  it('dead letter action opens Relay panel', () => {
    mockUseAggregatedDeadLetters.mockReturnValue({
      data: [makeDeadLetterGroup()],
    });

    const { result } = renderHook(() => useAttentionItems());
    result.current[0].action.onClick();

    expect(mockSetRelayOpen).toHaveBeenCalledWith(true);
  });

  it('offline agent action opens Mesh panel', () => {
    mockUseMeshStatus.mockReturnValue({ data: makeMeshStatus(1) });

    const { result } = renderHook(() => useAttentionItems());
    result.current[0].action.onClick();

    expect(mockSetMeshOpen).toHaveBeenCalledWith(true);
  });
});
