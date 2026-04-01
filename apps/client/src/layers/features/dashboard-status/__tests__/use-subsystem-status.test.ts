import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Task, TaskRun } from '@dorkos/shared/types';
import type { AdapterListItem, AggregatedDeadLetter } from '@dorkos/shared/transport';
import type { MeshStatus } from '@dorkos/shared/types';
import { useSubsystemStatus } from '../model/use-subsystem-status';

// Mock all entity hooks
vi.mock('@/layers/entities/tasks', () => ({
  useTasksEnabled: vi.fn().mockReturnValue(true),
  useTasks: vi.fn().mockReturnValue({ data: undefined }),
  useTaskRuns: vi.fn().mockReturnValue({ data: undefined }),
}));

vi.mock('@/layers/entities/relay', () => ({
  useRelayEnabled: vi.fn().mockReturnValue(true),
  useRelayAdapters: vi.fn().mockReturnValue({ data: undefined }),
  useAggregatedDeadLetters: vi.fn().mockReturnValue({ data: undefined }),
}));

vi.mock('@/layers/entities/mesh', () => ({
  useMeshStatus: vi.fn().mockReturnValue({ data: undefined }),
}));

import { useTasksEnabled, useTasks, useTaskRuns } from '@/layers/entities/tasks';
import {
  useRelayEnabled,
  useRelayAdapters,
  useAggregatedDeadLetters,
} from '@/layers/entities/relay';
import { useMeshStatus } from '@/layers/entities/mesh';

/** Minimal Task stub for tests — only fields the hook reads. */
function makeSchedule(overrides: Partial<Task>): Task {
  return {
    id: 's1',
    name: 'Test',
    prompt: '',
    cron: '0 * * * *',
    timezone: null,
    agentId: null,
    enabled: true,
    maxRuntime: null,
    permissionMode: 'default',
    status: 'active',
    filePath: '/tmp/tasks/test.md',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nextRun: null,
    ...overrides,
  };
}

/** Minimal TaskRun stub for tests — only fields the hook reads. */
function makeRun(overrides: Partial<TaskRun>): TaskRun {
  return {
    id: 'r1',
    scheduleId: 's1',
    status: 'failed',
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    outputSummary: null,
    error: null,
    sessionId: null,
    trigger: 'scheduled',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Minimal AdapterListItem stub — cast through unknown since only state and type are read. */
function makeAdapter(type: string, connected: boolean): AdapterListItem {
  return {
    config: { id: type, type, enabled: true, config: {} } as unknown as AdapterListItem['config'],
    status: {
      id: type,
      type,
      displayName: type,
      state: connected ? 'connected' : 'disconnected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    } as unknown as AdapterListItem['status'],
  };
}

/** Minimal AggregatedDeadLetter stub. */
function makeDeadLetterGroup(count: number): AggregatedDeadLetter {
  return { source: 'test', reason: 'hop_limit', count, firstSeen: '', lastSeen: '' };
}

/** Minimal MeshStatus stub. */
function makeMeshStatus(totalAgents: number, unreachableCount: number): MeshStatus {
  return {
    totalAgents,
    activeCount: totalAgents - unreachableCount,
    inactiveCount: 0,
    staleCount: 0,
    unreachableCount,
    byRuntime: {},
    byProject: {},
  };
}

describe('useSubsystemStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTasksEnabled).mockReturnValue(true);
    vi.mocked(useTasks).mockReturnValue({ data: undefined } as ReturnType<typeof useTasks>);
    vi.mocked(useTaskRuns).mockReturnValue({ data: undefined } as ReturnType<typeof useTaskRuns>);
    vi.mocked(useRelayEnabled).mockReturnValue(true);
    vi.mocked(useRelayAdapters).mockReturnValue({ data: undefined } as ReturnType<
      typeof useRelayAdapters
    >);
    vi.mocked(useAggregatedDeadLetters).mockReturnValue({ data: undefined } as ReturnType<
      typeof useAggregatedDeadLetters
    >);
    vi.mocked(useMeshStatus).mockReturnValue({ data: undefined } as ReturnType<
      typeof useMeshStatus
    >);
  });

  it('returns schedule count from Tasks', () => {
    vi.mocked(useTasks).mockReturnValue({
      data: [makeSchedule({ id: 's1', name: 'Daily' }), makeSchedule({ id: 's2', name: 'Hourly' })],
    } as ReturnType<typeof useTasks>);

    const { result } = renderHook(() => useSubsystemStatus());

    expect(result.current.tasks.scheduleCount).toBe(2);
  });

  it('computes nextRunIn from the earliest future schedule nextRun', () => {
    // Use 90 minutes to avoid off-by-one from test execution time (floor rounds down)
    const futureDate = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    vi.mocked(useTasks).mockReturnValue({
      data: [makeSchedule({ nextRun: futureDate })],
    } as ReturnType<typeof useTasks>);

    const { result } = renderHook(() => useSubsystemStatus());

    expect(result.current.tasks.nextRunIn).toBe('1h');
  });

  it('returns null nextRunIn when no schedules have future runs', () => {
    vi.mocked(useTasks).mockReturnValue({
      data: [makeSchedule({ nextRun: null })],
    } as ReturnType<typeof useTasks>);

    const { result } = renderHook(() => useSubsystemStatus());

    expect(result.current.tasks.nextRunIn).toBeNull();
  });

  it('counts failed runs from the last 24 hours', () => {
    const recentFailed = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const oldFailed = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago

    vi.mocked(useTaskRuns).mockReturnValue({
      data: [
        makeRun({ id: 'r1', createdAt: recentFailed }),
        makeRun({ id: 'r2', createdAt: oldFailed }),
      ],
    } as ReturnType<typeof useTaskRuns>);

    const { result } = renderHook(() => useSubsystemStatus());

    // Only the recent failure should be counted
    expect(result.current.tasks.failedRunCount).toBe(1);
  });

  it('returns connected adapter names from Relay', () => {
    vi.mocked(useRelayAdapters).mockReturnValue({
      data: [makeAdapter('telegram', true), makeAdapter('slack', false)],
    } as ReturnType<typeof useRelayAdapters>);

    const { result } = renderHook(() => useSubsystemStatus());

    expect(result.current.relay.connectedNames).toEqual(['telegram']);
    expect(result.current.relay.adapterCount).toBe(2);
  });

  it('sums dead letter counts from Relay', () => {
    vi.mocked(useAggregatedDeadLetters).mockReturnValue({
      data: [makeDeadLetterGroup(3), makeDeadLetterGroup(5)],
    } as ReturnType<typeof useAggregatedDeadLetters>);

    const { result } = renderHook(() => useSubsystemStatus());

    expect(result.current.relay.deadLetterCount).toBe(8);
  });

  it('returns agent count and offline count from Mesh', () => {
    vi.mocked(useMeshStatus).mockReturnValue({
      data: makeMeshStatus(10, 2),
    } as ReturnType<typeof useMeshStatus>);

    const { result } = renderHook(() => useSubsystemStatus());

    expect(result.current.mesh.totalAgents).toBe(10);
    expect(result.current.mesh.offlineCount).toBe(2);
  });

  it('returns disabled state when Tasks feature flag is off', () => {
    vi.mocked(useTasksEnabled).mockReturnValue(false);

    const { result } = renderHook(() => useSubsystemStatus());

    expect(result.current.tasks.enabled).toBe(false);
  });

  it('returns disabled state when Relay feature flag is off', () => {
    vi.mocked(useRelayEnabled).mockReturnValue(false);

    const { result } = renderHook(() => useSubsystemStatus());

    expect(result.current.relay.enabled).toBe(false);
  });

  it('returns zero defaults when all data is undefined', () => {
    const { result } = renderHook(() => useSubsystemStatus());

    expect(result.current.tasks.scheduleCount).toBe(0);
    expect(result.current.tasks.failedRunCount).toBe(0);
    expect(result.current.relay.adapterCount).toBe(0);
    expect(result.current.relay.deadLetterCount).toBe(0);
    expect(result.current.relay.connectedNames).toEqual([]);
    expect(result.current.mesh.totalAgents).toBe(0);
    expect(result.current.mesh.offlineCount).toBe(0);
  });
});
