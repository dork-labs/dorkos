/**
 * The child-process {@link IsolationLauncher}: runs `@dorkos/server` from its
 * TypeScript source (`src/index.ts`, via `node --import tsx`) as a subprocess
 * with its own sandbox `DORK_HOME` and port — the default credentialed
 * isolation tier (the judgment suite Phase 3 builds on). No build step is
 * required; the workspace source is the entry, same as `pnpm dev`.
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

/** Resolve the server's TS source entry (`apps/server/src/index.ts`) via its package export. */
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
 * `claude` binary + its config resolve), layer the spec's credential + model env,
 * then PIN the four placement variables last, and STRIP the harness's own
 * test-mode flags so a credentialed boot never inherits `TestModeRuntime`.
 *
 * ## The pins are applied LAST, and that ordering is the containment
 *
 * `DORK_HOME`, `DORKOS_BOUNDARY`, `DORKOS_HOST`, and `DORKOS_PORT` decide WHERE
 * this server lives and what it can touch. They are the harness's to set, not a
 * case's, so they overwrite `spec.env` rather than being overwritten by it —
 * exactly what `docker-launcher.ts` already does with the same variables.
 *
 * The other direction was reachable: `spec.env` carries `evalCase.serverEnv`, so
 * a case declaring `serverEnv: { DORKOS_BOUNDARY: '/' }` used to win, silently
 * pointing a real model-driven server at the whole filesystem — including the
 * developer's actual `~/.dork`. Everything ELSE in `spec.env` (the resolved
 * credential, `ANTHROPIC_MODEL`, a case's own feature flags) stays overridable,
 * which is all a case legitimately needs.
 *
 * A fifth pin, `CLAUDE_CONFIG_DIR`, rides the same rule and lands in the same
 * place, for the same reason one layer up: it decides which user-level
 * `settings.json`, `CLAUDE.md` and skills a measured turn reads. Without it the
 * child inherits the operator's, and every absolute number the run reports is a
 * fact about that developer's machine (DOR-1712). It is pinned only when the
 * spec carries one — see `runner/claude-config.ts` for the one case where
 * isolating it would sign the run out of its own credential.
 *
 * ## Why `DORKOS_BOUNDARY` must be set at all
 *
 * Without it the server falls back to a boundary of the operator's HOME
 * (`lib/boundary.ts`), and every eval sandbox lives in the OS temp directory,
 * which is outside HOME on both macOS (`/var/folders/…`) and Linux (`/tmp`). So
 * every driven turn was refused with `403 OUTSIDE_BOUNDARY` before it started, on
 * every platform.
 *
 * Note this REPLACES an operator's own `DORKOS_BOUNDARY`, not just a missing one.
 * The sandbox path is disjoint from whatever an operator set, so the pin is not
 * strictly "narrower" than a narrower setting — it points somewhere else
 * entirely. That is deliberate: an eval server has no business reading the
 * operator's project tree, however tightly that tree was already scoped.
 *
 * @param spec - The launch spec (dorkHome, host, port, credentialed env).
 * @returns The child process environment.
 */
function buildEnv(spec: ServerLaunchSpec): NodeJS.ProcessEnv {
  // The sandbox ROOT is the parent of dorkHome (`<root>/.dork`); it also holds
  // `<root>/project`, the cwd turns are driven in.
  const sandboxRoot = path.dirname(spec.dorkHome);
  const env: NodeJS.ProcessEnv = {
    // eslint-disable-next-line no-restricted-syntax -- the launcher deliberately inherits the parent env so the spawned server finds PATH/HOME and the `claude` binary; this is the launcher's env carve-out (analogous to the app's env.ts).
    ...process.env,
    ...spec.env,
    // Placement + containment: the harness's call, so these land last.
    DORK_HOME: spec.dorkHome,
    DORKOS_BOUNDARY: sandboxRoot,
    DORKOS_HOST: spec.host,
    DORKOS_PORT: String(spec.port),
    // Spread rather than assigned, so declining to pin leaves an inherited
    // `CLAUDE_CONFIG_DIR` exactly as it was. Writing `undefined` here would work
    // for `spawn` (which skips undefined entries) but would silently ERASE an
    // operator's own value on the one path that still depends on it — the local
    // sign-in, whose identity is that directory.
    ...(spec.claudeConfigDir !== undefined
      ? { CLAUDE_CONFIG_DIR: spec.claudeConfigDir }
      : undefined),
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
