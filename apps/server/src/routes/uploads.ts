import path from 'path';
import { Hono, type Context } from 'hono';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { uploadHandler } from '../services/core/upload-handler.js';
import { configManager } from '../services/core/config-manager.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readQuery } from '../http/request-query.js';
import { sendFileFromRoot } from '../http/send-file.js';
import { isPassiveMedia, MEDIA_CONTENT_TYPES } from '../lib/file-route-guards.js';
import { parseUploads, type UploadedFile } from '../http/uploads.js';
import { uploadRefusalProblem } from '../http/problems/upload-refusal.js';
import { problem } from '@dorkos/http-kit';

const router = new Hono<ApiEnv>();

/** The answer for a request with no `cwd` to find the uploads folder in. */
const missingCwd = (c: Context<ApiEnv>) =>
  problem(c, 'invalid_request', { detail: 'Send `cwd`: the chat’s folder.' });

/** The answer for a folder the boundary refused: a NUL byte is a bad path, else a refusal. */
const boundaryRefusal = (c: Context<ApiEnv>, err: BoundaryError) =>
  err.code === 'NULL_BYTE'
    ? problem(c, 'invalid_request', { detail: 'That path has a character paths can’t hold.' })
    : problem(c, 'outside_boundary', {
        detail: 'That folder is outside the folders DorkOS may use.',
      });

/**
 * Upload files to a session's working directory for agent access.
 *
 * Accepts multipart/form-data with field name `files`. The `cwd` query
 * parameter determines the upload directory (`{cwd}/.dork/.temp/uploads/`).
 * The limits (maxFileSize, maxFiles, allowedTypes) are loaded from the user
 * config on each request.
 */
router.post('/', async (c) => {
  try {
    const cwd = readQuery(c).cwd;
    if (!cwd || typeof cwd !== 'string') {
      return missingCwd(c);
    }

    const validatedCwd = await validateBoundary(cwd);
    const uploadConfig = configManager.get('uploads');

    let files: UploadedFile[];
    try {
      files = await parseUploads(c, uploadHandler.uploadOptions(validatedCwd, uploadConfig));
    } catch (err) {
      return uploadRefusalProblem(c, err, {
        tooLargeDetail: `File too large (max ${uploadConfig.maxFileSize / 1024 / 1024}MB)`,
      });
    }

    if (files.length === 0) {
      return problem(c, 'invalid_request', { detail: 'Attach at least one file in `files`.' });
    }

    return c.json({
      uploads: files.map((f) => ({
        originalName: f.originalname,
        savedPath: f.path,
        filename: f.filename,
        size: f.size,
        mimeType: f.mimetype,
      })),
    });
  } catch (err) {
    if (err instanceof BoundaryError) return boundaryRefusal(c, err);
    logger.error('[uploads] POST / failed', { err });
    return problem(c, 'internal_error', { detail: 'Couldn’t save the upload. Try again.' });
  }
});

/**
 * Serve an uploaded file by filename.
 *
 * Requires `cwd` query parameter to locate the upload directory.
 * Uses `path.basename()` to prevent directory traversal, and
 * `sendFileFromRoot` refuses a name that resolves outside the upload directory.
 */
router.get('/:filename', async (c) => {
  try {
    const cwd = readQuery(c).cwd;
    if (!cwd || typeof cwd !== 'string') {
      return missingCwd(c);
    }

    const validatedCwd = await validateBoundary(cwd);
    const filename = path.basename(c.req.param('filename'));
    const type = MEDIA_CONTENT_TYPES[path.extname(filename).toLowerCase()];
    // Every upload is somebody's file: never sniffed, never in a shared cache.
    c.env.outgoing.setHeader('X-Content-Type-Options', 'nosniff');
    c.env.outgoing.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    if (!(type && isPassiveMedia(type))) downloadOnly(c.env.outgoing);
    const sent = await sendFileFromRoot(c, uploadHandler.getUploadDir(validatedCwd), filename);
    if (sent.kind === 'sent') return sent.response;
    if (sent.kind === 'outside')
      return problem(c, 'outside_boundary', { detail: 'That file is outside the uploads folder.' });
    // `send` reports not-found via err.status (404). err.code is only 'ENOENT'
    // when the parent dir exists, so check both to stay robust.
    const status = sent.error.status === 404 || sent.error.code === 'ENOENT' ? 404 : 500;
    // Any other refusal `send` words itself (a bad name, a range past the
    // end) is the caller's, not the server's.
    const refused = sent.error.status;
    if (status === 500 && refused && refused >= 400 && refused < 500) {
      return problem(c, 'invalid_request', {
        detail: 'That file can’t be sent as asked.',
        status: refused as 400,
      });
    }
    return status === 404
      ? problem(c, 'not_found', { detail: 'That upload doesn’t exist.' })
      : problem(c, 'internal_error', { detail: 'Couldn’t send that upload. Try again.' });
  } catch (err) {
    if (err instanceof BoundaryError) return boundaryRefusal(c, err);
    logger.error('[uploads] GET /:filename failed', { err });
    return problem(c, 'internal_error', { detail: 'Couldn’t send that upload. Try again.' });
  }
});

/**
 * Make an upload a download of opaque bytes that run nothing even if opened,
 * for every upload but a picture, sound or video (DOR-2990): an upload is
 * anything a person or an agent put there, and served as its type an `.html`
 * would run as a page on the app's own address. Set before `send`, which
 * keeps a `Content-Type` already there; an error answer's own headers win.
 */
function downloadOnly(outgoing: ApiEnv['Bindings']['outgoing']): void {
  outgoing.setHeader('Content-Type', 'application/octet-stream');
  outgoing.setHeader('Content-Disposition', 'attachment');
  outgoing.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
}

export default router;
