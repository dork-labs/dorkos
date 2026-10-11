/**
 * The heartbeat routes' OpenAPI entries (spec `heartbeats` §6.3, §7.6).
 *
 * @module services/heartbeats/heartbeats-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { HeartbeatStatusSchema, TriageCreditsChoiceSchema } from '@dorkos/shared/heartbeat-schemas';

/**
 * Register `GET /api/agents/{id}/heartbeat` and `PUT /api/heartbeats/triage-credits`.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerHeartbeatsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/agents/{id}/heartbeat',
    tags: ['Heartbeats'],
    summary: "An agent's heartbeat",
    description:
      'How the agent wakes on its own, when its next timed beat is due, its last 20 beats ' +
      'from the record, and the messages to people still held for their working hours.',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'The heartbeat',
        content: { 'application/json': { schema: HeartbeatStatusSchema } },
      },
      404: { description: 'No agent with that id' },
    },
  });
  registry.registerPath({
    method: 'put',
    path: '/api/heartbeats/triage-credits',
    tags: ['Heartbeats'],
    summary: 'Choose whether cheap checks run on DorkOS credits',
    description:
      'A person’s answer to the one-time offer: `true` is Use credits, `false` is Not now. ' +
      'Owner only, and never an agent. Nothing is spent while the answer is not `true`.',
    request: {
      body: { content: { 'application/json': { schema: TriageCreditsChoiceSchema } } },
    },
    responses: {
      200: {
        description: 'The answer, stored',
        content: { 'application/json': { schema: TriageCreditsChoiceSchema } },
      },
      400: { description: 'The body is not an answer' },
      403: { description: 'Only the owner of this DorkOS can answer' },
    },
  });
}
