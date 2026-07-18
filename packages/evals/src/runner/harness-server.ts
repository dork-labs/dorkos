/**
 * The harness server: a real DorkOS server the runner drives prompts against.
 *
 * The IN-PROCESS mode (the `test-mode` tier) boots through
 * `bootInProcessTestServer` — the additive `@dorkos/server/harness-boot` export
 * that wires the config store, the sandbox DB, the durable session-event store,
 * and a registered `TestModeRuntime` as default (the subset of `start()` a real
 * turn needs, which `createApp()` alone does not) — then binds `listen(0)` so
 * the OS assigns a free port. It runs with `DORKOS_TEST_RUNTIME` set and
 * `DORK_HOME` pointed at the caller's sandbox, so the resolver
 * (`apps/server/src/lib/dork-home.ts`) reads the sandbox rather than the real
 * home.
 *
 * The credentialed CHILD-PROCESS mode ({@link startChildProcessServer}):
 * an {@link IsolationLauncher} runs the server from its TS source (via tsx)
 * against a sandbox `DORK_HOME` with `ANTHROPIC_API_KEY` + a cheap model, and
 * this module polls
 * `/api/health` until it is ready. Because the process is out-of-band, that tier
 * gets REAL per-eval isolation (no shared singletons / env mutation), unlike the
 * serial-only in-process mode. The launcher is the seam a future `docker` tier
 * plugs into — see `isolation/types.ts`.
 *
 * @module evals/runner/harness-server
 */
import net, { type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { bootInProcessTestServer } from '@dorkos/server/harness-boot';
import type { IsolationLauncher, ServerExit } from './isolation/index.js';
import { ChildProcessLauncher } from './isolation/index.js';

/** A running harness server, addressable by URL, with a teardown handle. */
export interface HarnessServer {
  /** Base URL of the listening server (e.g. `http://127.0.0.1:53511`). */
  baseUrl: string;
  /** The `DORK_HOME` this server was booted against (the sandbox). */
  dorkHome: string;
  /**
   * Stop the server and free every resource the boot held. The in-process mode
   * closes the sandbox DB and restores the `process.env` it mutated (`DORK_HOME`,
   * `DORKOS_TEST_RUNTIME`) to their pre-boot values; the child-process mode kills
   * the launched process group. Either way a torn-down server never leaves the
   * env pointing at — or a process/db handle open on — a now-deleted sandbox.
   * Safe to call more than once.
   *
   * The process-global singletons the in-process boot installs (the config
   * manager, the registry DB handle, the session-event store, the registered
   * `TestModeRuntime`) are NOT individually restored — they carry no
   * reset/teardown seam, and adding test-only surface to production code to
   * unwind them is not worth it. Acceptable because in-process servers boot
   * SERIALLY (the next boot OVERWRITES each singleton) and the harness owns the
   * whole process; nothing outside the runner reads them between boots.
   */
  dispose: () => Promise<void>;
}

/** Options for {@link startInProcessServer}. */
export interface StartInProcessServerOptions {
  /** Sandbox `DORK_HOME` the server (and its oracles) read/write. */
  dorkHome: string;
  /** Host to bind. Defaults to `127.0.0.1` (loopback only). */
  host?: string;
}

/**
 * Set a process env var for the in-process boot, returning a thunk that restores
 * its prior value (or deletes it if it was unset before this boot). The harness
 * deliberately owns the booted server's environment — this is the one place it
 * may touch `process.env` (the app's own resolver reads
 * `DORK_HOME`/`DORKOS_TEST_RUNTIME` off it), analogous to the server's own
 * `env.ts` carve-out. `dispose()` runs the returned thunk so the mutation does
 * not outlive the server.
 *
 * @param key - The env var name.
 * @param value - The value to set.
 * @returns A thunk that restores the pre-boot value (idempotent).
 */
function setBootEnv(key: string, value: string): () => void {
  // eslint-disable-next-line no-restricted-syntax -- capture the pre-boot value so dispose() can restore it; the harness owns the booted server's env.
  const prior = process.env[key];
  // eslint-disable-next-line no-restricted-syntax -- the harness owns the booted server's env; DORK_HOME must be the sandbox before createApp runs.
  process.env[key] = value;
  return () => {
    if (prior === undefined) {
      // eslint-disable-next-line no-restricted-syntax -- restore the pre-boot env: the var was unset before this server booted.
      delete process.env[key];
    } else {
      // eslint-disable-next-line no-restricted-syntax -- restore the pre-boot env to the value captured before this server booted.
      process.env[key] = prior;
    }
  };
}

/**
 * Boot the DorkOS server in-process against a sandbox `DORK_HOME` and return a
 * {@link HarnessServer}. The server serves `/api/health` immediately; product
 * routes that need a registered runtime become live once the credentialed tier
 * lands (Phase 2+).
 *
 * @param opts - The sandbox `DORK_HOME` and optional host; see
 *   {@link StartInProcessServerOptions}.
 * @returns The listening {@link HarnessServer}.
 */
export async function startInProcessServer(
  opts: StartInProcessServerOptions
): Promise<HarnessServer> {
  const host = opts.host ?? '127.0.0.1';
  // Point the live resolver (`resolveDorkHome()` reads `process.env.DORK_HOME`
  // per call) at the sandbox and mark test mode BEFORE the boot: `createApp()`
  // reads `DORKOS_TEST_RUNTIME` to mount the test-control routes, and any live
  // env reader must see the sandbox home.
  const restoreDorkHome = setBootEnv('DORK_HOME', opts.dorkHome);
  const restoreTestRuntime = setBootEnv('DORKOS_TEST_RUNTIME', 'true');

  // `bootInProcessTestServer` (a `@dorkos/server` harness export) wires the
  // SUBSET of `start()` a driven turn needs — the config store, the sandbox DB +
  // migrations, the durable session-event store, and a registered
  // `TestModeRuntime` as default — that `createApp()` alone does not. Without it
  // the server answers `/api/health` but rejects the first real turn (no runtime
  // registered). The wired singletons are process-global, so in-process servers
  // boot SERIALLY, one sandbox at a time (concurrent isolation is the
  // child-process tier's job).
  const { app, dispose: closeDb } = await bootInProcessTestServer(opts.dorkHome);

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(0, host);
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://${host}:${address.port}`;

  return {
    baseUrl,
    dorkHome: opts.dorkHome,
    dispose: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          // Close the sandbox DB, then restore the env this boot mutated, once
          // no more requests can read either.
          closeDb();
          restoreTestRuntime();
          restoreDorkHome();
          resolve();
        });
        // Drop keep-alive sockets so close() is not blocked by idle clients.
        server.closeAllConnections?.();
      }),
  };
}

/**
 * The repo's canonical cheap (Haiku-class) model id, passed as `ANTHROPIC_MODEL`
 * so the credentialed runtime defaults to it. The judgment tier is
 * tool-choice-from-natural-language, which a cheap model handles — keeping the
 * nightly suite affordable. A per-session model override is a Phase 3 concern.
 */
export const DEFAULT_CHEAP_MODEL = 'claude-haiku-4-5';

/** Default budget (ms) for the credentialed server's `/api/health` to go green. */
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000;

/** Interval (ms) between `/api/health` polls while the server boots. */
const HEALTH_POLL_INTERVAL_MS = 250;

/** Allocate a free loopback TCP port by binding `:0`, reading it, then releasing it. */
function allocatePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

/** Sleep for `ms`. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `GET /api/health` until it returns 200 or the budget expires — the
 * `apps/e2e` webServer precedent. Rejects early (with the crash's stderr tail)
 * if the launched server exits before it ever became healthy, so a boot crash
 * is a clear error, not a silent timeout.
 *
 * @param baseUrl - The launched server's base URL.
 * @param opts.timeoutMs - Total budget before giving up.
 * @param opts.exited - Resolves if the server process dies first.
 * @throws {Error} On timeout or an early server exit.
 */
async function waitForHealth(
  baseUrl: string,
  opts: { timeoutMs: number; exited: Promise<ServerExit> }
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  let crashed: ServerExit | undefined;
  void opts.exited.then((exit) => {
    crashed = exit;
  });

  while (Date.now() < deadline) {
    if (crashed) {
      throw new Error(
        `Harness server exited before becoming healthy (code=${crashed.code}, signal=${crashed.signal}).\n${crashed.stderr}`
      );
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.status === 200) return;
    } catch {
      // Not listening yet — keep polling until the deadline.
    }
    await delay(HEALTH_POLL_INTERVAL_MS);
  }
  throw new Error(`Harness server did not become healthy within ${opts.timeoutMs}ms at ${baseUrl}`);
}

/** Options for {@link startChildProcessServer}. */
export interface StartChildProcessServerOptions {
  /** Sandbox `DORK_HOME` the launched server (and its oracles) read/write. */
  dorkHome: string;
  /** Host to bind. Defaults to `127.0.0.1` (loopback only). */
  host?: string;
  /**
   * The `ANTHROPIC_API_KEY` the credentialed runtime authenticates with. Without
   * it the boot fails (the real runtime cannot reach a model) — the caller gates
   * on it so a missing key is a runner error, not a false pass.
   */
  anthropicApiKey?: string;
  /** Cheap default model (`ANTHROPIC_MODEL`). Defaults to {@link DEFAULT_CHEAP_MODEL}. */
  model?: string;
  /** Extra environment for the launched server (per-eval overrides). */
  env?: Record<string, string>;
  /** Health-poll budget in ms. Defaults to {@link DEFAULT_HEALTH_TIMEOUT_MS}. */
  readyTimeoutMs?: number;
  /** The isolation launcher. Defaults to {@link ChildProcessLauncher}. */
  launcher?: IsolationLauncher;
}

/**
 * Boot the DorkOS server OUT OF PROCESS against a sandbox `DORK_HOME` and return
 * a {@link HarnessServer} — the credentialed tier (`claude-code-cheap` /
 * `real-provider`). Allocates a free port, launches the server through the
 * {@link IsolationLauncher} (default: a Node child process), and polls
 * `/api/health` until ready. `dispose()` kills the launched server (and its
 * descendant runtime binaries) and frees the port EVEN if the boot never became
 * healthy — the launch is torn down on the health-timeout / crash path too.
 *
 * @param opts - Sandbox, credentials, model, launcher; see
 *   {@link StartChildProcessServerOptions}.
 * @returns The listening {@link HarnessServer}.
 * @throws {Error} If the server never becomes healthy (timeout or an early crash).
 */
export async function startChildProcessServer(
  opts: StartChildProcessServerOptions
): Promise<HarnessServer> {
  const host = opts.host ?? '127.0.0.1';
  const launcher = opts.launcher ?? new ChildProcessLauncher();
  const port = await allocatePort(host);

  const env: Record<string, string> = {
    ANTHROPIC_MODEL: opts.model ?? DEFAULT_CHEAP_MODEL,
    ...opts.env,
  };
  if (opts.anthropicApiKey) env.ANTHROPIC_API_KEY = opts.anthropicApiKey;

  const launched = await launcher.launch({ dorkHome: opts.dorkHome, host, port, env });

  try {
    await waitForHealth(launched.baseUrl, {
      timeoutMs: opts.readyTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      exited: launched.exited,
    });
  } catch (err) {
    // A server that never became healthy must still be torn down — otherwise a
    // half-booted process (and its port) leaks past the failed boot.
    await launched.kill();
    throw err;
  }

  return {
    baseUrl: launched.baseUrl,
    dorkHome: opts.dorkHome,
    dispose: () => launched.kill(),
  };
}
