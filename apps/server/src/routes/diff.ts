/**
 * Diff-review routes (DOR-212) — the text diff base, baseline advance, and the
 * pending-edits list behind the per-hunk review surface.
 *
 * Every handler is thin and boundary-safe: it resolves the caller-supplied path
 * through {@link resolveWithinCwd} (the same guard `routes/files.ts` uses, which
 * closes the symlinked-parent hole), then delegates to the `services/diff`
 * domain. Reverting a hunk is NOT here — the client reuses `PUT /api/files/content`
 * (optimistic-concurrency, atomic, existing-file-only), so the diff surface never
 * invents a write path. The image byte endpoint (`GET /baseline/raw`) is Chunk B.
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
} from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { resolveWithinCwd, sendPathError } from '../lib/file-route-guards.js';
import { editBaselineStore, resolveTextBaseline } from '../services/diff/index.js';
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

export default router;
