/**
 * Query keys for to-dos, in one place so every write can invalidate every
 * list it changes.
 *
 * @module entities/todo/model/todo-promise-keys
 */
import type { ListTodoPromisesQuery } from '@dorkos/shared/todo-promise-schemas';

/** Every to-do query sits under this prefix. */
const TODO_PROMISES_KEY = ['todoPromises'] as const;

/** The query keys the to-do hooks read under. */
export const todoPromiseKeys = {
  /** Everything to-do-shaped. */
  all: TODO_PROMISES_KEY,
  /** `GET /api/todo-promises` with these filters. */
  list: (query: ListTodoPromisesQuery = {}) =>
    [...TODO_PROMISES_KEY, 'list', query.agentId ?? '', query.state ?? '', query.to ?? ''] as const,
};
