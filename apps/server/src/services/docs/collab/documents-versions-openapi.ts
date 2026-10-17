/**
 * OpenAPI entries for a doc's saved versions and their restore (DOR-2984,
 * `routes/documents-versions.ts`). Bodies are the wire's own
 * (`@dorkos/shared/doc-collab`). The live editing socket beside them,
 * `GET /api/documents/live`, is a WebSocket upgrade and so has no entry here.
 *
 * @module services/docs/collab/documents-versions-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  DocRefSchema,
  DocVersionListSchema,
  DocVersionSchema,
  KeepDocDraftRequestSchema,
  RestoreDocVersionRequestSchema,
  RestoreDocVersionResponseSchema,
} from '@dorkos/shared/doc-collab';

const TAGS = ['Documents'];

const ErrorSchema = z.object({ error: z.string(), code: z.string() });

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const REFUSALS = {
  400: json(ErrorSchema, 'The doc path is malformed'),
  403: json(ErrorSchema, 'The doc is outside the directory boundary'),
  404: json(ErrorSchema, 'No such doc or version, or the `docs.enabled` experiment is off'),
  415: json(ErrorSchema, 'The file is not markdown'),
};

/**
 * Register the doc version routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerDocumentVersionsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/documents/versions',
    tags: TAGS,
    summary: 'A doc’s saved versions',
    description:
      'The doc as it was just before each recent change made outside its editors (an ' +
      'agent’s write, a change on disk, a restore), newest first. Bounded per doc.',
    request: { query: DocRefSchema },
    responses: { 200: json(DocVersionListSchema, 'The versions, newest first'), ...REFUSALS },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/documents/versions',
    tags: TAGS,
    summary: 'Keep unsaved edits as a version',
    description:
      'Keep text an editor could not save (its live copy was replaced while it was offline) ' +
      'as a version of the doc, so a person can put it back.',
    request: {
      body: { content: { 'application/json': { schema: KeepDocDraftRequestSchema } } },
    },
    responses: {
      200: json(
        z.object({ ok: z.literal(true), version: DocVersionSchema.nullable() }),
        'Kept, or already the newest version'
      ),
      ...REFUSALS,
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/documents/versions/restore',
    tags: TAGS,
    summary: 'Restore a saved version',
    description:
      'Replace the doc with that version. What it said before is kept as a version first, so ' +
      'a restore can be undone. While the doc is open, its editors see the restore live.',
    request: {
      body: { content: { 'application/json': { schema: RestoreDocVersionRequestSchema } } },
    },
    responses: {
      200: json(RestoreDocVersionResponseSchema, 'Restored'),
      409: json(ErrorSchema, 'The doc changed while restoring'),
      ...REFUSALS,
    },
  });
}
