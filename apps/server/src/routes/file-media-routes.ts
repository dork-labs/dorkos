import { Router } from 'express';
import { z } from 'zod';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { RawFileQuerySchema } from '@dorkos/shared/schemas';
import {
  MEDIA_CONTENT_TYPES,
  resolveWithinCwd,
  pathErrorReply,
  parseByteRange,
} from '../lib/file-route-guards.js';
import { logger } from '../lib/logger.js';

/** Register the original installFileMediaRoutes group on the owned router, in its original order. */
export function installFileMediaRoutes(router: Router): void {
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
  router.get('/raw', async (req, res) => {
    const parsed = RawFileQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
    }
    const { cwd, path: relPath } = parsed.data;

    let resolved: string;
    try {
      ({ resolved } = await resolveWithinCwd(cwd, relPath));
    } catch (err) {
      const refusal = pathErrorReply(err);
      if (refusal) {
        res.status(refusal.status).json(refusal.body);
        return;
      }
      logger.error('[files] GET /raw boundary failed', { err, cwd, path: relPath });
      return res.status(500).json({ error: 'Internal server error' });
    }

    const contentType = MEDIA_CONTENT_TYPES[path.extname(resolved).toLowerCase()];
    if (!contentType) {
      return res.status(415).json({
        error: 'Only image, PDF, 3D-model, audio, and video files can be served',
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

    // Resolve the requested byte range (if any) before writing media headers, so an
    // unsatisfiable range answers as JSON without a media Content-Type getting stuck
    // to the 416.
    const range = parseByteRange(req.headers.range, size);
    if (range.kind === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res
        .status(416)
        .json({ error: 'Requested range not satisfiable', code: 'RANGE_NOT_SATISFIABLE' });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    // Advertise Range support so browsers know they can seek audio/video.
    res.setHeader('Accept-Ranges', 'bytes');
    if (contentType === 'image/svg+xml') {
      // Neutralize scripts in a hostile SVG even if it's opened as a top-level
      // document (the "open full size" affordance navigates to this URL).
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; sandbox"
      );
    }

    // `end` is inclusive in both HTTP Content-Range and Node's createReadStream.
    const streamOptions =
      range.kind === 'range' ? { start: range.start, end: range.end } : undefined;
    if (range.kind === 'range') {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader('Content-Length', range.end - range.start + 1);
    } else {
      res.setHeader('Content-Length', size);
    }

    const stream = createReadStream(resolved, streamOptions);
    stream.on('error', (err) => {
      logger.error('[files] GET /raw stream failed', { err, resolved });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
      else res.destroy(err);
    });
    stream.pipe(res);
  });
}
