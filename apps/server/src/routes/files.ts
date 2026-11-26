import { Hono } from 'hono';
import fs, { type FileHandle } from 'fs/promises';
import { Readable } from 'node:stream';
import path from 'path';
import { fileLister } from '../services/core/file-lister.js';
import {
  FileListQuerySchema,
  FileTreeQuerySchema,
  RawFileQuerySchema,
} from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import {
  MEDIA_CONTENT_TYPES,
  resolveWithinCwd,
  parseByteRange,
  servesInlineHere,
} from '../lib/file-route-guards.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, validationProblem } from '@dorkos/http-kit';
import { boundaryProblem } from '../http/problems/boundary-refusal.js';
import {
  FILE_MISSING,
  FOLDER_NOT_FILE,
  PATH_UNFOLLOWABLE,
  pathCheckFailure,
} from './file-problems.js';
import { readQuery } from '../http/request-query.js';
import fileEntryRoutes from './file-entries.js';

/** A file the server could not read for a reason that is not the caller's. */
const FILE_UNREADABLE = 'Couldn’t read that file. Try again.';

/** A path that names a file where a folder was needed. */
const FILE_NOT_FOLDER = 'That path is a file, not a folder.';

/**
 * Build the file routes that stay by hand: the media bytes (`GET /raw`), which a
 * capability cannot answer, and the two lists (`GET /`, `GET /tree`) and the copy,
 * until they page and name a resource (the API lint's rules). Reading a text file
 * and the other changes are capabilities the mount serves
 * (`services/core/directory/file-capabilities.ts`, DOR-4978).
 */
export function createFileRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  /**
   * Stream a local media file (image, PDF, 3D model, audio, or video), confined to
   * the session's working directory. Backs the media canvas variants when the agent
   * points them at a local file path (vs. an https URL or data: URI, which the
   * client loads directly).
   *
   * Safety mirrors the file saves (`files.save`): the target is resolved against `cwd` and
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
      return validationProblem(c, parsed.error);
    }
    const { cwd, path: relPath } = parsed.data;

    let resolved: string;
    try {
      ({ resolved } = await resolveWithinCwd(cwd, relPath));
    } catch (err) {
      return pathCheckFailure(c, err, 'GET /raw', { cwd, path: relPath });
    }

    const contentType = MEDIA_CONTENT_TYPES[path.extname(resolved).toLowerCase()];
    if (!contentType) {
      return problem(c, 'unsupported_media_type', {
        detail: 'Only pictures, PDFs, 3D models, sound and video open here.',
      });
    }

    let size: number;
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        return problem(c, 'not_a_file', { detail: FOLDER_NOT_FILE });
      }
      size = stat.size;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return problem(c, 'not_found', { detail: FILE_MISSING });
      }
      if (code === 'ELOOP' || code === 'ENOTDIR') {
        return problem(c, 'invalid_request', { detail: PATH_UNFOLLOWABLE });
      }
      logger.error('[files] GET /raw stat failed', { err, resolved });
      return problem(c, 'internal_error', { detail: FILE_UNREADABLE });
    }

    // Resolve the requested byte range (if any) before writing media headers, so an
    // unsatisfiable range answers as a problem without a media Content-Type getting
    // stuck to the 416.
    const range = parseByteRange(c.req.header('range'), size);
    if (range.kind === 'unsatisfiable') {
      c.header('Content-Range', `bytes */${size}`);
      return problem(c, 'range_not_satisfiable', {
        detail: 'That part of the file doesn’t exist.',
      });
    }

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': servesInlineHere(contentType) ? 'inline' : 'attachment',
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

    // Opened before answering, so a file gone since the stat is a problem 500
    // rather than media headers with nothing behind them.
    let file: FileHandle;
    try {
      file = await fs.open(resolved, 'r');
    } catch (err) {
      logger.error('[files] GET /raw open failed', { err, resolved });
      return problem(c, 'internal_error', { detail: FILE_UNREADABLE });
    }
    const stream = file.createReadStream(streamOptions);
    stream.on('error', (err) => logger.error('[files] GET /raw stream failed', { err, resolved }));
    return c.body(Readable.toWeb(stream) as ReadableStream<Uint8Array>, status, headers);
  });

  router.get('/', async (c) => {
    const parsed = FileListQuerySchema.safeParse(readQuery(c));
    if (!parsed.success) {
      return validationProblem(c, parsed.error);
    }
    try {
      const validatedCwd = await validateBoundary(parsed.data.cwd);
      const result = await fileLister.listFiles(validatedCwd);
      return c.json(result);
    } catch (err) {
      if (err instanceof BoundaryError) return boundaryProblem(c, err);
      logger.error('[files] GET / failed', { err, cwd: parsed.data.cwd });
      return problem(c, 'internal_error', { detail: 'Couldn’t list the files here. Try again.' });
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
      return validationProblem(c, parsed.error);
    }
    const { cwd, path: relPath, depth, showHidden } = parsed.data;

    let validatedCwd: string;
    let resolved: string;
    try {
      ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath ?? '.'));
    } catch (err) {
      return pathCheckFailure(c, err, 'GET /tree', { cwd, path: relPath });
    }

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        return problem(c, 'not_a_folder', { detail: FILE_NOT_FOLDER });
      }
      const entries = await fileLister.listTree(resolved, validatedCwd, depth, showHidden);
      return c.json({ entries });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return problem(c, 'not_found', { detail: 'That folder doesn’t exist.' });
      }
      if (code === 'ENOTDIR') {
        return problem(c, 'not_a_folder', { detail: FILE_NOT_FOLDER });
      }
      logger.error('[files] GET /tree failed', { err, resolved });
      return problem(c, 'internal_error', { detail: 'Couldn’t list that folder. Try again.' });
    }
  });

  // Copying stays by hand until its path names a resource (`routes/file-entries.ts`).
  router.route('/', fileEntryRoutes);

  return router;
}

export default createFileRoutes();
