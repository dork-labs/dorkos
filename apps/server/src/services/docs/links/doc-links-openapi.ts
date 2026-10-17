/**
 * OpenAPI entry for the doc index wiki links resolve against (DOR-2982,
 * `routes/docs-links.ts`), projected from the schemas the route parses and
 * answers with.
 *
 * @module server/services/docs/links/doc-links-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { DocIndexQuerySchema, DocIndexSchema } from '@dorkos/shared/doc-links';
import { ErrorResponseSchema } from '@dorkos/shared/schemas';
import { DOC_INDEX_LIMITS } from './doc-index.js';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});

/**
 * Register `GET /api/documents/index` on the OpenAPI registry.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerDocLinksOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/documents/index',
    tags: ['Docs'],
    summary: 'List the docs in a space',
    description:
      'Every `.md` file under `cwd`, with its path (relative, forward slashes), title ' +
      '(frontmatter `title:`, else the first `# ` heading, else the file name) and slug (the ' +
      'file name without `.md`, lowercased, spaces as `-`), sorted by path. Wiki links and the ' +
      '`[[` menu resolve against it with the rules in `@dorkos/shared/doc-links`. Dot-folders, ' +
      'dependency and build folders and symlinks are skipped. The walk stops at ' +
      `${DOC_INDEX_LIMITS.maxDocs} docs, ${DOC_INDEX_LIMITS.maxFolders} folders or ` +
      `${DOC_INDEX_LIMITS.maxDepth} levels deep, and then answers \`truncated: true\`. ` +
      'Part of the Docs experiment (`docs.enabled`).',
    request: { query: DocIndexQuerySchema },
    responses: {
      200: {
        description: 'The docs in the space',
        content: { 'application/json': { schema: DocIndexSchema } },
      },
      400: error('`cwd` is missing, not absolute, or not an existing folder'),
      403: error('`cwd` is outside the directory boundary'),
      404: error('The `docs.enabled` experiment is off'),
      500: error('The docs could not be listed'),
    },
  });
}
