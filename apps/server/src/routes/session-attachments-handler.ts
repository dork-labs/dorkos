/**
 * Handler for `GET /api/sessions/:id/attachments/:file` — stream back one image
 * a turn produced. Extracted from `sessions.ts` to keep that file under the
 * size rule, mirroring `session-devtools.ts`.
 *
 * **Its security posture is `GET /api/files/raw`'s, deliberately.** The content
 * type is decided by the stored suffix and by nothing else, `nosniff` is set so
 * a browser cannot second-guess it, and the response is `inline` — which is
 * safe here for a reason it would not be for an arbitrary upload: the store
 * only ever wrote four raster image formats, and SVG, the one image format that
 * executes, is refused at the door (`session-media-types.ts`). The route
 * therefore needs no `preview` column and no sniffing, which is the same
 * observation that let session attachments skip a database row entirely.
 *
 * Every refusal is a 404 — a malformed id, a suffix nothing here writes, a
 * session with no such file. Existence is never leaked by a 403.
 *
 * @module routes/session-attachments-handler
 */
import path from 'path';
import type { ServerResponse } from 'node:http';
import { finished } from 'node:stream';
import type { Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { tryGetSessionAttachmentStore } from '../services/session/attachments/index.js';
import { errorBody, parseSessionId, discardStream } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';

const NO_SUCH_IMAGE = errorBody('No such image.', 'ATTACHMENT_NOT_FOUND');

/**
 * Handler for `GET /api/sessions/:id/attachments/:file`, where `:file` is
 * `<attachmentId>.<ext>` exactly as {@link LocalSessionAttachmentStore.put}
 * answered it.
 *
 * The suffix rides in the URL rather than being looked up, which is what makes
 * this route rowless. It is not trusted for it: the store maps the suffix back
 * through the same allowlist it wrote with, and anything else is a 404.
 *
 * The image is piped straight to the Node response
 * (`http/raw-node-stream.ts`), so a read that fails before its first byte can
 * still answer a JSON 500.
 *
 * @param c - The request context (`:id` and `:file` route params); answers
 *   200 / 304 / 404 / 500.
 */
export async function sessionAttachmentHandler(c: Context<ApiEnv>): Promise<Response> {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);

  const store = tryGetSessionAttachmentStore();
  if (!store) return c.json(NO_SUCH_IMAGE, 404);

  // The route pattern binds one segment, so this is always a string.
  const file = c.req.param('file') ?? '';
  const extension = path.extname(file).slice(1);
  const attachmentId = extension ? file.slice(0, -(extension.length + 1)) : file;

  let stored: Awaited<ReturnType<typeof store.get>>;
  try {
    stored = await store.get(sessionId, attachmentId, extension);
  } catch (err) {
    // An id the store refuses outright lands here. It is still "no such image"
    // to whoever asked — a distinct code would only tell a prober that their
    // traversal attempt was recognized.
    logger.debug('[session-attachments] refused a read', { err, sessionId });
    return c.json(NO_SUCH_IMAGE, 404);
  }
  if (!stored) return c.json(NO_SUCH_IMAGE, 404);
  const image = stored;

  // Somebody is looking at this picture RIGHT NOW — the strongest in-use
  // signal there is, and what keeps retention from deleting a transcript
  // somebody reads every week. Not awaited: the response must not wait on a
  // timestamp, and `touch` swallows its own failures.
  // `.catch` despite the interface forbidding a throw: the local store is
  // total, but a future one that breaks that contract would take the process
  // down with an unhandled rejection rather than fail a timestamp refresh.
  void store.touch(sessionId, attachmentId, extension).catch(() => {});

  const ifNoneMatch = c.req.header('if-none-match');
  return streamToNodeResponse(c, (res) => {
    res.setHeader('Content-Type', image.contentType);
    // An image served from a URL a model can influence is exactly where a
    // sniffing browser turns bytes into a document.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('ETag', image.etag);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    res.setHeader('Content-Length', String(image.size));

    if (ifNoneMatch === image.etag) {
      // Discarded rather than piped, so the file handle does not leak — and
      // discarded rather than merely destroyed, because destroying does not
      // defuse the `fs.open` already in flight (see `discardStream`).
      discardStream(image.stream);
      res.statusCode = 304;
      res.end();
      return;
    }

    return new Promise<void>((resolve) => {
      // Settles on the end, the client leaving, or a socket already gone.
      finished(res, () => resolve());
      image.stream.on('error', (streamErr) => {
        logger.error('[session-attachments] stream failed', { err: streamErr, sessionId });
        if (!res.headersSent) {
          sendJsonError(
            res,
            500,
            errorBody('Could not read that image.', 'ATTACHMENT_READ_FAILED')
          );
        } else res.destroy(streamErr);
      });
      image.stream.pipe(res);
    });
  });
}

/**
 * Answer a JSON error on a raw response whose image headers were set but not
 * sent, as Express's `res.status(n).json(body)` did: the type and length are
 * the body's, the other headers stay.
 */
function sendJsonError(res: ServerResponse, status: number, body: object): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(text)));
  res.end(text);
}
