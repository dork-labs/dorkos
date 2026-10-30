/**
 * OpenAPI entries for the work queue routes (DOR-3462), projected from the schemas
 * the routes parse and answer with.
 *
 * @module services/work-queue/work-queue-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  AddWorkItemRequestSchema,
  ReorderWorkQueueRequestSchema,
  SetWorkQueuesStoppedRequestSchema,
  UpdateWorkQueueRequestSchema,
  WorkItemSchema,
  WorkQueueSchema,
} from '@dorkos/shared/work-queue-schemas';

/** A refusal: plain words and a stable code. */
const WorkQueueErrorSchema = z
  .object({ error: z.string(), code: z.string() })
  .openapi('WorkQueueError');

/** The answers every route shares. */
const REFUSALS = {
  403: {
    description: 'The caller is an agent (`NOT_A_PERSON`), or not the owner (`NOT_YOURS`)',
    content: { 'application/json': { schema: WorkQueueErrorSchema } },
  },
  404: {
    description: 'No such agent or item (`NOT_FOUND`)',
    content: { 'application/json': { schema: WorkQueueErrorSchema } },
  },
};

/** A 200 or 201 answering with `schema`. */
function answers(description: string, schema: z.ZodType) {
  return { description, content: { 'application/json': { schema } } };
}

/** A JSON request body. */
function jsonBody(schema: z.ZodType) {
  return { content: { 'application/json': { schema } } };
}

/**
 * Register the work queue routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerWorkQueueOpenApi(registry: OpenAPIRegistry): void {
  const agent = z.object({ id: z.string() });
  const item = z.object({ id: z.string(), itemId: z.string() });

  registry.registerPath({
    method: 'get',
    path: '/api/agents/{id}/work-queue',
    tags: ['Work queue'],
    summary: "An agent's work queue",
    description:
      'What waits in order, what is running, what recently ended, whether it is on, the target ' +
      'and daily cap, and what is stopping the next start.',
    request: { params: agent },
    responses: { 200: answers('The queue', WorkQueueSchema), ...REFUSALS },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/agents/{id}/work-queue',
    tags: ['Work queue'],
    summary: 'Turn a queue on or off, or set its target or daily cap',
    description: 'A queue is off until a person turns it on. Only a person can change these.',
    request: { params: agent, body: jsonBody(UpdateWorkQueueRequestSchema) },
    responses: { 200: answers('The queue, changed', WorkQueueSchema), ...REFUSALS },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/work-queues/stop',
    tags: ['Work queue'],
    summary: 'Stop every queue, or lift the stop',
    description: 'Only a person can do this. Chats already running keep going.',
    request: { body: jsonBody(SetWorkQueuesStoppedRequestSchema) },
    responses: {
      200: answers('The stop, as set', SetWorkQueuesStoppedRequestSchema),
      403: REFUSALS[403],
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/agents/{id}/work-queue/order',
    tags: ['Work queue'],
    summary: 'Set the order of what is waiting',
    description: 'An item that started meanwhile is left out of the change.',
    request: { params: agent, body: jsonBody(ReorderWorkQueueRequestSchema) },
    responses: { 200: answers('The queue, in order', WorkQueueSchema), ...REFUSALS },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/agents/{id}/work-queue/items',
    tags: ['Work queue'],
    summary: 'Add an item',
    description: "A person adds work to the back of an agent's queue.",
    request: { params: agent, body: jsonBody(AddWorkItemRequestSchema) },
    responses: {
      201: answers('The new item', WorkItemSchema),
      ...REFUSALS,
      409: {
        description: 'The queue is full (`FULL`)',
        content: { 'application/json': { schema: WorkQueueErrorSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/agents/{id}/work-queue/items/{itemId}',
    tags: ['Work queue'],
    summary: 'Remove a waiting item',
    description: "A running item is its chat's to end, so it is refused.",
    request: { params: item },
    responses: {
      204: { description: 'Removed' },
      ...REFUSALS,
      409: {
        description: 'It already started (`NOT_QUEUED`)',
        content: { 'application/json': { schema: WorkQueueErrorSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/agents/{id}/work-queue/items/{itemId}/requeue',
    tags: ['Work queue'],
    summary: 'Queue an ended item again',
    description: 'It goes to the back of the queue and starts a new chat.',
    request: { params: item },
    responses: {
      200: answers('The item, waiting again', WorkItemSchema),
      ...REFUSALS,
      409: {
        description: 'It has not ended (`NOT_ENDED`)',
        content: { 'application/json': { schema: WorkQueueErrorSchema } },
      },
    },
  });
}
