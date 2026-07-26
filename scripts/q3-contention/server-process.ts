/**
 * Boots and reaps the throwaway DorkOS server the Q3 harness measures
 * (DOR-500), and tails its output for the two error classes the experiment is
 * watching for: `SQLITE_BUSY` on `~/.dork` and `EMFILE` on descriptors.
 *
 * Process handling mirrors the proven capture harness (`apps/e2e/capture/boot.ts`):
 * the child runs in its own process group so a group kill reaps `sh` and the
 * server together, and every exit path — clean, thrown, or signalled — reaps it.
 *
 * @module scripts/q3-contention/server-process
 */
import { spawn, type ChildProcess } from 'child_process';
import { createWriteStream, type WriteStream } from 'fs';
import type { RunPlan } from './plan.js';
import type { RunPaths } from './provision.js';
import { buildCanaryMap } from './provision.js';

/** Counts of the error classes scraped from the server's output. */
export interface ErrorCounters {
  /** Occurrences of `SQLITE_BUSY` / "database is locked" in server output. */
  sqliteBusy: number;
  /** Occurrences of `EMFILE` in server output. */
  emfile: number;
}

/** A booted server, its live error counters, and the way to stop it. */
export interface ServerHandle {
  readonly baseUrl: string;
  /** PID of the process group leader — the root of the RSS tree the sampler walks. */
  readonly pid: number;
  readonly counters: ErrorCounters;
  stop(): Promise<void>;
}

const SQLITE_BUSY_PATTERN = /SQLITE_BUSY|database is locked/gi;
const EMFILE_PATTERN = /EMFILE/g;

const TERM_GRACE_MS = 3_000;
const KILL_GRACE_MS = 2_000;
const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 250;

/** Environment for the throwaway server. Every path points inside the run root. */
function serverEnv(plan: RunPlan, paths: RunPaths): NodeJS.ProcessEnv {
  return {
    // eslint-disable-next-line no-restricted-syntax -- the harness has no env.ts; the spawned server needs the inherited environment (PATH, HOME, credentials for arm 3)
    ...process.env,
    ...(plan.testMode ? { DORKOS_TEST_RUNTIME: 'true' } : {}),
    DORKOS_PORT: String(plan.port),
    // Pin the bind address rather than taking the `localhost` default: on macOS
    // that resolves to ::1 first, and the harness's 127.0.0.1 requests would be
    // refused by a server that is otherwise perfectly healthy.
    DORKOS_HOST: '127.0.0.1',
    DORK_HOME: paths.dorkHome,
    // Confine the server's directory boundary and default cwd to the run root,
    // so nothing it scans or defaults to can reach real state.
    DORKOS_BOUNDARY: paths.runRoot,
    DORKOS_DEFAULT_CWD: paths.trees.a,
    DORKOS_Q3_DURATION_MS: String(plan.durationMs),
    DORKOS_Q3_TICK_MS: String(plan.tickMs),
    DORKOS_Q3_CANARY_MAP: buildCanaryMap(plan, paths),
    // A measurement run must not phone home; outbound requests would pollute
    // both the fd count and the load average being sampled.
    DO_NOT_TRACK: '1',
    DORKOS_TELEMETRY_DISABLED: '1',
  };
}

/**
 * Poll until the URL answers, the child dies, or the deadline passes. Watching
 * the child means a server that crashes on boot fails the run in seconds rather
 * than burning the whole health timeout.
 */
async function waitForUrl(url: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `[q3] server exited during boot (code ${child.exitCode ?? child.signalCode})`
      );
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error(`[q3] server did not answer ${url} within ${timeoutMs}ms`);
}

/** Build the workspace dependencies the server imports. */
export function buildServerDeps(repoRoot: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', 'turbo run build --filter=@dorkos/server'], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`[q3] server build failed (exit ${code})`))
    );
  });
}

/** Group-kill helper: signal the whole process group, ignoring an already-dead one. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

/** Resolve when the child exits, or after `timeoutMs`. */
function waitExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Boot the throwaway server and wait for it to answer `/api/health`.
 *
 * @param plan - The resolved run plan.
 * @param paths - Throwaway paths from `provision()`.
 * @param repoRoot - Checkout to run the server from.
 * @param logPath - File the server's combined output is tee'd into.
 * @returns A handle carrying the base URL, the group pid, and live error counters.
 */
export async function bootServer(
  plan: RunPlan,
  paths: RunPaths,
  repoRoot: string,
  logPath: string
): Promise<ServerHandle> {
  const baseUrl = `http://127.0.0.1:${plan.port}`;
  const log: WriteStream = createWriteStream(logPath, { flags: 'a' });
  const counters: ErrorCounters = { sqliteBusy: 0, emfile: 0 };

  const child = spawn('sh', ['-c', 'pnpm --filter @dorkos/server exec tsx src/index.ts'], {
    cwd: repoRoot,
    env: serverEnv(plan, paths),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  const scan = (buf: Buffer): void => {
    const text = buf.toString();
    log.write(text);
    counters.sqliteBusy += text.match(SQLITE_BUSY_PATTERN)?.length ?? 0;
    counters.emfile += text.match(EMFILE_PATTERN)?.length ?? 0;
  };
  child.stdout?.on('data', scan);
  child.stderr?.on('data', scan);

  const stop = async (): Promise<void> => {
    killGroup(child, 'SIGTERM');
    await waitExit(child, TERM_GRACE_MS);
    if (child.exitCode === null && child.signalCode === null) {
      killGroup(child, 'SIGKILL');
      await waitExit(child, KILL_GRACE_MS);
    }
    child.stdout?.removeAllListeners('data');
    child.stderr?.removeAllListeners('data');
    child.stdout?.destroy();
    child.stderr?.destroy();
    await new Promise<void>((resolve) => log.end(resolve));
  };

  try {
    await waitForUrl(`${baseUrl}/api/health`, HEALTH_TIMEOUT_MS, child);
  } catch (err) {
    await stop();
    throw err;
  }

  if (child.pid === undefined) {
    await stop();
    throw new Error('[q3] server process has no pid');
  }
  return { baseUrl, pid: child.pid, counters, stop };
}
