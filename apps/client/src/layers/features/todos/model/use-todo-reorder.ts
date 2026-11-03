/**
 * Moving a to-do in "My order": the rank changes a move needs, saved top first, one at a time,
 * so each key is stored before the next one is judged against it.
 *
 * @module features/todos/model/use-todo-reorder
 */
import { useCallback, useState } from 'react';
import type { Todo } from '@dorkos/shared/todo-schemas';
import { useUpdateTodo } from '@/layers/entities/todo';
import { planMove } from '../lib/todo-rank';

/**
 * Move to-dos within the open ones the list draws.
 *
 * @param rows - The open to-dos, in the order the list draws them.
 * @returns `move(from, to)`, and whether a move is still saving.
 */
export function useTodoReorder(rows: readonly Todo[]) {
  const update = useUpdateTodo();
  const [moving, setMoving] = useState(false);
  const move = useCallback(
    async (from: number, to: number) => {
      const changes = planMove(rows, from, to);
      if (changes.length === 0) return;
      setMoving(true);
      try {
        for (const change of changes) {
          await update.mutateAsync({ id: change.id, body: { rank: change.rank } });
        }
      } catch {
        // The shared mutation handler has already said what went wrong.
      } finally {
        setMoving(false);
      }
    },
    [rows, update]
  );
  return { move, moving };
}
