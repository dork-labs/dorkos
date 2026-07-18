/**
 * The child-process {@link IsolationLauncher}: boots the built `@dorkos/server`
 * as a Node subprocess with its own sandbox `DORK_HOME` and port — the default
 * credentialed isolation tier (the judgment suite Phase 3 builds on).
 *
 * The subprocess is spawned DETACHED (its own process group) so `kill()` can
 * signal the WHOLE group and take the runtime's descendant binaries (the real
 * `claude` process the credentialed runtime shells out to) down with it — a bare
 * `child.kill()` would orphan them. This is the container-analog seam: a future
 * `docker` launcher replaces "spawn a process group" with "run a container" and
 * `kill()` with `docker rm -f`, leaving the rest of the harness unchanged.
 *
 * @module evals/runner/isolation/child-process-launcher
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IsolationLauncher, LaunchedServer, ServerExit, ServerLaunchSpec } from './types.js';

/** Cap on the retained stderr tail (bytes) — enough to diagnose a boot crash. */
const STDERR_TAIL_BYTES = 8_192;

/** Grace period (ms) to wait for a killed process to be reaped before returning. */
const KILL_GRACE_MS = 5_000;

/** Resolve the built server's entry (`apps/server/src/index.ts`) via its package export. */
function resolveServerEntry(): string {
  // `require.resolve` honors the `@dorkos/server` `.` export (`./src/index.ts`),
  // so the launcher never hard-codes a path relative to `packages/evals`.
  return createRequire(import.meta.url).resolve('@dorkos/server');
}

/** Options for {@link ChildProcessLauncher}. */
export interface ChildProcessLauncherOptions {
  /** Absolute path to the server entry. Defaults to the resolved `@dorkos/server`. */
  serverEntry?: string;
  /** Node executable to spawn. Defaults to the current `process.execPath`. */
  nodeExecPath?: string;
  /** Argv before the entry. Defaults to `['--import', 'tsx']` (run TS from source). */
  execArgv?: string[];
}

/** Sleep for `ms`, used to bound the post-kill reap wait. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the launched server's environment: inherit the parent (PATH, HOME so the
 * `claude` binary + its config resolve), pin the sandbox `DORK_HOME`/host/port,
 * layer the spec's credentialed env, and STRIP the harness's own test-mode flags
 * so a credentialed boot never inherits `TestModeRuntime`.
 *
 * @param spec - The launch spec (dorkHome, host, port, credentialed env).
 * @returns The child process environment.
 */
function buildEnv(spec: ServerLaunchSpec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // eslint-disable-next-line no-restricted-syntax -- the launcher deliberately inherits the parent env so the spawned server finds PATH/HOME and the `claude` binary; this is the launcher's env carve-out (analogous to the app's env.ts).
    ...process.env,
    DORK_HOME: spec.dorkHome,
    DORKOS_HOST: spec.host,
    DORKOS_PORT: String(spec.port),
    ...spec.env,
  };
  // A credentialed run uses the real claude-code runtime — never the harness's
  // in-process test-mode flags, which would otherwise leak from the parent.
  delete env.DORKOS_TEST_RUNTIME;
  delete env.DORKOS_TEST_RUNTIME_SECONDARY;
  return env;
}

/**
 * Launches the DorkOS server as a detached Node subprocess. The default
 * credentialed isolation tier; the reference implementation of the
 * {@link IsolationLauncher} seam.
 */
export class ChildProcessLauncher implements IsolationLauncher {
  readonly id = 'child-process';

  private readonly serverEntry: string;
  private readonly nodeExecPath: string;
  private readonly execArgv: string[];

  /**
   * Construct a child-process launcher, resolving the server entry, node binary,
   * and argv (each defaulting) up front so `launch()` only spawns.
   *
   * @param opts - Overrides for the server entry / node binary / argv; see
   *   {@link ChildProcessLauncherOptions}. Every field defaults, so
   *   `new ChildProcessLauncher()` boots the workspace `@dorkos/server`.
   */
  constructor(opts: ChildProcessLauncherOptions = {}) {
    this.serverEntry = opts.serverEntry ?? resolveServerEntry();
    this.nodeExecPath = opts.nodeExecPath ?? process.execPath;
    this.execArgv = opts.execArgv ?? ['--import', 'tsx'];
  }

  /**
   * Spawn the server subprocess against the sandbox and return a
   * {@link LaunchedServer}. Resolves as soon as the process is spawned — the
   * caller polls `/api/health` and watches `exited` for an early crash.
   *
   * @param spec - The launch spec; see {@link ServerLaunchSpec}.
   * @returns The reachable, disposable launched-server handle.
   */
  async launch(spec: ServerLaunchSpec): Promise<LaunchedServer> {
    const child = spawn(this.nodeExecPath, [...this.execArgv, this.serverEntry], {
      cwd: path.resolve(path.dirname(this.serverEntry), '..'),
      env: buildEnv(spec),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so `kill()` can signal the whole tree (the server AND
      // the `claude` binary it shells out to), never orphaning descendants.
      detached: true,
    });

    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    // Drain stdout so a chatty server never stalls on backpressure.
    child.stdout?.on('data', () => {});

    const exited = new Promise<ServerExit>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal, stderr: stderrTail }));
      // A spawn failure (e.g. the entry cannot be resolved) never emits `exit`;
      // fold it into `exited` so the health poll surfaces it as a boot crash.
      child.once('error', (err) =>
        resolve({ code: null, signal: null, stderr: `${stderrTail}\n${err.message}` })
      );
    });

    let disposed = false;
    const kill = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      if (child.pid === undefined) return;
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        // Negative pid ⇒ signal the whole process group (detached leader).
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone — the group vanished; nothing left to free.
      }
      // Wait for the OS to reap it so the port is free before the next boot.
      await Promise.race([exited, delay(KILL_GRACE_MS)]);
    };

    return { baseUrl: `http://${spec.host}:${spec.port}`, kill, exited };
  }
}
