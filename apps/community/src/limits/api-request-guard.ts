import type { MiddlewareHandler } from 'hono';
import type { CommunityConfig } from '../config.js';
import { ApiError } from '../http.js';
import { IMPORT_ARCHIVE_UPLOAD_PATH } from '../routes/host/imports.js';
import { IMPORT_PART_UPLOAD_PATH } from '../imports/part-routes.js';
import { bufferBoundedBody } from './bounded-body.js';

/**
 * The guard every `/api/*` request passes first. A mutating request must come from the
 * Community's own site, and its body is read in full under a size cap and a deadline before any
 * handler parses it. Attachment, archive and part uploads stream on and bound themselves.
 *
 * @param config - Server configuration: the public URL and the text size limit.
 * @param jsonBodyMs - How long a JSON request body may take to arrive.
 */
export function createApiRequestGuard(
  config: CommunityConfig,
  jsonBodyMs: number
): MiddlewareHandler {
  return async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin && origin !== config.publicUrl) {
        throw new ApiError(403, 'FORBIDDEN', 'This request came from an untrusted site.');
      }
      if (!origin && c.req.header('sec-fetch-site') === 'cross-site') {
        throw new ApiError(403, 'FORBIDDEN', 'This request came from an untrusted site.');
      }
      // Bound JSON and auth requests before parsing, even for chunked or false-length bodies.
      if (
        (c.req.path.match(/^\/api\/v1\/(?:communities\/[^/]+\/)?channels\/[^/]+\/attachments$/) &&
          c.req.method === 'POST') ||
        ((IMPORT_ARCHIVE_UPLOAD_PATH.test(c.req.path) ||
          IMPORT_PART_UPLOAD_PATH.test(c.req.path)) &&
          c.req.method === 'PUT')
      ) {
        await next();
        return;
      }
      const maxBodyBytes = Math.max(config.limits.textBytes + 32 * 1024, 96 * 1024);
      await bufferBoundedBody(c, maxBodyBytes, jsonBodyMs);
    }
    await next();
  };
}
