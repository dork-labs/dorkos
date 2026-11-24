/**
 * OpenAPI entries for removing an extension and forgetting an approval whose
 * extension is gone (DOR-3541, DOR-3372).
 *
 * @module services/extensions/removal/extension-removal-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { problemResponse as error } from '../../core/openapi/problem-openapi.js';

/** The bar every route here carries, said once. */
const PERSON_BAR =
  'The same person bar as approving applies: a caller naming itself an agent is refused in every ' +
  'posture, another site is refused, and a signed-in person is required when login is on. There ' +
  'is no MCP tool for this.';

const StaleApprovalSchema = z
  .object({
    id: z.string().describe('The extension id the approval names.'),
    path: z
      .string()
      .nullable()
      .describe('The folder the approval was given to; null for a caller that is not the person.'),
    plugin: z.string().nullable().describe('The plugin that carried it, when it came inside one.'),
  })
  .openapi('StaleExtensionApproval');

/**
 * Register the remove, forget and stale-approval routes.
 *
 * @param registry - The OpenAPI registry.
 */
export function registerExtensionRemovalOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/extensions/stale-approvals',
    tags: ['Extensions'],
    summary: 'List approvals whose extension is no longer installed',
    description:
      'Every extension id that still has a run approval, approved source or permission set ' +
      'recorded although no copy of it is installed anywhere. Settings shows each as "Folder ' +
      'missing" with Forget. Paths are only sent to the person.',
    responses: {
      200: {
        description: 'The approvals left behind, A–Z',
        content: {
          'application/json': {
            schema: z.object({ approvals: z.array(StaleApprovalSchema) }),
          },
        },
      },
      500: error('`internal_error`: the list could not be read'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/extensions/{id}/remove',
    tags: ['Extensions'],
    summary: 'Remove an installed extension',
    description:
      'Forgets every approval and choice recorded for this copy, then deletes its folder and ' +
      'rescans. Only a folder DorkOS puts extensions in is deleted (`<data dir>/extensions/<id>` ' +
      'or `.dork/extensions/<id>`, with no symbolic link): a plugin-carried copy is removed by ' +
      'uninstalling the plugin, a dev link by unlinking it, and a DorkOS extension not at all. ' +
      PERSON_BAR,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Removed',
        content: { 'application/json': { schema: z.object({ removed: z.string() }) } },
      },
      400: error('`invalid_request`: an invalid extension id'),
      401: error('`unauthenticated`: login is on and the caller is not signed in'),
      403: error('`person_only`: an agent or another site cannot remove an extension'),
      404: error('`not_found`: no such extension'),
      409: error(
        '`conflict` (`detail` says which): it ships with DorkOS, came with a plugin, runs ' +
          'from a dev link, or its folder is not one DorkOS would delete'
      ),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/extensions/{id}/forget',
    tags: ['Extensions'],
    summary: 'Forget the approval of an extension that is gone',
    description:
      'Clears the run approval, approved source, permission set and "Not now" recorded for an ' +
      'extension id that is installed nowhere, so a folder put back at that path asks again. ' +
      PERSON_BAR,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Forgotten' },
      400: error('`invalid_request`: an invalid extension id'),
      401: error('`unauthenticated`: login is on and the caller is not signed in'),
      403: error('`person_only`: an agent or another site cannot forget an approval'),
      404: error('`not_found`: no approval is left for this id'),
      409: error('`conflict`: it is still installed; stop it running or remove it instead'),
    },
  });
}
