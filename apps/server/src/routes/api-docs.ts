/**
 * The API's own description: `GET /api/openapi.json`, and the interactive
 * reference page at `/api/docs` that reads it. Both show the published
 * document, the same one `docs/api/openapi.json` holds: `internal` operations
 * are served but not described here.
 *
 * The page is Scalar's, rendered by `@scalar/client-side-rendering`: the
 * function the Express integration wrapped in one line. It is static HTML
 * that loads the viewer from a CDN, so it is built once, with the document,
 * and every request to it is answered with the same bytes.
 *
 * Building the document never stops the server. `docs:export-api` and the
 * tests build it the strict way and fail on a bad document (two operations
 * sharing an id, say); here a failure is logged and both routes answer 503,
 * because the API works whether or not its description does.
 *
 * @module routes/api-docs
 */
import { Hono } from 'hono';
import { renderApiReference } from '@scalar/client-side-rendering';
import { problem } from '@dorkos/http-kit';
import type { ApiEnv } from '../http/api-chain.js';
import { logger } from '../lib/logger.js';
import { generateOpenAPISpec } from '../services/core/openapi-registry.js';
import { splitPublishedDocument } from '../services/core/openapi/published-document.js';

/** What the routes build the document with; the real registry unless a test passes its own. */
export type ApiDocumentBuilder = () => ReturnType<typeof generateOpenAPISpec>;

/** The published document: every operation but the `internal` ones (ADR 261123-170832). */
function publishedDocument(): ReturnType<ApiDocumentBuilder> {
  return splitPublishedDocument(generateOpenAPISpec()).published;
}

/**
 * The API docs routes, to mount at `/api`.
 *
 * The page answers every method and every path under `/api/docs`, as the
 * Express integration's `app.use` did.
 *
 * @param build - Builds the document. Defaults to the real registry's published document.
 * @returns The routes, for `app.route('/api', …)`.
 */
export function createApiDocsRoutes(build: ApiDocumentBuilder = publishedDocument): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  let spec: ReturnType<ApiDocumentBuilder>;
  try {
    spec = build();
  } catch (err) {
    logger.error(
      '[api-docs] the API document could not be built; /api/openapi.json and /api/docs answer 503',
      { err }
    );
    const unavailable = (c: Parameters<typeof problem>[0]) =>
      problem(c, 'temporarily_unavailable', {
        detail: 'The API description is unavailable on this server.',
      });
    router.get('/openapi.json', unavailable);
    router.all('/docs', unavailable);
    router.all('/docs/*', unavailable);
    return router;
  }
  const page = renderApiReference({ config: { content: spec, _integration: 'hono' } });
  router.get('/openapi.json', (c) => c.json(spec));
  router.all('/docs', (c) => c.html(page));
  router.all('/docs/*', (c) => c.html(page));
  return router;
}
