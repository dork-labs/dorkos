import { useQuery } from '@tanstack/react-query';
import type { ListTodoPromisesQuery } from '@dorkos/shared/todo-promise-schemas';
import { useTransport } from '@/layers/shared/model';
import { todoPromiseKeys } from './todo-promise-keys';

/** How often an open list re-reads, so `overdue` turns on without a reload. */
const REFRESH_MS = 60_000;

/**
 * What agents promised, open first. Anyone reads every agent's list.
 *
 * @param query - Optional filters: one agent, one state, or one recipient.
 * @param options - `enabled: false` holds the read until there is something to ask about.
 * @returns The TanStack Query result for `GET /api/todo-promises`.
 */
export function useTodoPromises(
  query: ListTodoPromisesQuery = {},
  options: { enabled?: boolean } = {}
) {
  const transport = useTransport();
  return useQuery({
    queryKey: todoPromiseKeys.list(query),
    queryFn: () => transport.listTodoPromises(query),
    select: (data) => data.todoPromises,
    refetchInterval: REFRESH_MS,
    enabled: options.enabled ?? true,
  });
}
