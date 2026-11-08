/**
 * To-dos Transport method factory (spec `heartbeats` §12).
 *
 * The app's side of the to-do routes: read every agent's promises, add
 * one for an agent as the person, and close or move one.
 *
 * @module shared/lib/transport/todo-promise-methods
 */
import type {
  TodoPromise,
  CreateTodoPromiseRequest,
  ListTodoPromisesQuery,
  ListTodoPromisesResponse,
  UpdateTodoPromiseRequest,
} from '@dorkos/shared/todo-promise-schemas';
import { fetchJSON } from './http-client';

/**
 * Create the to-do methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createTodoPromiseMethods(baseUrl: string) {
  return {
    listTodoPromises(query: ListTodoPromisesQuery = {}): Promise<ListTodoPromisesResponse> {
      const params = new URLSearchParams();
      if (query.agentId) params.set('agentId', query.agentId);
      if (query.state) params.set('state', query.state);
      if (query.to) params.set('to', query.to);
      const qs = params.toString();
      return fetchJSON(baseUrl, `/todo-promises${qs ? `?${qs}` : ''}`);
    },

    createTodoPromise(agentId: string, body: CreateTodoPromiseRequest): Promise<TodoPromise> {
      return fetchJSON(baseUrl, `/agents/${encodeURIComponent(agentId)}/todo-promises`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    updateTodoPromise(id: string, body: UpdateTodoPromiseRequest): Promise<TodoPromise> {
      return fetchJSON(baseUrl, `/todo-promises/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },
  };
}
