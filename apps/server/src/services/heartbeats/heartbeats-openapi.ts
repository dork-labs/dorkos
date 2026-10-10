/**
 * The heartbeat route's OpenAPI entry (spec `heartbeats` §7.6).
 *
 * @module services/heartbeats/heartbeats-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { HeartbeatStatusSchema } from '@dorkos/shared/heartbeat-schemas';

/**
 * Register `GET /api/agents/{id}/heartbeat`.
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
}
