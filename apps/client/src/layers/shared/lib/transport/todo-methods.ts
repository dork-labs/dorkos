/**
 * To-dos Transport method factory (DOR-3088).
 *
 * The app's side of the to-do routes: read one view of the list, make a to-do as the person, and
 * complete, reopen or edit one, through the generated API client (DOR-5473).
 *
 * @module shared/lib/transport/todo-methods
 */
import type {
  CreateTodoRequest,
  ListTodosQuery,
  ListTodosResponse,
  Todo,
  TodoCard,
  UpdateTodoRequest,
} from '@dorkos/shared/todo-schemas';
import { createTransportApiClient } from './api-client';

/**
 * Create the to-do methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createTodoMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  // The document also lists each capability's 202 approval answer, which a
  // person's own call never gets; the casts keep today's types.
  return {
    async listTodos(query: ListTodosQuery = {}): Promise<ListTodosResponse> {
      // In the order the hand-written call sent them; an empty value sends nothing.
      const values = {
        view: query.view || undefined,
        agentId: query.agentId || undefined,
        roomId: query.roomId || undefined,
        due: query.due || undefined,
        showDone: query.showDone ? ('true' as const) : undefined,
        sort: query.sort || undefined,
        limit: query.limit,
      };
      return (await api.call('todos.view_list', { query: values })) as ListTodosResponse;
    },

    async getTodo(id: string): Promise<TodoCard> {
      return (await api.call('todos.view_card', { path: { id } })) as TodoCard;
    },

    async createTodo(body: CreateTodoRequest): Promise<Todo> {
      return (await api.call('todos.add_as_person', { body })) as Todo;
    },

    async updateTodo(id: string, body: UpdateTodoRequest): Promise<Todo> {
      return (await api.call('todos.change_as_person', { path: { id }, body })) as Todo;
    },
  };
}
