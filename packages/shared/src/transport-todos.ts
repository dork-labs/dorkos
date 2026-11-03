/**
 * The to-dos slice of the {@link Transport} port (DOR-3088): one list read through four views,
 * and a person making and changing to-dos.
 *
 * Split out of `transport.ts` the way the commitments slice is: `Transport` extends this, so
 * nothing consuming the port sees a difference.
 *
 * @module shared/transport-todos
 */
import type {
  CreateTodoRequest,
  ListTodosQuery,
  ListTodosResponse,
  Todo,
  TodoCard,
  UpdateTodoRequest,
} from './todo-schemas.js';

/** The to-do methods every Transport implements. */
export interface TodoTransport {
  /**
   * One view of the to-do list, with how many done ones it hides and the person's badge count.
   *
   * @param query - Optional view, filters and sort. The server defaults to the person's own.
   */
  listTodos(query?: ListTodosQuery): Promise<ListTodosResponse>;

  /**
   * One to-do as its card reads it, with the chat its latest turn ran in. Rejects with a 404 for
   * a to-do the reader can't see.
   *
   * @param id - The to-do id.
   */
  getTodo(id: string): Promise<TodoCard>;

  /**
   * Make a to-do as the person.
   *
   * @param body - What, for whom, and optionally by when.
   */
  createTodo(body: CreateTodoRequest): Promise<Todo>;

  /**
   * Complete, reopen, decline or edit a to-do.
   *
   * @param id - The to-do id.
   * @param body - The fields to change.
   */
  updateTodo(id: string, body: UpdateTodoRequest): Promise<Todo>;
}
