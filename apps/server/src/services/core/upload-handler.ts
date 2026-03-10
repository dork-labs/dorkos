import multer from 'multer';
import path from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';

/** Sanitize a filename: strip path components, replace unsafe chars, add UUID prefix. */
function sanitizeFilename(original: string): string {
  const base = path.basename(original);
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${randomUUID().slice(0, 8)}-${safe}`;
}

interface UploadConfig {
  maxFileSize: number;
  maxFiles: number;
  allowedTypes: string[];
}

/**
 * Manages disk storage, filename sanitization, and multer middleware configuration
 * for file uploads.
 *
 * Files are stored in `{cwd}/.dork/.temp/uploads/` with sanitized filenames
 * that include a UUID prefix to prevent collisions.
 */
class UploadHandler {
  /** Build the upload directory path for a given cwd. */
  getUploadDir(cwd: string): string {
    return path.join(cwd, '.dork', '.temp', 'uploads');
  }

  /** Ensure the upload directory exists, creating it recursively if needed. */
  async ensureUploadDir(cwd: string): Promise<string> {
    const dir = this.getUploadDir(cwd);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /** Create a multer middleware instance with dynamic config. */
  createMulterMiddleware(cwd: string, config: UploadConfig) {
    const uploadDir = this.getUploadDir(cwd);

    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => {
        fs.mkdir(uploadDir, { recursive: true })
          .then(() => cb(null, uploadDir))
          .catch((err) => cb(err, uploadDir));
      },
      filename: (_req, file, cb) => {
        cb(null, sanitizeFilename(file.originalname));
      },
    });

    return multer({
      storage,
      limits: {
        fileSize: config.maxFileSize,
        files: config.maxFiles,
      },
      fileFilter: (_req, file, cb) => {
        if (config.allowedTypes.includes('*/*')) {
          return cb(null, true);
        }
        if (config.allowedTypes.includes(file.mimetype)) {
          return cb(null, true);
        }
        cb(new Error(`File type not allowed: ${file.mimetype}`));
      },
    });
  }
}

export const uploadHandler = new UploadHandler();
