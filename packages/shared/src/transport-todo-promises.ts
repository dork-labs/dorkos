/**
 * The to-dos slice of the {@link Transport} port: what agents promised,
 * read by anyone, added and changed by a person (spec `heartbeats` §12).
 *
 * Split out of `transport.ts` the way the rooms slice is: `Transport` extends
 * this, so nothing consuming the port sees a difference.
 *
 * @module shared/transport-todo-promises
 */
import type {
  TodoPromise,
  CreateTodoPromiseRequest,
  ListTodoPromisesQuery,
  ListTodoPromisesResponse,
  UpdateTodoPromiseRequest,
} from './todo-promise-schemas.js';

/** The to-do methods every Transport implements. */
export interface TodoPromiseTransport {
  /**
   * What agents promised. Anyone reads every agent's list; open ones come
   * first, and `overdue` is computed by the server.
   *
   * @param query - Optional filters: one agent, one state, or one recipient.
   */
  listTodoPromises(query?: ListTodoPromisesQuery): Promise<ListTodoPromisesResponse>;

  /**
   * Record a promise an agent made, as the person.
   *
   * @param agentId - The agent that promised.
   * @param body - What, to whom, and by when.
   */
  createTodoPromise(agentId: string, body: CreateTodoPromiseRequest): Promise<TodoPromise>;

  /**
   * Mark a promise kept, missed or dropped, or move its date.
   *
   * @param id - The to-do id.
   * @param body - The new state, and optionally a new date and a note.
   */
  updateTodoPromise(id: string, body: UpdateTodoPromiseRequest): Promise<TodoPromise>;
}
