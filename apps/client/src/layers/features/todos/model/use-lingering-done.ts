/**
 * A to-do just completed stays in the open list for a moment, marked done, with an Undo.
 *
 * The server stops listing it the moment it is kept, so the list holds its own copy, at the
 * place it was, until the moment passes or the person undoes it. The moment starts once the
 * server has saved it, never at the click: a slow server or a sign-in prompt must not use it up,
 * and Undo waits for the save so the two changes can never land out of order.
 *
 * @module features/todos/model/use-lingering-done
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Todo } from '@dorkos/shared/todo-schemas';

/** How long a completed row stays, in milliseconds. */
const TODO_LINGER_MS = 2_000;

/** One held row: the copy drawn, where it sat, and whether its change is still being saved. */
export interface LingeringTodo {
  todo: Todo;
  index: number;
  saving: boolean;
}

/**
 * The rows being held, and the things that move them. Every held row is dropped when `scope`
 * changes, so a row held in one view never shows up in another.
 *
 * @param scope - The view the rows were held in (its query key, as a string).
 * @returns `held` by id; `hold` a row just completed; `saved` once the server has it, which starts
 *   the moment; `reopen` one being undone, kept until its change lands; `release` one for good.
 */
export function useLingeringDone(scope: string) {
  const [held, setHeld] = useState<Readonly<Record<string, LingeringTodo>>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const stopAll = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  }, []);

  useEffect(() => stopAll, [stopAll]);

  useEffect(() => {
    stopAll();
    setHeld({});
  }, [scope, stopAll]);

  const stopTimer = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const release = useCallback(
    (id: string) => {
      stopTimer(id);
      setHeld((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [stopTimer]
  );

  const hold = useCallback(
    (todo: Todo, index: number) => {
      stopTimer(todo.id);
      setHeld((prev) => ({
        ...prev,
        [todo.id]: { todo: { ...todo, state: 'kept' }, index, saving: true },
      }));
    },
    [stopTimer]
  );

  const saved = useCallback(
    (id: string) => {
      setHeld((prev) => {
        const entry = prev[id];
        if (!entry || entry.todo.state !== 'kept') return prev;
        return { ...prev, [id]: { ...entry, saving: false } };
      });
      // Undo is offered only from here on, so nothing can reopen the row before its timer
      // starts; releasing a row that is already gone does nothing.
      stopTimer(id);
      timers.current.set(
        id,
        setTimeout(() => release(id), TODO_LINGER_MS)
      );
    },
    [release, stopTimer]
  );

  const reopen = useCallback(
    (id: string) => {
      stopTimer(id);
      setHeld((prev) => {
        const entry = prev[id];
        if (!entry) return prev;
        return {
          ...prev,
          [id]: { ...entry, todo: { ...entry.todo, state: 'open' }, saving: true },
        };
      });
    },
    [stopTimer]
  );

  return { held, hold, saved, reopen, release };
}

/**
 * The list as drawn: the server's rows with each held copy in place of its row, and each held
 * row the server no longer lists put back where it sat.
 *
 * @param todos - The rows the server listed.
 * @param held - The rows being held, by id.
 */
export function withLingering(
  todos: readonly Todo[],
  held: Readonly<Record<string, LingeringTodo>>
): Todo[] {
  const listed = new Set(todos.map((todo) => todo.id));
  const out = todos.map((todo) => held[todo.id]?.todo ?? todo);
  const missing = Object.values(held)
    .filter((entry) => !listed.has(entry.todo.id))
    .sort((a, b) => a.index - b.index);
  for (const entry of missing) out.splice(Math.min(entry.index, out.length), 0, entry.todo);
  return out;
}
