/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { createMockSchedule } from '@dorkos/test-utils';
import {
  useTasks,
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
  useTriggerTask,
} from '../model/use-tasks';

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches and caches task list', async () => {
    const tasks = [createMockSchedule({ id: 'task-1', name: 'Daily review' })];
    const transport = createMockTransport({
      listTasks: vi.fn().mockResolvedValue(tasks),
    });

    const { result } = renderHook(() => useTasks(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].name).toBe('Daily review');
    expect(transport.listTasks).toHaveBeenCalledTimes(1);
  });

  it('returns undefined data while loading', () => {
    const transport = createMockTransport();

    const { result } = renderHook(() => useTasks(), {
      wrapper: createWrapper(transport),
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });

  it('exposes error state on failure', async () => {
    const transport = createMockTransport({
      listTasks: vi.fn().mockRejectedValue(new Error('Network error')),
    });

    const { result } = renderHook(() => useTasks(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});

describe('useCreateTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.createTask and invalidates cache', async () => {
    const newTask = createMockSchedule({ id: 'task-new', name: 'New job' });
    const transport = createMockTransport({
      createTask: vi.fn().mockResolvedValue(newTask),
      listTasks: vi.fn().mockResolvedValue([]),
    });

    const wrapper = createWrapper(transport);

    // First, prime the tasks cache
    const { result: tasksResult } = renderHook(() => useTasks(), { wrapper });
    await waitFor(() => {
      expect(tasksResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useCreateTask(), { wrapper });

    result.current.mutate({
      name: 'New job',
      prompt: 'Do something',
      cron: '0 9 * * 1-5',
      target: 'global',
      description: 'Do something',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.createTask).toHaveBeenCalledWith({
      name: 'New job',
      prompt: 'Do something',
      cron: '0 9 * * 1-5',
      target: 'global',
      description: 'Do something',
    });

    // Cache should be invalidated (listTasks called again)
    await waitFor(() => {
      expect(transport.listTasks).toHaveBeenCalledTimes(2);
    });
  });
});

describe('useUpdateTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.updateTask with id and input, then invalidates cache', async () => {
    const updated = createMockSchedule({ id: 'task-1', name: 'Updated name' });
    const transport = createMockTransport({
      updateTask: vi.fn().mockResolvedValue(updated),
      listTasks: vi.fn().mockResolvedValue([]),
    });

    const wrapper = createWrapper(transport);

    // Prime the cache
    const { result: tasksResult } = renderHook(() => useTasks(), { wrapper });
    await waitFor(() => {
      expect(tasksResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useUpdateTask(), { wrapper });

    result.current.mutate({ id: 'task-1', name: 'Updated name' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.updateTask).toHaveBeenCalledWith('task-1', { name: 'Updated name' });

    await waitFor(() => {
      expect(transport.listTasks).toHaveBeenCalledTimes(2);
    });
  });
});

describe('useDeleteTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.deleteTask and invalidates cache', async () => {
    const transport = createMockTransport({
      deleteTask: vi.fn().mockResolvedValue({ ok: true }),
      listTasks: vi.fn().mockResolvedValue([]),
    });

    const wrapper = createWrapper(transport);

    // Prime the cache
    const { result: tasksResult } = renderHook(() => useTasks(), { wrapper });
    await waitFor(() => {
      expect(tasksResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useDeleteTask(), { wrapper });

    result.current.mutate('task-1');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.deleteTask).toHaveBeenCalledWith('task-1');

    await waitFor(() => {
      expect(transport.listTasks).toHaveBeenCalledTimes(2);
    });
  });
});

describe('useTriggerTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.triggerTask and invalidates runs cache', async () => {
    const transport = createMockTransport({
      triggerTask: vi.fn().mockResolvedValue({ runId: 'run-42' }),
    });

    const { result } = renderHook(() => useTriggerTask(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate('task-1');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.triggerTask).toHaveBeenCalledWith('task-1');
    expect(result.current.data).toEqual({ runId: 'run-42' });
  });

  it('exposes error state on failure', async () => {
    const transport = createMockTransport({
      triggerTask: vi.fn().mockRejectedValue(new Error('Task not found')),
    });

    const { result } = renderHook(() => useTriggerTask(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate('nonexistent');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});
