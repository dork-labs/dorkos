/**
 * Binary baseline resolution + whole-file revert (DOR-212 Chunk B).
 *
 * The image-diff surface needs the baseline's raw BYTES (not text): the
 * "before" layer streams them, and rejecting an image restores them to disk.
 * Both ride the same ladder as the text base — session snapshot (skipping
 * `oversize` markers, whose bytes were deliberately never buffered) → git HEAD
 * → nothing — and the revert writes the server-held bytes itself, so no bytes
 * ever travel from the client and the text-oriented `PUT /api/files/content`
 * stays untouched.
 *
 * @module services/diff/baseline-bytes
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { DiffBaselineOrigin } from '@dorkos/shared/types';
import { editBaselineStore } from './edit-baseline.js';
import { gitShowHead } from './git-baseline.js';

/** A resolved binary baseline: the pre-edit bytes and how they were obtained. */
export interface BaselineBytes {
  bytes: Buffer;
  origin: Exclude<DiffBaselineOrigin, 'empty'>;
}

/**
 * Resolve a file's baseline BYTES for a session: the stored pre-edit snapshot
 * (skipping `oversize` markers), else the file's git-HEAD content, else `null`
 * (no baseline exists — e.g. a file the agent created this session in a
 * non-git cwd).
 *
 * @param cwd - The (already boundary-validated) session working directory.
 * @param absPath - Absolute path to the file, confined within `cwd`.
 * @param sessionId - Session whose pre-edit snapshot to resolve.
 */
export async function resolveBaselineBytes(
  cwd: string,
  absPath: string,
  sessionId: string
): Promise<BaselineBytes | null> {
  const snapshot = editBaselineStore.get(sessionId, absPath);
  if (snapshot && !snapshot.oversize) {
    return { bytes: snapshot.bytes, origin: snapshot.capturedFrom };
  }
  const head = await gitShowHead(cwd, absPath);
  if (head !== null) return { bytes: head, origin: 'head' };
  return null;
}

/**
 * Restore a file's baseline bytes to disk, whole-file (the image diff's
 * "reject"). Atomic (temp + rename), binary-safe, and non-destructive by
 * construction: it refuses (`'no-baseline'`) when no baseline exists OR the
 * baseline is empty — an empty pre-image means the file did not exist before
 * this session, and the revert never deletes files or writes empty blobs.
 * Content-independent and idempotent: the restored bytes are the same
 * regardless of what is on disk now (the caller confirm-gates the action).
 *
 * @param cwd - The (already boundary-validated) session working directory.
 * @param absPath - Absolute path to the file, confined within `cwd`.
 * @param sessionId - Session whose baseline to restore.
 * @returns `'ok'` when the bytes were written, `'no-baseline'` when there is
 *   nothing restorable.
 */
export async function revertToBaseline(
  cwd: string,
  absPath: string,
  sessionId: string
): Promise<'ok' | 'no-baseline'> {
  const baseline = await resolveBaselineBytes(cwd, absPath, sessionId);
  if (baseline === null || baseline.bytes.byteLength === 0) return 'no-baseline';

  const tmp = `${absPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, baseline.bytes);
    await fs.rename(tmp, absPath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return 'ok';
}
