/**
 * OpenAPI entries for the to-do routes (spec `heartbeats` §12), projected
 * from the schemas the routes parse and answer with.
 *
 * @module services/todos/todo-promises-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  TodoPromiseSchema,
  CreateTodoPromiseRequestSchema,
  ListTodoPromisesQuerySchema,
  ListTodoPromisesResponseSchema,
  UpdateTodoPromiseRequestSchema,
} from '@dorkos/shared/todo-promise-schemas';

/** A refusal: plain words and a stable code. */
const TodoPromiseErrorSchema = z
  .object({ error: z.string(), code: z.string() })
  .openapi('TodoPromiseError');

/**
 * Register the to-do routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerTodoPromisesOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/todo-promises',
    tags: ['To-dos'],
    summary: 'What agents promised',
    description:
      "Every agent's promises, readable by anyone in the space: open first (soonest due " +
      'first), then kept, missed and dropped, newest first. `overdue` is computed on read.',
    request: { query: ListTodoPromisesQuerySchema },
    responses: {
      200: {
        description: 'The promises',
        content: { 'application/json': { schema: ListTodoPromisesResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/agents/{id}/todo-promises',
    tags: ['To-dos'],
    summary: 'Add a promise for an agent',
    description:
      'A person records something an agent promised. Agents record their own with ' +
      '`todo_promise_add`, so a caller presenting an agent identity is refused.',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: CreateTodoPromiseRequestSchema } } },
    },
    responses: {
      201: {
        description: 'The new promise',
        content: { 'application/json': { schema: TodoPromiseSchema } },
      },
      400: {
        description: 'Invalid body, or a past date (`PAST_DUE`)',
        content: { 'application/json': { schema: TodoPromiseErrorSchema } },
      },
      403: {
        description: 'The caller is an agent (`NOT_A_PERSON`), or not the owner (`NOT_YOURS`)',
        content: { 'application/json': { schema: TodoPromiseErrorSchema } },
      },
      404: {
        description: 'No agent has that id (`UNKNOWN_AGENT`)',
        content: { 'application/json': { schema: TodoPromiseErrorSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/todo-promises/{id}',
    tags: ['To-dos'],
    summary: 'Close a promise or move its date',
    description:
      'Mark a promise kept, missed or dropped. `state: "open"` moves an open promise to a new ' +
      '`dueAt`, or reopens a closed one. Only a person may change one here: agents change their ' +
      'own with `todo_promise_update`, so a caller presenting an agent identity is refused.',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: UpdateTodoPromiseRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The promise, changed',
        content: { 'application/json': { schema: TodoPromiseSchema } },
      },
      400: {
        description:
          'Invalid body, nothing to change (`NOTHING_TO_CHANGE`), or a past date (`PAST_DUE`)',
        content: { 'application/json': { schema: TodoPromiseErrorSchema } },
      },
      403: {
        description: 'The caller is an agent (`NOT_A_PERSON`), or not the owner (`NOT_YOURS`)',
        content: { 'application/json': { schema: TodoPromiseErrorSchema } },
      },
      404: {
        description: 'No promise has that id (`NOT_FOUND`)',
        content: { 'application/json': { schema: TodoPromiseErrorSchema } },
      },
      409: {
        description: 'It is no longer in the `from` state the caller named (`CONFLICT`)',
        content: { 'application/json': { schema: TodoPromiseErrorSchema } },
      },
    },
  });
}
