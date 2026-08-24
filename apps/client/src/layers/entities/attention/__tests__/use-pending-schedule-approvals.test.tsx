/**
 * The schedules an agent parked, and how they get to a surface.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Task } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { usePendingScheduleApprovals } from '../model/use-pending-schedule-approvals';

/** A schedule, with everything a case does not care about filled in. */
function task(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    name: overrides.id,
    displayName: null,
    description: null,
    prompt: 'Do the thing.',
    cron: '0 3 * * *',
    timezone: 'UTC',
    agentId: null,
    enabled: false,
    maxRuntime: null,
    permissionMode: 'default',
    status: 'pending_approval',
    filePath: `/tmp/${overrides.id}/SKILL.md`,
    createdAt: '2026-08-19T09:00:00.000Z',
    updatedAt: '2026-08-19T09:00:00.000Z',
    reason: null,
    proposedBySessionId: null,
    proposedByAgentPath: null,
    proposedByName: null,
    origin: null,
    nextRuns: [],
    ...overrides,
  };
}

function setup(tasks: Task[], config?: Record<string, unknown>) {
  const transport = createMockTransport({
    listTasks: vi.fn().mockResolvedValue(tasks),
    ...(config === undefined ? {} : { getConfig: vi.fn().mockResolvedValue(config) }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  function wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }

  return { transport, queryClient, wrapper };
}

describe('usePendingScheduleApprovals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('answers with the schedules waiting on a person, oldest proposal first', async () => {
    const { wrapper } = setup([
      task({ id: 'newer', createdAt: '2026-08-19T11:00:00.000Z' }),
      task({ id: 'older', createdAt: '2026-08-19T08:00:00.000Z' }),
    ]);

    const { result } = renderHook(() => usePendingScheduleApprovals(), { wrapper });

    await waitFor(() => expect(result.current.schedules).toHaveLength(2));
    expect(result.current.schedules.map((s) => s.id)).toEqual(['older', 'newer']);
  });

  it('says nothing about a schedule that is already active or paused', async () => {
    // The discriminating half of the case above: without the status filter,
    // every schedule on the machine would be reported as waiting on somebody.
    const { wrapper } = setup([
      task({ id: 'running', status: 'active', enabled: true }),
      task({ id: 'held', status: 'paused' }),
      task({ id: 'parked' }),
    ]);

    const { result } = renderHook(() => usePendingScheduleApprovals(), { wrapper });

    await waitFor(() => expect(result.current.schedules).toHaveLength(1));
    expect(result.current.schedules[0]?.id).toBe('parked');
  });

  it('keeps one array identity while nothing is parked', async () => {
    // Every consumer of this hook memoizes on the array, and a fresh empty
    // array per render would rebuild the header on every clock tick.
    const { wrapper } = setup([task({ id: 'running', status: 'active' })]);

    const { result, rerender } = renderHook(() => usePendingScheduleApprovals(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const first = result.current.schedules;
    rerender();

    expect(result.current.schedules).toBe(first);
  });

  it('picks up a schedule an agent parked in the background, without a reload', async () => {
    // What `tasks_changed` does on the wire (DOR-1380): the sync hook
    // invalidates the shared `['tasks']` query, and this hook — which holds no
    // subscription of its own — answers with the new list.
    const { transport, queryClient, wrapper } = setup([]);

    const { result } = renderHook(() => usePendingScheduleApprovals(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.schedules).toHaveLength(0);

    vi.mocked(transport.listTasks).mockResolvedValue([task({ id: 'proposed' })]);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['tasks'], exact: true });
    });

    await waitFor(() => expect(result.current.schedules.map((s) => s.id)).toEqual(['proposed']));
  });

  it('answers empty when the Tasks subsystem is switched off', async () => {
    // A schedule that cannot run is not waiting on anybody, and asking for the
    // list at all would be a request for a feature the operator turned off.
    const { transport, wrapper } = setup([task({ id: 'parked' })], {
      version: '1.0.0',
      port: 4242,
      uptime: 0,
      workingDirectory: '/test',
      nodeVersion: 'v20.0.0',
      platform: 'linux-x64',
      runtimes: ['claude-code'],
      claudeCliPath: null,
      tasks: { enabled: false },
    });

    const { result } = renderHook(() => usePendingScheduleApprovals(), { wrapper });

    await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
    expect(result.current.schedules).toHaveLength(0);
    expect(transport.listTasks).not.toHaveBeenCalled();
  });

  it('stays loading while the CONFIG read has not answered (DOR-1391)', async () => {
    // **"Off" and "we have not looked yet" are the same value here, and that
    // was a false knock.** The task query is gated on the config's `tasks`
    // flag, and a disabled TanStack query reports `isLoading: false` — so a
    // hook reading only its own query called an empty list settled while the
    // config was still in flight. `useBlockingArrivals` seeds its known set
    // from the first settled read, so every schedule that had been parked for
    // days was then announced as a NEW arrival the moment config landed: a
    // knock and an OS banner for nothing. `AppShell` gives up waiting on
    // config after three seconds and renders anyway, so this is reachable.
    const transport = createMockTransport({
      listTasks: vi.fn().mockResolvedValue([task({ id: 'parked' })]),
      getConfig: vi.fn(() => new Promise<never>(() => {})),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    function wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      );
    }

    const { result } = renderHook(() => usePendingScheduleApprovals(), { wrapper });

    // The config read is genuinely in flight — asserted, so "still loading" is
    // not simply "nothing has run yet".
    await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.schedules).toHaveLength(0);
  });

  it('settles once the config says yes and the schedules land', async () => {
    // The discriminating half: with a config that answers, the same hook
    // reports settled — so "loading" above is the config read rather than a
    // flag stuck on.
    const { wrapper } = setup([task({ id: 'parked' })]);

    const { result } = renderHook(() => usePendingScheduleApprovals(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.schedules.map((s) => s.id)).toEqual(['parked']);
  });
});
