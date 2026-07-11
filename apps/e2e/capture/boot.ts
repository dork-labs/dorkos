import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import {
  API_URL,
  CAPTURE_HOME,
  CAPTURE_WORLD,
  CLIENT_URL,
  FLEET_ROOT,
  REPO_ROOT,
  SERVER_PORT,
  VITE_PORT,
} from './config.js';
import {
  assertPortsFree,
  clearPidfile,
  log,
  reconcileStaleStack,
  writePidfile,
} from './supervisor.js';

/**
 * Process orchestration for the capture run: builds the server's workspace
 * dependencies, boots a test-mode API server and a Vite client bound to it,
 * waits for both to answer, and tears everything down. Mirrors the proven
 * test-mode webServer wiring in `playwright.config.ts`, but with isolated ports
 * and an isolated `DORK_HOME`.
 *
 * Teardown is a single, guaranteed path: every spawned child runs in its own
 * process group, {@link teardownAll} escalates SIGTERM→SIGKILL over the whole
 * set (so a slow Vite can never keep the run's event loop alive on a dangling
 * pipe), and a crashed run's survivors are reconciled from a pidfile on the next
 * boot ({@link preflightStack}).
 *
 * @module capture/boot
 */

/** Environment shared by the spawned processes. */
function baseEnv(): NodeJS.ProcessEnv {
  return {
    // eslint-disable-next-line no-restricted-syntax -- capture harness has no env.ts; the child processes need the inherited environment
    ...process.env,
    DORKOS_TEST_RUNTIME: 'true',
    // A second test-mode runtime so some session rows carry a distinct (still
    // truthful) runtime mark alongside the default.
    DORKOS_TEST_RUNTIME_SECONDARY: 'true',
    DORKOS_PORT: String(SERVER_PORT),
    VITE_PORT: String(VITE_PORT),
    DORK_HOME: CAPTURE_HOME,
    // Confine the server's directory boundary to the capture world. This is a
    // privacy guarantee: the onboarding discovery step can auto-start its scan
    // before the client's config query resolves, and that fallback sweeps the
    // BOUNDARY — which must never be the operator's real home directory.
    DORKOS_BOUNDARY: CAPTURE_WORLD,
    // The default working directory must sit inside that boundary.
    DORKOS_DEFAULT_CWD: path.join(FLEET_ROOT, 'atlas'),
    DORKOS_RELAY_ENABLED: 'true',
    // Mount the Tasks surface (test-mode runtime stands in as the scheduler's
    // agent manager); crons here are non-imminent so nothing fires mid-capture.
    DORKOS_TASKS_ENABLED: 'true',
  };
}

/** Poll `url` until it responds or the deadline passes. */
async function waitForUrl(url: string, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${label} at ${url}`);
}

/** A spawned child in its own process group, with a guaranteed way to reap it. */
interface Managed {
  readonly child: ChildProcess;
  /** True once the child's `exit` event has fired. */
  exited: boolean;
  /** Signal the child's whole process group (sh + server/Vite + descendants). */
  kill(signal: NodeJS.Signals): void;
  /** Resolve when the child exits, or after `timeoutMs` (whichever comes first). */
  waitExit(timeoutMs: number): Promise<void>;
  /** Drop the stderr listener and destroy its pipe so no handle outlives teardown. */
  releaseStreams(): void;
}

/**
 * Every process this module has spawned and not yet reaped. {@link teardownAll}
 * and {@link teardownAllSync} both drain this, so the set is the single source
 * of truth for what must die.
 */
const active: Managed[] = [];

/** SIGTERM→SIGKILL grace: how long a group gets to exit cleanly before we force it. */
const TERM_GRACE_MS = 3_000;
/** How long we wait for a SIGKILL'd survivor to actually disappear. */
const KILL_GRACE_MS = 2_000;

function run(command: string, label: string): Managed {
  // A new process group (`detached`) so a group kill can signal the whole
  // subtree: `sh -c 'a && b'` does not forward signals to its running child, so
  // killing the sh PID alone would orphan the server/Vite — a group kill won't.
  // stdout is dropped (`ignore`): nothing reads it, and an unconsumed pipe both
  // wastes a handle and can back-pressure the child. stderr stays piped so fatal
  // output surfaces; it is destroyed on teardown so it can't keep us alive.
  const child = spawn('sh', ['-c', command], {
    cwd: REPO_ROOT,
    env: baseEnv(),
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  const managed: Managed = {
    child,
    exited: false,
    kill(signal) {
      if (child.pid === undefined) return;
      try {
        // Negative pid → signal the whole process group (sh + server/Vite).
        process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    },
    waitExit(timeoutMs) {
      if (managed.exited || child.pid === undefined) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        // Unref so a hung wait can never itself keep the event loop alive.
        timer.unref();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    releaseStreams() {
      // stdout is `ignore` (no pipe); only stderr is piped and must be released.
      child.stderr?.removeAllListeners('data');
      child.stderr?.destroy();
    },
  };
  child.once('exit', () => {
    managed.exited = true;
  });
  // Surface fatal output but stay quiet otherwise — capture logs are noisy.
  child.stderr?.on('data', (buf: Buffer) => {
    const line = buf.toString();
    if (/error|fatal|EADDRINUSE/i.test(line)) process.stderr.write(`[${label}] ${line}`);
  });
  active.push(managed);
  return managed;
}

/**
 * Stop every process this module has spawned, whatever state boot is in, and
 * guarantee it is dead before resolving. SIGTERM the groups, wait out a grace
 * window, SIGKILL any survivor, then destroy the pipes and clear the pidfile.
 * Because it awaits the actual exits, the run's event loop is never left alive
 * by a dangling child or its stdio pipe.
 */
export async function teardownAll(): Promise<void> {
  const managed = active.splice(0, active.length);
  if (managed.length === 0) {
    clearPidfile();
    return;
  }
  for (const m of managed) m.kill('SIGTERM');
  await Promise.all(managed.map((m) => m.waitExit(TERM_GRACE_MS)));
  const survivors = managed.filter((m) => !m.exited);
  for (const m of survivors) {
    log(`teardown: SIGKILL survivor group ${m.child.pid}`);
    m.kill('SIGKILL');
  }
  if (survivors.length > 0) await Promise.all(survivors.map((m) => m.waitExit(KILL_GRACE_MS)));
  for (const m of managed) m.releaseStreams();
  clearPidfile();
  log(`teardown: stopped ${managed.length} process group(s)`);
}

/**
 * Synchronous, force-only teardown for signal handlers and the process `exit`
 * hook — where there is no time to await. SIGKILL every group, release its
 * pipes, and clear the pidfile, all synchronously.
 *
 * @param signal - The signal to deliver (SIGKILL by default; SIGTERM from a
 *   forwarded Ctrl-C so children can flush if they can).
 */
export function teardownAllSync(signal: NodeJS.Signals = 'SIGKILL'): void {
  const managed = active.splice(0, active.length);
  for (const m of managed) {
    m.kill(signal);
    m.releaseStreams();
  }
  clearPidfile();
}

// Last-resort guarantee: any exit path — a clean return, an uncaught throw, a
// forwarded signal — group-kills whatever is still tracked, so a crashed run can
// never orphan a server or Vite on a capture port. A no-op after a clean
// teardown (the set is already drained).
process.once('exit', () => teardownAllSync('SIGKILL'));

/**
 * Reconcile a stack a previous run orphaned, then require the capture ports to
 * be free. Run this at the very start of a record path — BEFORE the filesystem
 * prep wipes `CAPTURE_HOME` — because reconciliation reads the pidfile that lives
 * there. If a port is still occupied afterwards, it belongs to a foreign process
 * and boot fails fast with a clear message rather than seeding against it.
 */
export async function preflightStack(): Promise<void> {
  await reconcileStaleStack();
  await assertPortsFree();
}

/**
 * Build the server's workspace dependencies once. Split from {@link bootStack}
 * so a parallel record builds a single time up front and then boots N stacks
 * from the shared build output, instead of rebuilding per shard.
 */
export function buildServerDeps(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', 'turbo run build --filter=@dorkos/server'], {
      cwd: REPO_ROOT,
      env: baseEnv(),
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`server build failed (exit ${code})`))
    );
  });
}

/** Handles for a running capture stack. */
export interface Stack {
  /** Stop every spawned process and resolve once they are all reaped. */
  teardown(): Promise<void>;
}

/** Timeout for the workspace build + server first response. */
const SERVER_TIMEOUT_MS = 240_000;
/** Timeout for the Vite dev client. */
const CLIENT_TIMEOUT_MS = 120_000;

/**
 * Boot the capture stack: start the test-mode API server and a Vite client on
 * this shard's ports, and resolve once both answer. Server workspace deps must
 * already be built ({@link buildServerDeps}); the server runs from source via
 * tsx so scenario edits stay live. On success the live group pids are written to
 * the pidfile so a crash can be reconciled next boot. The caller must
 * `teardown()`.
 */
export async function bootStack(): Promise<Stack> {
  const server = run('pnpm --filter @dorkos/server exec tsx src/index.ts', 'server');
  const client = run('pnpm --filter @dorkos/client exec vite', 'client');

  const stack: Stack = { teardown: teardownAll };

  try {
    await waitForUrl(`${API_URL}/api/health`, 'API server', SERVER_TIMEOUT_MS);
    await waitForUrl(CLIENT_URL, 'Vite client', CLIENT_TIMEOUT_MS);
  } catch (err) {
    await teardownAll();
    throw err;
  }

  const pids = [server, client]
    .map((m) => m.child.pid)
    .filter((pid): pid is number => pid !== undefined);
  writePidfile(pids);
  log(`boot: stack up on ${SERVER_PORT}/${VITE_PORT} (groups ${pids.join(',')})`);
  return stack;
}
