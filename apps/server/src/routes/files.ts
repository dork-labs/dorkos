import { Hono } from 'hono';
import { z } from 'zod';
import crypto from 'crypto';
import fs, { type FileHandle } from 'fs/promises';
import { Readable } from 'node:stream';
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
  CopyEntryRequestSchema,
  RevealEntryRequestSchema,
} from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { revealInFileManager } from '../lib/reveal-in-file-manager.js';
import {
  MEDIA_CONTENT_TYPES,
  sha256,
  resolveWithinCwd,
  pathErrorReply,
  parseByteRange,
} from '../lib/file-route-guards.js';
import { FILE_LIMITS } from '../config/constants.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';

const router = new Hono<ApiEnv>();

/**
 * Stream a local media file (image, PDF, 3D model, audio, or video), confined to
 * the session's working directory. Backs the media canvas variants when the agent
 * points them at a local file path (vs. an https URL or data: URI, which the
 * client loads directly).
 *
 * Safety mirrors `PUT /content`: the target is resolved against `cwd` and
 * re-validated with `cwd` as the boundary, so `..` or symlinks that escape the
 * working directory are rejected (403). Only the extensions in
 * {@link MEDIA_CONTENT_TYPES} are served — any other file is 415, so this never
 * turns into an arbitrary-file reader. SVGs are served under a script-neutering
 * CSP sandbox so an SVG opened as a top-level document can't execute embedded
 * script (`<img>` loading is unaffected by the sandbox directive).
 *
 * Advertises `Accept-Ranges: bytes` and honors a single-range `Range` request
 * (206 + `Content-Range`; 416 when unsatisfiable) so audio/video can seek without
 * downloading the whole file; a request with no `Range` gets the full body (200).
 */
router.get('/raw', async (c) => {
  const parsed = RawFileQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
  }
  const { cwd, path: relPath } = parsed.data;

  let resolved: string;
  try {
    ({ resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[files] GET /raw boundary failed', { err, cwd, path: relPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  const contentType = MEDIA_CONTENT_TYPES[path.extname(resolved).toLowerCase()];
  if (!contentType) {
    return c.json(
      {
        error: 'Only image, PDF, 3D-model, audio, and video files can be served',
        code: 'UNSUPPORTED_TYPE',
      },
      415
    );
  }

  let size: number;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return c.json({ error: 'Not a regular file', code: 'NOT_A_FILE' }, 400);
    }
    size = stat.size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return c.json({ error: 'File not found', code: 'NOT_FOUND' }, 404);
    }
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      return c.json({ error: 'Invalid path', code }, 400);
    }
    logger.error('[files] GET /raw stat failed', { err, resolved });
    return c.json({ error: 'Internal server error' }, 500);
  }

  // Resolve the requested byte range (if any) before writing media headers, so an
  // unsatisfiable range answers as JSON without a media Content-Type getting stuck
  // to the 416.
  const range = parseByteRange(c.req.header('range'), size);
  if (range.kind === 'unsatisfiable') {
    c.header('Content-Range', `bytes */${size}`);
    return c.json({ error: 'Requested range not satisfiable', code: 'RANGE_NOT_SATISFIABLE' }, 416);
  }

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, max-age=0, must-revalidate',
    // Advertise Range support so browsers know they can seek audio/video.
    'Accept-Ranges': 'bytes',
  };
  if (contentType === 'image/svg+xml') {
    // Neutralize scripts in a hostile SVG even if it's opened as a top-level
    // document (the "open full size" affordance navigates to this URL).
    headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  }

  // `end` is inclusive in both HTTP Content-Range and Node's createReadStream.
  const streamOptions = range.kind === 'range' ? { start: range.start, end: range.end } : {};
  const status = range.kind === 'range' ? 206 : 200;
  if (range.kind === 'range') {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
  } else {
    headers['Content-Length'] = String(size);
  }
  // A HEAD gets the headers alone: Hono drops a body it is handed for one,
  // and a stream nobody reads would hold its file open.
  if (c.req.method === 'HEAD') return c.body(null, status, headers);

  // Opened before answering, so a file gone since the stat is a JSON 500
  // rather than media headers with nothing behind them.
  let file: FileHandle;
  try {
    file = await fs.open(resolved, 'r');
  } catch (err) {
    logger.error('[files] GET /raw open failed', { err, resolved });
    return c.json({ error: 'Internal server error' }, 500);
  }
  const stream = file.createReadStream(streamOptions);
  stream.on('error', (err) => logger.error('[files] GET /raw stream failed', { err, resolved }));
  return c.body(Readable.toWeb(stream) as ReadableStream<Uint8Array>, status, headers);
});

router.get('/', async (c) => {
  const parsed = FileListQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
  }
  try {
    const validatedCwd = await validateBoundary(parsed.data.cwd);
    const result = await fileLister.listFiles(validatedCwd);
    return c.json(result);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return c.json({ error: err.message, code: err.code }, 403);
    }
    logger.error('[files] GET / failed', { err, cwd: parsed.data.cwd });
    return c.json({ error: 'Internal server error' }, 500);
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
router.put('/content', async (c) => {
  const parsed = WriteFileRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: z.flattenError(parsed.error) }, 400);
  }
  const { cwd, path: relPath, content, expectedHash, expectedContent } = parsed.data;

  let resolved: string;
  try {
    ({ resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[files] PUT /content boundary failed', { err, cwd, path: relPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  // The canvas edits a file the agent opened; it never creates new files.
  let current: string;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return c.json({ error: 'Not a regular file', code: 'NOT_A_FILE' }, 400);
    }
    current = await fs.readFile(resolved, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return c.json({ error: 'File not found', code: 'NOT_FOUND' }, 404);
    }
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      return c.json({ error: 'Invalid path', code }, 400);
    }
    logger.error('[files] PUT /content read failed', { err, resolved });
    return c.json({ error: 'Internal server error' }, 500);
  }

  const currentHash = sha256(current);

  // Optimistic concurrency: reject if the file changed since the client loaded
  // it. The client supplies either a hash (subsequent saves) or the baseline
  // content (first save, so it needs no client-side hashing); the server hashes
  // the latter. A hash wins if both are sent.
  const effectiveExpected =
    expectedHash ?? (expectedContent !== undefined ? sha256(expectedContent) : undefined);
  if (effectiveExpected !== undefined && effectiveExpected !== currentHash) {
    return c.json(
      {
        error: 'File changed on disk since it was opened',
        code: 'CONFLICT',
        currentHash,
        currentContent: current,
      },
      409
    );
  }

  const newHash = sha256(content);
  // Identical content — nothing to write, but report success so the client's
  // save state settles (avoids spurious failures on no-op flushes).
  if (newHash === currentHash) {
    return c.json({ ok: true, hash: currentHash, effect: 'no_op' });
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
      return c.json({ error: 'Permission denied', code: 'EACCES' }, 403);
    }
    logger.error('[files] PUT /content write failed', { err, resolved });
    return c.json({ error: 'Internal server error' }, 500);
  }

  return c.json({ ok: true, hash: newHash, effect: 'changed' });
});

/**
 * List one directory level of a session's working directory for the workbench
 * file explorer. Lazy (depth 1 by default), rooted at `path` (relative to
 * `cwd`). Dotfiles and `.gitignore`d entries are filtered unless `showHidden`.
 * The subtree root is boundary-validated against `cwd`, so a `..`/symlink escape
 * is rejected; the target must be a directory.
 */
router.get('/tree', async (c) => {
  const parsed = FileTreeQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
  }
  const { cwd, path: relPath, depth, showHidden } = parsed.data;

  let validatedCwd: string;
  let resolved: string;
  try {
    ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath ?? '.'));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[files] GET /tree boundary failed', { err, cwd, path: relPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return c.json({ error: 'Not a directory', code: 'NOT_A_DIRECTORY' }, 400);
    }
    const entries = await fileLister.listTree(resolved, validatedCwd, depth, showHidden);
    return c.json({ entries });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return c.json({ error: 'Directory not found', code: 'NOT_FOUND' }, 404);
    }
    if (code === 'ENOTDIR') {
      return c.json({ error: 'Not a directory', code: 'NOT_A_DIRECTORY' }, 400);
    }
    logger.error('[files] GET /tree failed', { err, resolved });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * Read a UTF-8 text file's content plus its SHA-256 fingerprint, confined to the
 * session's working directory. Distinct from `/raw` (media bytes): files larger
 * than {@link FILE_LIMITS.MAX_TEXT_FILE_BYTES} are rejected (413) and binary
 * files (a NUL byte in the content) are rejected (415). The `hash` is the
 * baseline for a later optimistic-concurrency `PUT /content`.
 */
router.get('/content', async (c) => {
  const parsed = FileContentQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
  }
  const { cwd, path: relPath } = parsed.data;

  let resolved: string;
  try {
    ({ resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[files] GET /content boundary failed', { err, cwd, path: relPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  let buffer: Buffer;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return c.json({ error: 'Not a regular file', code: 'NOT_A_FILE' }, 400);
    }
    if (stat.size > FILE_LIMITS.MAX_TEXT_FILE_BYTES) {
      return c.json({ error: 'File too large to open as text', code: 'TOO_LARGE' }, 413);
    }
    buffer = await fs.readFile(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return c.json({ error: 'File not found', code: 'NOT_FOUND' }, 404);
    }
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      return c.json({ error: 'Invalid path', code }, 400);
    }
    logger.error('[files] GET /content read failed', { err, resolved });
    return c.json({ error: 'Internal server error' }, 500);
  }

  // A NUL byte is the standard binary-file heuristic (git uses the same test).
  if (buffer.includes(0)) {
    return c.json({ error: 'Binary files cannot be opened as text', code: 'BINARY_FILE' }, 415);
  }

  const content = buffer.toString('utf8');
  return c.json({ content, hash: sha256(content), encoding: 'utf-8' });
});

/**
 * Create a file or directory inside a session's working directory. Rejects with
 * 409 if the target already exists. A new file's write is atomic (temp +
 * rename); intermediate parent directories are created as needed. The target is
 * boundary-validated against `cwd`.
 */
router.post('/', async (c) => {
  const parsed = CreateEntryRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: z.flattenError(parsed.error) }, 400);
  }
  const { cwd, path: relPath, type, content } = parsed.data;

  let validatedCwd: string;
  let resolved: string;
  try {
    ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[files] POST / boundary failed', { err, cwd, path: relPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  if (resolved === validatedCwd) {
    return c.json(
      { error: 'Refusing to create over the working-directory root', code: 'REFUSE_ROOT' },
      400
    );
  }

  try {
    await fs.access(resolved);
    return c.json({ error: 'Target already exists', code: 'CONFLICT' }, 409);
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
      return c.json({ error: 'Permission denied', code: 'EACCES' }, 403);
    }
    logger.error('[files] POST / create failed', { err, resolved });
    return c.json({ error: 'Internal server error' }, 500);
  }

  return c.json({ ok: true, path: relForResponse }, 201);
});

/**
 * Delete a file or directory inside a session's working directory. Refuses to
 * delete the `cwd` root itself. A non-empty directory requires `recursive`; a
 * bare non-empty-directory delete is rejected with 409. The target is
 * boundary-validated against `cwd`.
 */
router.delete('/', async (c) => {
  const parsed = DeleteEntryQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
  }
  const { cwd, path: relPath, recursive } = parsed.data;

  let validatedCwd: string;
  let resolved: string;
  try {
    ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[files] DELETE / boundary failed', { err, cwd, path: relPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  if (resolved === validatedCwd) {
    return c.json(
      { error: 'Refusing to delete the working-directory root', code: 'REFUSE_ROOT' },
      400
    );
  }

  try {
    const stat = await fs.lstat(resolved);
    if (stat.isDirectory() && !recursive) {
      const children = await fs.readdir(resolved);
      if (children.length > 0) {
        return c.json(
          { error: 'Directory is not empty; pass recursive', code: 'DIR_NOT_EMPTY' },
          409
        );
      }
    }
    await fs.rm(resolved, { recursive, force: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return c.json({ error: 'Path not found', code: 'NOT_FOUND' }, 404);
    }
    if (code === 'ENOTEMPTY') {
      return c.json(
        { error: 'Directory is not empty; pass recursive', code: 'DIR_NOT_EMPTY' },
        409
      );
    }
    if (code === 'EACCES') {
      return c.json({ error: 'Permission denied', code: 'EACCES' }, 403);
    }
    logger.error('[files] DELETE / failed', { err, resolved });
    return c.json({ error: 'Internal server error' }, 500);
  }

  return c.json({ ok: true });
});

/**
 * Move or rename an entry within a session's working directory. Both `from` and
 * `to` are boundary-validated against `cwd`; `from` must exist (404), `to` must
 * not (409), and neither may be the `cwd` root. The destination's parent
 * directories are created as needed.
 */
router.post('/rename', async (c) => {
  const parsed = RenameEntryRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: z.flattenError(parsed.error) }, 400);
  }
  const { cwd, from, to } = parsed.data;

  let validatedCwd: string;
  let fromResolved: string;
  let toResolved: string;
  try {
    const fromR = await resolveWithinCwd(cwd, from);
    validatedCwd = fromR.validatedCwd;
    fromResolved = fromR.resolved;
    // `to` does not exist yet, so it is confined through its deepest existing
    // ancestor — a `..` escape and a symlinked parent are both rejected.
    ({ resolved: toResolved } = await resolveWithinCwd(cwd, to));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[files] POST /rename boundary failed', { err, cwd, from, to });
    return c.json({ error: 'Internal server error' }, 500);
  }

  if (fromResolved === validatedCwd || toResolved === validatedCwd) {
    return c.json(
      { error: 'Refusing to move the working-directory root', code: 'REFUSE_ROOT' },
      400
    );
  }

  try {
    await fs.access(fromResolved);
  } catch {
    return c.json({ error: 'Source not found', code: 'NOT_FOUND' }, 404);
  }

  try {
    await fs.access(toResolved);
    return c.json({ error: 'Target already exists', code: 'CONFLICT' }, 409);
  } catch {
    // Target free — proceed.
  }

  try {
    await fs.mkdir(path.dirname(toResolved), { recursive: true });
    await fs.rename(fromResolved, toResolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      return c.json({ error: 'Permission denied', code: 'EACCES' }, 403);
    }
    logger.error('[files] POST /rename failed', { err, fromResolved, toResolved });
    return c.json({ error: 'Internal server error' }, 500);
  }

  return c.json({ ok: true });
});

/**
 * Copy an entry within a session's working directory. Mirrors `POST /rename`'s
 * shape and guards: both `from` and `to` are boundary-validated against `cwd`,
 * `from` must exist (404), `to` must not (409), and neither may be the `cwd`
 * root. Directories copy recursively; copying a directory into itself or into
 * its own subtree is refused (400), because the copy would otherwise recurse
 * into the destination it is still writing.
 */
router.post('/copy', async (c) => {
  const parsed = CopyEntryRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: z.flattenError(parsed.error) }, 400);
  }
  const { cwd, from, to } = parsed.data;

  let validatedCwd: string;
  let fromResolved: string;
  let toResolved: string;
  try {
    const fromR = await resolveWithinCwd(cwd, from);
    validatedCwd = fromR.validatedCwd;
    fromResolved = fromR.resolved;
    // `to` does not exist yet, so it is confined through its deepest existing
    // ancestor — a `..` escape and a symlinked parent are both rejected.
    ({ resolved: toResolved } = await resolveWithinCwd(cwd, to));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[files] POST /copy boundary failed', { err, cwd, from, to });
    return c.json({ error: 'Internal server error' }, 500);
  }

  if (fromResolved === validatedCwd || toResolved === validatedCwd) {
    return c.json(
      { error: 'Refusing to copy over the working-directory root', code: 'REFUSE_ROOT' },
      400
    );
  }

  let sourceIsDir: boolean;
  try {
    sourceIsDir = (await fs.stat(fromResolved)).isDirectory();
  } catch {
    return c.json({ error: 'Source not found', code: 'NOT_FOUND' }, 404);
  }

  // `lstat`, not `access`: `access` follows symlinks, so a DANGLING symlink at
  // the destination reads as "free" — and the rollback below would then delete
  // a link the user put there. `lstat` sees the link itself, so an occupied
  // name is an occupied name whatever it points at.
  const targetWasFree = await fs
    .lstat(toResolved)
    .then(() => false)
    .catch(() => true);
  if (!targetWasFree) {
    return c.json({ error: 'Target already exists', code: 'CONFLICT' }, 409);
  }

  if (
    sourceIsDir &&
    (toResolved === fromResolved || toResolved.startsWith(fromResolved + path.sep))
  ) {
    return c.json({ error: 'Refusing to copy a folder into itself', code: 'COPY_INTO_SELF' }, 400);
  }

  try {
    await fs.mkdir(path.dirname(toResolved), { recursive: true });
    await fs.cp(fromResolved, toResolved, { recursive: true, errorOnExist: true, force: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    // Someone else took the name between the check above and the copy. `fs.cp`
    // refused to clobber it (`errorOnExist`), so there is nothing of ours to
    // undo — and deleting THEIR file is exactly the damage the rollback is
    // supposed to prevent.
    if (code === 'ERR_FS_CP_EEXIST') {
      return c.json({ error: 'Target already exists', code: 'CONFLICT' }, 409);
    }
    // The prefix check above misses a case-insensitive filesystem, where
    // `src` → `SRC/inner` is the same self-copy under a different spelling.
    // Node catches it and says so; answer with the honest reason, not a 500.
    if (code === 'ERR_FS_CP_EINVAL') {
      return c.json(
        { error: 'Refusing to copy a folder into itself', code: 'COPY_INTO_SELF' },
        400
      );
    }

    // Only now, having established the destination was free before we started
    // and that we are the ones who wrote to it, is removing it safe. A
    // partially-written destination is worse than none.
    if (targetWasFree) {
      await fs.rm(toResolved, { recursive: true, force: true }).catch(() => {});
    }
    if (code === 'EACCES') {
      return c.json({ error: 'Permission denied', code: 'EACCES' }, 403);
    }
    logger.error('[files] POST /copy failed', { err, fromResolved, toResolved });
    return c.json({ error: 'Internal server error' }, 500);
  }

  return c.json({ ok: true });
});

/**
 * Show an entry in the operating system's file manager, on the machine the
 * server runs on: Finder (macOS), File Explorer (Windows), or the desktop's
 * default handler (everything else). The path is boundary-validated against
 * `cwd` and must exist (404); nothing is read or written.
 *
 * Every launcher runs through `execFile` with an argument array — never a
 * shell — so a file name containing shell metacharacters is passed through as
 * data rather than parsed as a command.
 */
router.post('/reveal', async (c) => {
  const parsed = RevealEntryRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: z.flattenError(parsed.error) }, 400);
  }
  const { cwd, path: relPath } = parsed.data;

  let resolved: string;
  try {
    ({ resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[files] POST /reveal boundary failed', { err, cwd, path: relPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  try {
    await fs.access(resolved);
  } catch {
    return c.json({ error: 'Path not found', code: 'NOT_FOUND' }, 404);
  }

  try {
    await revealInFileManager(resolved);
  } catch (err) {
    logger.error('[files] POST /reveal failed', { err, resolved });
    return c.json({ error: "Couldn't open the file manager", code: 'REVEAL_UNAVAILABLE' }, 500);
  }

  return c.body(null, 204);
});

export default router;
