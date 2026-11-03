/**
 * What the to-do list is showing: its view, due filter, sort, and whether done ones show.
 *
 * @module features/todos/model/use-todo-filters
 */
import { useMemo, useState } from 'react';
import type { ListTodosQuery, TodoView } from '@dorkos/shared/todo-schemas';
import type { TodoDueFilter, TodoSort } from '../lib/todo-labels';

/** Everything the list's controls choose. */
export interface TodoFilters {
  view: TodoView;
  due: TodoDueFilter;
  sort: TodoSort;
  showDone: boolean;
}

/** Where the list opens: the person's own, soonest due first, open ones only. */
const DEFAULT_TODO_FILTERS: TodoFilters = {
  view: 'mine',
  due: 'any',
  sort: 'due',
  showDone: false,
};

/**
 * The query a set of filters asks the server. Only what differs from the server's own defaults
 * is sent, except the view, which is always named.
 *
 * @param filters - What the controls chose.
 */
function todoQueryOf(filters: TodoFilters): ListTodosQuery {
  return {
    view: filters.view,
    ...(filters.due !== 'any' && { due: filters.due }),
    ...(filters.sort === 'rank' && { sort: 'rank' as const }),
    ...(filters.showDone && { showDone: true }),
  };
}

/**
 * The list's filters, held for as long as the page is open.
 *
 * @param initial - Where the list opens; defaults to {@link DEFAULT_TODO_FILTERS}.
 * @returns The filters, a setter for one field at a time, and the query they ask.
 */
export function useTodoFilters(initial: TodoFilters = DEFAULT_TODO_FILTERS) {
  const [filters, setFilters] = useState<TodoFilters>(initial);
  const query = useMemo(() => todoQueryOf(filters), [filters]);
  const set = <K extends keyof TodoFilters>(key: K, value: TodoFilters[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));
  return { filters, query, set };
}
