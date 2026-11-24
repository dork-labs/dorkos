/** HTTP contract for private, caller-owned launch folder references. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ErrorResponseSchema } from '@dorkos/shared/schemas';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';

/** Register launch-location reads and reservations without exposing paths in links. */
export function registerSessionLocationsOpenApi(registry: OpenAPIRegistry): void {
  const error = (description: string) => ({
    description,
    content: { 'application/json': { schema: ErrorResponseSchema } },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/session-locations',
    tags: ['Sessions'],
    summary: 'Reserve a private session folder reference',
    description:
      'Returns a durable opaque reference scoped to the caller. Reuses an existing canonical folder reference. Only a person may reserve a folder; filesystem boundaries and cross-site checks apply.',
    request: {
      body: {
        content: { 'application/json': { schema: z.object({ cwd: z.string().min(1) }).strict() } },
      },
    },
    responses: {
      200: {
        description: 'Existing reference.',
        content: { 'application/json': { schema: z.object({ id: z.uuid() }) } },
      },
      201: {
        description: 'New reference.',
        content: { 'application/json': { schema: z.object({ id: z.uuid() }) } },
      },
      400: error('Invalid folder request.'),
      403: error('Caller, request origin or filesystem boundary refused.'),
      409: error('Saved folder limit reached.'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/session-locations/{id}/chats',
    tags: ['Sessions'],
    summary: 'Acknowledge a new chat in a saved folder',
    description:
      'Allocates a fresh chat id for a person’s own saved folder. The acknowledgement starts no turn and sets no runtime or settings.',
    request: {
      params: z.object({ id: z.uuid() }),
      body: { content: { 'application/json': { schema: z.strictObject({}) } } },
    },
    responses: {
      201: {
        description: 'Acknowledged chat id and its saved folder reference.',
        content: {
          'application/json': { schema: z.object({ sessionId: z.uuid(), launchRef: z.uuid() }) },
        },
      },
      400: error('Invalid chat allocation request.'),
      403: error('Caller, request origin or filesystem boundary refused.'),
      404: error('Saved folder not found.'),
      409: error('The issued chat id was already in use.'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/session-locations/chats',
    // Its derived id, `sessionLocations.createChats`, is the saved-folder route's above.
    operationId: 'sessionLocations.createAgentChat',
    tags: ['Sessions'],
    summary: 'Acknowledge a new chat with a registered agent',
    description: 'Reserves a chat id without starting a turn or setting a runtime.',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.strictObject({
              kind: z.literal('registered-agent'),
              agentId: AgentManifestSchema.shape.id,
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Acknowledged chat id.',
        content: { 'application/json': { schema: z.object({ sessionId: z.uuid() }) } },
      },
      400: error('Invalid chat allocation request.'),
      403: error('Caller or request origin refused.'),
      404: error('Registered agent not found.'),
      409: error('The issued chat id was already in use.'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/session-locations/{id}',
    tags: ['Sessions'],
    summary: 'Resolve a private session folder reference',
    description:
      'Resolves only the caller’s own reference and revalidates the current filesystem boundary. Unknown references and references owned by someone else both return 404.',
    request: { params: z.object({ id: z.uuid() }) },
    responses: {
      200: {
        description: 'Allowed folder.',
        content: { 'application/json': { schema: z.object({ cwd: z.string() }) } },
      },
      403: error('Caller, request origin or filesystem boundary refused.'),
      404: error('Reference not found.'),
    },
  });
}
