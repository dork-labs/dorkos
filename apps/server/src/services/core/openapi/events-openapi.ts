/**
 * The global event stream, `GET /api/events` (`routes/events.ts`), in the API
 * document: every frame's `data:` is one `DorkOsEvent` envelope, with the
 * per-type payload union inside it; `event:` repeats the type and `id:` is an
 * opaque cursor (DOR-5474).
 *
 * @module services/core/openapi/events-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { DorkOsEventSchema } from '@dorkos/shared/dorkos-events';
import { EVENT_REPLAY_LIMITS } from '../../../lib/event-stream/event-replay-buffer.js';
import { problemResponse } from './problem-openapi.js';

const CURSOR =
  'The `id:` of the last frame you received, whole and unchanged (it is opaque). ' +
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
    description: [
      'One stream for the chat list and everything else that changes: rooms, tasks, agents,',
      "settings, approvals, Relay, extensions. Each SSE frame's `data:` is one event,",
      '`{ seq, at, type, payload }` (described below): `seq` is its place in this stream (it',
      'only grows and may skip; 0 on the opening frames and the heartbeat), `at` when the server',
      'emitted it, `type` the event type and `payload` its data. `event:` repeats the type and,',
      'on every event after the opening frames, `id:` is an opaque resume cursor (send it back',
      'whole; read `seq` from `data:`, never from the id). Every connect opens with',
      '`connected` (with `resumed: true` when it picked up from your cursor), then any missed',
      'events, then `tunnel_status` with remote access as it is now (never to an agent), then one',
      '`session_status` for each chat that is working, waiting on a person or stopped with an',
      'error; those opening frames have no `id:`. The server keeps the last',
      `${EVENT_REPLAY_LIMITS.maxEvents} events (at most ${EVENT_REPLAY_LIMITS.maxBytes / 1024} KiB)`,
      'for replay, filtered with the rights you have when you reconnect; a replayed event keeps',
      'its first `at`. A `heartbeat` event arrives every 15 seconds. The same path answers a',
      'WebSocket upgrade, which is what the DorkOS app uses: each message is the same event,',
      '`{ seq, at, type, payload }`, with the cursor beside it as `id`, resuming from `?resume=`.',
      'An event addressed to a person (settings, the inbox, an',
      "ask's detail, remote access) never reaches a reader that presents an agent token.",
    ].join(' '),
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
        description: "An SSE stream; each frame's `data:` is one `DorkOsEvent`.",
        content: { 'text/event-stream': { schema: DorkOsEventSchema } },
      },
      503: problemResponse(
        '`temporarily_unavailable`: too many live connections are open. Try again soon.'
      ),
    },
  });
}
