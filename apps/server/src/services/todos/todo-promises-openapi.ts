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
  UpdateTodoPromiseRequestSchema,
  ConfirmTodoPromiseRequestSchema,
} from '@dorkos/shared/todo-promise-schemas';
import { problemResponse } from '../core/openapi/problem-openapi.js';

/**
 * Register the to-do routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerTodoPromisesOpenApi(registry: OpenAPIRegistry): void {
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
      400: problemResponse(
        '`invalid_request`: invalid body, or nothing to change. `past_due`: a past date'
      ),
      403: problemResponse('`person_only`: the caller is an agent. `owner_only`: not the owner'),
      404: problemResponse('`not_found`: no promise has that id'),
      412: problemResponse(
        '`precondition_failed`: it is no longer in the `from` state the caller named'
      ),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/todo-promises/{id}/confirm',
    tags: ['To-dos'],
    summary: 'Answer whether a kept promise was kept',
    description:
      'When an agent marks a promise to a person kept, that person is asked to confirm it ' +
      '(DOR-3034). `yes` confirms it; `not-yet` reopens it. A person only: a caller ' +
      'presenting an agent identity is refused.',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: ConfirmTodoPromiseRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The promise, confirmed or reopened',
        content: { 'application/json': { schema: TodoPromiseSchema } },
      },
      400: problemResponse('`invalid_request`: invalid body, or no answer is waiting'),
      403: problemResponse('`person_only`: the caller is an agent. `owner_only`: not the owner'),
      404: problemResponse('`not_found`: no promise has that id'),
    },
  });
}
