/**
 * @vitest-environment jsdom
 */
/**
 * Moving to-dos (DOR-3088): the new order shows at once, and a save that fails part-way puts back
 * the ranks already saved and the order on screen.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTodo, createMockTransport } from '@dorkos/test-utils';
import type { ListTodosResponse } from '@dorkos/shared/todo-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { todoKeys, useMoveTodos } from '../index';

const QUERY = { view: 'mine' as const, sort: 'rank' as const };

function setup() {
  const transport = createMockTransport();
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const list: ListTodosResponse = {
    todos: [createMockTodo({ id: 'a' }), createMockTodo({ id: 'b' }), createMockTodo({ id: 'c' })],
    doneCount: 0,
    badge: 0,
  };
  queryClient.setQueryData(todoKeys.list(QUERY), list);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  const { result } = renderHook(() => useMoveTodos(), { wrapper });
  const order = () =>
    queryClient.getQueryData<ListTodosResponse>(todoKeys.list(QUERY))!.todos.map((t) => t.id);
  return { transport, result, order };
}

describe('useMoveTodos', () => {
  it('shows the new order before the server answers', async () => {
    const { transport, result, order } = setup();
    let release: () => void = () => {};
    vi.mocked(transport.updateTodo).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(createMockTodo());
        })
    );
    act(() =>
      result.current.mutate({
        query: QUERY,
        order: ['c', 'a', 'b'],
        changes: [{ id: 'c', rank: 'n', previous: null }],
      })
    );
    await waitFor(() => expect(order()).toEqual(['c', 'a', 'b']));
    release();
  });

  it('puts back the ranks already saved, and the order, when a later save fails', async () => {
    const { transport, result, order } = setup();
    vi.mocked(transport.updateTodo)
      .mockResolvedValueOnce(createMockTodo())
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(createMockTodo());
    act(() =>
      result.current.mutate({
        query: QUERY,
        order: ['b', 'c', 'a'],
        changes: [
          { id: 'b', rank: 'n', previous: null },
          { id: 'c', rank: 'u', previous: 'q' },
        ],
      })
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(vi.mocked(transport.updateTodo).mock.calls).toEqual([
      ['b', { rank: 'n' }],
      ['c', { rank: 'u' }],
      ['b', { rank: null }],
    ]);
    expect(order()).toEqual(['a', 'b', 'c']);
  });
});
