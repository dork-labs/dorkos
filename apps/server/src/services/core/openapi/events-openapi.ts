/**
 * The global event stream, `GET /api/events` (`routes/events.ts`), in the API
 * document, with the one event union as its schema (ADR 261123-170833), so a
 * generated client gets typed events.
 *
 * @module services/core/openapi/events-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { DorkOsEventSchema } from '@dorkos/shared/dorkos-events';
import { EVENT_REPLAY_LIMITS } from '../../../lib/event-stream/event-replay-buffer.js';
import { problemResponse } from './problem-openapi.js';

const CURSOR =
  'The `id` of the last frame you received, whole: `events-<epoch>-<generation>-<seq>`. ' +
  'Sends the events after it that you may read, then live ones. A cursor older than the ' +
  'window the server keeps, from before a restart, or for another stream starts a fresh ' +
  'connect instead, which is the snapshot to rebuild from.';

/**
 * Register `GET /api/events`.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerEventsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/events',
    tags: ['Events'],
    summary: 'The global event stream (SSE, or WebSocket at the same path)',
    description:
      'One stream for the chat list and everything else that changes: rooms, tasks, agents, settings, approvals, Relay, extensions. Each frame is one `DorkOsEvent`: the SSE `event:` line is its `type`, `data:` is its `payload`, and every event after the opening frames has an `id:` whose last part is its `seq`. `seq` only grows within this stream and may skip numbers, since you are not sent events that are not yours. Every connect opens with `connected` (with `resumed: true` when it picked up from your cursor), then any missed events, then one `session_status` for each chat that is working, waiting on a person or stopped with an error; those opening frames have no `id:`. The server keeps the last ' +
      `${EVENT_REPLAY_LIMITS.maxEvents} events (at most ${EVENT_REPLAY_LIMITS.maxBytes / 1024} KiB) for replay, ` +
      "filtered for each reader exactly as live events are. Over SSE a `heartbeat` frame arrives every 15 seconds. The same path answers a WebSocket upgrade, which is what the DorkOS app uses: each message a JSON frame `{ event, data, id }`, resuming from `?resume=`. An event addressed to a person (settings, the inbox, an ask's detail) never reaches a reader that presents an agent token.",
    request: {
      query: z.object({
        resume: z
          .string()
          .optional()
          .openapi({
            description: `${CURSOR} For WebSocket clients, which cannot set headers; \`Last-Event-ID\` wins when both are sent.`,
          }),
      }),
      headers: z.object({
        'Last-Event-ID': z.string().optional().openapi({ description: CURSOR }),
      }),
    },
    responses: {
      200: {
        description: 'An SSE stream of `DorkOsEvent` frames.',
        content: { 'text/event-stream': { schema: DorkOsEventSchema } },
      },
      503: problemResponse(
        '`temporarily_unavailable`: too many live connections are open. Try again soon.'
      ),
    },
  });
}
