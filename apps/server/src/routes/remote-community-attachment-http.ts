/**
 * Read an attachment upload for a remote space: its envelope headers, checked before any byte is
 * read, and the request body as the adapter's portable byte source.
 *
 * @module routes/remote-community-attachment-http
 */
import type { IncomingMessage } from 'node:http';
import type { Context } from 'hono';
import { z } from 'zod';

function isSafeAttachmentName(value: string): boolean {
  return [...value].every((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && code >= 0x20 && code !== 0x7f;
  });
}

const attachmentHeadersSchema = z.object({
  name: z.string().min(1).max(255).refine(isSafeAttachmentName),
  contentType: z.string().min(1).max(255),
  byteSize: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(25 * 1024 * 1024),
  idempotencyKey: z.string().min(1).max(128),
});

/** Parse the raw attachment envelope without letting a file MIME select a body parser. */
export function attachmentHeaders(c: Context) {
  const envelopeContentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (envelopeContentType !== 'application/octet-stream') return null;
  const encodedName = c.req.header('x-file-name');
  let name: string | undefined;
  try {
    name = encodedName ? decodeURIComponent(encodedName) : undefined;
  } catch {
    return null;
  }
  const parsed = attachmentHeadersSchema.safeParse({
    name,
    contentType: c.req.header('x-file-content-type'),
    byteSize: c.req.header('x-file-size'),
    idempotencyKey: c.req.header('idempotency-key'),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Turn an incoming HTTP byte stream into the adapter's portable byte source. The chain's JSON
 * parser leaves an `application/octet-stream` body unread, so it is all still here.
 */
export async function* requestBytes(req: IncomingMessage): AsyncIterable<Uint8Array> {
  for await (const chunk of req) yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
}
