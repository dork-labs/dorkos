/**
 * Where the load gate's shared queue lives, and the checks that folder must
 * pass before anything is written to it (DOR-4209).
 *
 * @module services/core/load-gate/queue-folder
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PRIVATE_FOLDER = 0o700;
const GROUP_OR_OTHER_BITS = 0o077;

/**
 * The shared folder: `/tmp/dorkos-load-gate-<uid>` wherever there is a uid.
 *
 * A fixed `/tmp` rather than `os.tmpdir()`, which follows `TMPDIR`: macOS gives
 * each login its own, and two DorkOS processes started from different shells
 * would stand in two lines. `scripts/heavy-run-lock.sh` keeps its slots beside
 * it for the same reason. Windows has no uid; there the per-user temp folder is
 * the one place every process of that user agrees on.
 */
export function defaultLoadGateDir(): string {
  const uid = process.getuid?.();
  if (uid === undefined) return path.join(os.tmpdir(), 'dorkos-load-gate');
  return `/tmp/dorkos-load-gate-${uid}`;
}

/** What {@link prepareDir} compares the folder against. */
export interface DirChecks {
  /**
   * The uid the folder must belong to; defaults to this process's.
   *
   * @internal Replaced in tests to stand for a folder another user made.
   */
  uid?: number;
}

/**
 * Make the folder, and refuse one that is a link or another user's. `/tmp` is
 * shared, so someone else could make the name first; a folder this user owns
 * with loose permissions is tightened to `0700`.
 *
 * @param dir - The folder.
 * @param checks - What it must match.
 */
export function prepareDir(dir: string, checks: DirChecks = {}): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_FOLDER });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`The load gate's folder ${dir} is not a plain folder.`);
  }
  const uid = checks.uid ?? process.getuid?.();
  if (uid === undefined) return;
  if (stat.uid !== uid) throw new Error(`The load gate's folder ${dir} belongs to another user.`);
  if ((stat.mode & GROUP_OR_OTHER_BITS) !== 0) fs.chmodSync(dir, PRIVATE_FOLDER);
}
