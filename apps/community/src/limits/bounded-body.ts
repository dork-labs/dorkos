import type { Context } from 'hono';
import { ApiError } from '../http.js';

/**
 * Read a request body into memory, refusing it once it passes `maxBodyBytes` or takes longer
 * than `deadlineMs` to arrive, then put the buffered copy back on the request. Bounds a JSON or
 * auth body before anything parses it, even a chunked or false-length one.
 */
export async function bufferBoundedBody(
  c: Context,
  maxBodyBytes: number,
  deadlineMs: number
): Promise<void> {
  const declared = Number(c.req.header('content-length'));
  if (declared > maxBodyBytes)
    throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'Request body is too large.');
  if (c.req.raw.body) {
    const reader = c.req.raw.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    // The server lets a request take hours to arrive, for export uploads. A small JSON
    // body gets its own short deadline, so a slow drip cannot hold a connection open.
    const deadline = Date.now() + deadlineMs;
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ApiError(408, 'UNAVAILABLE', 'The request took too long to arrive.')),
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
