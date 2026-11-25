/**
 * OpenAPI entries for the to-do routes (DOR-3088), projected from the schemas the routes parse and
 * answer with. Registered only behind `DORKOS_TODOS_ENABLED`, like the routes themselves.
 *
 * @module services/todos/todos-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../core/openapi/problem-openapi.js';
import { z } from 'zod';
import {
  CreateTodoRequestSchema,
  TodoSchema,
  UpdateTodoRequestSchema,
} from '@dorkos/shared/todo-schemas';

/** A refusal: plain words and a stable code. */

/**
 * Register the to-do routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerTodosOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/api/todos',
    tags: ['To-dos'],
    summary: 'Make a to-do',
    description:
      "A person makes a to-do. Only the owner's own sign-in gives it their authority; an app " +
      'window that is not signed in is asked to step up first. Agents use `todo_add`.',
    request: { body: { content: { 'application/json': { schema: CreateTodoRequestSchema } } } },
    responses: {
      201: {
        description: 'The new to-do',
        content: { 'application/json': { schema: TodoSchema } },
      },
      400: problemResponse('A bad body'),
      401: problemResponse('Step up first'),
      403: problemResponse('An agent'),
      429: problemResponse('Past a daily cap'),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/todos/{id}',
    tags: ['To-dos'],
    summary: 'Change a to-do',
    description:
      'Mark it done (`kept`) or declined (`dropped` with a note), reopen, edit, move or reassign ' +
      'it. A request that does not prove the person changes nothing.',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: UpdateTodoRequestSchema } } },
    },
    responses: {
      200: { description: 'The to-do', content: { 'application/json': { schema: TodoSchema } } },
      400: problemResponse('A bad body'),
      401: problemResponse('Step up first'),
      403: problemResponse('Not yours'),
      404: problemResponse('No such to-do'),
      412: problemResponse('`precondition_failed`: it changed since it was shown'),
    },
  });
}
