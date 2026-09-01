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
 * against a sandbox `DORK_HOME` with the resolved model credential + a cheap
 * model, and this module polls
 * `/api/health` until it is ready. Because the process is out-of-band, that tier
 * gets REAL per-eval isolation (no shared singletons / env mutation), unlike the
 * serial-only in-process mode. The launcher is the seam the hardened `docker`
 * tier plugs into — see `isolation/types.ts`. This module polls whatever
 * `baseUrl` the launcher reports and never assumes the server is listening on the
 * host directly (the docker tier's is not).
 *
 * @module evals/runner/harness-server
 */
import net, { type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { bootInProcessTestServer } from '@dorkos/server/harness-boot';
import type { IsolationLauncher, ServerExit } from './isolation/index.js';
import { ChildProcessLauncher } from './isolation/index.js';
import { buildOpenCodeSandboxConfig, writeSandboxConfig } from './opencode-sandbox.js';
import type { EvalRuntime } from '../types.js';

/**
 * The one runtime id this module CONFIGURES rather than merely names. The others
 * need no setup beyond the credential env, so they pass straight through.
 */
const OPENCODE_RUNTIME: EvalRuntime = 'opencode';

/** A running harness server, addressable by URL, with a teardown handle. */
export interface HarnessServer {
  /** Base URL of the listening server (e.g. `http://127.0.0.1:53511`). */
  baseUrl: string;
  /** The `DORK_HOME` this server was booted against (the sandbox). */
  dorkHome: string;
  /**
   * The path THIS SERVER sees for the sandbox project directory, when it differs
   * from the host path (the docker tier's container mount point). Undefined for
   * the local tiers, whose view is the host filesystem. The drive loop prefers
   * it for `?cwd=`; oracles always read the host sandbox.
   */
  projectCwd?: string;
  /**
   * Identifier of the underlying isolation unit when externally inspectable (the
   * docker tier's container id), so a retained failure is findable.
   */
  containerId?: string;
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
   *
   * @param opts.failed - True when the eval FAILED, so a tier that can retain
   *   post-mortem state (the docker tier keeps the stopped container + its logs)
   *   does; other tiers ignore it.
   */
  dispose: (opts?: { failed?: boolean }) => Promise<void>;
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
   * Cheap default model. On `claude-code` this is passed as `ANTHROPIC_MODEL`
   * and defaults to {@link DEFAULT_CHEAP_MODEL}; on `opencode` it is the
   * `provider/model` pin written into the sandbox config, and it has no default
   * here (the caller owns the pin).
   */
  model?: string;
  /**
   * The agent runtime this server should run sessions on. `claude-code`
   * (default) needs no setup beyond the credential env. `opencode` is
   * CONFIGURED rather than switched: the sandbox config names the provider, the
   * binary and the model before the boot — see `runner/opencode-sandbox.ts`.
   */
  runtime?: EvalRuntime;
  /**
   * Model provider for a runtime that fronts several (`openrouter` on
   * `opencode`). Ignored by `claude-code`, which reaches Anthropic directly.
   *
   * REQUIRED when `runtime` is `opencode`, and deliberately not defaulted — see
   * {@link configureOpenCodeSandbox}.
   */
  provider?: string;
  /**
   * Absolute path to the `opencode` binary the sandboxed server must use.
   * Required when `runtime` is `opencode` — a sandbox `DORK_HOME` holds no
   * provisioned install, so the server cannot find one on its own.
   */
  openCodeBinaryPath?: string;
  /**
   * Extra environment for the launched server: the resolved model credential
   * (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, from
   * `runner/credentials.ts`) plus any per-eval overrides. May be empty when the
   * run authenticates through the `claude` sign-in on this machine, which the
   * child-process launcher inherits rather than being handed as a value.
   */
  env?: Record<string, string>;
  /** Health-poll budget in ms. Defaults to {@link DEFAULT_HEALTH_TIMEOUT_MS}. */
  readyTimeoutMs?: number;
  /** The isolation launcher. Defaults to {@link ChildProcessLauncher}. */
  launcher?: IsolationLauncher;
}

/**
 * Write the sandbox config an OpenCode boot needs, before the server starts.
 *
 * Refuses rather than degrades when the caller gave no binary or no model. Both
 * are things the run resolved (or failed to resolve) long before this point, and
 * booting anyway would produce a server that registers OpenCode, accepts the
 * session, and then fails every turn on a missing binary — a red about the
 * harness wearing the costume of a red about the product.
 *
 * @param opts - The child-process boot options.
 * @throws {Error} When `openCodeBinaryPath` or `model` is missing.
 */
async function configureOpenCodeSandbox(opts: StartChildProcessServerOptions): Promise<void> {
  if (!opts.openCodeBinaryPath) {
    throw new Error(
      'An OpenCode harness boot needs `openCodeBinaryPath`: a sandbox DORK_HOME holds no ' +
        'provisioned install, so the server would resolve no binary and fail every turn.'
    );
  }
  if (!opts.model) {
    throw new Error(
      'An OpenCode harness boot needs a pinned `model` (as `provider/model`). Without one the ' +
        'sidecar picks its own default, and a run cannot say what answered it.'
    );
  }
  // NEVER default the provider here. Writing `providers.<id>` into the sandbox
  // config is the moment this harness commits to spending somebody's provider
  // account, and a default at THIS layer silently manufactures that commitment
  // for a caller who never asked: it is precisely how `--tier claude-code-cheap
  // --runtime opencode` reached OpenRouter with the spend gate unarmed. The
  // caller resolves the provider alongside the gate (`run-suite.ts`) or this
  // refuses. A missing provider is a harness bug, not a shape to paper over.
  if (!opts.provider) {
    throw new Error(
      'An OpenCode harness boot needs an explicit `provider`. It is deliberately not defaulted ' +
        'here: naming a provider is what commits the run to spending on one, and that decision ' +
        'belongs beside the spend gate in `run-suite.ts`, never to a default in the boot path.'
    );
  }
  await writeSandboxConfig(
    opts.dorkHome,
    buildOpenCodeSandboxConfig({
      binaryPath: opts.openCodeBinaryPath,
      provider: opts.provider,
      model: opts.model,
    })
  );
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

  // `ANTHROPIC_MODEL` is claude-code's model selector and NOTHING else's. Setting
  // it on an OpenCode boot would leave a Haiku id in the environment of a server
  // that answers through OpenRouter — a value no code reads and every reader of a
  // retained sandbox would be misled by.
  const runsOpenCode = opts.runtime === OPENCODE_RUNTIME;
  const env: Record<string, string> = runsOpenCode
    ? { ...opts.env }
    : { ANTHROPIC_MODEL: opts.model ?? DEFAULT_CHEAP_MODEL, ...opts.env };

  if (runsOpenCode) await configureOpenCodeSandbox(opts);

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
    // A tier whose server sees the sandbox at a different path (docker) reports
    // it; local tiers leave both undefined.
    ...(launched.projectCwd !== undefined ? { projectCwd: launched.projectCwd } : {}),
    ...(launched.containerId !== undefined ? { containerId: launched.containerId } : {}),
    dispose: (disposeOpts) => launched.kill(disposeOpts),
  };
}
