/**
 * `/api/documents/index`: the docs in one space, so the editor can resolve wiki
 * links and fill the `[[` menu (DOR-2982).
 *
 * `GET /index?cwd=<dir>` answers `{ docs: [{ path, title, slug }], truncated }`.
 * `cwd` is the working directory the canvas already reads files from, checked
 * against the same directory boundary as the files routes through
 * `resolveDocSpace`, so this route lists nothing the files routes could not.
 * It answers the `/api` 404 while the `docs.enabled` experiment is off.
 *
 * @module routes/docs-links
 */
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { DocIndexQuerySchema, type DocIndex } from '@dorkos/shared/doc-links';
import type { ApiEnv } from '../http/api-chain.js';
import { readQuery } from '../http/request-query.js';
import { BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import { errorBody } from '../lib/route-utils.js';
import { resolveDocSpace } from '../services/docs/doc-space.js';
import { docsEnabled } from '../services/docs/docs-enabled.js';
import { buildDocIndex } from '../services/docs/links/doc-index.js';

/** What the routes read, injectable for tests. */
export interface DocLinkRouteDeps {
  /** Whether the Docs experiment is on. */
  enabled: () => boolean;
  /** Every doc reached from a working directory. */
  index: (cwd: string) => Promise<DocIndex>;
}

const liveDeps: DocLinkRouteDeps = {
  enabled: docsEnabled,
  index: async (cwd) => buildDocIndex(await resolveDocSpace(cwd)),
};

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
      if (err instanceof BoundaryError) {
        return c.json(errorBody(err.message, err.code), 403);
      }
      logger.error('[docs] GET /index failed', { err, cwd: parsed.data.cwd });
      return c.json(errorBody('Couldn’t list the docs here.', 'DOC_INDEX_FAILED'), 500);
    }
  });

  return router;
}
