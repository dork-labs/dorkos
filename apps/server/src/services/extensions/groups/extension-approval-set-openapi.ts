/**
 * OpenAPI entries for "Allow all": the sets a person can be asked about, and
 * the one answer that approves each member on its own (DOR-3583).
 *
 * @module services/extensions/groups/extension-approval-set-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ErrorResponseSchema } from '@dorkos/shared/schemas';
import {
  ApprovalSetResultSchema,
  ApproveExtensionSetRequestSchema,
  ExtensionApprovalSetSchema,
} from '@dorkos/shared/extension-approval-schemas';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});

/**
 * Register the approval-set routes.
 *
 * @param registry - The OpenAPI registry.
 */
export function registerExtensionApprovalSetOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/extensions/approval-sets',
    tags: ['Extensions'],
    summary: 'List plugins whose extensions wait to be allowed together',
    description:
      'One entry per plugin with two or more extensions waiting for a first OK. A member joins ' +
      'only when the plugin’s installed-files record lists its manifest with matching bytes: an ' +
      'extension an agent made, a dev link, or a folder added to the plugin later never joins. ' +
      'A member allowed before keeps its own card. `grant` is the waiting members’ combined ' +
      'grant, from the same members `setHash` binds.',
    responses: {
      200: {
        description: 'The sets, by plugin A–Z',
        content: {
          'application/json': { schema: z.object({ sets: z.array(ExtensionApprovalSetSchema) }) },
        },
      },
      500: error('The sets could not be read'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/extensions/approve-set',
    tags: ['Extensions'],
    summary: 'Allow every waiting extension a plugin installed',
    description:
      'Derives the plugin’s waiting members from DorkOS’s own records and refuses unless the ' +
      'request names exactly those, and unless `setHash` (over each member’s id, version, ' +
      'digest and permission set) matches. Only after every check passes is each member ' +
      'approved, one at a time with its own digest: N approvals and N Activity entries, nothing ' +
      'stored about the group; each Activity entry is written as its member is allowed. A ' +
      'member that fails for any reason is reported in `results`, and the rest go on. The same ' +
      'person bar as approving one extension applies, and there is no MCP tool for this.',
    request: {
      body: { content: { 'application/json': { schema: ApproveExtensionSetRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Each member’s result; `allAllowed` only when every one was allowed',
        content: {
          'application/json': {
            schema: z.object({
              results: z.array(ApprovalSetResultSchema),
              allAllowed: z.boolean(),
            }),
          },
        },
      },
      400: error('The body is not a set'),
      401: error('Login is enabled and the caller is not signed in'),
      403: error('Refused: an agent or another site cannot allow extensions'),
      409: error(
        'Nothing was turned on: a member was not installed by this plugin (`not_in_set`), the ' +
          'set or a member’s files or permissions changed (`stale_set`), or more than 10 wait ' +
          '(`too_many_in_set`)'
      ),
    },
  });
}
