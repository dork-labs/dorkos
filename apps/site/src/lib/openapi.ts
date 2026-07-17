import { createOpenAPI } from 'fumadocs-openapi/server';

/**
 * OpenAPI server instance for loading and processing the DorkOS API spec.
 *
 * Points to the generated OpenAPI JSON file at the repo root docs/api/ directory.
 * Under fumadocs-openapi v11 the `APIPage` factory moved to a client module
 * (`components/api-page.tsx`); this file keeps only the server instance, which
 * the catch-all docs page uses to bundle each API page's schema on the server
 * (`openapi.preloadOpenAPIPage`) before handing it to the client `APIPage`.
 */
export const openapi = createOpenAPI({
  input: ['../../docs/api/openapi.json'],
});
