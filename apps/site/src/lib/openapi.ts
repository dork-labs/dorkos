import { createOpenAPI } from 'fumadocs-openapi/server';
import { createAPIPage } from 'fumadocs-openapi/ui';

/**
 * OpenAPI server instance for loading and processing the DorkOS API spec.
 *
 * Points to the generated OpenAPI JSON file at the repo root docs/api/ directory.
 */
export const openapi = createOpenAPI({
  input: ['../../docs/api/openapi.json'],
});

/**
 * APIPage component factory bound to the DorkOS OpenAPI server.
 *
 * Used by the catch-all docs page to render interactive API reference pages.
 */
export const APIPage = createAPIPage(openapi);
