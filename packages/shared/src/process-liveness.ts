/**
 * Recycled-pid-safe process liveness checks.
 *
 * A bare `process.kill(pid, 0)` answers "is *some* process running under this
 * pid", which is not the question either of this module's two callers
 * actually needs answered. Once the OS recycles a pid onto an unrelated
 * process (especially a root-owned one, which answers `EPERM` — alive, from
 * `process.kill`'s point of view — forever), a signal-0-only check reads
 * "still there" for good. Corroborating the pid against its process start
 * time (`ps -o lstart=`) is what tells a genuine holder apart from a stranger
 * wearing its old pid.
 *
 * Shared by the server's single-instance lock
 * (`apps/server/src/lib/instance-lock.ts`, DOR-532, which first solved this)
 * and the desktop app's dev orphan watchdog
 * (`apps/desktop/src/main/server-entry.ts`, DOR-552) — two processes with the
 * same "is the pid I remember still who I think it is" question and, before
 * this, two different answers to it.
 *
 * @module process-liveness
 */
import { execFileSync } from 'node:child_process';

/**
 * Ceiling on the `ps` call. It is synchronous and typically runs on a boot or
 * poll path, so a wedged or unusually slow `ps` must not hang the caller. A
 * throw lands on {@link processStartTime} returning `null`, which resolves to
 * `'live-unconfirmed'` in {@link assessProcessLiveness} — the safe direction,
 * since it never claims a process is gone that could still be alive.
 */
const PS_TIMEOUT_MS = 2_000;

/**
 * How much later than a reference time the process may appear to have
 * started before it is judged a different process wearing a recycled pid.
 *
 * A real, still-running process necessarily started at or before the moment
 * something else recorded about it (a lock file's `startedAt`, a watchdog's
 * `DORKOS_PARENT_STARTED_AT`). The window is generous on purpose, because the
 * two errors this trades off are not symmetric: too tight and a LIVE process
 * reads as gone, which for a lock means two writers open the same store, and
 * for a watchdog means a live parent's death goes undetected forever after a
 * false "already gone" verdict flips something it shouldn't. Too loose only
 * means a recycled pid is trusted a little longer, and a recycled pid is off
 * by minutes or days, never seconds.
 *
 * Wall-clock steps are the realistic source of the skew this accommodates:
 * Linux `procps` derives `lstart` from `btime + start_jiffies/Hz`, and
 * `btime` is itself `now − uptime`, so NTP correcting a bad RTC, or a VM
 * resuming from a snapshot, shifts a live process's reported start time.
 */
export const DEFAULT_PID_REUSE_TOLERANCE_MS = 120_000;

/**
 * Whether a process id belongs to a process that is running right now.
 *
 * Signal `0` performs the kernel's existence and permission checks without
 * delivering anything. `EPERM` means the process exists but is owned by
 * someone else — alive is alive; only `ESRCH` means it is gone.
 *
 * Callers that must never mistake their own pid for a rival (a lock file
 * naming the process about to replace it, say) handle that themselves before
 * calling this — it is a fact about the OS, not a policy about self-checks.
 *
 * @param pid - The process id to check.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * When a process started, or `null` when this platform cannot say.
 *
 * `ps -o lstart=` is POSIX-portable enough for macOS and Linux, which is
 * where DorkOS runs today. Windows has no `ps`, so the call fails and every
 * caller degrades to pid-only liveness (see {@link assessProcessLiveness}'s
 * `'live-unconfirmed'`) — there is no `Stop-Process`-based equivalent worth
 * shelling out for here, since PowerShell's process start time still requires
 * a second call this module has no portable way to make.
 *
 * `LC_ALL=C` is load-bearing, not tidiness. macOS renders `lstart` through
 * `strftime("%c")`, which is locale-dependent, and `new Date()` parses almost
 * none of those forms — `fr_FR` gives `dim. 26 juil. 15:40:36 2026` → `NaN`,
 * as do most non-English UTF-8 locales. Without this, the corroboration in
 * {@link assessProcessLiveness} silently does nothing on a large share of
 * Macs, and the recycled-pid lockout it exists to prevent comes straight
 * back.
 *
 * @param pid - The process id to look up.
 */
export function processStartTime(pid: number): Date | null {
  try {
    const raw = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PS_TIMEOUT_MS,
      // eslint-disable-next-line no-restricted-syntax -- forwarding the real environment to a child process, with the C locale forced so `lstart` parses
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    // No `ps` (Windows), no such process, a timeout, or an unparseable format.
    return null;
  }
}

/** What could be established about a process a caller remembers by pid. */
export type ProcessLivenessState =
  /** No such process, or a different process wearing a recycled pid. */
  | 'gone'
  /** Alive, and it started no later than the caller's reference time — this really is the same process. */
  | 'live-confirmed'
  /** Alive, but this platform (or a slow/failed `ps`) can't say when it started. */
  | 'live-unconfirmed';

/**
 * Decide whether `pid` is genuinely still the process a caller is watching,
 * rather than an unrelated process the OS has since recycled the pid onto.
 *
 * Pid existence alone is not enough. After a hard kill (an out-of-memory
 * kill, `pkill -9`, a forced logout) whatever recorded the pid survives
 * naming a process that is gone, and operating systems wrap pids around onto
 * unrelated processes. A pid-only check would then either refuse forever (a
 * lock) or never notice the watched process died (a watchdog). So this
 * corroborates: the process named by `pid` must have STARTED no later than
 * `referenceTime` — the moment the caller first observed or recorded it. A
 * recycled pid belongs to a process that started afterwards, and is reported
 * `'gone'`.
 *
 * @param pid - The process id the caller is watching.
 * @param referenceTime - When the caller first observed/recorded this pid
 *   (a lock file's `startedAt`, a watchdog's own start time at the moment it
 *   captured the parent's pid).
 * @param toleranceMs - How much later than `referenceTime` the process may
 *   appear to have started before it's judged a different process. Defaults
 *   to {@link DEFAULT_PID_REUSE_TOLERANCE_MS}.
 */
export function assessProcessLiveness(
  pid: number,
  referenceTime: Date,
  toleranceMs: number = DEFAULT_PID_REUSE_TOLERANCE_MS
): ProcessLivenessState {
  if (!isProcessAlive(pid)) return 'gone';

  const startedAt = processStartTime(pid);
  if (startedAt === null) return 'live-unconfirmed';

  return startedAt.getTime() <= referenceTime.getTime() + toleranceMs ? 'live-confirmed' : 'gone';
}
