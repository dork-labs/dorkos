/** Ordinary file-save API documentation, including safe identity-change refusal. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { WriteFileRequestSchema, WriteFileResponseSchema } from '@dorkos/shared/schemas';

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
      'or produce a document event receipt without optional documentSave metadata. That lane is ' +
      'operator-only and chat-document-only, validates the server-projected incarnation, and ' +
      'returns an original host saved receipt without route-delivery claims. Identical retries never repeat the file effect. ' +
      'A duplicate acknowledges the original operation: its hash is historical, not proof against later writes. ' +
      'A no-op without a prior committed save has no saved receipt.',
    request: {
      body: { required: true, content: { 'application/json': { schema: WriteFileRequestSchema } } },
    },
    responses: {
      200: {
        description:
          'Content saved or already identical; a verified original document operation may include its durable receipt',
        content: { 'application/json': { schema: WriteFileResponseSchema } },
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
              code: z.enum(['FILE_IDENTITY_CHANGED', 'DOC_SAVE_ID_CONFLICT', 'DOC_SAVE_FAILED']),
            }),
          },
        },
      },
      503: {
        description:
          'The original save remains uncertain; no effect is replayed and no receipt is invented',
        content: { 'application/json': { schema: RefusalSchema } },
      },
      500: {
        description: 'Save unavailable; includes unresolved checkbox admission evidence',
        content: { 'application/json': { schema: RefusalSchema } },
      },
    },
  });
}
