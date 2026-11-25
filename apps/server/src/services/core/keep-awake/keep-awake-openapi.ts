/**
 * OpenAPI entry for `GET /api/keep-awake`, projected from the schema the route
 * answers with.
 *
 * @module services/core/keep-awake/keep-awake-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { KeepAwakeStatusSchema } from '@dorkos/shared/schemas';
import { INTERNAL_ERROR_RESPONSE } from '../openapi/problem-openapi.js';

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
      'awake (chats, room replies and task runs, each counted once), the setting, and why it ' +
      'cannot when it cannot (a container, a missing tool, or a refusal). The same payload is ' +
      'pushed as `keep_awake_status` on `GET /api/events` whenever it changes.',
    responses: {
      500: INTERNAL_ERROR_RESPONSE,
      200: {
        description: 'The keep-awake status',
        content: { 'application/json': { schema: KeepAwakeStatusSchema } },
      },
    },
  });
}
