/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { TaskRun } from '@dorkos/shared/types';
import type { AggregatedDeadLetter } from '@dorkos/shared/transport';
import type { MeshStatus } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Mocks — must be before imports
// ---------------------------------------------------------------------------

const mockUseRuns = vi.fn<() => { data: TaskRun[] | undefined; isLoading?: boolean }>(() => ({
  data: undefined,
}));
vi.mock('@/layers/entities/tasks', () => ({
  useTaskRuns: () => mockUseRuns(),
}));

const mockUseAggregatedDeadLetters = vi.fn<
  () => { data: AggregatedDeadLetter[] | undefined; isLoading?: boolean }
>(() => ({ data: undefined }));
vi.mock('@/layers/entities/relay', () => ({
  useAggregatedDeadLetters: () => mockUseAggregatedDeadLetters(),
}));

const mockUseMeshStatus = vi.fn<() => { data: MeshStatus | undefined; isLoading?: boolean }>(
  () => ({
    data: undefined,
  })
);
vi.mock('@/layers/entities/mesh', () => ({
  useMeshStatus: () => mockUseMeshStatus(),
}));

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

import { useRecentActivityItems } from '../model/use-recent-activity-items';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
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

describe('useRecentActivityItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRuns.mockReturnValue({ data: undefined });
    mockUseAggregatedDeadLetters.mockReturnValue({ data: undefined });
    mockUseMeshStatus.mockReturnValue({ data: undefined });
  });

  it('returns empty array when nothing has gone wrong', () => {
    const { result } = renderHook(() => useRecentActivityItems());
    expect(result.current.items).toHaveLength(0);
  });

  it('reports isLoading while any backing query is still cold-loading', () => {
    // A consumer showing an all-clear must withhold it until the data loads —
    // here mesh is still on its first fetch, so isLoading is true even though no
    // items have materialised yet.
    mockUseMeshStatus.mockReturnValue({ data: undefined, isLoading: true });
    const { result } = renderHook(() => useRecentActivityItems());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.items).toHaveLength(0);
  });

  it('reports not-loading once every backing query has settled', () => {
    const { result } = renderHook(() => useRecentActivityItems());
    expect(result.current.isLoading).toBe(false);
  });

  it('has no session source at all — a quiet session can never become a row (DOR-1381)', () => {
    // "Session idle for N minutes" was the loudest group on the home surface
    // and the least actionable, and it is gone at the source rather than
    // filtered downstream. Enforced by the SHAPE: this module reads no session
    // hook, so no future branch can raise one without adding a dependency
    // somebody has to review. Comments are stripped, because a scan that reds
    // on its own explanation would be satisfied by deleting the explanation.
    const source = readFileSync(join(__dirname, '..', 'model', 'use-recent-activity-items.ts'))
      .toString()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    // The read reaches real code — a spelling that IS there is found.
    expect(source).toContain('useMeshStatus');
    expect(source).not.toContain('useSessions');
    expect(source).not.toContain('stalled');
  });

  it('returns failed Tasks runs from last 24h with severity error', () => {
    const recentRun = makeRun({
      id: 'recent-run',
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    });
    mockUseRuns.mockReturnValue({ data: [recentRun] });

    const { result } = renderHook(() => useRecentActivityItems());

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].type).toBe('failed-run');
    expect(result.current.items[0].severity).toBe('error');
  });

  it('excludes failed Tasks runs older than 24h', () => {
    const oldRun = makeRun({
      id: 'old-run',
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
    });
    mockUseRuns.mockReturnValue({ data: [oldRun] });

    const { result } = renderHook(() => useRecentActivityItems());

    expect(result.current.items).toHaveLength(0);
  });

  it('returns dead letter groups with count > 0 with severity warning', () => {
    mockUseAggregatedDeadLetters.mockReturnValue({
      data: [makeDeadLetterGroup({ count: 3 })],
    });

    const { result } = renderHook(() => useRecentActivityItems());

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].type).toBe('dead-letter');
    expect(result.current.items[0].severity).toBe('warning');
  });

  it('excludes dead letter groups with count of 0', () => {
    mockUseAggregatedDeadLetters.mockReturnValue({
      data: [makeDeadLetterGroup({ count: 0 })],
    });

    const { result } = renderHook(() => useRecentActivityItems());

    expect(result.current.items).toHaveLength(0);
  });

  it('returns offline mesh agents when unreachableCount > 0 with severity error', () => {
    mockUseMeshStatus.mockReturnValue({ data: makeMeshStatus(2) });

    const { result } = renderHook(() => useRecentActivityItems());

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].type).toBe('offline-agent');
    expect(result.current.items[0].severity).toBe('error');
    expect(result.current.items[0].title).toContain('2 agents offline');
  });

  it('uses singular "agent" when exactly 1 agent is offline', () => {
    mockUseMeshStatus.mockReturnValue({ data: makeMeshStatus(1) });

    const { result } = renderHook(() => useRecentActivityItems());

    expect(result.current.items[0].title).toContain('1 agent offline');
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

    const { result } = renderHook(() => useRecentActivityItems());

    expect(result.current.items[0].id).toBe('failed-newer');
    expect(result.current.items[1].id).toBe('failed-older');
  });

  it('caps results at 8 items', () => {
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

    const { result } = renderHook(() => useRecentActivityItems());

    expect(result.current.items.length).toBeLessThanOrEqual(8);
  });

  it('each item has a valid action.onClick function', () => {
    mockUseRuns.mockReturnValue({
      data: [makeRun()],
    });
    mockUseAggregatedDeadLetters.mockReturnValue({
      data: [makeDeadLetterGroup()],
    });
    mockUseMeshStatus.mockReturnValue({ data: makeMeshStatus(1) });

    const { result } = renderHook(() => useRecentActivityItems());

    for (const item of result.current.items) {
      expect(typeof item.action.onClick).toBe('function');
    }
  });

  it('failed run action navigates with detail search params', () => {
    mockUseRuns.mockReturnValue({ data: [makeRun()] });

    const { result } = renderHook(() => useRecentActivityItems());
    result.current.items[0].action.onClick();

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/',
      search: { detail: 'failed-run', itemId: 'run-1' },
    });
  });

  it('dead letter action navigates with compound key itemId', () => {
    mockUseAggregatedDeadLetters.mockReturnValue({
      data: [makeDeadLetterGroup()],
    });

    const { result } = renderHook(() => useRecentActivityItems());
    result.current.items[0].action.onClick();

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/',
      search: { detail: 'dead-letter', itemId: 'telegram-adapter::hop_limit' },
    });
  });

  it('offline agent action navigates with sentinel itemId', () => {
    mockUseMeshStatus.mockReturnValue({ data: makeMeshStatus(1) });

    const { result } = renderHook(() => useRecentActivityItems());
    result.current.items[0].action.onClick();

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/',
      search: { detail: 'offline-agent', itemId: 'offline' },
    });
  });
});
