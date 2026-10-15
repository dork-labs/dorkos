/** Ordinary file-save API documentation, including safe identity-change refusal. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { WriteFileRequestSchema } from '@dorkos/shared/schemas';

const RefusalSchema = z.object({ error: z.string(), code: z.string().optional() });

/** Register the existing ordinary file save and its cooperative-write outcomes. */
export function registerFileWriteOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'put',
    path: '/api/files/content',
    tags: ['Files'],
    summary: 'Save an existing file within the working directory',
    description:
      'Confined to cwd. Cooperating ordinary and checkbox writes share the installation file gate. ' +
      'A stale content baseline returns 409 with current content. A replaced physical identity ' +
      'returns 412 FILE_IDENTITY_CHANGED; reload before saving again. This does not create files ' +
      'or produce a document event receipt.',
    request: {
      body: { required: true, content: { 'application/json': { schema: WriteFileRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Content saved or already identical',
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              hash: z.string(),
              effect: z.enum(['no_op', 'changed']),
            }),
          },
        },
      },
      400: {
        description: 'Invalid body, path or non-file target',
        content: { 'application/json': { schema: RefusalSchema } },
      },
      403: {
        description: 'Outside the permitted directory or permission denied',
        content: { 'application/json': { schema: RefusalSchema } },
      },
      404: {
        description: 'Existing file not found',
        content: { 'application/json': { schema: RefusalSchema } },
      },
      409: {
        description: 'The content baseline no longer matches',
        content: {
          'application/json': {
            schema: z.object({
              error: z.string(),
              code: z.literal('CONFLICT'),
              currentHash: z.string(),
              currentContent: z.string(),
            }),
          },
        },
      },
      412: {
        description: 'The physical identity changed before replacement; reload the file',
        content: {
          'application/json': {
            schema: z.object({
              error: z.string(),
              code: z.literal('FILE_IDENTITY_CHANGED'),
            }),
          },
        },
      },
      500: {
        description: 'Save unavailable; includes unresolved checkbox admission evidence',
        content: { 'application/json': { schema: RefusalSchema } },
      },
    },
  });
}
