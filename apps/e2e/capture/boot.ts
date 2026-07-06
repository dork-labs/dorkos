import { spawn, type ChildProcess } from 'child_process';
import { API_URL, CLIENT_URL, REPO_ROOT, SERVER_PORT, VITE_PORT, CAPTURE_HOME } from './config.js';

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

function run(command: string, label: string): Managed {
  const child = spawn('sh', ['-c', command], {
    cwd: REPO_ROOT,
    env: baseEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Surface fatal output but stay quiet otherwise — capture logs are noisy.
  child.stderr?.on('data', (buf: Buffer) => {
    const line = buf.toString();
    if (/error|fatal|EADDRINUSE/i.test(line)) process.stderr.write(`[${label}] ${line}`);
  });
  return {
    child,
    stop() {
      if (!child.killed) child.kill('SIGTERM');
    },
  };
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
 * Boot the capture stack: build server deps, start the test-mode API server and
 * a Vite client, and resolve once both answer. The caller must `teardown()`.
 */
export async function bootStack(): Promise<Stack> {
  // Build workspace dependencies once (server runs from source via tsx, so the
  // scenario edits are live, but @dorkos/* deps must have fresh dists).
  const server = run(
    'turbo run build --filter=@dorkos/server && pnpm --filter @dorkos/server exec tsx src/index.ts',
    'server'
  );
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
