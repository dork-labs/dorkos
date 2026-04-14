import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { uploadHandler } from '../services/core/upload-handler.js';
import { configManager } from '../services/core/config-manager.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * Upload files to a session's working directory for agent access.
 *
 * Accepts multipart/form-data with field name `files`. The `cwd` query
 * parameter determines the upload directory (`{cwd}/.dork/.temp/uploads/`).
 * Multer config (maxFileSize, maxFiles, allowedTypes) is loaded dynamically
 * from the user config on each request.
 */
router.post('/', async (req, res) => {
  try {
    const cwd = req.query.cwd;
    if (!cwd || typeof cwd !== 'string') {
      return res.status(400).json({ error: 'Missing required parameter: cwd' });
    }

    const validatedCwd = await validateBoundary(cwd);
    const uploadConfig = configManager.get('uploads');

    // Multer is invoked manually (not as route-level middleware) because
    // config is loaded dynamically per-request from the config manager.
    const upload = uploadHandler.createMulterMiddleware(validatedCwd, uploadConfig);

    upload.array('files', uploadConfig.maxFiles)(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          const message =
            err.code === 'LIMIT_FILE_SIZE'
              ? `File too large (max ${uploadConfig.maxFileSize / 1024 / 1024}MB)`
              : err.message;
          return res.status(400).json({ error: message, code: err.code });
        }
        return res.status(400).json({ error: err.message });
      }

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files provided' });
      }

      res.json({
        uploads: files.map((f) => ({
          originalName: f.originalname,
          savedPath: f.path,
          filename: f.filename,
          size: f.size,
          mimeType: f.mimetype,
        })),
      });
    });
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    logger.error('[uploads] POST / failed', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Serve an uploaded file by filename.
 *
 * Requires `cwd` query parameter to locate the upload directory.
 * Uses `path.basename()` to prevent directory traversal and validates
 * the resolved path stays within the upload directory.
 */
router.get('/:filename', async (req, res) => {
  try {
    const cwd = req.query.cwd;
    if (!cwd || typeof cwd !== 'string') {
      return res.status(400).json({ error: 'Missing required parameter: cwd' });
    }

    const validatedCwd = await validateBoundary(cwd);
    const filename = path.basename(req.params.filename);
    const filePath = path.join(uploadHandler.getUploadDir(validatedCwd), filename);

    const resolvedPath = path.resolve(filePath);
    const uploadDir = path.resolve(uploadHandler.getUploadDir(validatedCwd));
    if (!resolvedPath.startsWith(uploadDir + path.sep) && resolvedPath !== uploadDir) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.sendFile(resolvedPath, (err) => {
      if (err && !res.headersSent) {
        const status = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
        res.status(status).json({ error: status === 404 ? 'File not found' : 'Internal error' });
      }
    });
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    logger.error('[uploads] GET /:filename failed', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
