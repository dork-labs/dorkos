/**
 * `/api/documents/index` and `/api/documents/resolve`: the docs in one space,
 * so the editor can resolve wiki links and fill the `[[` menu (DOR-2982).
 *
 * - `GET /index?cwd=<dir>` answers `{ root, docs: [{ path, title, slug }], truncated }`.
 * - `GET /resolve?cwd=<dir>&target=<typed>&from=<path>` answers
 *   `{ doc, complete }` for one target, looked for beyond the index's limits,
 *   for a link the truncated index could not place.
 *
 * `cwd` is the working directory the canvas already reads files from, checked
 * against the same directory boundary as the files routes through
 * `resolveDocSpace`, so these routes list nothing the files routes could not.
 * Both answer the `/api` 404 while the `docs.enabled` experiment is off.
 *
 * @module routes/docs-links
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import {
  DocIndexQuerySchema,
  DocResolveQuerySchema,
  type DocIndex,
  type DocResolve,
} from '@dorkos/shared/doc-links';
import type { ApiEnv } from '../http/api-chain.js';
import { readQuery } from '../http/request-query.js';
import { BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import { errorBody } from '../lib/route-utils.js';
import { DocPathError, resolveDocSpace } from '../services/docs/doc-space.js';
import { docsEnabled } from '../services/docs/docs-enabled.js';
import { buildDocIndex } from '../services/docs/links/doc-index.js';
import { resolveDocTarget } from '../services/docs/links/doc-resolve.js';

/** What the routes read, injectable for tests. */
export interface DocLinkRouteDeps {
  /** Whether the Docs experiment is on. */
  enabled: () => boolean;
  /** Every doc reached from a working directory. */
  index: (cwd: string) => Promise<DocIndex>;
  /** One target, looked for through the whole space. */
  resolve: (cwd: string, target: string, from: string | null) => Promise<DocResolve>;
}

const liveDeps: DocLinkRouteDeps = {
  enabled: docsEnabled,
  index: async (cwd) => buildDocIndex(await resolveDocSpace(cwd)),
  resolve: async (cwd, target, from) => resolveDocTarget(await resolveDocSpace(cwd), target, from),
};

/** The answer for a failed doc read: the boundary's 403, a bad space's 400, else 500. */
function failure(c: Context<ApiEnv>, err: unknown, route: string, cwd: string): Response {
  if (err instanceof BoundaryError) return c.json(errorBody(err.message, err.code), 403);
  if (err instanceof DocPathError) return c.json(errorBody(err.message, 'INVALID_DOC_SPACE'), 400);
  logger.error(`[docs] GET ${route} failed`, { err, cwd });
  return c.json(errorBody('Couldn’t list the docs here.', 'DOC_INDEX_FAILED'), 500);
}

/**
 * Build the doc-link routes, mounted at `/api/documents`.
 *
 * @param deps - Seams for tests; the live config and file system by default.
 */
export function createDocLinkRoutes(deps: DocLinkRouteDeps = liveDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  // Gates only this file's routes, so the other `/api/documents` groups keep their own.
  const whileEnabled: MiddlewareHandler<ApiEnv> = async (c, next) => {
    if (!deps.enabled()) return c.json(errorBody('Not found', 'API_NOT_FOUND'), 404);
    c.header('Cache-Control', 'no-store');
    await next();
  };

  router.get('/index', whileEnabled, async (c) => {
    const parsed = DocIndexQuerySchema.safeParse(readQuery(c));
    if (!parsed.success) {
      return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      return c.json(await deps.index(parsed.data.cwd));
    } catch (err) {
      return failure(c, err, '/index', parsed.data.cwd);
    }
  });

  router.get('/resolve', whileEnabled, async (c) => {
    const parsed = DocResolveQuerySchema.safeParse(readQuery(c));
    if (!parsed.success) {
      return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
    }
    const { cwd, target, from } = parsed.data;
    try {
      return c.json(await deps.resolve(cwd, target, from?.normalize('NFC') ?? null));
    } catch (err) {
      return failure(c, err, '/resolve', cwd);
    }
  });

  return router;
}
