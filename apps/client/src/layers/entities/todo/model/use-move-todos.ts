/**
 * Moving to-dos in a list's own order: the new order shows at once, the rank changes are saved top
 * first, and a failure part-way puts back the ones already saved, so a list is never left half
 * moved. Every list is read again once, at the end.
 *
 * @module entities/todo/model/use-move-todos
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ListTodosQuery, ListTodosResponse } from '@dorkos/shared/todo-schemas';
import { PERSON_SESSION_REQUIRED_CODE } from '@dorkos/shared/person-session';
import { useTransport } from '@/layers/shared/model';
import { todoKeys } from './todo-keys';

/** One to-do's rank, before and after a move. */
export interface TodoRankChange {
  /** The to-do. */
  id: string;
  /** Its new key. */
  rank: string;
  /** The key it had, to put back if the move fails. */
  previous: string | null;
}

/** A move in one list. */
export interface MoveTodosInput {
  /** The list it happened in, whose cached order changes at once. */
  query: ListTodosQuery;
  /** Every id in that list, in the new order. */
  order: string[];
  /** The rank changes, top first. */
  changes: TodoRankChange[];
}

/**
 * Move to-dos within one list.
 *
 * @returns The TanStack mutation.
 */
export function useMoveTodos() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ changes }: MoveTodosInput) => {
      const saved: TodoRankChange[] = [];
      try {
        for (const change of changes) {
          await transport.updateTodo(change.id, { rank: change.rank });
          saved.push(change);
        }
      } catch (error) {
        // Put back what was saved, newest first, so the list reads as it did before.
        for (const change of saved.reverse()) {
          await transport.updateTodo(change.id, { rank: change.previous }).catch(() => undefined);
        }
        throw error;
      }
    },
    meta: {
      errorLabel: 'Couldn’t move the to-do. Try again.',
      isShownInline: (error: Error) =>
        (error as Error & { code?: unknown }).code === PERSON_SESSION_REQUIRED_CODE,
    },
    onMutate: async ({ query, order, changes }: MoveTodosInput) => {
      const key = todoKeys.list(query);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ListTodosResponse>(key);
      const ranks = new Map(changes.map((change) => [change.id, change.rank]));
      const position = new Map(order.map((id, index) => [id, index]));
      queryClient.setQueryData<ListTodosResponse>(key, (data) =>
        data
          ? {
              ...data,
              todos: data.todos
                .map((todo) => (ranks.has(todo.id) ? { ...todo, rank: ranks.get(todo.id)! } : todo))
                .sort(
                  (a, b) =>
                    (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                    (position.get(b.id) ?? Number.MAX_SAFE_INTEGER)
                ),
            }
          : data
      );
      return { key, previous };
    },
    onError: (_error, _input, context) => {
      if (context) queryClient.setQueryData(context.key, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: todoKeys.all }),
  });
}
