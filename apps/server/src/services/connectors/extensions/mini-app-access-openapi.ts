/**
 * OpenAPI entries for mini apps' access to connected apps (DOR-3547): the
 * list and the revoke. The page where a person gives a yes is HTML for a
 * person, outside the app, and on purpose has no API entry.
 *
 * @module services/connectors/extensions/mini-app-access-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  MiniAppAccessListSchema,
  MiniAppAccessRevokeParamsSchema,
  MiniAppAccessRevokeResponseSchema,
} from '@dorkos/shared/mini-app-access-schemas';

/**
 * Register the mini app access routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerMiniAppAccessOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/connectors/mini-app-access',
    tags: ['Connectors'],
    summary: 'What mini apps wait to read, and what each may read now',
    description:
      'Each connected app a mini app declares and may not read yet (new, files changed or reads ' +
      'changed), and each yes a person gave, with the account. Only the owner at the app. A yes ' +
      'is given on its own page outside the app, never through the API.',
    responses: {
      200: {
        description: 'Waiting reads and live yeses.',
        content: { 'application/json': { schema: MiniAppAccessListSchema } },
      },
      403: { description: 'Not the owner at the app: an agent, a program or another site.' },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/connectors/mini-app-access/{approvalId}/revoke',
    tags: ['Connectors'],
    summary: "Take back a mini app's access to a connected app",
    description:
      'Revokes one yes and its grants, unless another live yes of the same mini app still covers ' +
      "that account. The mini app's next read is refused. Only the owner at the app.",
    request: { params: MiniAppAccessRevokeParamsSchema },
    responses: {
      200: {
        description: 'Revoked.',
        content: { 'application/json': { schema: MiniAppAccessRevokeResponseSchema } },
      },
      403: { description: 'Not the owner at the app.' },
      404: { description: 'No live yes under that id (`MINI_APP_ACCESS_NOT_FOUND`).' },
    },
  });
}
