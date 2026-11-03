/**
 * "New to-do" in the command palette (DOR-3088), there only while to-dos are on.
 *
 * Registered here, in the app layer, because it joins two features that may not import each
 * other: the palette's rows and handlers, and the to-dos' dialog. It comes and goes with the
 * server's flag, so a hidden feature never shows up in a search.
 *
 * @module app/use-todos-palette
 */
import { useEffect } from 'react';
import { useTodosEnabled } from '@/layers/entities/todo';
import {
  registerPaletteCommandHandler,
  unregisterPaletteCommandHandler,
} from '@/layers/features/command-palette';
import { openNewTodo } from '@/layers/features/todos';
import { useExtensionRegistry } from '@/layers/shared/model';

/** The palette action New to-do runs. */
const NEW_TODO_ACTION = 'newTodo';

/** Keep the palette's New to-do row in step with the to-dos flag. */
export function useTodosPalette(): void {
  const enabled = useTodosEnabled();
  useEffect(() => {
    if (!enabled) return;
    registerPaletteCommandHandler(NEW_TODO_ACTION, openNewTodo);
    const unregister = useExtensionRegistry.getState().register('command-palette.items', {
      id: 'new-todo',
      label: 'New to-do',
      icon: 'Plus',
      action: NEW_TODO_ACTION,
      category: 'quick-action',
      keywords: ['todo', 'to do', 'remind'],
    });
    return () => {
      unregister();
      unregisterPaletteCommandHandler(NEW_TODO_ACTION);
    };
  }, [enabled]);
}
