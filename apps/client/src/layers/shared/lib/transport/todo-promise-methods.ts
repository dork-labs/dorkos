/**
 * To-dos Transport method factory (spec `heartbeats` §12).
 *
 * The app's side of the to-do routes: read every agent's promises, add
 * one for an agent as the person, and close or move one. Each call goes
 * through the generated API client (DOR-5473).
 *
 * @module shared/lib/transport/todo-promise-methods
 */
import type {
  TodoPromise,
  CreateTodoPromiseRequest,
  ListTodoPromisesQuery,
  ListTodoPromisesResponse,
  UpdateTodoPromiseRequest,
  ConfirmTodoPromiseRequest,
} from '@dorkos/shared/todo-promise-schemas';
import { createTransportApiClient } from './api-client';

/**
 * Create the to-do methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createTodoPromiseMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  // The document also lists each capability's 202 approval answer, which a
  // person's own call never gets; the casts keep today's types.
  return {
    async listTodoPromises(query: ListTodoPromisesQuery = {}): Promise<ListTodoPromisesResponse> {
      // An empty string is no filter, as it always was here.
      const answer = await api.call('todos.view_promises', {
        query: {
          agentId: query.agentId || undefined,
          state: query.state || undefined,
          to: query.to || undefined,
        },
      });
      return answer as ListTodoPromisesResponse;
    },

    async createTodoPromise(agentId: string, body: CreateTodoPromiseRequest): Promise<TodoPromise> {
      return (await api.call('todos.add_promise_for_agent', {
        path: { id: agentId },
        body,
      })) as TodoPromise;
    },

    async updateTodoPromise(id: string, body: UpdateTodoPromiseRequest): Promise<TodoPromise> {
      return (await api.call('todos.change_promise', { path: { id }, body })) as TodoPromise;
    },

    async confirmTodoPromise(
      id: string,
      answer: ConfirmTodoPromiseRequest['answer']
    ): Promise<TodoPromise> {
      return (await api.call('todos.confirm_promise', {
        path: { id },
        body: { answer },
      })) as TodoPromise;
    },
  };
}
