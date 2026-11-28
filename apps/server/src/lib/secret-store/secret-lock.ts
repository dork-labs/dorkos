/**
 * A cross-process lock beside one secret file, for a read-decide-write that
 * must not interleave: two servers, or a server and a `dorkos auth` command,
 * each check and maybe replace the same file, and must end on one value.
 *
 * The lock is a file created exclusively (`wx`) next to the secret. A holder
 * that died leaves it behind; one older than {@link STALE_AFTER_MS} is taken
 * over. Synchronous, like the boot path that uses it.
 *
 * @module lib/secret-store/secret-lock
 */
import fs from 'node:fs';
import path from 'node:path';

/** A lock untouched this long belongs to a process that died holding it. */
const STALE_AFTER_MS = 30_000;
/** How long to wait for another holder before giving up. */
const WAIT_MS = 10_000;
/** How long to sleep between tries. */
const RETRY_MS = 25;

/** Sleep without yielding: the callers are synchronous by design. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding the lock for `secretPath`.
 *
 * @param secretPath - The secret file the lock guards; the lock is `<secretPath>.lock`.
 * @param fn - The read-decide-write to run alone.
 * @returns What `fn` returns.
 * @throws If the lock can't be made, or another process holds it for longer
 *   than ten seconds. The message names the lock's path, never the secret.
 */
export function withSecretFileLock<T>(secretPath: string, fn: () => T): T {
  const lockPath = `${secretPath}.lock`;
  // A first boot's data folder may not exist yet.
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  const deadline = Date.now() + WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST')
        throw new Error(
          `DorkOS could not lock ${lockPath} (${code ?? 'open failed'}). Check that the folder is writable, then start DorkOS again.`,
          { cause: err }
        );
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_AFTER_MS)
          fs.rmSync(lockPath, { force: true });
      } catch {
        // Released between the open and the stat: try again.
      }
      if (Date.now() > deadline)
        throw new Error(
          `Another DorkOS process is holding ${lockPath}. Wait for it to finish, or remove the file if none is running.`,
          { cause: err }
        );
      pause(RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}
