/**
 * Query keys for to-dos, in one place so every write can invalidate every list it changes.
 *
 * @module entities/todo/model/todo-keys
 */
import type { ListTodosQuery } from '@dorkos/shared/todo-schemas';

/** Every to-do query sits under this prefix. */
const TODOS_KEY = ['todos'] as const;

/** The query keys the to-do hooks read under. */
export const todoKeys = {
  /** Everything to-do-shaped. */
  all: TODOS_KEY,
  /** One to-do, as its card reads it. */
  one: (id: string) => [...TODOS_KEY, 'one', id] as const,
  /** Every list, whatever its filters. */
  lists: () => [...TODOS_KEY, 'list'] as const,
  /**
   * `GET /api/todos` with these filters. The server's defaults are spelled out, so the page's
   * "Assigned to me" list and the sidebar's badge read share one entry.
   */
  list: (query: ListTodosQuery = {}) =>
    [
      ...TODOS_KEY,
      'list',
      query.view ?? 'mine',
      query.agentId ?? '',
      query.roomId ?? '',
      query.due ?? '',
      query.showDone ? 'done' : '',
      query.sort ?? 'due',
      query.limit ?? '',
    ] as const,
};
