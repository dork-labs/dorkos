import path from 'path';
import { Hono } from 'hono';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { uploadHandler } from '../services/core/upload-handler.js';
import { configManager } from '../services/core/config-manager.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readQuery } from '../http/request-query.js';
import { sendFileFromRoot } from '../http/send-file.js';
import { parseUploads, UploadLimitError, type UploadedFile } from '../http/uploads.js';

const router = new Hono<ApiEnv>();

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
      return c.json({ error: 'Missing required parameter: cwd' }, 400);
    }

    const validatedCwd = await validateBoundary(cwd);
    const uploadConfig = configManager.get('uploads');

    let files: UploadedFile[];
    try {
      files = await parseUploads(c, uploadHandler.uploadOptions(validatedCwd, uploadConfig));
    } catch (err) {
      if (err instanceof UploadLimitError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? `File too large (max ${uploadConfig.maxFileSize / 1024 / 1024}MB)`
            : err.message;
        return c.json({ error: message, code: err.code }, 400);
      }
      return c.json({ error: (err as Error).message }, 400);
    }

    if (files.length === 0) {
      return c.json({ error: 'No files provided' }, 400);
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
    if (err instanceof BoundaryError) {
      return c.json({ error: err.message, code: err.code }, 403);
    }
    logger.error('[uploads] POST / failed', { err });
    return c.json({ error: 'Internal server error' }, 500);
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
      return c.json({ error: 'Missing required parameter: cwd' }, 400);
    }

    const validatedCwd = await validateBoundary(cwd);
    const filename = path.basename(c.req.param('filename'));
    const sent = await sendFileFromRoot(c, uploadHandler.getUploadDir(validatedCwd), filename);
    if (sent.kind === 'sent') return sent.response;
    if (sent.kind === 'outside') return c.json({ error: 'Access denied' }, 403);
    // `send` reports not-found via err.status (404). err.code is only 'ENOENT'
    // when the parent dir exists, so check both to stay robust.
    const status = sent.error.status === 404 || sent.error.code === 'ENOENT' ? 404 : 500;
    return c.json({ error: status === 404 ? 'File not found' : 'Internal error' }, status);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return c.json({ error: err.message, code: err.code }, 403);
    }
    logger.error('[uploads] GET /:filename failed', { err });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default router;
