/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Task, TaskRun } from '@dorkos/shared/types';
import type { ConnectorAgentRequestItem } from '@/layers/entities/connectors';
import { TransportProvider } from '@/layers/shared/model';
import { useActivitySeenStore } from '@/layers/entities/activity';

// The waiting queue reads five queues of its own; only its schedules matter here.
const waitingSchedules = vi.fn<() => readonly Task[]>(() => []);
vi.mock('@/layers/entities/attention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/attention')>()),
  useWaitingQueue: () => ({ items: waitingSchedules(), schedules: waitingSchedules() }),
}));
vi.mock('@/layers/entities/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/tasks')>()),
  useTasksEnabledState: () => ({ enabled: true, isLoading: false }),
}));

import { useTabSignalsSync } from '../model/use-tab-signals-sync';
import { useTabSignalsStore } from '../model/tab-signals';

const transport = createMockTransport();

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

const task = (id: string, name: string) => ({ id, name, displayName: null }) as unknown as Task;
const run = (scheduleId: string, status: TaskRun['status']) =>
  ({ id: `${scheduleId}-${status}`, scheduleId, status }) as TaskRun;
const badge = (path: string) => useTabSignalsStore.getState().routeBadges[path];

beforeEach(() => {
  vi.clearAllMocks();
  waitingSchedules.mockReturnValue([]);
  useTabSignalsStore.setState({ needsYouCount: 0, routeBadges: {}, scheduleAttentionCount: 0 });
  useActivitySeenStore.setState({ lastSeenAt: null, viewing: false });
  vi.mocked(transport.listTasks).mockResolvedValue([
    task('digest', 'Morning digest'),
    task('inbox', 'Inbox sweep'),
  ]);
});

describe('useTabSignalsSync', () => {
  it('names the one schedule running on the Schedules tab', async () => {
    vi.mocked(transport.listTaskRuns).mockResolvedValue([run('digest', 'running')]);
    renderHook(() => useTabSignalsSync(), { wrapper });
    await waitFor(() =>
      expect(badge('/tasks')).toEqual({ status: 'working', sentence: 'Morning digest is running' })
    );
  });

  it('counts schedules whose last run failed, and hands the count to the title', async () => {
    vi.mocked(transport.listTaskRuns).mockResolvedValue([
      run('digest', 'failed'),
      run('inbox', 'completed'),
      run('inbox', 'failed'),
      // A run of a schedule since deleted has nobody to fix it.
      run('gone', 'failed'),
    ]);
    renderHook(() => useTabSignalsSync(), { wrapper });
    await waitFor(() => expect(badge('/tasks')).toMatchObject({ status: 'failed', count: 1 }));
    expect(useTabSignalsStore.getState().scheduleAttentionCount).toBe(1);
  });

  it('puts schedules waiting for your OK first, and counts them in the title too', async () => {
    waitingSchedules.mockReturnValue([task('new', 'Weekly report')]);
    vi.mocked(transport.listTaskRuns).mockResolvedValue([run('digest', 'failed')]);
    renderHook(() => useTabSignalsSync(), { wrapper });
    await waitFor(() => expect(useTabSignalsStore.getState().scheduleAttentionCount).toBe(2));
    expect(badge('/tasks')).toMatchObject({ status: 'needs-you', count: 1 });
  });

  it('counts the requests waiting on the Connections page', async () => {
    vi.mocked(transport.getConnectorAgentRequests).mockResolvedValue([
      {} as ConnectorAgentRequestItem,
      {} as ConnectorAgentRequestItem,
    ]);
    renderHook(() => useTabSignalsSync(), { wrapper });
    await waitFor(() =>
      expect(badge('/connections')).toMatchObject({ status: 'needs-you', count: 2 })
    );
  });

  it('counts what is new on the Activity tab since you last looked', async () => {
    useActivitySeenStore.setState({ lastSeenAt: '2026-10-09T10:00:00.000Z' });
    vi.mocked(transport.listActivityEvents).mockResolvedValue({
      items: [{}, {}] as never,
      nextCursor: null,
    });
    renderHook(() => useTabSignalsSync(), { wrapper });
    await waitFor(() => expect(badge('/activity')).toMatchObject({ status: 'new', count: 2 }));
  });

  it('leaves idle pages without a badge', async () => {
    renderHook(() => useTabSignalsSync(), { wrapper });
    await waitFor(() => expect(transport.listTaskRuns).toHaveBeenCalled());
    expect(useTabSignalsStore.getState().routeBadges).toEqual({});
  });
});
