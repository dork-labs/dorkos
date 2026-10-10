/**
 * The API's own description: `GET /api/openapi.json`, and the interactive
 * reference page at `/api/docs` that reads it.
 *
 * The page is Scalar's, rendered by `@scalar/client-side-rendering`: the
 * function the Express integration wrapped in one line. It is static HTML
 * that loads the viewer from a CDN, so it is built once, with the document,
 * and every request to it is answered with the same bytes.
 *
 * @module routes/api-docs
 */
import { Hono } from 'hono';
import { renderApiReference } from '@scalar/client-side-rendering';
import type { ApiEnv } from '../http/api-chain.js';
import { generateOpenAPISpec } from '../services/core/openapi-registry.js';

/**
 * The API docs routes, to mount at `/api`.
 *
 * The page answers every method and every path under `/api/docs`, as the
 * Express integration's `app.use` did.
 *
 * @returns The routes, for `app.route('/api', …)`.
 */
export function createApiDocsRoutes(): Hono<ApiEnv> {
  const spec = generateOpenAPISpec();
  const page = renderApiReference({ config: { content: spec, _integration: 'hono' } });
  const router = new Hono<ApiEnv>();
  router.get('/openapi.json', (c) => c.json(spec));
  router.all('/docs', (c) => c.html(page));
  router.all('/docs/*', (c) => c.html(page));
  return router;
}
