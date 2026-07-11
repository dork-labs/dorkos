/**
 * Resolve the text diff base for a file — the shared logic behind
 * `GET /api/diff/baseline` and the in-process transport (DOR-212 §Q1).
 *
 * The resolution ladder (session mode): stored pre-edit snapshot (which itself
 * may be a pre-tool capture or a reconstructed pre-image) → git `HEAD` → empty.
 * `head` mode forces the git-HEAD compare (the secondary user-toggled base). The
 * current disk content is always the file's live bytes; both sides are hashed so
 * the caller gets an optimistic-concurrency token for a later reject write.
 *
 * @module services/diff/resolve-baseline
 */
import fs from 'node:fs/promises';
import type { DiffBaselineResponse, DiffBaselineOrigin } from '@dorkos/shared/types';
import { FILE_LIMITS } from '../../config/constants.js';
import { sha256 } from '../../lib/file-route-guards.js';
import { editBaselineStore } from './edit-baseline.js';
import { gitShowHead } from './git-baseline.js';

/** A coded reason the text diff can't be produced, mapped to an HTTP status by the route. */
export type ResolveBaselineError = 'TOO_LARGE' | 'BINARY_FILE' | 'NOT_A_FILE';

/** Outcome of {@link resolveTextBaseline} — the DTO, or a coded failure. */
export type ResolveBaselineResult =
  | { ok: true; response: DiffBaselineResponse }
  | { ok: false; error: ResolveBaselineError };

/**
 * Read the file's current on-disk text, or a coded failure. A missing file
 * (deleted by the agent) resolves to empty text so the diff shows a full
 * removal; a directory, oversize, or binary target is rejected (the text diff
 * isn't for those).
 */
async function readCurrentText(
  absPath: string
): Promise<{ ok: true; text: string } | { ok: false; error: ResolveBaselineError }> {
  let buffer: Buffer;
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) return { ok: false, error: 'NOT_A_FILE' };
    if (stat.size > FILE_LIMITS.MAX_TEXT_FILE_BYTES) return { ok: false, error: 'TOO_LARGE' };
    buffer = await fs.readFile(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, text: '' };
    throw err;
  }
  if (buffer.includes(0)) return { ok: false, error: 'BINARY_FILE' };
  return { ok: true, text: buffer.toString('utf8') };
}

/** Resolve the baseline text + its origin for `session` mode (snapshot → HEAD → empty). */
async function resolveSessionBaseline(
  cwd: string,
  absPath: string,
  sessionId: string
): Promise<{ text: string; origin: DiffBaselineOrigin }> {
  const snapshot = editBaselineStore.get(sessionId, absPath);
  // An `oversize` marker means the pre-image was deliberately not buffered —
  // fall through to HEAD/empty (whose origin the client discloses) rather than
  // present the marker's empty bytes as a real session base.
  if (snapshot && !snapshot.oversize) {
    return { text: snapshot.bytes.toString('utf8'), origin: snapshot.capturedFrom };
  }
  const head = await gitShowHead(cwd, absPath);
  if (head !== null) return { text: head.toString('utf8'), origin: 'head' };
  return { text: '', origin: 'empty' };
}

/** Resolve the baseline text + its origin for `head` mode (git HEAD → empty). */
async function resolveHeadBaseline(
  cwd: string,
  absPath: string
): Promise<{ text: string; origin: DiffBaselineOrigin }> {
  const head = await gitShowHead(cwd, absPath);
  if (head !== null) return { text: head.toString('utf8'), origin: 'head' };
  return { text: '', origin: 'empty' };
}

/**
 * Resolve the full text-diff DTO for a file: the baseline (per the ladder) and
 * the current disk content, each hashed.
 *
 * @param cwd - The (already boundary-validated) session working directory.
 * @param absPath - Absolute path to the file, confined within `cwd`.
 * @param sessionId - Session whose pre-edit snapshot to diff against.
 * @param mode - `'session'` (snapshot ladder) or `'head'` (git-HEAD compare).
 */
export async function resolveTextBaseline(
  cwd: string,
  absPath: string,
  sessionId: string,
  mode: 'session' | 'head'
): Promise<ResolveBaselineResult> {
  const current = await readCurrentText(absPath);
  if (!current.ok) return current;

  const { text: baseline, origin } =
    mode === 'head'
      ? await resolveHeadBaseline(cwd, absPath)
      : await resolveSessionBaseline(cwd, absPath, sessionId);

  return {
    ok: true,
    response: {
      baseline,
      baselineHash: sha256(baseline),
      current: current.text,
      currentHash: sha256(current.text),
      capturedFrom: origin,
    },
  };
}
