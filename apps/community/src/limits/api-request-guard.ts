import type { MiddlewareHandler } from 'hono';
import type { CommunityConfig } from '../config.js';
import { ApiError } from '../http.js';
import { IMPORT_ARCHIVE_UPLOAD_PATH } from '../routes/host/imports.js';
import { IMPORT_PART_UPLOAD_PATH } from '../imports/part-routes.js';

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
      const declared = Number(c.req.header('content-length'));
      if (declared > maxBodyBytes)
        throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'Request body is too large.');
      if (c.req.raw.body) {
        const reader = c.req.raw.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        // The server lets a request take hours to arrive, for export uploads. A small JSON
        // body gets its own short deadline, so a slow drip cannot hold a connection open.
        const deadline = Date.now() + jsonBodyMs;
        while (true) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const { done, value } = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new ApiError(408, 'UNAVAILABLE', 'The request took too long to arrive.')),
                Math.max(0, deadline - Date.now())
              );
            }),
          ])
            .catch(async (error: unknown) => {
              await reader.cancel().catch(() => undefined);
              throw error;
            })
            .finally(() => clearTimeout(timer));
          if (done) break;
          size += value.byteLength;
          if (size > maxBodyBytes) {
            await reader.cancel();
            throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'Request body is too large.');
          }
          chunks.push(value);
        }
        const body = new Uint8Array(new ArrayBuffer(size));
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        c.req.raw = new Request(c.req.raw, { body: new Blob([body]) });
      }
    }
    await next();
  };
}
