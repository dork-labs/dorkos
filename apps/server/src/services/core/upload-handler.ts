import path from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import type { SingleFieldUploadOptions } from '../../http/uploads.js';

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

/** The form field `POST /api/uploads` reads files from. */
const UPLOAD_FIELD = 'files';

/**
 * Manages disk storage, filename sanitization, and the upload parser's
 * options for file uploads.
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

  /**
   * The parser options for one upload into `cwd`, from the user's upload
   * config: the `files` field, its size and count limits, the type allowlist,
   * and disk storage under sanitized names. `parseUploads` (`http/uploads.ts`)
   * reads the body with them.
   */
  uploadOptions(cwd: string, config: UploadConfig): SingleFieldUploadOptions {
    return {
      field: UPLOAD_FIELD,
      maxCount: config.maxFiles,
      limits: { fileSize: config.maxFileSize, files: config.maxFiles },
      filter: (file) => {
        if (config.allowedTypes.includes('*/*')) return undefined;
        if (config.allowedTypes.includes(file.mimetype)) return undefined;
        return new UploadTypeRefusedError(file.mimetype);
      },
      disk: { directory: this.getUploadDir(cwd), filename: sanitizeFilename },
    };
  }
}

/** The upload type filter's refusal: a file whose type the upload config does not allow. */
export class UploadTypeRefusedError extends Error {
  /**
   * A refusal for one file.
   *
   * @param mimetype - The type the client declared for it.
   */
  constructor(readonly mimetype: string) {
    super(`File type not allowed: ${mimetype}`);
    this.name = 'UploadTypeRefusedError';
  }
}

export const uploadHandler = new UploadHandler();
