import { Hono } from 'hono';
import { z } from 'zod';
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
} from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';

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
import fileEntryRoutes from './file-entries.js';
import { InstallationFileWrites } from '../services/canvas/doc-channel/writes/installation-file-writes.js';
import { CanonicalFileIdentityChangedError } from '../services/canvas/doc-channel/writes/canonical-writer.js';

/** Build confined file routes using the owning installation writer. */
export function createFileRoutes(writes = new InstallationFileWrites()): Hono<ApiEnv> {
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
      return c.json(
        { error: 'Requested range not satisfiable', code: 'RANGE_NOT_SATISFIABLE' },
        416
      );
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
    try {
      const result = await writes.save(parsed.data);
      return c.json(result.body, result.status);
    } catch (err) {
      const refusal = pathErrorReply(err);
      if (refusal) return c.json(refusal.body, refusal.status);
      if (err instanceof CanonicalFileIdentityChangedError)
        return c.json(
          {
            error: 'File changed while waiting to save. Reload it before saving again.',
            code: 'FILE_IDENTITY_CHANGED',
          },
          412
        );
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return c.json({ error: 'File not found', code: 'NOT_FOUND' }, 404);
      if (code === 'NOT_A_FILE') return c.json({ error: 'Not a regular file', code }, 400);
      if (code === 'ELOOP' || code === 'ENOTDIR')
        return c.json({ error: 'Invalid path', code }, 400);
      if (code === 'EACCES') return c.json({ error: 'Permission denied', code }, 403);
      logger.error('[files] PUT /content write failed', { err });
      return c.json({ error: 'Internal server error' }, 500);
    }
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

  // Create, delete, rename, copy and reveal: the routes that change the tree.
  router.route('/', fileEntryRoutes);

  return router;
}

export default createFileRoutes();
