/**
 * Moving a to-do in "My order": plan the rank changes, show the new order at once, and save it.
 * One move at a time, each planned from the order the last one left on screen.
 *
 * @module features/todos/model/use-todo-reorder
 */
import { useCallback } from 'react';
import { toast } from 'sonner';
import type { ListTodosQuery, Todo } from '@dorkos/shared/todo-schemas';
import { useMoveTodos } from '@/layers/entities/todo';
import { planMove } from '../lib/todo-rank';

/**
 * Move to-dos within the open ones the list draws.
 *
 * @param query - The list's query, whose cached order changes at once.
 * @param rows - Every to-do the list holds, in order.
 * @param movable - The ones that move (open and settled), in order.
 * @returns `move(from, to)` over `movable`'s indices, and whether a move is saving.
 */
export function useTodoReorder(
  query: ListTodosQuery,
  rows: readonly Todo[],
  movable: readonly Todo[]
) {
  const mutation = useMoveTodos();
  const moving = mutation.isPending;
  const move = useCallback(
    (from: number, to: number): boolean => {
      // A second move planned before the first is saved would read stale keys.
      if (moving) return false;
      const changes = planMove(movable, from, to);
      if (changes === null) {
        toast.error('That to-do can’t move there. Try another spot.');
        return false;
      }
      const ids = movable.map((todo) => todo.id);
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved!);
      const rest = rows.map((todo) => todo.id).filter((id) => !ids.includes(id));
      mutation.mutate({ query, order: [...ids, ...rest], changes });
      return true;
    },
    [moving, movable, rows, query, mutation]
  );
  return { move, moving };
}
