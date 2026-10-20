/**
 * OpenAPI entry for cancelling a held connected-app action (spec
 * `trusted-by-default-flip` §5.6), projected from the schemas the route answers
 * with.
 *
 * @module services/connectors/execution/holds-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  CancelHeldActionErrorSchema,
  CancelHeldActionParamsSchema,
  CancelHeldActionResponseSchema,
} from '@dorkos/shared/connector-hold-schemas';

/**
 * Register the held-action route.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerConnectorHoldsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/api/connectors/holds/{holdId}/cancel',
    tags: ['Connectors'],
    summary: "Cancel an agent's action before it runs",
    description:
      "On a Trusted install, an agent's high-risk action in a connected app waits 60 seconds " +
      'before it runs, and everyone is told. This cancels it, so it never runs. A person may ' +
      'cancel, and so may any agent except the one that asked for the action. It cannot undo ' +
      'an action that already ran.',
    request: { params: CancelHeldActionParamsSchema },
    responses: {
      200: {
        description: 'Cancelled. The action will not run.',
        content: { 'application/json': { schema: CancelHeldActionResponseSchema } },
      },
      403: {
        description: 'The caller is the agent that asked for the action (`HOLD_REQUESTER`)',
        content: { 'application/json': { schema: CancelHeldActionErrorSchema } },
      },
      404: {
        description:
          'No action is waiting under that id: it already ran, was already cancelled, or DorkOS restarted (`HOLD_NOT_FOUND`)',
        content: { 'application/json': { schema: CancelHeldActionErrorSchema } },
      },
    },
  });
}
