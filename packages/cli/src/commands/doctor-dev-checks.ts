/**
 * The contributor-only checks behind `pnpm doctor:dev`.
 *
 * These are failures of the *development loop*, not of a DorkOS install: a
 * stale build output, a watcher nobody stopped, a native module rebuilt for the
 * wrong runtime. Someone who installed DorkOS from npm cannot hit any of them,
 * so they are deliberately kept out of `dorkos doctor` — a shipped checklist
 * that lists problems its reader cannot have is noise.
 *
 * Every function here is pure: it takes facts someone else gathered and returns
 * a {@link CheckResult}. `packages/cli/scripts/doctor-dev.ts` does the gathering.
 *
 * @module commands/doctor-dev-checks
 */
import type { CheckResult } from '@dorkos/shared/health-schemas';

/** How stale a dist may be before it is worth mentioning (clock skew tolerance). */
const STALE_DIST_TOLERANCE_MS = 1000;

/** Timestamps describing one package's source and its build output. */
export interface DistFreshnessInput {
  /** The package whose build output is being judged, e.g. `@dorkos/shared`. */
  packageName: string;
  /** Modification time of the newest file under `src/`, or `null` when there is none. */
  newestSourceMs: number | null;
  /** Modification time of the newest file under `dist/`, or `null` when `dist/` is missing. */
  newestDistMs: number | null;
}

/**
 * Whether a workspace package's build output is older than its source.
 *
 * This is the repo's most convincing lie: type errors appear in files nobody
 * touched, imports resolve to symbols that no longer exist, and the failure
 * points anywhere except the package that needs rebuilding.
 *
 * @param input - The two timestamps and the package name.
 * @returns A `pass` when the build is current, otherwise a `warn` with the rebuild command.
 */
export function checkDistFreshness(input: DistFreshnessInput): CheckResult {
  if (input.newestSourceMs === null) {
    return { label: `${input.packageName} has no source to build`, status: 'info' };
  }
  if (input.newestDistMs === null) {
    return {
      label: `${input.packageName} has never been built`,
      status: 'warn',
      detail: 'Anything importing it will fail to resolve, usually somewhere unrelated.',
      fix: `Build it:\n  pnpm --filter ${input.packageName} build`,
    };
  }
  if (input.newestDistMs + STALE_DIST_TOLERANCE_MS < input.newestSourceMs) {
    const behindMinutes = Math.round((input.newestSourceMs - input.newestDistMs) / 60_000);
    return {
      label: `${input.packageName} build output is out of date`,
      status: 'warn',
      detail:
        `Its source changed about ${behindMinutes} ${behindMinutes === 1 ? 'minute' : 'minutes'} ` +
        'after it was last built. Typechecks will fail in files you never touched.',
      fix: `Rebuild it:\n  pnpm --filter ${input.packageName} build`,
    };
  }
  return { label: `${input.packageName} build output is current`, status: 'pass' };
}

/** One process from a listing, reduced to what the watcher check needs. */
export interface RunningProcess {
  pid: number;
  /** The full command line. */
  command: string;
}

/**
 * How many `tsx watch` processes are running.
 *
 * Each one keeps its chokidar watchers open, and enough of them make unrelated
 * test runs fail with `EMFILE` — an error that never mentions the dev servers
 * nobody stopped.
 *
 * This reports rather than accuses, and it is deliberately `info` with no
 * `kill` line. From a process listing there is no way to tell a leftover from
 * the `pnpm dev` the reader is running right now (or a teammate's, or the one
 * in another worktree), and a check that says "kill these" about a live dev
 * server is worse than one that says nothing. Counting them is enough: someone
 * chasing `EMFILE` needs the number, and can decide for themselves.
 *
 * @param processes - Every process visible to this user.
 * @returns A `pass` when none are running, otherwise an `info` with the count and pids.
 */
export function checkOrphanedWatchers(processes: readonly RunningProcess[]): CheckResult {
  const watchers = processes.filter((p) => /tsx\s+watch/.test(p.command));
  if (watchers.length === 0) {
    return { label: 'No dev servers running', status: 'pass' };
  }
  return {
    label: `${watchers.length} dev ${watchers.length === 1 ? 'server is' : 'servers are'} running`,
    status: 'info',
    detail:
      `pid ${watchers.map((w) => w.pid).join(', ')}. Each one holds file watchers open; a pile ` +
      'left over from interrupted `pnpm dev` runs is what makes unrelated tests fail with EMFILE.',
  };
}

/**
 * Whether the native SQLite binding loads in plain Node.
 *
 * Building the desktop app rebuilds `better-sqlite3` against Electron's ABI. It
 * then loads fine inside Electron and not at all anywhere else, so vitest
 * workers across several packages are killed outright with nothing in the
 * output that points at the desktop build that caused it.
 *
 * @param loadError - The error thrown by requiring the binding, or `null` when it loaded.
 * @returns A `pass` when it loaded, a `fail` on an ABI mismatch, a `warn` otherwise.
 */
export function checkNativeSqlite(loadError: Error | null): CheckResult {
  if (loadError === null) {
    return { label: 'SQLite native module loads', status: 'pass' };
  }
  if (loadError.message.includes('NODE_MODULE_VERSION')) {
    return {
      label: 'SQLite native module was built for the wrong runtime',
      status: 'fail',
      detail:
        'It was compiled against Electron, so plain Node cannot load it. Test workers are ' +
        'killed with no message that points here — this is almost always the desktop build.',
      fix: 'Rebuild it for Node:\n  pnpm rebuild better-sqlite3',
    };
  }
  return {
    label: 'SQLite native module did not load',
    status: 'warn',
    detail: loadError.message,
    fix: 'Rebuild it:\n  pnpm rebuild better-sqlite3',
  };
}
