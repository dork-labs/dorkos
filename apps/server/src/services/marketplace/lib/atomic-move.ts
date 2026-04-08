/**
 * Atomic move helper with a cross-device (`EXDEV`) fallback.
 *
 * Every marketplace install flow stages the incoming package under
 * `os.tmpdir()` and then moves the staged tree onto the live install
 * root inside `dorkHome`. On the happy path this is a single
 * `fs.rename`, which is atomic on the same filesystem and avoids the
 * torn-write hazard of a recursive copy.
 *
 * On POSIX — and frequently on Linux CI runners where `/tmp` is a
 * `tmpfs` mount distinct from the user's home partition — `rename`
 * throws with `errno === 'EXDEV'` when the source and destination live
 * on different devices. Windows surfaces the same cross-volume failure
 * via the same error code for moves between drive letters or volume
 * mount points. In that case we fall back to `cp(..., { recursive: true })`
 * followed by `rm(..., { recursive: true, force: true })` so the
 * observable result is indistinguishable from a successful rename.
 *
 * All other errors rethrow — we only catch the cross-device case. This
 * keeps EACCES, ENOENT, ENOTEMPTY, and friends bubbling up to the
 * transaction engine's rollback path where they belong.
 *
 * @module services/marketplace/lib/atomic-move
 */
import { cp, rename, rm } from 'node:fs/promises';

/**
 * Move `source` onto `dest` atomically, falling back to a recursive
 * copy + remove when the filesystem-level rename fails with `EXDEV`.
 *
 * The caller is responsible for ensuring `path.dirname(dest)` exists —
 * this helper does not create parent directories, to match the
 * semantics of raw `fs.rename`.
 *
 * @param source - Absolute path to the source directory or file.
 * @param dest - Absolute path to the destination. Must not already exist.
 * @throws If `rename` fails with any error other than `EXDEV`, or if
 *   the fallback copy/remove fails.
 */
export async function atomicMove(source: string, dest: string): Promise<void> {
  try {
    await rename(source, dest);
  } catch (err) {
    if (!isCrossDeviceError(err)) throw err;
    await cp(source, dest, { recursive: true, errorOnExist: true, force: false });
    await rm(source, { recursive: true, force: true });
  }
}

/**
 * Type guard for Node's `EXDEV` (cross-device link) error. Both POSIX
 * and Windows surface the same `code` value when `fs.rename` is asked
 * to move across filesystem boundaries.
 *
 * @internal Exported for testing only.
 */
export function isCrossDeviceError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'EXDEV'
  );
}
