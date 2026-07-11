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
  FileTreeQuerySchema,
  FileContentQuerySchema,
  CreateEntryRequestSchema,
  DeleteEntryQuerySchema,
  RenameEntryRequestSchema,
} from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import {
  MEDIA_CONTENT_TYPES,
  sha256,
  resolveWithinCwd,
  sendPathError,
} from '../lib/file-route-guards.js';
import { FILE_LIMITS } from '../config/constants.js';
import { logger } from '../lib/logger.js';

const router = Router();

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
    ({ resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    if (sendPathError(res, err)) return;
    logger.error('[files] GET /raw boundary failed', { err, cwd, path: relPath });
    return res.status(500).json({ error: 'Internal server error' });
  }

  const contentType = MEDIA_CONTENT_TYPES[path.extname(resolved).toLowerCase()];
  if (!contentType) {
    return res.status(415).json({
      error: 'Only image, PDF, and 3D-model files can be served',
      code: 'UNSUPPORTED_TYPE',
    });
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
    ({ resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    if (sendPathError(res, err)) return;
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

/**
 * List one directory level of a session's working directory for the workbench
 * file explorer. Lazy (depth 1 by default), rooted at `path` (relative to
 * `cwd`). Dotfiles and `.gitignore`d entries are filtered unless `showHidden`.
 * The subtree root is boundary-validated against `cwd`, so a `..`/symlink escape
 * is rejected; the target must be a directory.
 */
router.get('/tree', async (req, res) => {
  const parsed = FileTreeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  const { cwd, path: relPath, depth, showHidden } = parsed.data;

  let validatedCwd: string;
  let resolved: string;
  try {
    ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath ?? '.'));
  } catch (err) {
    if (sendPathError(res, err)) return;
    logger.error('[files] GET /tree boundary failed', { err, cwd, path: relPath });
    return res.status(500).json({ error: 'Internal server error' });
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Not a directory', code: 'NOT_A_DIRECTORY' });
    }
    const entries = await fileLister.listTree(resolved, validatedCwd, depth, showHidden);
    return res.json({ entries });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return res.status(404).json({ error: 'Directory not found', code: 'NOT_FOUND' });
    }
    if (code === 'ENOTDIR') {
      return res.status(400).json({ error: 'Not a directory', code: 'NOT_A_DIRECTORY' });
    }
    logger.error('[files] GET /tree failed', { err, resolved });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Read a UTF-8 text file's content plus its SHA-256 fingerprint, confined to the
 * session's working directory. Distinct from `/raw` (media bytes): files larger
 * than {@link FILE_LIMITS.MAX_TEXT_FILE_BYTES} are rejected (413) and binary
 * files (a NUL byte in the content) are rejected (415). The `hash` is the
 * baseline for a later optimistic-concurrency `PUT /content`.
 */
router.get('/content', async (req, res) => {
  const parsed = FileContentQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  const { cwd, path: relPath } = parsed.data;

  let resolved: string;
  try {
    ({ resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    if (sendPathError(res, err)) return;
    logger.error('[files] GET /content boundary failed', { err, cwd, path: relPath });
    return res.status(500).json({ error: 'Internal server error' });
  }

  let buffer: Buffer;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Not a regular file', code: 'NOT_A_FILE' });
    }
    if (stat.size > FILE_LIMITS.MAX_TEXT_FILE_BYTES) {
      return res.status(413).json({ error: 'File too large to open as text', code: 'TOO_LARGE' });
    }
    buffer = await fs.readFile(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
    }
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      return res.status(400).json({ error: 'Invalid path', code });
    }
    logger.error('[files] GET /content read failed', { err, resolved });
    return res.status(500).json({ error: 'Internal server error' });
  }

  // A NUL byte is the standard binary-file heuristic (git uses the same test).
  if (buffer.includes(0)) {
    return res
      .status(415)
      .json({ error: 'Binary files cannot be opened as text', code: 'BINARY_FILE' });
  }

  const content = buffer.toString('utf8');
  return res.json({ content, hash: sha256(content), encoding: 'utf-8' });
});

/**
 * Create a file or directory inside a session's working directory. Rejects with
 * 409 if the target already exists. A new file's write is atomic (temp +
 * rename); intermediate parent directories are created as needed. The target is
 * boundary-validated against `cwd`.
 */
router.post('/', async (req, res) => {
  const parsed = CreateEntryRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: z.flattenError(parsed.error) });
  }
  const { cwd, path: relPath, type, content } = parsed.data;

  let validatedCwd: string;
  let resolved: string;
  try {
    ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    if (sendPathError(res, err)) return;
    logger.error('[files] POST / boundary failed', { err, cwd, path: relPath });
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (resolved === validatedCwd) {
    return res
      .status(400)
      .json({ error: 'Refusing to create over the working-directory root', code: 'REFUSE_ROOT' });
  }

  try {
    await fs.access(resolved);
    return res.status(409).json({ error: 'Target already exists', code: 'CONFLICT' });
  } catch {
    // Does not exist — proceed to create.
  }

  const relForResponse = path.relative(validatedCwd, resolved).split(path.sep).join('/');
  try {
    if (type === 'dir') {
      await fs.mkdir(resolved, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      const tmp = `${resolved}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fs.writeFile(tmp, content ?? '', 'utf8');
        await fs.rename(tmp, resolved);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      return res.status(403).json({ error: 'Permission denied', code: 'EACCES' });
    }
    logger.error('[files] POST / create failed', { err, resolved });
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(201).json({ ok: true, path: relForResponse });
});

/**
 * Delete a file or directory inside a session's working directory. Refuses to
 * delete the `cwd` root itself. A non-empty directory requires `recursive`; a
 * bare non-empty-directory delete is rejected with 409. The target is
 * boundary-validated against `cwd`.
 */
router.delete('/', async (req, res) => {
  const parsed = DeleteEntryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  const { cwd, path: relPath, recursive } = parsed.data;

  let validatedCwd: string;
  let resolved: string;
  try {
    ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    if (sendPathError(res, err)) return;
    logger.error('[files] DELETE / boundary failed', { err, cwd, path: relPath });
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (resolved === validatedCwd) {
    return res
      .status(400)
      .json({ error: 'Refusing to delete the working-directory root', code: 'REFUSE_ROOT' });
  }

  try {
    const stat = await fs.lstat(resolved);
    if (stat.isDirectory() && !recursive) {
      const children = await fs.readdir(resolved);
      if (children.length > 0) {
        return res
          .status(409)
          .json({ error: 'Directory is not empty; pass recursive', code: 'DIR_NOT_EMPTY' });
      }
    }
    await fs.rm(resolved, { recursive, force: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return res.status(404).json({ error: 'Path not found', code: 'NOT_FOUND' });
    }
    if (code === 'ENOTEMPTY') {
      return res
        .status(409)
        .json({ error: 'Directory is not empty; pass recursive', code: 'DIR_NOT_EMPTY' });
    }
    if (code === 'EACCES') {
      return res.status(403).json({ error: 'Permission denied', code: 'EACCES' });
    }
    logger.error('[files] DELETE / failed', { err, resolved });
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.json({ ok: true });
});

/**
 * Move or rename an entry within a session's working directory. Both `from` and
 * `to` are boundary-validated against `cwd`; `from` must exist (404), `to` must
 * not (409), and neither may be the `cwd` root. The destination's parent
 * directories are created as needed.
 */
router.post('/rename', async (req, res) => {
  const parsed = RenameEntryRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: z.flattenError(parsed.error) });
  }
  const { cwd, from, to } = parsed.data;

  let validatedCwd: string;
  let fromResolved: string;
  let toResolved: string;
  try {
    const fromR = await resolveWithinCwd(cwd, from);
    validatedCwd = fromR.validatedCwd;
    fromResolved = fromR.resolved;
    // `to` does not exist yet, so its own realpath falls back to path.resolve;
    // the containment check still rejects a `..` escape.
    ({ resolved: toResolved } = await resolveWithinCwd(cwd, to));
  } catch (err) {
    if (sendPathError(res, err)) return;
    logger.error('[files] POST /rename boundary failed', { err, cwd, from, to });
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (fromResolved === validatedCwd || toResolved === validatedCwd) {
    return res
      .status(400)
      .json({ error: 'Refusing to move the working-directory root', code: 'REFUSE_ROOT' });
  }

  try {
    await fs.access(fromResolved);
  } catch {
    return res.status(404).json({ error: 'Source not found', code: 'NOT_FOUND' });
  }

  try {
    await fs.access(toResolved);
    return res.status(409).json({ error: 'Target already exists', code: 'CONFLICT' });
  } catch {
    // Target free — proceed.
  }

  try {
    await fs.mkdir(path.dirname(toResolved), { recursive: true });
    await fs.rename(fromResolved, toResolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      return res.status(403).json({ error: 'Permission denied', code: 'EACCES' });
    }
    logger.error('[files] POST /rename failed', { err, fromResolved, toResolved });
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.json({ ok: true });
});

export default router;
