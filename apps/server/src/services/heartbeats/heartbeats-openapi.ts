/**
 * The heartbeat page's OpenAPI entry (spec `heartbeats` §7.6). The credits
 * answer (`PUT /api/heartbeats/triage-credits`) is a capability's route, documented
 * from its declaration (`heartbeat.choose_triage_credits`).
 *
 * @module services/heartbeats/heartbeats-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { HeartbeatStatusSchema } from '@dorkos/shared/heartbeat-schemas';
import { problemResponse } from '../core/openapi/problem-openapi.js';

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
      'How the agent wakes on its own, when its next timed beat is due, its last 50 beats ' +
      'from the record, the messages to people still held for their working hours, and its ' +
      'measures: whether its work on its own helped, each with its source and starting target.',
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({
        days: z.coerce
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe('How many days the measures cover. Defaults to 7.'),
      }),
    },
    responses: {
      200: {
        description: 'The heartbeat',
        content: { 'application/json': { schema: HeartbeatStatusSchema } },
      },
      400: problemResponse('`invalid_request`: `days` is not a whole number from 1 to 90'),
      404: problemResponse('`not_found`: no agent with that id'),
    },
  });
}
