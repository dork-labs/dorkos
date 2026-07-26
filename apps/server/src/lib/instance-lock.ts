/**
 * Single-instance lock, scoped to one data directory.
 *
 * A DorkOS data directory is not shareable. Two servers pointed at the same
 * `dorkHome` open the same SQLite file, run two agent reconcilers over the same
 * `agents/` tree, and race each other's writes — which is exactly what happens
 * when the desktop app and a CLI server are both running, because each listens
 * on its own port and the existing `EADDRINUSE` check never fires.
 *
 * So the boundary is the data directory, not the port: one JSON file inside
 * `dorkHome` naming the process that holds it. Claiming it is atomic (`wx`, which
 * fails if the file already exists), and a file left behind by a process that is
 * no longer running is simply taken over — a crash never wedges the next start.
 *
 * The lock is inert under `NODE_ENV=test` and behind the
 * `DORKOS_SKIP_INSTANCE_LOCK` escape hatch, so nothing that boots servers in
 * bulk (unit tests, the eval harness) has to know it exists.
 *
 * @module lib/instance-lock
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { env } from '../env.js';

/** File name (under `dorkHome`) holding the current instance's claim. */
export const INSTANCE_LOCK_FILENAME = 'instance.lock';

/** Shape of the lock file. Parsed defensively: a hand-edited file must not crash boot. */
const InstanceLockSchema = z.object({
  /** OS process id of the server holding the data directory. */
  pid: z.number().int().positive(),
  /** Port that server is listening on, so the message can point at it. */
  port: z.number().int().min(1).max(65535),
  /** ISO timestamp of when it took the lock. */
  startedAt: z.string(),
  /** DorkOS version it is running, useful when two builds are installed. */
  version: z.string(),
});

/** The recorded identity of the server holding a data directory. */
export type InstanceLockInfo = z.infer<typeof InstanceLockSchema>;

/** Inputs to {@link acquireInstanceLock}. */
export interface AcquireInstanceLockInput {
  /** The resolved data directory this lock is scoped to. */
  dorkHome: string;
  /** Port this server is about to listen on. */
  port: number;
  /** This server's version string. */
  version: string;
}

/** Outcome of {@link acquireInstanceLock}. */
export type AcquireInstanceLockResult =
  | {
      acquired: true;
      /** Removes this process's claim. Safe to call more than once. */
      release: () => void;
    }
  | {
      acquired: false;
      /** The live instance already holding the data directory. */
      holder: InstanceLockInfo;
      /** An actionable operator-facing error naming that instance and the fix. */
      reason: string;
    };

/** No-op release handed back when the lock is switched off. */
const NO_RELEASE = (): void => {};

/**
 * Whether the single-instance lock runs in this process.
 *
 * Off under `NODE_ENV=test` (suites boot many servers against throwaway
 * directories) and off behind `DORKOS_SKIP_INSTANCE_LOCK`, the escape hatch for
 * anyone who knows better than the check.
 */
export function isInstanceLockEnabled(): boolean {
  if (env.NODE_ENV === 'test') return false;
  return !env.DORKOS_SKIP_INSTANCE_LOCK;
}

/**
 * Whether a process id belongs to a process that is running right now.
 *
 * Signal `0` performs the permission and existence checks without delivering
 * anything. `EPERM` means the process exists but belongs to another user, which
 * still counts as alive. Our own pid never counts: a lock file naming this
 * process is one we are about to replace, not a rival.
 *
 * @param pid - The process id recorded in the lock file.
 */
function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Build the message printed when another instance already holds the directory.
 * Mirrors the `EADDRINUSE` message: name the conflict, then the command that
 * resolves it.
 *
 * @param holder - The live instance holding the lock.
 * @param dorkHome - The contested data directory.
 */
function conflictMessage(holder: InstanceLockInfo, dorkHome: string): string {
  return (
    `Another DorkOS instance is already using this data directory (${dorkHome}).\n` +
    `It is running as process ${holder.pid} on port ${holder.port} (DorkOS ${holder.version}).\n` +
    `Stop it first (\`kill ${holder.pid}\`), or start this one against a different ` +
    `directory (\`DORK_HOME=/path/to/other dorkos\`).\n` +
    `If you are certain that process is not DorkOS, set DORKOS_SKIP_INSTANCE_LOCK=true to override.`
  );
}

/** Read and validate the lock file, or `null` when it is missing or unreadable. */
function readLock(lockPath: string): InstanceLockInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = InstanceLockSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // Truncated or hand-mangled JSON: treat it as no lock at all rather than
    // refusing to boot over a file nobody can act on.
    return null;
  }
}

/**
 * Claim the data directory for this process, or report who already has it.
 *
 * Call once at boot, before any service opens the database. On success the
 * returned `release` must run during graceful shutdown so the next start (and,
 * importantly, the restart the admin endpoint spawns) finds the directory free.
 *
 * @param input - The data directory, port, and version to record.
 */
export function acquireInstanceLock(input: AcquireInstanceLockInput): AcquireInstanceLockResult {
  if (!isInstanceLockEnabled()) return { acquired: true, release: NO_RELEASE };

  const lockPath = path.join(input.dorkHome, INSTANCE_LOCK_FILENAME);
  const info: InstanceLockInfo = {
    pid: process.pid,
    port: input.port,
    startedAt: new Date().toISOString(),
    version: input.version,
  };
  const payload = JSON.stringify(info, null, 2);

  fs.mkdirSync(input.dorkHome, { recursive: true });

  // Two passes at most: claim it, and if someone else's claim is stale, drop
  // theirs and claim it again. A second EEXIST means a real instance won the
  // race in between, and the re-read below reports it.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' fails when the file exists, which makes the claim atomic against
      // another server starting at the same moment.
      fs.writeFileSync(lockPath, payload, { flag: 'wx' });
      return { acquired: true, release: () => releaseInstanceLock(input.dorkHome) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const holder = readLock(lockPath);
    if (holder && isProcessAlive(holder.pid)) {
      return { acquired: false, holder, reason: conflictMessage(holder, input.dorkHome) };
    }
    // Unreadable, or naming a process that is gone: the claim is stale.
    fs.rmSync(lockPath, { force: true });
  }

  const holder = readLock(lockPath);
  if (holder) {
    return { acquired: false, holder, reason: conflictMessage(holder, input.dorkHome) };
  }
  // Contended by something that keeps recreating the file without a readable
  // claim. Refusing beats guessing, so report the contention as-is.
  const unknown: InstanceLockInfo = { pid: 0, port: input.port, startedAt: '', version: 'unknown' };
  return { acquired: false, holder: unknown, reason: conflictMessage(unknown, input.dorkHome) };
}

/**
 * Remove this process's claim on a data directory. A claim held by a different
 * live process is left alone, so a shutdown racing another instance's start can
 * never delete the winner's lock.
 *
 * @param dorkHome - The data directory whose lock should be released.
 */
export function releaseInstanceLock(dorkHome: string): void {
  const lockPath = path.join(dorkHome, INSTANCE_LOCK_FILENAME);
  const holder = readLock(lockPath);
  if (holder && holder.pid !== process.pid) return;
  fs.rmSync(lockPath, { force: true });
}
