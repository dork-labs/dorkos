/**
 * Shared path-safety guards for the workbench file routes (`routes/files.ts`,
 * `routes/diff.ts`).
 *
 * Every route that resolves a caller-supplied path inside a session's working
 * directory MUST go through {@link resolveWithinCwd} — it double-validates
 * against the boundary and closes the symlinked-parent create-target hole that a
 * naive `path.resolve` leaves open. Extracted here (rather than duplicated per
 * route) so the diff routes reuse the exact guard the file routes were hardened
 * with — no path logic is reinvented per DOR-212's security requirement.
 *
 * @module lib/file-route-guards
 */
import type { Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateBoundary, BoundaryError } from './boundary.js';

/**
 * File extensions the raw media routes will stream, mapped to their content
 * type. Kept deliberately narrow (images, PDF, and 3D models) so a raw route can
 * never become a general-purpose file-download endpoint — anything else is 415.
 */
export const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  // 3D models for the workbench model viewer (glTF/GLB via <model-viewer>,
  // STL/OBJ via three.js loaders). `.obj` is plain-text geometry.
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.stl': 'model/stl',
  '.obj': 'model/obj',
};

/** SHA-256 hex of a UTF-8 string — the optimistic-concurrency fingerprint. */
export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Confine a target through its nearest EXISTING ancestor.
 *
 * `validateBoundary` follows symlinks only when the path itself exists; for a
 * not-yet-created target it falls back to `path.resolve` (no symlink follow), so
 * a symlinked parent directory (`cwd/link -> /outside`) would pass the string
 * containment check while the actual write lands outside `cwd`. This walks up to
 * the closest ancestor that exists on disk, `realpath`s it, and rejects if that
 * real location escapes `root` — closing the create/rename-target hole.
 *
 * @param target - Absolute target path (may not exist yet).
 * @param root - The already-`realpath`'d working-directory boundary.
 */
export async function assertAncestorWithin(target: string, root: string): Promise<void> {
  const canonicalRoot = await fs.realpath(root).catch(() => root);
  let ancestor = path.dirname(path.resolve(target));
  for (;;) {
    try {
      const real = await fs.realpath(ancestor);
      if (real !== canonicalRoot && !real.startsWith(canonicalRoot + path.sep)) {
        throw new BoundaryError(
          'Access denied: path outside directory boundary',
          'OUTSIDE_BOUNDARY'
        );
      }
      return;
    } catch (err) {
      if (err instanceof BoundaryError) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = path.dirname(ancestor);
        // Reached the filesystem root without an existing ancestor — the earlier
        // string containment check already vouched for the resolved path.
        if (parent === ancestor) return;
        ancestor = parent;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Resolve `relPath` within `cwd`, boundary-validated twice: first `cwd` against
 * the global boundary, then the target against `cwd` (which resolves symlinks),
 * so `..` or symlink escapes out of the working directory are rejected.
 *
 * When the target does not yet exist, its parent chain is additionally confined
 * via {@link assertAncestorWithin} so a symlinked parent can't smuggle a
 * create/rename write outside `cwd`.
 *
 * @param cwd - Session working directory.
 * @param relPath - Path to resolve, absolute or relative to `cwd`.
 * @returns The validated `cwd` and the resolved, confined target path.
 */
export async function resolveWithinCwd(
  cwd: string,
  relPath: string
): Promise<{ validatedCwd: string; resolved: string }> {
  const validatedCwd = await validateBoundary(cwd);
  const target = path.isAbsolute(relPath) ? relPath : path.join(validatedCwd, relPath);
  const resolved = await validateBoundary(target, validatedCwd);
  const exists = await fs
    .access(resolved)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await assertAncestorWithin(target, validatedCwd);
  }
  return { validatedCwd, resolved };
}

/**
 * Map a boundary/path-resolution error to an HTTP response. Returns `true` when
 * it handled the error (caller should stop); `false` for an unexpected error the
 * caller should treat as a 500.
 *
 * @param res - The Express response to write on a handled error.
 * @param err - The thrown error to classify.
 */
export function sendPathError(res: Response, err: unknown): boolean {
  if (err instanceof BoundaryError) {
    const status = err.code === 'NULL_BYTE' ? 400 : 403;
    res.status(status).json({ error: err.message, code: err.code });
    return true;
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENAMETOOLONG') {
    res.status(400).json({ error: 'Invalid path', code });
    return true;
  }
  return false;
}
