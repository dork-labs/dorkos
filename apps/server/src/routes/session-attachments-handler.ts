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
import type { Request, Response } from 'express';
import { tryGetSessionAttachmentStore } from '../services/session/attachments/index.js';
import { parseSessionId, sendError } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';

/**
 * Express handler for `GET /api/sessions/:id/attachments/:file`, where `:file`
 * is `<attachmentId>.<ext>` exactly as {@link LocalSessionAttachmentStore.put}
 * answered it.
 *
 * The suffix rides in the URL rather than being looked up, which is what makes
 * this route rowless. It is not trusted for it: the store maps the suffix back
 * through the same allowlist it wrote with, and anything else is a 404.
 *
 * @param req - The Express request (`:id` and `:file` route params).
 * @param res - The Express response (200 / 304 / 404 / 500).
 */
export async function sessionAttachmentHandler(req: Request, res: Response): Promise<void> {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const store = tryGetSessionAttachmentStore();
  if (!store) return sendError(res, 404, 'No such image.', 'ATTACHMENT_NOT_FOUND');

  // `req.params` is typed loosely by Express 5; the router pattern binds one
  // segment, so anything but a string here is impossible in practice and a
  // 404 either way.
  const file = typeof req.params.file === 'string' ? req.params.file : '';
  const extension = path.extname(file).slice(1);
  const attachmentId = extension ? file.slice(0, -(extension.length + 1)) : file;

  try {
    const stored = await store.get(sessionId, attachmentId, extension);
    if (!stored) return sendError(res, 404, 'No such image.', 'ATTACHMENT_NOT_FOUND');

    // Somebody is looking at this picture RIGHT NOW — the strongest in-use
    // signal there is, and what keeps retention from deleting a transcript
    // somebody reads every week. Not awaited: the response must not wait on a
    // timestamp, and `touch` swallows its own failures.
    // `.catch` despite the interface forbidding a throw: the local store is
    // total, but a future one that breaks that contract would take the process
    // down with an unhandled rejection rather than fail a timestamp refresh.
    void store.touch(sessionId, attachmentId, extension).catch(() => {});

    res.setHeader('Content-Type', stored.contentType);
    // An image served from a URL a model can influence is exactly where a
    // sniffing browser turns bytes into a document.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('ETag', stored.etag);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    res.setHeader('Content-Length', String(stored.size));

    if (req.headers['if-none-match'] === stored.etag) {
      // Destroyed rather than piped, so the file handle does not leak.
      stored.stream.destroy();
      res.status(304).end();
      return;
    }

    stored.stream.on('error', (streamErr) => {
      logger.error('[session-attachments] stream failed', { err: streamErr, sessionId });
      if (!res.headersSent) {
        sendError(res, 500, 'Could not read that image.', 'ATTACHMENT_READ_FAILED');
      } else res.destroy(streamErr);
    });
    stored.stream.pipe(res);
  } catch (err) {
    // An id the store refuses outright lands here. It is still "no such image"
    // to whoever asked — a distinct code would only tell a prober that their
    // traversal attempt was recognized.
    logger.debug('[session-attachments] refused a read', { err, sessionId });
    sendError(res, 404, 'No such image.', 'ATTACHMENT_NOT_FOUND');
  }
}
