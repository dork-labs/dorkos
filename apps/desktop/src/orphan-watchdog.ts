/**
 * Shuts the server child down when the desktop shell that spawned it goes
 * away (DOR-552).
 *
 * Armed only in development, where the shell passes its own pid as
 * `DORKOS_PARENT_PID`. A packaged build leaves that unset and this is a no-op:
 * there the server runs in an Electron UtilityProcess, which Electron tears
 * down with the app. In dev it runs under `child_process.fork` instead, and a
 * fork outlives a parent that dies without cleaning up — it gets reparented to
 * init and keeps the port, the SQLite WAL lock and every live agent session,
 * so the next launch starts against a directory another process still owns.
 *
 * Watching an explicitly-passed pid is the only thing that works here, and the
 * two obvious alternatives were both measured failing before this was written.
 * `tsx` does not run `server-entry.ts` in-process: it spawns the real server as
 * a *grandchild* of the shell and proxies IPC through itself. So from in here
 * `process.ppid` is the tsx wrapper, and the peer whose exit would fire
 * `process.on('disconnect')` is the tsx wrapper too. Neither notices Electron
 * dying — with the shell killed hard, a watchdog built on either one never
 * fired and the server was still holding its port seconds later. A pid handed
 * down from the shell sees straight through the wrapper.
 *
 * Corroborated against `DORKOS_PARENT_STARTED_AT` via
 * `@dorkos/shared/process-liveness`, the same helper the server's instance
 * lock uses for the identical problem: a bare `process.kill(pid, 0)` treats
 * `EPERM` as alive, which is correct, but once the OS recycles the shell's pid
 * onto some other process — especially a root-owned one, which answers `EPERM`
 * forever — this would read "parent still there" forever too, and the orphan
 * keeps its port, its SQLite WAL lock, and every live agent session:
 * precisely the state this watchdog exists to prevent.
 * `DORKOS_PARENT_STARTED_AT` is optional because `processStartTime` can fail
 * to establish it (no `ps` on Windows); when it's absent the check degrades to
 * plain pid-only liveness, same as before this existed.
 *
 * @module orphan-watchdog
 */
import { assessProcessLiveness, isProcessAlive } from '@dorkos/shared/process-liveness';

/** How often the dev child re-checks that the process that spawned it is still alive. */
export const ORPHAN_CHECK_INTERVAL_MS = 2_000;

/** What {@link exitWhenOrphaned} reads from the environment, narrowed for testability. */
export interface OrphanWatchdogEnv {
  DORKOS_PARENT_PID?: string;
  DORKOS_PARENT_STARTED_AT?: string;
}

/**
 * Build the per-poll liveness check {@link exitWhenOrphaned} arms on an
 * interval, exposed separately so a test can drive it directly without a
 * real timer.
 *
 * The full corroboration (`assessProcessLiveness`, which forks `ps` to read
 * the parent's start time) runs on the FIRST check, and again any time the
 * pid's bare liveness has flipped from alive to dead — never on every poll.
 * Once a check confirms `'live-confirmed'`, that fact is cached: a real
 * parent's start time can never change, so re-forking `ps` every 2 seconds
 * forever to re-verify a fact already established is pure overhead. From
 * then on, each poll is a bare `isProcessAlive` — cheap, and sufficient,
 * because the identity question is already answered; only "is it still
 * running" remains. If that ever answers false, the cache is cleared: a
 * pid that goes on to come back (a hypothetical recycle) gets fully
 * re-corroborated rather than trusted on a stale confirmation.
 *
 * A first check that only reaches `'live-unconfirmed'` (no `ps` on this
 * platform, a timeout, an unparseable format) is NOT cached as confirmed —
 * every subsequent poll re-runs the full check. That is not wasted work in
 * practice: `parentStartedAt` is only ever set when `processStartTime`
 * succeeded at spawn time (see `server-spawn.ts`), so a platform where `ps`
 * doesn't exist at all (Windows) never reaches this function with a
 * non-null `parentStartedAt` in the first place — see the `!parentStartedAt`
 * branch below, which is the actual Windows path and never forks anything.
 *
 * @param parentPid - The pid to watch.
 * @param parentStartedAt - When the shell reported it started, or `null` if
 *   that couldn't be established at spawn time (falls back to bare
 *   `isProcessAlive` liveness with no corroboration at all).
 */
export function createParentLivenessCheck(
  parentPid: number,
  parentStartedAt: Date | null
): () => boolean {
  let corroborated = false;

  return (): boolean => {
    if (corroborated) {
      const alive = isProcessAlive(parentPid);
      // Pid-liveness flipped to dead: drop the cache. Nothing polls after
      // this returns false in practice (the caller exits), but a pid that
      // somehow reappears must not be trusted on a stale confirmation.
      if (!alive) corroborated = false;
      return alive;
    }

    if (!parentStartedAt) return isProcessAlive(parentPid);

    const state = assessProcessLiveness(parentPid, parentStartedAt);
    if (state === 'gone') return false;
    corroborated = state === 'live-confirmed';
    return true;
  };
}

/**
 * Arm the orphan watchdog: poll `env.DORKOS_PARENT_PID` every
 * {@link ORPHAN_CHECK_INTERVAL_MS} and exit this process the moment it's
 * gone.
 *
 * A no-op when `DORKOS_PARENT_PID` is unset, empty, or malformed —
 * `Number(undefined)` is `NaN` and `Number('')` is `0`, and neither survives
 * the guard. A packaged build also deletes any inherited value (see
 * `server-spawn.ts`), so production never arms.
 *
 * @param env - Defaults to `process.env`; overridable so a test can drive
 *   this without mutating global state.
 */
export function exitWhenOrphaned(env: OrphanWatchdogEnv = process.env): void {
  const parentPid = Number(env.DORKOS_PARENT_PID);
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;

  const parentStartedAtMs = Date.parse(env.DORKOS_PARENT_STARTED_AT ?? '');
  const parentStartedAt = Number.isNaN(parentStartedAtMs) ? null : new Date(parentStartedAtMs);

  const isParentAlive = createParentLivenessCheck(parentPid, parentStartedAt);

  // unref'd: this watchdog must never be the reason the process stays alive.
  setInterval(() => {
    if (isParentAlive()) return;
    console.error('Shutting the server down: the desktop app that started it is gone.');
    process.exit(0);
  }, ORPHAN_CHECK_INTERVAL_MS).unref();
}
