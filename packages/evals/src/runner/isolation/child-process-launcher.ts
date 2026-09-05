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
 * Every environment variable that decides where the launched server looks for a
 * HOME-shaped directory, pointed at the sandbox.
 *
 * `HOME` alone is not enough, and the gap is not theoretical: measured by
 * booting a real server through this launcher with `CODEX_HOME` exported by the
 * parent, the operator's Codex thread came back out of the sandbox's own
 * `GET /api/search` — 2 hits — on a run whose `HOME` was already pinned. Each
 * of these variables sits IN FRONT of the home-derived default in the resolver
 * that reads it, so any one of them left inherited re-opens the leak on its own
 * runtime. `XDG_DATA_HOME` matters most of the three because a Linux desktop
 * routinely exports it without anyone choosing to.
 *
 * The set values are exactly what each resolver's home-derived fallback would
 * produce with `HOME` at the sandbox root, so nothing here invents a layout:
 *
 * | Variable        | Resolver                  | Home-derived default   |
 * | --------------- | ------------------------- | ---------------------- |
 * | `CODEX_HOME`    | `resolveCodexHome`        | `~/.codex`             |
 * | `XDG_DATA_HOME` | `resolveOpenCodeDataDir`  | `~/.local/share`       |
 *
 * `OPENCODE_DB` is ERASED rather than set, and that asymmetry is the honest
 * shape. It overrides a FILENAME, not a directory: OpenCode names the file by
 * release channel (`opencode-<channel>.db`), so any value written here would be
 * a guess at a name DorkOS's own sidecar never uses. Unset, the resolver falls
 * back to `<data dir>/opencode.db` — which the `XDG_DATA_HOME` row above has
 * already moved into the sandbox. `spawn` omits `undefined` entries when it
 * builds the child's environment, so this both overrides an inherited absolute
 * path and removes it.
 *
 * This is also the write side, not only the read side: the OpenCode sidecar is
 * spawned with the server's own environment (`opencode/server-manager.ts`) and
 * resolves its data directory the same way, so before this an eval's OpenCode
 * sessions were being WRITTEN into the operator's real store.
 *
 * @param sandboxRoot - The sandbox root (parent of `.dork`, `project`, `.claude`).
 * @returns The env fragment to spread into a pinned child's environment.
 */
function sandboxHomeEnv(sandboxRoot: string): NodeJS.ProcessEnv {
  return {
    // What `os.homedir()` answers from — POSIX reads the first, Windows the
    // second, so both are written and the resolved home is the same either way.
    HOME: sandboxRoot,
    USERPROFILE: sandboxRoot,
    CODEX_HOME: path.join(sandboxRoot, '.codex'),
    XDG_DATA_HOME: path.join(sandboxRoot, '.local', 'share'),
    OPENCODE_DB: undefined,
  };
}

/**
 * Build the launched server's environment: inherit the parent (PATH, so the
 * `claude` binary resolves), layer the spec's credential + model env, then PIN
 * the placement variables last, and STRIP the harness's own test-mode flags so a
 * credentialed boot never inherits `TestModeRuntime`.
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
 * ## Why the HOME pin rides on the same `if`, and is not a second decision
 *
 * `CLAUDE_CONFIG_DIR` alone answers what the MODEL reads. It does not answer
 * what the SERVER enumerates, because the server's root set is a UNION, not a
 * single directory: `resolveClaudeRootSet()` (in
 * `apps/server/.../claude-code/claude-config-dir.ts`) keeps `~/.claude` in
 * unconditionally, on purpose — dropping it would hide history from an operator
 * who has switched accounts. So a sandboxed server pinned to a controlled config
 * dir still listed, searched and read the operator's real transcripts, because
 * `~` was still the operator's (DOR-1779).
 *
 * `HOME` is the whole of that `~`: `os.homedir()` reads it on POSIX (and
 * `USERPROFILE` on Windows), so pinning both collapses every candidate in that
 * union onto ONE directory. The sandbox layout is what makes the collapse total
 * rather than merely narrower: the seeded config dir is `<sandboxRoot>/.claude`
 * (`runner/claude-config.ts`), so with `HOME` at the sandbox root the
 * unconditional `~/.claude` candidate IS the controlled empty one. The sandbox
 * `DORK_HOME` is `<sandboxRoot>/.dork` for the same reason, which also keeps the
 * server's home inside its own filesystem boundary instead of pointing outside
 * it.
 *
 * `HOME` alone is only Claude Code's half. Codex and OpenCode each read a
 * variable that sits IN FRONT of their home-derived default, so an exported
 * `CODEX_HOME`, `XDG_DATA_HOME` or `OPENCODE_DB` walks straight past a pinned
 * home — measured, on a run whose `HOME` was already pinned. {@link
 * sandboxHomeEnv} is the whole set, and it is one function so a fourth runtime's
 * variable is added in one place rather than found by the next leak.
 *
 * It is deliberately NOT its own condition. Moving `HOME` is safe exactly when
 * `runner/claude-config.ts` has already established that this run can
 * authenticate without the operator's real directory — a portable key/token, or
 * a sign-in file carried into the sandbox. On the one row that pin declines (a
 * macOS sign-in living in the Keychain, which belongs to that exact directory),
 * `HOME` must stay inherited too, or the harness would take away the home the
 * credential is reached through while claiming to have taken away nothing. One
 * `if` makes pinning one without the other unspellable. That row instead gets
 * `DORKOS_SEARCH_NO_EXTERNAL_HISTORY`, which closes the part of the leak that
 * does not need the home to move — see the `else` branch in `buildEnv`.
 *
 * The other two runtimes lose nothing to the move. The `claude` binary is
 * resolved by absolute path before `PATH` is ever consulted (`sdk-utils.ts`:
 * env override → the SDK's bundled binary → `<dorkHome>/runtimes/claude-code`),
 * none of which reads a home. OpenCode's sidecar is spawned from the absolute
 * `openCodeBinaryPath` the run resolved, and its provider key reaches it as an
 * environment VALUE — a run that would spend on OpenRouter is refused before
 * anything boots unless `OPENROUTER_API_KEY` is set (`runner/credentials.ts`),
 * so the sidecar never depended on a sign-in file under the operator's home.
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
    // `CLAUDE_CONFIG_DIR` — and the operator's own `HOME` — exactly as they
    // were. Writing `undefined` here would work for `spawn` (which skips
    // undefined entries) but would silently ERASE an operator's own value on the
    // one path that still depends on it — the local sign-in, whose identity is
    // that directory and whose Keychain entry is reached through that home.
    //
    // `sandboxHomeEnv` is what `os.homedir()` and its three siblings answer
    // from, and the server's root set (`resolveClaudeRootSet`) unions in
    // `~/.claude` unconditionally. So that block, not `CLAUDE_CONFIG_DIR`, is
    // what stops a sandboxed server from enumerating the operator's real
    // transcripts. `<sandboxRoot>/.claude` is the seeded controlled dir, so the
    // union collapses onto it (DOR-1779).
    //
    // The ELSE branch is the keychain row, where the home cannot move. It still
    // must not full-text-index the operator's history into a throwaway
    // directory, which is what `pnpm evals:local` — the most-used path of all —
    // was doing. `DORKOS_SEARCH_NO_EXTERNAL_HISTORY` is the existing lever for
    // exactly this (DOR-1551, already used by the browser suite): it drops every
    // `corpus: 'external'` source. It costs this harness nothing, because no
    // eval case queries search; it also means that row does not index the
    // SANDBOX's own transcripts either, which is the honest price and the reason
    // it is the fallback rather than the default.
    ...(spec.claudeConfigDir !== undefined
      ? {
          CLAUDE_CONFIG_DIR: spec.claudeConfigDir,
          ...sandboxHomeEnv(sandboxRoot),
        }
      : { DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true' }),
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
