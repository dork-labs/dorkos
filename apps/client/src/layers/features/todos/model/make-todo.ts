/**
 * "Make a to-do" from a message: one dialog for the whole app, opened from any message's actions.
 *
 * The dialog registers with the root dialog host, which mounts it only while it is open. Opening
 * it records the message first, so the form mounts with the message it was asked for.
 *
 * @module features/todos/model/make-todo
 */
import { useCallback } from 'react';
import { useTodosEnabled } from '@/layers/entities/todo';
import { createDialogOpenState } from '@/layers/shared/model';
import type { TodoMessageSource } from '../ui/NewTodoDialog';

/** The message the dialog was last opened for. */
let pending: TodoMessageSource | null = null;

/** Whether the Make a to-do dialog is open; the root dialog host reads it. */
export const makeTodoDialogState = createDialogOpenState();

/**
 * Open the dialog for one message.
 *
 * @param source - The message: its id and its text.
 */
export function openMakeTodo(source: TodoMessageSource): void {
  pending = source;
  makeTodoDialogState.set(true);
}

/** The message the open dialog is for, or null before any was opened. */
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
