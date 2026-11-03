/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTodo, createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useTodoBadge, useTodos } from '../model/use-todos';
import { useUpdateTodo } from '../model/use-todo-mutations';
import { useTodosEnabled, useTodosEnabledState } from '../model/use-todos-config';

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useTodos', () => {
  it('asks for the view it is given and returns the whole answer', async () => {
    const transport = createMockTransport();
    const todo = createMockTodo();
    vi.mocked(transport.listTodos).mockResolvedValue({ todos: [todo], doneCount: 2, badge: 1 });
    const { result } = renderHook(() => useTodos({ view: 'by-me', due: 'today' }), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(transport.listTodos).toHaveBeenCalledWith({ view: 'by-me', due: 'today' });
    expect(result.current.data).toEqual({ todos: [todo], doneCount: 2, badge: 1 });
  });

  it('asks nothing while held', () => {
    const transport = createMockTransport();
    renderHook(() => useTodos({}, { enabled: false }), { wrapper: createWrapper(transport) });
    expect(transport.listTodos).not.toHaveBeenCalled();
  });
});

describe('useTodoBadge', () => {
  it('reads the badge off the person’s own list', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.listTodos).mockResolvedValue({ todos: [], doneCount: 0, badge: 4 });
    const { result } = renderHook(() => useTodoBadge(), { wrapper: createWrapper(transport) });
    await waitFor(() => expect(result.current).toBe(4));
    expect(transport.listTodos).toHaveBeenCalledWith({ view: 'mine' });
  });
});

describe('useTodosEnabled', () => {
  it('is off for a server that does not report to-dos', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue(
      {} as Awaited<ReturnType<Transport['getConfig']>>
    );
    const { result } = renderHook(() => useTodosEnabledState(), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toBe(false);
  });

  it('is on when the server says so', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({ todos: { enabled: true } } as Awaited<
      ReturnType<Transport['getConfig']>
    >);
    const { result } = renderHook(() => useTodosEnabled(), { wrapper: createWrapper(transport) });
    await waitFor(() => expect(result.current).toBe(true));
  });
});

describe('useUpdateTodo', () => {
  it('shows the new state at once, and the row reads open again when the server refuses', async () => {
    const transport = createMockTransport();
    const todo = createMockTodo();
    vi.mocked(transport.listTodos).mockResolvedValue({ todos: [todo], doneCount: 0, badge: 0 });
    let refuse: (error: Error) => void = () => {};
    vi.mocked(transport.updateTodo).mockImplementation(
      () => new Promise((_resolve, reject) => (refuse = reject))
    );
    const { result } = renderHook(
      () => ({ list: useTodos({ view: 'mine' }), update: useUpdateTodo() }),
      { wrapper: createWrapper(transport) }
    );
    await waitFor(() => expect(result.current.list.data?.todos[0]?.state).toBe('open'));

    act(() => result.current.update.mutate({ id: todo.id, body: { state: 'kept' } }));
    await waitFor(() => expect(result.current.list.data?.todos[0]?.state).toBe('kept'));
    expect(transport.updateTodo).toHaveBeenCalledWith(todo.id, { state: 'kept' });

    act(() => refuse(new Error('refused')));
    await waitFor(() => expect(result.current.list.data?.todos[0]?.state).toBe('open'));
  });
});
