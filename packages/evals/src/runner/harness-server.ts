/**
 * The harness server: a real DorkOS server the runner drives prompts against.
 *
 * Phase 1 ships the IN-PROCESS mode (the `test-mode` tier): `createApp()` +
 * `finalizeApp()` — imported through `@dorkos/server/app`, the additive export
 * that exposes the boot symbols without a deep `src/` reach — bound to
 * `listen(0)` so the OS assigns a free port. It runs with `DORKOS_TEST_RUNTIME`
 * set and `DORK_HOME` pointed at the caller's sandbox, so the resolver
 * (`apps/server/src/lib/dork-home.ts`) reads the sandbox rather than the real
 * home.
 *
 * The credentialed CHILD-PROCESS mode (spawn the built server, poll
 * `/api/health`) is Phase 2 (task 2.1); this module deliberately ships only the
 * in-process seam so Phase 1 stands alone.
 *
 * @module evals/runner/harness-server
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, finalizeApp } from '@dorkos/server/app';
import { initConfigManager } from '@dorkos/server/services/core/config-manager';

/** A running harness server, addressable by URL, with a teardown handle. */
export interface HarnessServer {
  /** Base URL of the listening server (e.g. `http://127.0.0.1:53511`). */
  baseUrl: string;
  /** The `DORK_HOME` this server was booted against (the sandbox). */
  dorkHome: string;
  /**
   * Stop the server, free its port, and restore the `process.env` this boot
   * mutated (`DORK_HOME`, `DORKOS_TEST_RUNTIME`) to their pre-boot values — so a
   * server that ran against a now-deleted sandbox never leaves the process env
   * pointing at it. Safe to call more than once.
   *
   * The process-global `configManager` singleton that `initConfigManager`
   * installed is NOT restored: `@dorkos/server/services/core/config-manager`
   * exposes only `initConfigManager` (which constructs a fresh manager) with no
   * reset/teardown export, so there is no seam to restore the prior instance
   * without adding test-only surface to production code. That is acceptable
   * here because in-process servers boot SERIALLY (the next boot overwrites the
   * singleton) and the harness owns the whole process — nothing outside the
   * runner reads it between a dispose and the next boot.
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
  // per call) at the sandbox and mark test mode. The config store below is the
  // load-bearing wiring for Phase 1; these env vars keep any live env reader on
  // the sandbox and pre-stage the flags the credentialed boot (Phase 2) needs.
  const restoreDorkHome = setBootEnv('DORK_HOME', opts.dorkHome);
  const restoreTestRuntime = setBootEnv('DORKOS_TEST_RUNTIME', 'true');

  // The full server bootstrap (`index.ts start()`) wires the config store before
  // building the app; `createApp()` alone does not. `sessionGate` reads the
  // config store on every request, so without this the app 500s. Initialize it
  // against the sandbox `DORK_HOME` so the config file (and its `auth.enabled:
  // false` default, which makes `sessionGate` a pass-through) lands in the
  // sandbox, never the developer's real home. This is a process-level singleton,
  // so in-process servers are booted serially, one sandbox at a time (concurrent
  // isolation arrives with the child-process mode, Phase 2 / task 2.1).
  initConfigManager(opts.dorkHome);

  const app = createApp();
  finalizeApp(app);

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
          // Restore the env this boot mutated once no more requests can read it.
          restoreTestRuntime();
          restoreDorkHome();
          resolve();
        });
        // Drop keep-alive sockets so close() is not blocked by idle clients.
        server.closeAllConnections?.();
      }),
  };
}
