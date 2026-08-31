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
import {
  assessProcessLiveness,
  isProcessAlive,
  type ProcessLivenessState,
} from '@dorkos/shared/process-liveness';
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
      /**
       * The instance already holding the data directory. Absent when the lock
       * file could not be read, so there is no pid or port to report.
       */
      holder?: InstanceLockInfo;
      /** An actionable operator-facing error naming the conflict and the fix. */
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
 * How much later than the lock's `startedAt` the holding process may appear to
 * have started before we call it a different process.
 *
 * A real holder starts, then writes its lock milliseconds later, so its start
 * time is always at or before `startedAt`. The window is generous on purpose,
 * because the two errors are not symmetric. Too tight and a LIVE holder reads as
 * gone, whereupon the next boot deletes its lock and two servers open the same
 * SQLite file — the exact corruption this module exists to prevent. Too loose
 * only means a recycled pid keeps the lock a little longer, and a recycled pid
 * is off by minutes or days, never seconds. Matches
 * `@dorkos/shared/process-liveness`'s own default — see that module for the
 * wall-clock-skew rationale, which is not specific to lock files.
 */
const PID_REUSE_TOLERANCE_MS = 120_000;

/** What we could establish about the process named in a lock file. */
type HolderState = ProcessLivenessState;

/**
 * Decide whether the process named in a lock file is genuinely still holding it.
 *
 * Pid existence alone is not enough. After a SIGKILL (an out-of-memory kill,
 * `pkill -9`, a forced logout) the lock file survives naming a dead pid, and
 * operating systems wrap pids around onto unrelated processes. A pid-only check
 * would then refuse every future start forever, while telling the operator to
 * kill a process that has nothing to do with DorkOS. So we corroborate via
 * `@dorkos/shared/process-liveness`: the holder must have STARTED no later
 * than the moment it wrote the lock. A recycled pid belongs to a process that
 * started afterwards, and is reported `gone` so the next boot simply takes the
 * lock over.
 *
 * @param holder - The claim read from the lock file.
 */
function assessHolder(holder: InstanceLockInfo): HolderState {
  // Our own pid never counts as a holder: a lock file naming this process is
  // one we are about to replace, not a rival. Checked ahead of the shared
  // corroboration, which knows nothing about "this process" as a concept.
  if (holder.pid === process.pid) return 'gone';

  const lockWrittenAt = Date.parse(holder.startedAt);
  if (Number.isNaN(lockWrittenAt)) {
    // Can't corroborate a start time against an unparseable one, but a dead
    // pid is still dead regardless — recorded as such rather than as merely
    // unconfirmed.
    return isProcessAlive(holder.pid) ? 'live-unconfirmed' : 'gone';
  }

  return assessProcessLiveness(holder.pid, new Date(lockWrittenAt), PID_REUSE_TOLERANCE_MS);
}

/**
 * Build the message printed when another instance already holds the directory.
 * Mirrors the `EADDRINUSE` message: name the conflict, then the command that
 * resolves it.
 *
 * The `kill` hint appears only when {@link assessHolder} confirmed the process
 * really is the one that wrote the lock. Unconfirmed, the pid may belong to
 * something else entirely, and `kill <pid>` would be an instruction to damage an
 * innocent process (`kill` is a Stop-Process alias in PowerShell, so this is not
 * only a POSIX concern).
 *
 * @param holder - The instance holding the lock.
 * @param dorkHome - The contested data directory.
 * @param state - How firmly the holder was identified.
 */
function conflictMessage(
  holder: InstanceLockInfo,
  dorkHome: string,
  state: Exclude<HolderState, 'gone'>
): string {
  const stopHint =
    state === 'live-confirmed'
      ? `Stop it first (\`kill ${holder.pid}\`), or start this one against a different `
      : `Stop that instance first — check that process ${holder.pid} really is DorkOS before ` +
        `you end it — or start this one against a different `;
  return (
    `Another DorkOS instance is already using this data directory (${dorkHome}).\n` +
    `It is running as process ${holder.pid} on port ${holder.port} (DorkOS ${holder.version}).\n` +
    stopHint +
    `directory (\`DORK_HOME=/path/to/other dorkos\`).\n` +
    `If you are certain that process is not DorkOS, set DORKOS_SKIP_INSTANCE_LOCK=true to override.`
  );
}

/**
 * Build the message for a lock file that keeps reappearing but never parses, so
 * there is no pid to name. Deliberately carries no `kill` command: inventing a
 * pid here is what produced `kill 0`, which signals the caller's entire process
 * group — in a shell, the shell itself.
 *
 * @param lockPath - The lock file that could not be read.
 * @param dorkHome - The contested data directory.
 */
function unreadableLockMessage(lockPath: string, dorkHome: string): string {
  return (
    `Something else is holding the DorkOS lock file for this data directory (${dorkHome}), ` +
    `and it cannot be read.\n` +
    `Make sure no other DorkOS is running, then delete ${lockPath} and start again. ` +
    `Or start this one against a different directory (\`DORK_HOME=/path/to/other dorkos\`).\n` +
    `DORKOS_SKIP_INSTANCE_LOCK=true skips this check entirely.`
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
    if (holder) {
      const state = assessHolder(holder);
      if (state !== 'gone') {
        return {
          acquired: false,
          holder,
          reason: conflictMessage(holder, input.dorkHome, state),
        };
      }
    }
    // Unreadable, or naming a process that is gone (including a recycled pid):
    // the claim is stale, so clear it and try again. If it will not clear (a
    // directory sits at the path, the filesystem is read-only, permissions say
    // no), there is nothing left to try — stop and report the contention rather
    // than letting a raw filesystem error abort the boot.
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      break;
    }
  }

  const holder = readLock(lockPath);
  if (holder) {
    const state = assessHolder(holder);
    return {
      acquired: false,
      holder,
      reason: conflictMessage(
        holder,
        input.dorkHome,
        state === 'gone' ? 'live-unconfirmed' : state
      ),
    };
  }
  // Contended by something that keeps recreating the file without a readable
  // claim. There is no pid to name, so the message names the file instead.
  return { acquired: false, reason: unreadableLockMessage(lockPath, input.dorkHome) };
}

/**
 * Remove this process's claim on a data directory.
 *
 * A claim naming any process other than this one is left alone. Liveness is
 * deliberately NOT checked: the only cost of leaving a dead process's file
 * behind is that the next start clears it, whereas deleting a file we do not own
 * could free the directory out from under an instance that is still running.
 *
 * @param dorkHome - The data directory whose lock should be released.
 */
export function releaseInstanceLock(dorkHome: string): void {
  const lockPath = path.join(dorkHome, INSTANCE_LOCK_FILENAME);
  const holder = readLock(lockPath);
  if (holder && holder.pid !== process.pid) return;
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // Shutdown must not fail over a lock file we could not delete. A leftover
    // file names a pid that is about to be gone, so the next start clears it.
  }
}
