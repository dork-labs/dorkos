/**
 * To-dos Transport method factory (DOR-3088).
 *
 * The app's side of the to-do routes: read one view of the list, make a to-do as the person, and
 * complete, reopen or edit one.
 *
 * @module shared/lib/transport/todo-methods
 */
import type {
  CreateTodoRequest,
  ListTodosQuery,
  ListTodosResponse,
  Todo,
  UpdateTodoRequest,
} from '@dorkos/shared/todo-schemas';
import { fetchJSON } from './http-client';

/**
 * Create the to-do methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createTodoMethods(baseUrl: string) {
  return {
    listTodos(query: ListTodosQuery = {}): Promise<ListTodosResponse> {
      const params = new URLSearchParams();
      if (query.view) params.set('view', query.view);
      if (query.agentId) params.set('agentId', query.agentId);
      if (query.roomId) params.set('roomId', query.roomId);
      if (query.due) params.set('due', query.due);
      if (query.showDone) params.set('showDone', 'true');
      if (query.sort) params.set('sort', query.sort);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      const qs = params.toString();
      return fetchJSON(baseUrl, `/todos${qs ? `?${qs}` : ''}`);
    },

    createTodo(body: CreateTodoRequest): Promise<Todo> {
      return fetchJSON(baseUrl, '/todos', { method: 'POST', body: JSON.stringify(body) });
    },

    updateTodo(id: string, body: UpdateTodoRequest): Promise<Todo> {
      return fetchJSON(baseUrl, `/todos/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },
  };
}
