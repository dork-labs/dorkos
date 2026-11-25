/**
 * The diff review's one hand route (DOR-212): a file's BASELINE bytes, for the
 * image diff's "before" layer. It answers raw bytes, which a capability cannot
 * (`http/hand-routes/allowlist.ts`). The text diff base, the pending list,
 * marking reviewed and the whole-file revert are capabilities the mount serves
 * (`services/diff/diff-capabilities.ts`).
 *
 * The route names a session, and an agent caller gets 404 for one it may not
 * read (spec `audit-trail` §3.4), the same answer as the session routes.
 *
 * @module routes/diff
 */
import { Hono } from 'hono';
import path from 'node:path';
import { DiffBaselineRawQuerySchema } from '@dorkos/shared/schemas';
import {
  MEDIA_CONTENT_TYPES,
  resolveWithinCwd,
  servesInlineHere,
} from '../lib/file-route-guards.js';
import { pathRefusalProblem } from '../http/problems/boundary-refusal.js';
import { resolveBaselineBytes } from '../services/diff/index.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, validationProblem } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { canReadSession, sessionNotFoundProblem } from './audit-reader.js';

const router = new Hono<ApiEnv>();

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
    return validationProblem(c, parsed.error);
  }
  const { cwd, path: relPath, sessionId } = parsed.data;
  if (!canReadSession(honoRequestFacts(c), sessionId)) return sessionNotFoundProblem(c);

  let validatedCwd: string;
  let resolved: string;
  try {
    ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    const pathRefusal = pathRefusalProblem(c, err);
    if (pathRefusal) return pathRefusal;
    logger.error('[diff] GET /baseline/raw boundary failed', { err, cwd, path: relPath });
    return problem(c, 'internal_error');
  }

  const contentType = MEDIA_CONTENT_TYPES[path.extname(resolved).toLowerCase()];
  if (!contentType) {
    return problem(c, 'unsupported_media_type', {
      detail: 'Only image, PDF and 3D-model baselines can be served.',
    });
  }

  try {
    const baseline = await resolveBaselineBytes(validatedCwd, resolved, sessionId);
    if (baseline === null || baseline.bytes.byteLength === 0) {
      // No snapshot and no HEAD content (or an empty pre-image = the file did
      // not exist before this session) — there is no "before" to show.
      return problem(c, 'not_found', { detail: 'This file has no earlier version to show.' });
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
    return problem(c, 'internal_error');
  }
});

export default router;
