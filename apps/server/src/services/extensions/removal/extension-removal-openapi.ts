/**
 * The OpenAPI entry for the approvals whose extension is gone (DOR-3372).
 * Removing an extension and forgetting such an approval are capabilities the
 * mount describes from their own declarations (DOR-4978).
 *
 * @module services/extensions/removal/extension-removal-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { problemResponse as error } from '../../core/openapi/problem-openapi.js';

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
 * Register the stale-approval list.
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
}
