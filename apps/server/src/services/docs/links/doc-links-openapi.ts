/**
 * OpenAPI entry for the doc index wiki links resolve against (DOR-2982,
 * `routes/docs-links.ts`), projected from the schemas the route parses and
 * answers with.
 *
 * @module server/services/docs/links/doc-links-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  DocIndexQuerySchema,
  DocIndexSchema,
  DocResolveQuerySchema,
  DocResolveSchema,
} from '@dorkos/shared/doc-links';
import { ErrorResponseSchema } from '@dorkos/shared/schemas';
import { DOC_INDEX_LIMITS } from './doc-index.js';
import { DOC_RESOLVE_LIMITS } from './doc-resolve.js';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});

/**
 * Register `GET /api/documents/index` and `GET /api/documents/resolve` on the OpenAPI registry.
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
      'dependency and build folders and symlinks are skipped. The walk goes breadth first and ' +
      `stops at ${DOC_INDEX_LIMITS.maxDocs} docs, ${DOC_INDEX_LIMITS.maxFolders} folders, ` +
      `${DOC_INDEX_LIMITS.maxDepth} levels deep or ${DOC_INDEX_LIMITS.budgetMs} ms, and then ` +
      'answers `truncated: true`; a target the truncated list cannot place is asked about at ' +
      '`/api/documents/resolve`. `root` is the space folder with symlinks resolved. Part of the ' +
      'Docs experiment (`docs.enabled`).',
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

  registry.registerPath({
    method: 'get',
    path: '/api/documents/resolve',
    tags: ['Docs'],
    summary: 'Find the doc a wiki-link target names',
    description:
      'Looks for one target through the whole space, with the same rules as the index, for a ' +
      'link the truncated index could not place. The walk stops at ' +
      `${DOC_RESOLVE_LIMITS.maxDocs} docs, ${DOC_RESOLVE_LIMITS.maxFolders} folders, ` +
      `${DOC_RESOLVE_LIMITS.maxDepth} levels deep or ${DOC_RESOLVE_LIMITS.budgetMs} ms; ` +
      '`complete: false` then says a `null` doc may not be missing. `from` is the linking ' +
      "doc's path, so the nearest of several matches wins. Part of the Docs experiment " +
      '(`docs.enabled`).',
    request: { query: DocResolveQuerySchema },
    responses: {
      200: {
        description: 'The doc, or null, and whether the whole space was looked through',
        content: { 'application/json': { schema: DocResolveSchema } },
      },
      400: error('`cwd` or `target` is missing, or `cwd` is not an existing folder'),
      403: error('`cwd` is outside the directory boundary'),
      404: error('The `docs.enabled` experiment is off'),
      500: error('The docs could not be looked through'),
    },
  });
}
