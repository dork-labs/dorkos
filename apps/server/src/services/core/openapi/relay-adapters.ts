/**
 * OpenAPI entries for adding a chat connection and saving its settings,
 * projected from the schemas the routes read (`routes/relay-adapter-setting-routes.ts`).
 * A refused setting answers `400 invalid_request` with `fields`, the keys of
 * the settings to fix (DOR-4979). "Confirm it's you" adds its `428` to both
 * (`front-door-openapi.ts`).
 *
 * @module services/core/openapi/relay-adapters
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { PROBLEM_CONTENT_TYPE, ProblemSchema } from '@dorkos/shared/problem';
import {
  AdapterConfigUpdateSchema,
  AdapterCreateRequestSchema,
} from '@dorkos/shared/relay-schemas';
import { problemResponse } from './problem-openapi.js';

/** The refused-settings answer: a problem that names the settings to fix, by key. */
const invalidSettings = {
  description:
    '`invalid_request`: the body or a setting failed its checks. `fields` lists the refused settings by key (`token`, `inbound.subject`), never their values.',
  content: {
    [PROBLEM_CONTENT_TYPE]: {
      schema: ProblemSchema.extend({
        fields: z
          .array(z.string())
          .optional()
          .describe('The keys of the settings to fix, as the connection type names them.'),
      }),
    },
  },
};

const notAllowed = problemResponse(
  '`forbidden`, `person_only` or `owner_only`: this caller may not make that change, or a turn DorkOS can’t vouch for tried to enter a secret.'
);

/**
 * Register the add and save routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerRelayAdapterOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/api/relay/adapters',
    tags: ['Relay'],
    summary: 'Add a chat connection',
    request: { body: { content: { 'application/json': { schema: AdapterCreateRequestSchema } } } },
    responses: {
      201: {
        description: 'Added and started',
        content: {
          'application/json': { schema: z.object({ ok: z.literal(true), id: z.string() }) },
        },
      },
      400: invalidSettings,
      403: notAllowed,
      409: problemResponse('`connection_id_taken`: a connection with that id already exists.'),
      502: problemResponse(
        '`connection_saved_not_started`: it was saved, but it couldn’t connect. Fix its token, then turn it on.'
      ),
    },
  });
  registry.registerPath({
    method: 'patch',
    path: '/api/relay/adapters/{id}/config',
    tags: ['Relay'],
    summary: 'Save a chat connection’s settings',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: AdapterConfigUpdateSchema } } },
    },
    responses: {
      200: {
        description: 'Saved',
        content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
      },
      400: invalidSettings,
      403: notAllowed,
      404: problemResponse('`not_found`: no connection with that id.'),
      412: problemResponse(
        '`precondition_failed`: who may reach your agents here changed since an agent asked.'
      ),
    },
  });
}
