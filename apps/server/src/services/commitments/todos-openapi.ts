/**
 * OpenAPI entries for the to-do routes (DOR-3088), projected from the schemas the routes parse and
 * answer with. Registered only behind `DORKOS_TODOS_ENABLED`, like the routes themselves.
 *
 * @module services/commitments/todos-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  CreateTodoRequestSchema,
  ListTodosQuerySchema,
  ListTodosResponseSchema,
  TodoCardSchema,
  TodoSchema,
  UpdateTodoRequestSchema,
} from '@dorkos/shared/todo-schemas';

/** A refusal: plain words and a stable code. */
const TodoErrorSchema = z.object({ error: z.string(), code: z.string() }).openapi('TodoError');

/**
 * Register the to-do routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerTodosOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/todos',
    tags: ['To-dos'],
    summary: 'To-dos',
    description:
      'To-dos for a view (assigned to me by default), open first, with how many done ones the ' +
      'view hides and the rail badge.',
    request: { query: ListTodosQuerySchema },
    responses: {
      200: {
        description: 'The to-dos',
        content: { 'application/json': { schema: ListTodosResponseSchema } },
      },
    },
  });

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
      400: {
        description: 'A bad body',
        content: { 'application/json': { schema: TodoErrorSchema } },
      },
      401: {
        description: 'Step up first',
        content: { 'application/json': { schema: TodoErrorSchema } },
      },
      403: {
        description: 'An agent',
        content: { 'application/json': { schema: TodoErrorSchema } },
      },
      429: {
        description: 'Past a daily cap',
        content: { 'application/json': { schema: TodoErrorSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/todos/{id}',
    tags: ['To-dos'],
    summary: 'One to-do',
    description:
      'One to-do, read with the same reach as the list, and the chat its latest turn ran in. A ' +
      "to-do's card in a Direct chat draws from this, never from the card entry itself.",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'The to-do',
        content: { 'application/json': { schema: TodoCardSchema } },
      },
      404: {
        description: 'No such to-do',
        content: { 'application/json': { schema: TodoErrorSchema } },
      },
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
      400: {
        description: 'A bad body',
        content: { 'application/json': { schema: TodoErrorSchema } },
      },
      401: {
        description: 'Step up first',
        content: { 'application/json': { schema: TodoErrorSchema } },
      },
      403: {
        description: 'Not yours',
        content: { 'application/json': { schema: TodoErrorSchema } },
      },
      404: {
        description: 'No such to-do',
        content: { 'application/json': { schema: TodoErrorSchema } },
      },
      409: {
        description: 'It changed since',
        content: { 'application/json': { schema: TodoErrorSchema } },
      },
    },
  });
}
