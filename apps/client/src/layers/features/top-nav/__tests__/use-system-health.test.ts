import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { PulseRun } from '@dorkos/shared/types';
import type { AggregatedDeadLetter, AdapterListItem } from '@dorkos/shared/transport';
import type { MeshStatus } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/pulse', () => ({
  useRuns: vi.fn().mockReturnValue({ data: undefined }),
}));

vi.mock('@/layers/entities/relay', () => ({
  useAggregatedDeadLetters: vi.fn().mockReturnValue({ data: undefined }),
  useRelayAdapters: vi.fn().mockReturnValue({ data: undefined }),
}));

vi.mock('@/layers/entities/mesh', () => ({
  useMeshStatus: vi.fn().mockReturnValue({ data: undefined }),
}));

import { useRuns } from '@/layers/entities/pulse';
import { useAggregatedDeadLetters, useRelayAdapters } from '@/layers/entities/relay';
import { useMeshStatus } from '@/layers/entities/mesh';
import { useSystemHealth } from '../model/use-system-health';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(createdAt: string): PulseRun {
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
    createdAt,
  };
}

function makeDeadLetterGroup(count: number): AggregatedDeadLetter {
  return {
    source: 'telegram-adapter',
    reason: 'hop_limit',
    count,
    firstSeen: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    lastSeen: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
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

function makeAdapter(state: 'connected' | 'disconnected' | 'error'): AdapterListItem {
  return {
    config: {
      id: 'adapter-1',
      type: 'telegram',
      enabled: true,
      config: {},
    } as unknown as AdapterListItem['config'],
    status: {
      id: 'adapter-1',
      type: 'telegram',
      displayName: 'Telegram',
      state,
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    } as unknown as AdapterListItem['status'],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSystemHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRuns).mockReturnValue({ data: undefined } as ReturnType<typeof useRuns>);
    vi.mocked(useAggregatedDeadLetters).mockReturnValue({ data: undefined } as ReturnType<
      typeof useAggregatedDeadLetters
    >);
    vi.mocked(useMeshStatus).mockReturnValue({ data: undefined } as ReturnType<
      typeof useMeshStatus
    >);
    vi.mocked(useRelayAdapters).mockReturnValue({ data: undefined } as ReturnType<
      typeof useRelayAdapters
    >);
  });

  it('returns healthy when no issues exist', () => {
    const { result } = renderHook(() => useSystemHealth());
    expect(result.current).toBe('healthy');
  });

  it('returns error when failed Pulse runs exist in last 24h', () => {
    const recentRun = makeRun(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
    vi.mocked(useRuns).mockReturnValue({ data: [recentRun] } as ReturnType<typeof useRuns>);

    const { result } = renderHook(() => useSystemHealth());

    expect(result.current).toBe('error');
  });

  it('returns healthy when failed Pulse runs are older than 24h', () => {
    const oldRun = makeRun(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    vi.mocked(useRuns).mockReturnValue({ data: [oldRun] } as ReturnType<typeof useRuns>);

    const { result } = renderHook(() => useSystemHealth());

    expect(result.current).toBe('healthy');
  });

  it('returns error when dead letters exist with count > 0', () => {
    vi.mocked(useAggregatedDeadLetters).mockReturnValue({
      data: [makeDeadLetterGroup(3)],
    } as ReturnType<typeof useAggregatedDeadLetters>);

    const { result } = renderHook(() => useSystemHealth());

    expect(result.current).toBe('error');
  });

  it('returns healthy when dead letter count is 0', () => {
    vi.mocked(useAggregatedDeadLetters).mockReturnValue({
      data: [makeDeadLetterGroup(0)],
    } as ReturnType<typeof useAggregatedDeadLetters>);

    const { result } = renderHook(() => useSystemHealth());

    expect(result.current).toBe('healthy');
  });

  it('returns error when mesh unreachableCount > 0', () => {
    vi.mocked(useMeshStatus).mockReturnValue({
      data: makeMeshStatus(2),
    } as ReturnType<typeof useMeshStatus>);

    const { result } = renderHook(() => useSystemHealth());

    expect(result.current).toBe('error');
  });

  it('returns healthy when mesh unreachableCount is 0', () => {
    vi.mocked(useMeshStatus).mockReturnValue({
      data: makeMeshStatus(0),
    } as ReturnType<typeof useMeshStatus>);

    const { result } = renderHook(() => useSystemHealth());

    expect(result.current).toBe('healthy');
  });

  it('returns degraded when adapters are disconnected but no error conditions', () => {
    vi.mocked(useRelayAdapters).mockReturnValue({
      data: [makeAdapter('disconnected')],
    } as ReturnType<typeof useRelayAdapters>);

    const { result } = renderHook(() => useSystemHealth());

    expect(result.current).toBe('degraded');
  });

  it('returns degraded when adapters are in error state but no other errors', () => {
    vi.mocked(useRelayAdapters).mockReturnValue({
      data: [makeAdapter('error')],
    } as ReturnType<typeof useRelayAdapters>);

    const { result } = renderHook(() => useSystemHealth());

    expect(result.current).toBe('degraded');
  });

  it('returns healthy when all adapters are connected', () => {
    vi.mocked(useRelayAdapters).mockReturnValue({
      data: [makeAdapter('connected')],
    } as ReturnType<typeof useRelayAdapters>);

    const { result } = renderHook(() => useSystemHealth());

    expect(result.current).toBe('healthy');
  });

  it('prioritizes error over degraded', () => {
    const recentRun = makeRun(new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString());
    vi.mocked(useRuns).mockReturnValue({ data: [recentRun] } as ReturnType<typeof useRuns>);
    vi.mocked(useRelayAdapters).mockReturnValue({
      data: [makeAdapter('disconnected')],
    } as ReturnType<typeof useRelayAdapters>);

    const { result } = renderHook(() => useSystemHealth());

    expect(result.current).toBe('error');
  });
});
