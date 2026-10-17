/**
 * Diff-review routes (DOR-212) — the text diff base, baseline advance, the
 * pending-edits list, the baseline image bytes, and the whole-file revert
 * behind the per-hunk review surface.
 *
 * Every handler is thin and boundary-safe: it resolves the caller-supplied path
 * through {@link resolveWithinCwd} (the same guard `routes/files.ts` uses, which
 * closes the symlinked-parent hole), then delegates to the `services/diff`
 * domain. Every route names a session, and an agent caller gets 404 for one it
 * may not read (spec `audit-trail` §3.4), the same answer as the session routes:
 * a person's own chat's edits are theirs. Per-hunk text reverts are NOT here — the client reuses
 * `PUT /api/files/content` (optimistic-concurrency, atomic, existing-file-only).
 * The one write this router owns is `POST /revert`, the binary-safe whole-file
 * restore for the image diff, whose bytes are server-held (never
 * client-supplied).
 *
 * @module routes/diff
 */
import { Hono } from 'hono';
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
import {
  MEDIA_CONTENT_TYPES,
  resolveWithinCwd,
  pathErrorReply,
  servesInlineHere,
} from '../lib/file-route-guards.js';
import {
  editBaselineStore,
  resolveTextBaseline,
  resolveBaselineBytes,
  revertToBaseline,
} from '../services/diff/index.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { canReadSession, SESSION_NOT_FOUND_BODY } from './audit-reader.js';

const router = new Hono<ApiEnv>();

/**
 * Resolve a file's text diff base + current content. Resolution ladder (session
 * mode): stored pre-edit snapshot (pre-tool capture or reconstructed pre-image)
 * → git `HEAD` → empty; `mode=head` forces the git-HEAD compare. Oversize files
 * are 413 and binary files 415 (the text diff isn't for those — the image path
 * uses the raw endpoints instead). The path is confined to `cwd`; a `..`/symlink
 * escape is rejected (403).
 */
router.get('/baseline', async (c) => {
  const parsed = DiffBaselineQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
  }
  const { cwd, path: relPath, sessionId, mode } = parsed.data;
  if (!canReadSession(honoRequestFacts(c), sessionId)) return c.json(SESSION_NOT_FOUND_BODY, 404);

  let validatedCwd: string;
  let resolved: string;
  try {
    ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[diff] GET /baseline boundary failed', { err, cwd, path: relPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  try {
    const result = await resolveTextBaseline(validatedCwd, resolved, sessionId, mode);
    if (!result.ok) {
      if (result.error === 'TOO_LARGE') {
        return c.json({ error: 'File too large to diff here', code: 'TOO_LARGE' }, 413);
      }
      if (result.error === 'NOT_A_FILE') {
        return c.json({ error: 'Not a regular file', code: 'NOT_A_FILE' }, 400);
      }
      return c.json({ error: 'Binary files cannot be diffed as text', code: 'BINARY_FILE' }, 415);
    }
    return c.json(result.response);
  } catch (err) {
    logger.error('[diff] GET /baseline resolve failed', { err, resolved });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * Advance a file's baseline to its current disk content (finish-review), so
 * subsequent agent edits diff from the just-reviewed state. Idempotent and a
 * no-op when the session has no baseline for the path. The path is confined to
 * `cwd`; a `..`/symlink escape is rejected (403).
 */
router.post('/baseline/advance', async (c) => {
  const parsed = AdvanceDiffBaselineRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: z.flattenError(parsed.error) }, 400);
  }
  const { cwd, path: relPath, sessionId } = parsed.data;
  if (!canReadSession(honoRequestFacts(c), sessionId)) return c.json(SESSION_NOT_FOUND_BODY, 404);

  let resolved: string;
  try {
    ({ resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[diff] POST /baseline/advance boundary failed', { err, cwd, path: relPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  try {
    await editBaselineStore.advance(sessionId, resolved);
    return c.json({ ok: true });
  } catch (err) {
    logger.error('[diff] POST /baseline/advance failed', { err, resolved });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * List the `cwd`-relative paths a session has unreviewed agent edits for (a live
 * baseline that still differs from disk). Powers explorer "agent touched this"
 * badges + a review count. Paths outside `cwd` (a defensive guard — baselines are
 * always captured with confined absolute paths) are dropped.
 */
router.get('/pending', async (c) => {
  const parsed = DiffPendingQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
  }
  const { cwd, sessionId } = parsed.data;
  if (!canReadSession(honoRequestFacts(c), sessionId)) return c.json(SESSION_NOT_FOUND_BODY, 404);

  let validatedCwd: string;
  try {
    validatedCwd = await validateBoundary(cwd);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return c.json({ error: err.message, code: err.code }, 403);
    }
    logger.error('[diff] GET /pending boundary failed', { err, cwd });
    return c.json({ error: 'Internal server error' }, 500);
  }

  try {
    const absPaths = await editBaselineStore.listPending(sessionId);
    const files = absPaths
      .map((abs) => path.relative(validatedCwd, abs))
      .filter((rel) => rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel))
      .map((rel) => rel.split(path.sep).join('/'));
    return c.json({ files });
  } catch (err) {
    logger.error('[diff] GET /pending failed', { err, cwd });
    return c.json({ error: 'Internal server error' }, 500);
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
router.get('/baseline/raw', async (c) => {
  const parsed = DiffBaselineRawQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
  }
  const { cwd, path: relPath, sessionId } = parsed.data;
  if (!canReadSession(honoRequestFacts(c), sessionId)) return c.json(SESSION_NOT_FOUND_BODY, 404);

  let validatedCwd: string;
  let resolved: string;
  try {
    ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[diff] GET /baseline/raw boundary failed', { err, cwd, path: relPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  const contentType = MEDIA_CONTENT_TYPES[path.extname(resolved).toLowerCase()];
  if (!contentType) {
    return c.json(
      {
        error: 'Only image, PDF, and 3D-model baselines can be served',
        code: 'UNSUPPORTED_TYPE',
      },
      415
    );
  }

  try {
    const baseline = await resolveBaselineBytes(validatedCwd, resolved, sessionId);
    if (baseline === null || baseline.bytes.byteLength === 0) {
      // No snapshot and no HEAD content (or an empty pre-image = the file did
      // not exist before this session) — there is no "before" to show.
      return c.json({ error: 'No baseline for this file', code: 'NO_BASELINE' }, 404);
    }

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(baseline.bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': servesInlineHere(contentType) ? 'inline' : 'attachment',
      // Baselines can advance mid-session (mark reviewed) — never cache.
      'Cache-Control': 'private, max-age=0, must-revalidate',
    };
    if (contentType === 'image/svg+xml') {
      // Neutralize scripts in a hostile SVG even if opened as a top-level document.
      headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    }
    return c.body(new Uint8Array(baseline.bytes), 200, headers);
  } catch (err) {
    logger.error('[diff] GET /baseline/raw failed', { err, resolved });
    return c.json({ error: 'Internal server error' }, 500);
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
 *
 * Deliberately NOT restricted to the media allowlist (unlike `GET
 * /baseline/raw`, whose allowlist exists so a READ route can never become an
 * arbitrary-file reader): whole-file restore is path-type-agnostic and safe for
 * any file, because the only bytes it can ever write are the file's OWN
 * baseline from the server-held snapshot/HEAD ladder — semantically identical
 * to the text surface's reject-all, with no client-supplied payload to abuse.
 * Restricting it would just fork revert semantics by extension for no security
 * gain.
 */
router.post('/revert', async (c) => {
  const parsed = RevertDiffBaselineRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: z.flattenError(parsed.error) }, 400);
  }
  const { cwd, path: relPath, sessionId } = parsed.data;
  if (!canReadSession(honoRequestFacts(c), sessionId)) return c.json(SESSION_NOT_FOUND_BODY, 404);

  let validatedCwd: string;
  let resolved: string;
  try {
    ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[diff] POST /revert boundary failed', { err, cwd, path: relPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  try {
    const outcome = await revertToBaseline(validatedCwd, resolved, sessionId);
    if (outcome === 'no-baseline') {
      return c.json({ error: 'No baseline to restore for this file', code: 'NO_BASELINE' }, 404);
    }
    return c.json({ ok: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      return c.json({ error: 'Permission denied', code: 'EACCES' }, 403);
    }
    logger.error('[diff] POST /revert failed', { err, resolved });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default router;
