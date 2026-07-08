import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { fileLister } from '../services/core/file-lister.js';
import {
  FileListQuerySchema,
  RawFileQuerySchema,
  WriteFileRequestSchema,
} from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * File extensions the raw media route will stream, mapped to their content type.
 * Kept deliberately narrow (images + PDF) so this route can never become a
 * general-purpose file-download endpoint — anything else returns 415.
 */
const MEDIA_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

/** SHA-256 hex of a UTF-8 string — the optimistic-concurrency fingerprint. */
function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Stream a local image or PDF, confined to the session's working directory.
 * Backs the image/pdf canvas variants when the agent points them at a local
 * file path (vs. an https URL or data: URI, which the client loads directly).
 *
 * Safety mirrors `PUT /content`: the target is resolved against `cwd` and
 * re-validated with `cwd` as the boundary, so `..` or symlinks that escape the
 * working directory are rejected (403). Only the extensions in
 * {@link MEDIA_CONTENT_TYPES} are served — any other file is 415, so this never
 * turns into an arbitrary-file reader. SVGs are served under a script-neutering
 * CSP sandbox so an SVG opened as a top-level document can't execute embedded
 * script (`<img>` loading is unaffected by the sandbox directive).
 */
router.get('/raw', async (req, res) => {
  const parsed = RawFileQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  const { cwd, path: relPath } = parsed.data;

  let resolved: string;
  try {
    const validatedCwd = await validateBoundary(cwd);
    const target = path.isAbsolute(relPath) ? relPath : path.join(validatedCwd, relPath);
    // Re-validate with cwd as the boundary so the read cannot escape the
    // session's working directory (validateBoundary resolves symlinks first).
    resolved = await validateBoundary(target, validatedCwd);
  } catch (err) {
    if (err instanceof BoundaryError) {
      const status = err.code === 'NULL_BYTE' ? 400 : 403;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENAMETOOLONG') {
      return res.status(400).json({ error: 'Invalid path', code });
    }
    logger.error('[files] GET /raw boundary failed', { err, cwd, path: relPath });
    return res.status(500).json({ error: 'Internal server error' });
  }

  const contentType = MEDIA_CONTENT_TYPES[path.extname(resolved).toLowerCase()];
  if (!contentType) {
    return res
      .status(415)
      .json({ error: 'Only image and PDF files can be served', code: 'UNSUPPORTED_TYPE' });
  }

  let size: number;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Not a regular file', code: 'NOT_A_FILE' });
    }
    size = stat.size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
    }
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      return res.status(400).json({ error: 'Invalid path', code });
    }
    logger.error('[files] GET /raw stat failed', { err, resolved });
    return res.status(500).json({ error: 'Internal server error' });
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', size);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  if (contentType === 'image/svg+xml') {
    // Neutralize scripts in a hostile SVG even if it's opened as a top-level
    // document (the "open full size" affordance navigates to this URL).
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    );
  }

  const stream = createReadStream(resolved);
  stream.on('error', (err) => {
    logger.error('[files] GET /raw stream failed', { err, resolved });
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    else res.destroy(err);
  });
  stream.pipe(res);
});

router.get('/', async (req, res) => {
  const parsed = FileListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  try {
    const validatedCwd = await validateBoundary(parsed.data.cwd);
    const result = await fileLister.listFiles(validatedCwd);
    res.json(result);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    logger.error('[files] GET / failed', { err, cwd: parsed.data.cwd });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Write content back to an existing file, confined to the session's working
 * directory. Backs the editable markdown canvas (canvas file-backed editing).
 *
 * Safety: the target is resolved against `cwd` and re-validated with `cwd` as
 * the boundary, so symlinks or `..` that escape the working directory are
 * rejected (403). The file must already exist (404 otherwise) — this never
 * creates files. With `expectedHash`, the write is conditional: a content hash
 * that no longer matches disk means another writer (often the agent) changed the
 * file, so we reject with 409 and return the current bytes for the client to
 * reconcile. The write itself is atomic (temp file + rename).
 */
router.put('/content', async (req, res) => {
  const parsed = WriteFileRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: z.flattenError(parsed.error) });
  }
  const { cwd, path: relPath, content, expectedHash, expectedContent } = parsed.data;

  let resolved: string;
  try {
    const validatedCwd = await validateBoundary(cwd);
    const target = path.isAbsolute(relPath) ? relPath : path.join(validatedCwd, relPath);
    // Re-validate with cwd as the boundary so the write cannot escape the
    // session's working directory (validateBoundary resolves symlinks first).
    resolved = await validateBoundary(target, validatedCwd);
  } catch (err) {
    if (err instanceof BoundaryError) {
      const status = err.code === 'NULL_BYTE' ? 400 : 403;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    // A malformed path (symlink loop, non-directory component) is a client error,
    // not a server fault.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENAMETOOLONG') {
      return res.status(400).json({ error: 'Invalid path', code });
    }
    logger.error('[files] PUT /content boundary failed', { err, cwd, path: relPath });
    return res.status(500).json({ error: 'Internal server error' });
  }

  // The canvas edits a file the agent opened; it never creates new files.
  let current: string;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Not a regular file', code: 'NOT_A_FILE' });
    }
    current = await fs.readFile(resolved, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
    }
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      return res.status(400).json({ error: 'Invalid path', code });
    }
    logger.error('[files] PUT /content read failed', { err, resolved });
    return res.status(500).json({ error: 'Internal server error' });
  }

  const currentHash = sha256(current);

  // Optimistic concurrency: reject if the file changed since the client loaded
  // it. The client supplies either a hash (subsequent saves) or the baseline
  // content (first save, so it needs no client-side hashing); the server hashes
  // the latter. A hash wins if both are sent.
  const effectiveExpected =
    expectedHash ?? (expectedContent !== undefined ? sha256(expectedContent) : undefined);
  if (effectiveExpected !== undefined && effectiveExpected !== currentHash) {
    return res.status(409).json({
      error: 'File changed on disk since it was opened',
      code: 'CONFLICT',
      currentHash,
      currentContent: current,
    });
  }

  const newHash = sha256(content);
  // Identical content — nothing to write, but report success so the client's
  // save state settles (avoids spurious failures on no-op flushes).
  if (newHash === currentHash) {
    return res.json({ ok: true, hash: currentHash });
  }

  // Atomic write: a uniquely-named temp file in the same directory, renamed over
  // the target so a reader never sees a half-written file.
  const tmp = `${resolved}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, resolved);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      return res.status(403).json({ error: 'Permission denied', code: 'EACCES' });
    }
    logger.error('[files] PUT /content write failed', { err, resolved });
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.json({ ok: true, hash: newHash });
});

export default router;
