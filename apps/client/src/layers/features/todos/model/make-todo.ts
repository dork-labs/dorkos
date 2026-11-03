/**
 * The to-do dialog for the whole app: "New to-do" from the To-dos bar or an empty list, and "Make
 * a to-do" from any message's actions.
 *
 * The dialog registers with the root dialog host, which mounts it only while it is open. Opening
 * it records the message first (or that there is none), so the form mounts with what it was
 * asked for.
 *
 * @module features/todos/model/make-todo
 */
import { useCallback } from 'react';
import { useTodosEnabled } from '@/layers/entities/todo';
import type { DialogOpenState } from '@/layers/shared/model';
import type { TodoMessageSource } from '../ui/NewTodoDialog';

/** The message the dialog was last opened for, or null for a blank New to-do. */
let pending: TodoMessageSource | null = null;

/** Who hears the dialog open and close. */
const listeners = new Set<() => void>();
let open = false;

/**
 * Whether the to-do dialog is open; the root dialog host reads it. Made here rather than with
 * `createDialogOpenState`, so this module loads nothing at runtime from the shared model: the chat
 * transcript imports the to-do card, and its tests replace that module wholesale.
 */
export const makeTodoDialogState: DialogOpenState = {
  getSnapshot: () => open,
  set: (next) => {
    if (next === open) return;
    open = next;
    for (const listener of listeners) listener();
  },
  subscribe: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/**
 * Open the dialog for one message.
 *
 * @param source - The message: its id and its text.
 */
export function openMakeTodo(source: TodoMessageSource): void {
  pending = source;
  makeTodoDialogState.set(true);
}

/**
 * Open a blank New to-do.
 */
export function openNewTodo(): void {
  pending = null;
  makeTodoDialogState.set(true);
}

/** The message the open dialog is for, or null for a blank New to-do. */
export function makeTodoSource(): TodoMessageSource | null {
  return pending;
}

/**
 * The "Make a to-do" action for one message, or undefined while to-dos are off.
 *
 * @param entryId - The message's id.
 * @param text - The message's text.
 * @returns A stable callback, or undefined.
 */
export function useMakeTodoAction(entryId: string, text: string): (() => void) | undefined {
  const enabled = useTodosEnabled();
  const run = useCallback(() => openMakeTodo({ entryId, text }), [entryId, text]);
  return enabled ? run : undefined;
}
