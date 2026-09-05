/**
 * The claim file that says which process owns a DorkOS data directory.
 *
 * A data directory is not shareable: two servers pointed at one `dorkHome` open
 * the same SQLite file and race each other's writes. `apps/server` enforces that
 * by claiming `instance.lock` at boot (DOR-532) — but it is not the only program
 * that has to know what the file means. The desktop shell deletes the whole data
 * directory for "Reset All Data" (DOR-542), and a delete is only safe while
 * nothing else is holding it, so it has to be able to READ the same claim the
 * server WRITES.
 *
 * That is all this module is: the file's name, its shape, and the two questions
 * anyone outside the server needs answered — who holds it, and are they still
 * there. Claiming and releasing stay in `apps/server/src/lib/instance-lock.ts`,
 * because only the process that opens the directory may take it.
 *
 * @module instance-lock
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_PID_REUSE_TOLERANCE_MS,
  assessProcessLiveness,
  isProcessAlive,
  type ProcessLivenessState,
} from './process-liveness.js';

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

/**
 * Absolute path of the lock file for a data directory.
 *
 * @param dorkHome - The data directory.
 */
export function instanceLockPath(dorkHome: string): string {
  return path.join(dorkHome, INSTANCE_LOCK_FILENAME);
}

/**
 * Read and validate the claim on a data directory.
 *
 * Every unreadable state — no file, a truncated write, a hand-mangled value of
 * the wrong type — reads as "no claim". Refusing to act over a file nobody can
 * make sense of would wedge both callers permanently: the server would never
 * boot again, and the desktop's reset would never run again.
 *
 * @param dorkHome - The data directory to read the claim from.
 * @returns The claim, or `null` when there is none to be had.
 */
export function readInstanceLock(dorkHome: string): InstanceLockInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync(instanceLockPath(dorkHome), 'utf8');
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
 * Decide whether the process named in a claim is genuinely still holding it.
 *
 * Pid existence alone is not enough. After a SIGKILL (an out-of-memory kill, a
 * forced logout) the lock file survives naming a dead pid, and operating systems
 * wrap pids around onto unrelated processes. A pid-only check would then refuse
 * every future start forever, while telling the operator to kill a process that
 * has nothing to do with DorkOS. So the holder is corroborated via
 * `./process-liveness`: it must have STARTED no later than the moment it wrote
 * the lock. A recycled pid belongs to a process that started afterwards, and is
 * reported `gone` so the claim can simply be taken over.
 *
 * A claim naming the CALLING process is `gone` too — a lock file naming us is
 * one we are about to replace, not a rival. That is what the server's own
 * re-claim relies on; for a reader in another process it never fires, because
 * the holder is by definition somebody else.
 *
 * @param holder - The claim read by {@link readInstanceLock}.
 */
export function assessInstanceLockHolder(holder: InstanceLockInfo): ProcessLivenessState {
  if (holder.pid === process.pid) return 'gone';

  const lockWrittenAt = Date.parse(holder.startedAt);
  if (Number.isNaN(lockWrittenAt)) {
    // Can't corroborate a start time against an unparseable one, but a dead
    // pid is still dead regardless — recorded as such rather than as merely
    // unconfirmed.
    return isProcessAlive(holder.pid) ? 'live-unconfirmed' : 'gone';
  }

  return assessProcessLiveness(holder.pid, new Date(lockWrittenAt), DEFAULT_PID_REUSE_TOLERANCE_MS);
}

/**
 * The instance still holding a data directory right now, or `null` when it is
 * free.
 *
 * The whole question in one call, for callers that only want to know whether it
 * is safe to touch the directory — the desktop's "Reset All Data", which deletes
 * it outright. The server does not use this: it needs the difference between
 * `live-confirmed` and `live-unconfirmed` to decide whether printing
 * `kill <pid>` is safe advice.
 *
 * @param dorkHome - The data directory to ask about.
 */
export function liveInstanceLockHolder(dorkHome: string): InstanceLockInfo | null {
  const holder = readInstanceLock(dorkHome);
  if (!holder) return null;
  return assessInstanceLockHolder(holder) === 'gone' ? null : holder;
}
