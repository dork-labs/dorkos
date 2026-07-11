/**
 * Diff-review routes (DOR-212) — the text diff base, baseline advance, the
 * pending-edits list, the baseline image bytes, and the whole-file revert
 * behind the per-hunk review surface.
 *
 * Every handler is thin and boundary-safe: it resolves the caller-supplied path
 * through {@link resolveWithinCwd} (the same guard `routes/files.ts` uses, which
 * closes the symlinked-parent hole), then delegates to the `services/diff`
 * domain. Per-hunk text reverts are NOT here — the client reuses
 * `PUT /api/files/content` (optimistic-concurrency, atomic, existing-file-only).
 * The one write this router owns is `POST /revert`, the binary-safe whole-file
 * restore for the image diff, whose bytes are server-held (never
 * client-supplied).
 *
 * @module routes/diff
 */
import { Router } from 'express';
import path from 'node:path';
import { z } from 'zod';
import {
  DiffBaselineQuerySchema,
  AdvanceDiffBaselineRequestSchema,
  DiffPendingQuerySchema,
  DiffBaselineRawQuerySchema,
  RevertDiffBaselineRequestSchema,
} from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { MEDIA_CONTENT_TYPES, resolveWithinCwd, sendPathError } from '../lib/file-route-guards.js';
import {
  editBaselineStore,
  resolveTextBaseline,
  resolveBaselineBytes,
  revertToBaseline,
} from '../services/diff/index.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * Resolve a file's text diff base + current content. Resolution ladder (session
 * mode): stored pre-edit snapshot (pre-tool capture or reconstructed pre-image)
 * → git `HEAD` → empty; `mode=head` forces the git-HEAD compare. Oversize files
 * are 413 and binary files 415 (the text diff isn't for those — the image path
 * uses the raw endpoints instead). The path is confined to `cwd`; a `..`/symlink
 * escape is rejected (403).
 */
router.get('/baseline', async (req, res) => {
  const parsed = DiffBaselineQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  const { cwd, path: relPath, sessionId, mode } = parsed.data;

  let validatedCwd: string;
  let resolved: string;
  try {
    ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    if (sendPathError(res, err)) return;
    logger.error('[diff] GET /baseline boundary failed', { err, cwd, path: relPath });
    return res.status(500).json({ error: 'Internal server error' });
  }

  try {
    const result = await resolveTextBaseline(validatedCwd, resolved, sessionId, mode);
    if (!result.ok) {
      if (result.error === 'TOO_LARGE') {
        return res.status(413).json({ error: 'File too large to diff here', code: 'TOO_LARGE' });
      }
      if (result.error === 'NOT_A_FILE') {
        return res.status(400).json({ error: 'Not a regular file', code: 'NOT_A_FILE' });
      }
      return res
        .status(415)
        .json({ error: 'Binary files cannot be diffed as text', code: 'BINARY_FILE' });
    }
    return res.json(result.response);
  } catch (err) {
    logger.error('[diff] GET /baseline resolve failed', { err, resolved });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Advance a file's baseline to its current disk content (finish-review), so
 * subsequent agent edits diff from the just-reviewed state. Idempotent and a
 * no-op when the session has no baseline for the path. The path is confined to
 * `cwd`; a `..`/symlink escape is rejected (403).
 */
router.post('/baseline/advance', async (req, res) => {
  const parsed = AdvanceDiffBaselineRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: z.flattenError(parsed.error) });
  }
  const { cwd, path: relPath, sessionId } = parsed.data;

  let resolved: string;
  try {
    ({ resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    if (sendPathError(res, err)) return;
    logger.error('[diff] POST /baseline/advance boundary failed', { err, cwd, path: relPath });
    return res.status(500).json({ error: 'Internal server error' });
  }

  try {
    await editBaselineStore.advance(sessionId, resolved);
    return res.json({ ok: true });
  } catch (err) {
    logger.error('[diff] POST /baseline/advance failed', { err, resolved });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * List the `cwd`-relative paths a session has unreviewed agent edits for (a live
 * baseline that still differs from disk). Powers explorer "agent touched this"
 * badges + a review count. Paths outside `cwd` (a defensive guard — baselines are
 * always captured with confined absolute paths) are dropped.
 */
router.get('/pending', async (req, res) => {
  const parsed = DiffPendingQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  const { cwd, sessionId } = parsed.data;

  let validatedCwd: string;
  try {
    validatedCwd = await validateBoundary(cwd);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    logger.error('[diff] GET /pending boundary failed', { err, cwd });
    return res.status(500).json({ error: 'Internal server error' });
  }

  try {
    const absPaths = await editBaselineStore.listPending(sessionId);
    const files = absPaths
      .map((abs) => path.relative(validatedCwd, abs))
      .filter((rel) => rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel))
      .map((rel) => rel.split(path.sep).join('/'));
    return res.json({ files });
  } catch (err) {
    logger.error('[diff] GET /pending failed', { err, cwd });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Stream a file's BASELINE image bytes — its pre-edit snapshot, or its git-HEAD
 * content when no snapshot exists — for the image-diff surface's "before" layer
 * (DOR-212 Chunk B). Current bytes come from `GET /api/files/raw`.
 *
 * Security posture mirrors `GET /api/files/raw` exactly: the path is resolved
 * against `cwd` and re-validated with `cwd` as the boundary (403 on `..`/symlink
 * escapes), only the extensions in the media allowlist are served (415
 * otherwise — never an arbitrary-file reader), `nosniff` + `inline` headers,
 * and SVGs get the script-neutering CSP sandbox. 404 when no baseline exists
 * (the viewer reads that as "this image is new").
 */
router.get('/baseline/raw', async (req, res) => {
  const parsed = DiffBaselineRawQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  const { cwd, path: relPath, sessionId } = parsed.data;

  let validatedCwd: string;
  let resolved: string;
  try {
    ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    if (sendPathError(res, err)) return;
    logger.error('[diff] GET /baseline/raw boundary failed', { err, cwd, path: relPath });
    return res.status(500).json({ error: 'Internal server error' });
  }

  const contentType = MEDIA_CONTENT_TYPES[path.extname(resolved).toLowerCase()];
  if (!contentType) {
    return res.status(415).json({
      error: 'Only image, PDF, and 3D-model baselines can be served',
      code: 'UNSUPPORTED_TYPE',
    });
  }

  try {
    const baseline = await resolveBaselineBytes(validatedCwd, resolved, sessionId);
    if (baseline === null || baseline.bytes.byteLength === 0) {
      // No snapshot and no HEAD content (or an empty pre-image = the file did
      // not exist before this session) — there is no "before" to show.
      return res.status(404).json({ error: 'No baseline for this file', code: 'NO_BASELINE' });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', baseline.bytes.byteLength);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    // Baselines can advance mid-session (mark reviewed) — never cache.
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    if (contentType === 'image/svg+xml') {
      // Neutralize scripts in a hostile SVG even if opened as a top-level document.
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; sandbox"
      );
    }
    return res.end(baseline.bytes);
  } catch (err) {
    logger.error('[diff] GET /baseline/raw failed', { err, resolved });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Restore a file's baseline bytes to disk, whole-file — the image diff's
 * "reject" (DOR-212 Chunk B). Binary-safe and server-held: the snapshot's own
 * bytes (git-HEAD fallback) are written atomically, so no bytes travel from the
 * client and the text-oriented `PUT /api/files/content` stays untouched. 404
 * (`NO_BASELINE`) when nothing is restorable — a file the agent created this
 * session has no previous version, and the revert never deletes files. The path
 * is confined to `cwd`; a `..`/symlink escape is rejected (403).
 */
router.post('/revert', async (req, res) => {
  const parsed = RevertDiffBaselineRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: z.flattenError(parsed.error) });
  }
  const { cwd, path: relPath, sessionId } = parsed.data;

  let validatedCwd: string;
  let resolved: string;
  try {
    ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    if (sendPathError(res, err)) return;
    logger.error('[diff] POST /revert boundary failed', { err, cwd, path: relPath });
    return res.status(500).json({ error: 'Internal server error' });
  }

  try {
    const outcome = await revertToBaseline(validatedCwd, resolved, sessionId);
    if (outcome === 'no-baseline') {
      return res
        .status(404)
        .json({ error: 'No baseline to restore for this file', code: 'NO_BASELINE' });
    }
    return res.json({ ok: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      return res.status(403).json({ error: 'Permission denied', code: 'EACCES' });
    }
    logger.error('[diff] POST /revert failed', { err, resolved });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
