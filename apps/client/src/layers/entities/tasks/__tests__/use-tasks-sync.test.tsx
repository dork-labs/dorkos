/**
 * @vitest-environment jsdom
 */
/**
 * The Tasks list's freshness contract (DOR-1380).
 *
 * A schedule an agent proposes through `tasks_create` MCP always parks at
 * `pending_approval`, and before this the list had no way to notice: no SSE,
 * no activity entry, nothing until the next full page reload. This pins the
 * client half of the fix — that `useTasksSync` invalidates the shared tasks
 * query when the server's `tasks_changed` broadcast arrives, the same
 * contract `entities/unattended-autonomy` already pins for the banner.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport, createMockSchedule } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

/** Handlers registered through `useEventSubscription`, by event name. */
const handlers = new Map<string, () => void>();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: (name: string, handler: () => void) => {
      handlers.set(name, handler);
    },
  };
});

import { useTasks } from '../model/use-tasks';
import { useTasksSync } from '../model/use-tasks-sync';

afterEach(() => {
  cleanup();
  handlers.clear();
});

/** A provider tree with a transport whose task list the test controls. */
function harness(transport: ReturnType<typeof createMockTransport>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useTasksSync', () => {
  it('refetches the tasks list when the server broadcasts tasks_changed', async () => {
    const transport = createMockTransport({
      listTasks: vi.fn().mockResolvedValue([]),
    });
    const wrapper = harness(transport);

    const { result } = renderHook(
      () => {
        useTasksSync();
        return useTasks();
      },
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.listTasks).toHaveBeenCalledTimes(1);

    // An agent's tasks_create parks at pending_approval and (as of DOR-1380)
    // broadcasts this same event — this is what makes it show up live.
    handlers.get('tasks_changed')!();

    await waitFor(() => expect(transport.listTasks).toHaveBeenCalledTimes(2));
  });

  it('reflects a newly proposed schedule once the refetch resolves', async () => {
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createMockSchedule({
          id: 'sched-agent-1',
          name: 'agent-proposed',
          status: 'pending_approval',
        }),
      ]);
    const transport = createMockTransport({ listTasks });
    const wrapper = harness(transport);

    const { result } = renderHook(
      () => {
        useTasksSync();
        return useTasks();
      },
      { wrapper }
    );

    await waitFor(() => expect(result.current.data).toEqual([]));

    handlers.get('tasks_changed')!();

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data![0]!.status).toBe('pending_approval');
  });

  it('does not refetch a session-scoped ["tasks", sessionId, cwd] query — only the exact ["tasks"] list', async () => {
    // features/chat/model/use-task-state.ts keys the chat panel's streamed todo
    // query ['tasks', sessionId, cwd]. TanStack Query matches by PREFIX unless
    // told `exact: true`, so an invalidation of ['tasks'] alone would also catch
    // that query and reset a session's mid-turn todo state on every schedule
    // change anywhere in the app. This proves the sync hook does not do that.
    const transport = createMockTransport({
      listTasks: vi.fn().mockResolvedValue([]),
    });
    const wrapper = harness(transport);
    const sessionScopedFetch = vi.fn().mockResolvedValue('session-todos');

    const { result } = renderHook(
      () => {
        useTasksSync();
        const tasks = useTasks();
        const sessionScoped = useQuery({
          queryKey: ['tasks', 'session-x', '/cwd'],
          queryFn: sessionScopedFetch,
        });
        return { tasks, sessionScoped };
      },
      { wrapper }
    );

    await waitFor(() => expect(result.current.tasks.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.sessionScoped.isSuccess).toBe(true));
    expect(transport.listTasks).toHaveBeenCalledTimes(1);
    expect(sessionScopedFetch).toHaveBeenCalledTimes(1);

    handlers.get('tasks_changed')!();

    // The real tasks list refetches...
    await waitFor(() => expect(transport.listTasks).toHaveBeenCalledTimes(2));
    // ...but the session-scoped todo query is left alone.
    expect(sessionScopedFetch).toHaveBeenCalledTimes(1);
  });
});
