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

/**
 * Process orchestration for the capture run: builds the server's workspace
 * dependencies, boots a test-mode API server and a Vite client bound to it,
 * waits for both to answer, and tears everything down. Mirrors the proven
 * test-mode webServer wiring in `playwright.config.ts`, but with isolated ports
 * and an isolated `DORK_HOME`.
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

/** A spawned child plus a clean way to stop it. */
interface Managed {
  readonly child: ChildProcess;
  stop(): void;
}

/**
 * Every process this module has spawned and not yet stopped. Tracked so
 * {@link teardownAll} can guarantee nothing is left running — including a stack
 * still mid-boot when a shard worker is asked to abort.
 */
const active: Managed[] = [];

function run(command: string, label: string): Managed {
  // A new process group (`detached`) so `stop()` can signal the whole subtree.
  // `sh -c 'a && b'` does not forward SIGTERM to the running child, so killing
  // the sh PID alone would orphan the server/Vite process — a group kill won't.
  const child = spawn('sh', ['-c', command], {
    cwd: REPO_ROOT,
    env: baseEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  // Surface fatal output but stay quiet otherwise — capture logs are noisy.
  child.stderr?.on('data', (buf: Buffer) => {
    const line = buf.toString();
    if (/error|fatal|EADDRINUSE/i.test(line)) process.stderr.write(`[${label}] ${line}`);
  });
  const managed: Managed = {
    child,
    stop() {
      const idx = active.indexOf(managed);
      if (idx >= 0) active.splice(idx, 1);
      if (child.pid === undefined) return;
      try {
        // Negative pid → signal the whole process group (sh + server/Vite).
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    },
  };
  active.push(managed);
  return managed;
}

/**
 * Stop every process this module has spawned, whatever state boot is in. Used by
 * a shard worker's signal handler so an orchestrator-initiated abort can never
 * leave an orphaned server or Vite holding a port.
 */
export function teardownAll(): void {
  while (active.length > 0) active[active.length - 1]!.stop();
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
  /** Stop every spawned process. */
  teardown(): void;
}

/** Timeout for the workspace build + server first response. */
const SERVER_TIMEOUT_MS = 240_000;
/** Timeout for the Vite dev client. */
const CLIENT_TIMEOUT_MS = 120_000;

/**
 * Boot the capture stack: start the test-mode API server and a Vite client on
 * this shard's ports, and resolve once both answer. Server workspace deps must
 * already be built ({@link buildServerDeps}); the server runs from source via
 * tsx so scenario edits stay live. The caller must `teardown()`.
 */
export async function bootStack(): Promise<Stack> {
  const server = run('pnpm --filter @dorkos/server exec tsx src/index.ts', 'server');
  const client = run('pnpm --filter @dorkos/client exec vite', 'client');

  const stack: Stack = {
    teardown() {
      server.stop();
      client.stop();
    },
  };

  try {
    await waitForUrl(`${API_URL}/api/health`, 'API server', SERVER_TIMEOUT_MS);
    await waitForUrl(CLIENT_URL, 'Vite client', CLIENT_TIMEOUT_MS);
  } catch (err) {
    stack.teardown();
    throw err;
  }
  return stack;
}
