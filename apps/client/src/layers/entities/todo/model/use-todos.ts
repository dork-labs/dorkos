import { useQuery } from '@tanstack/react-query';
import type { ListTodosQuery, TodoCard } from '@dorkos/shared/todo-schemas';
import { useTransport } from '@/layers/shared/model';
import { todoKeys } from './todo-keys';

/** How often an open list re-reads, so `overdue` and the badge move without a reload. */
const REFRESH_MS = 60_000;

/** The view the sidebar badge reads: the person's own, which is the page's opening view too. */
const BADGE_QUERY: ListTodosQuery = { view: 'mine' };

/**
 * One view of the to-do list: the rows, how many done ones it hides, and the badge count.
 *
 * @param query - The view, filters and sort.
 * @param options - `enabled: false` holds the read, for a server with to-dos off.
 * @returns The TanStack Query result for `GET /api/todos`.
 */
export function useTodos(query: ListTodosQuery = {}, options: { enabled?: boolean } = {}) {
  const transport = useTransport();
  return useQuery({
    queryKey: todoKeys.list(query),
    queryFn: () => transport.listTodos(query),
    refetchInterval: REFRESH_MS,
    enabled: options.enabled ?? true,
  });
}

/**
 * The person's open to-dos due today or overdue, for the sidebar door. Reads the same entry as
 * the page's opening view, so the two never disagree and never ask twice.
 *
 * @param options - `enabled: false` holds the read, for a server with to-dos off.
 * @returns The count, `0` until the list answers.
 */
export function useTodoBadge(options: { enabled?: boolean } = {}): number {
  const transport = useTransport();
  const { data } = useQuery({
    queryKey: todoKeys.list(BADGE_QUERY),
    queryFn: () => transport.listTodos(BADGE_QUERY),
    select: (response) => response.badge,
    refetchInterval: REFRESH_MS,
    enabled: options.enabled ?? true,
  });
  return data ?? 0;
}

/**
 * One to-do as its card reads it, from `GET /api/todos/:id`, which reads with the same reach as
 * the list (v1 has one person, so that is every to-do on this install). An id nobody can read
 * comes back `null`, and the card says it's unavailable. It doesn't poll: every to-do write
 * refreshes it with the lists, so a chat with many cards asks once per card.
 *
 * @param id - The to-do id.
 * @param options - `enabled: false` holds the read, for a server with to-dos off.
 * @returns The TanStack Query result: the to-do, or `null` when it can't be seen.
 */
export function useTodo(id: string, options: { enabled?: boolean } = {}) {
  const transport = useTransport();
  return useQuery<TodoCard | null>({
    queryKey: todoKeys.one(id),
    queryFn: async () => {
      try {
        return await transport.getTodo(id);
      } catch (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    },
    enabled: options.enabled ?? true,
  });
}
