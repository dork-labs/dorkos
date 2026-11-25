import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { YourBrowserScanSchema } from '@dorkos/shared/your-browser';
import { problemResponse } from '../core/openapi/problem-openapi.js';

/** Person-only discovery is documented as HTTP only, never an agent capability. */
export function registerBrowserScanOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/api/your-browser/scan',
    tags: ['Local browser'],
    summary: 'Find browser profiles on this computer',
    description:
      'Off by default; enable DORKOS_YOUR_BROWSER_ENABLED=true in the server environment and restart. Reads profile names only when the person taps Find my browsers. Only the owner in the app can call it; agents, API keys and approval tokens are refused. The response must not be cached. Email is for the picker only and is discarded on selection or close.',
    responses: {
      200: {
        description: 'Browser profile metadata for the picker',
        content: { 'application/json': { schema: YourBrowserScanSchema } },
      },
      403: problemResponse('`person_only`: the caller is not the owner in the app'),
      404: problemResponse('`not_found`: browser discovery is disabled'),
    },
  });
}
