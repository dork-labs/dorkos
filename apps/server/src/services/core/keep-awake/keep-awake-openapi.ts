/**
 * OpenAPI entries for `/api/keep-awake` and its timed-session routes, projected
 * from the schemas the routes read and answer with.
 *
 * @module services/core/keep-awake/keep-awake-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { KeepAwakeSessionRequestSchema, KeepAwakeStatusSchema } from '@dorkos/shared/schemas';

/** The error body the timer routes answer a bad request or a refusal with. */
const SessionErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  paths: z.array(z.string()).optional(),
  message: z.string().optional(),
});

/** The refusals a timer write shares with `PATCH /api/config`. */
const SESSION_REFUSALS = {
  403: {
    description:
      'The caller identifies as an agent, or Require login is on and the request carries no ' +
      'sign-in cookie. A timer is a person’s choice, like the mode.',
    content: { 'application/json': { schema: SessionErrorSchema } },
  },
} as const;

/**
 * Register the keep-awake routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerKeepAwakeOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/keep-awake',
    tags: ['Keep awake'],
    summary: 'Whether this computer is being kept awake',
    description:
      'Whether DorkOS is keeping this computer from idle-sleeping right now, what is keeping it ' +
      'awake (chats, room replies and task runs, each counted once), the mode, any timer, ' +
      'whether the screen is held too, whether a power rule has paused it, and why it ' +
      'cannot when it cannot (a container, a missing tool, or a refusal). The same payload is ' +
      'pushed as `keep_awake_status` on `GET /api/events` whenever it changes.',
    responses: {
      200: {
        description: 'The keep-awake status',
        content: { 'application/json': { schema: KeepAwakeStatusSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/keep-awake/session',
    tags: ['Keep awake'],
    summary: 'Keep this computer awake for a while',
    description:
      'Starts a timer, or replaces the one running: the computer is held awake for ' +
      '`minutes` from now, or until `until`, whatever the mode says. At most a day. Stored in ' +
      '`keepAwake.manualUntil`, so it survives a restart, and simply ends when it runs out. ' +
      'Guarded like `PATCH /api/config`: agents are refused.',
    request: {
      body: { content: { 'application/json': { schema: KeepAwakeSessionRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The timer started; the new keep-awake status',
        content: { 'application/json': { schema: KeepAwakeStatusSchema } },
      },
      400: {
        description: 'Not `{ minutes }` or `{ until }`, or an end in the past or over a day away',
        content: { 'application/json': { schema: SessionErrorSchema } },
      },
      ...SESSION_REFUSALS,
    },
  });
  registry.registerPath({
    method: 'delete',
    path: '/api/keep-awake/session',
    tags: ['Keep awake'],
    summary: 'End the timer',
    description:
      'Ends the timer now, so the mode decides again. Answers the same when none was ' +
      'running. Guarded like `PATCH /api/config`: agents are refused.',
    responses: {
      200: {
        description: 'The timer ended; the new keep-awake status',
        content: { 'application/json': { schema: KeepAwakeStatusSchema } },
      },
      ...SESSION_REFUSALS,
    },
  });
}
