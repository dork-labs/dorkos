import { app, utilityProcess } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import { processStartTime } from '@dorkos/shared/process-liveness';
import { resolveDataDirectory } from './dork-home';
import { resolveServerCwd, type ServerWorkingDirectory } from './server-cwd';
import { createStderrTail, type StderrTail } from './server-output';
import { resolveChildPath } from './shell-path';

/**
 * Spawning the desktop app's Express server as a child process.
 *
 * This module knows how to *start* a server child — which runtime to use, what
 * entry script to run, and what environment to hand it. It deliberately knows
 * nothing about the child's lifecycle after that; supervising it (readiness,
 * crashes, shutdown) is `server-process.ts`'s job, and choosing the port it is
 * handed is `server-port.ts`'s.
 */

/**
 * Location of the Claude Code native binary inside a packaged build,
 * relative to `process.resourcesPath` (`.../Contents/Resources` on macOS,
 * `.../resources` on Windows), for the platform/arch this build runs on.
 *
 * The SDK ships its executable as a per-platform optional dependency named
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, matching Node's
 * `process.platform`/`process.arch` (e.g. `…-darwin-arm64`, `…-win32-x64`).
 * The executable inside is `claude` everywhere except Windows, where it's
 * `claude.exe`. electron-builder collects the package from the SDK's
 * dependency tree; electron-builder.yml's `asarUnpack` keeps it as a real
 * file on disk (a native executable cannot run from inside app.asar), landing
 * here. Only the target's own binary is packaged — a macOS build has no
 * win32-x64 sibling and vice versa — so this resolves exactly one path.
 */
const PACKAGED_CLAUDE_BINARY_SUBPATH = path.join(
  'app.asar.unpacked',
  'node_modules',
  '@anthropic-ai',
  `claude-agent-sdk-${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'claude.exe' : 'claude'
);

/**
 * Location of esbuild's native binary inside a packaged build, relative to
 * `process.resourcesPath`, for the platform/arch this build runs on.
 *
 * esbuild ships its compiler as a per-platform optional dependency named
 * `@esbuild/<platform>-<arch>`, with the executable at `bin/esbuild`
 * (`esbuild.exe` at the package root on Windows) — the layout esbuild's own
 * `pkgAndSubpathForCurrentPlatform` looks for. The server compiles extension
 * source with it on every boot, so a packaged app without it fails to compile
 * the bundled marketplace extension every single launch.
 *
 * Handed to the server as `ESBUILD_BINARY_PATH` for the same reason the Claude
 * binary is handed over explicitly: esbuild finds the package by
 * `require.resolve`, which inside a packaged app answers with an
 * `…/app.asar/…` path — and *spawning* one of those fails with `ENOTDIR`,
 * because Electron's asar shim covers `execFile` but not `spawn` (measured
 * against the shipped 0.61.0 app). The unpacked path sidesteps the question.
 */
const PACKAGED_ESBUILD_BINARY_SUBPATH = path.join(
  'app.asar.unpacked',
  'node_modules',
  '@esbuild',
  `${process.platform}-${process.arch}`,
  ...(process.platform === 'win32' ? ['esbuild.exe'] : ['bin', 'esbuild'])
);

/**
 * Value of `DORKOS_MANAGED_BY` in the child's environment.
 *
 * This module owns only the producer half of a contract with `apps/server`:
 * it sets the variable and nothing else. The matching gate lives server-side,
 * where `POST /api/admin/restart` and `POST /api/admin/reset` answer 409 when
 * they see it. Those endpoints re-exec the server process, which cannot work
 * here — the desktop shell owns the process lifecycle, and inside an Electron
 * UtilityProcess there is nothing to re-exec into. Ungated, the server exits 0
 * and leaves the app pointing at a dead port.
 */
const MANAGED_BY = 'desktop';

/**
 * Unified interface for the server child, abstracting the difference between
 * Electron's UtilityProcess (production) and `child_process.fork` (dev).
 *
 * `error` is only ever emitted by the fork path — Node reports a failed spawn
 * asynchronously through it, and without a listener that failure surfaces as
 * an uncaught exception in the main process instead of a friendly dialog.
 */
export interface ServerChild {
  on(event: 'message', handler: (msg: unknown) => void): void;
  on(event: 'exit', handler: (code: number | null) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  send(msg: unknown): void;
  kill(): void;
  /**
   * The child's most recent stderr lines, redacted and truncated.
   *
   * A server that refuses to start explains itself here — a data directory
   * another process already holds, a failed migration, a port it could not
   * bind — and then exits. Without this the shell could only report the exit
   * code, while the reason sat in a log file nobody opens.
   */
  recentErrors(): string[];
}

/**
 * Resolve the packaged Claude Code binary the bundled server should spawn.
 *
 * Only meaningful in a packaged build: there, the server bundle's own
 * `require.resolve` cannot reach the SDK's per-platform optional dependency
 * (pnpm links that sibling only inside the SDK's store `node_modules`, and an
 * `app.asar/…` path is not spawnable anyway), so the main process hands the
 * server the real unpacked path via `DORKOS_CLAUDE_CLI_PATH`. Returns `null`
 * in dev or if the expected file is absent, leaving the server's own PATH-based
 * resolution untouched.
 *
 * @returns Absolute path to the unpacked `claude` binary, or `null`.
 */
function resolvePackagedClaudeBinary(): string | null {
  if (!app.isPackaged) return null;
  const candidate = path.join(process.resourcesPath, PACKAGED_CLAUDE_BINARY_SUBPATH);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the packaged esbuild binary the bundled server should compile with.
 *
 * See {@link PACKAGED_ESBUILD_BINARY_SUBPATH} for why the server is told rather
 * than left to find it. Returns `null` in dev — where esbuild resolves its own
 * binary out of `node_modules` perfectly well — or if the expected file is
 * absent, in which case esbuild falls back to its own resolution and reports
 * its own (clear) error.
 *
 * @returns Absolute path to the unpacked `esbuild` binary, or `null`.
 */
function resolvePackagedEsbuildBinary(): string | null {
  if (!app.isPackaged) return null;
  const candidate = path.join(process.resourcesPath, PACKAGED_ESBUILD_BINARY_SUBPATH);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Wrap an Electron UtilityProcess to conform to the ServerChild interface.
 * UtilityProcess uses postMessage/on('message') with MessageEvent.
 *
 * `ServerChild`'s `on` is overloaded per event name so callers get a
 * precisely-typed handler; a single-signature object literal can't satisfy
 * an overloaded interface member structurally, so the whole object is cast
 * once at the boundary instead of per-call.
 */
function wrapUtilityProcess(proc: Electron.UtilityProcess, tail: StderrTail): ServerChild {
  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      proc.on(event as 'exit', handler as (code: number) => void);
    },
    send(msg: unknown) {
      proc.postMessage(msg);
    },
    kill() {
      proc.kill();
    },
    recentErrors: () => tail.lines(),
  } as ServerChild;
}

/**
 * Wrap a Node.js ChildProcess to conform to the ServerChild interface.
 * ChildProcess uses send/on('message') with direct message objects.
 */
function wrapChildProcess(proc: ChildProcess, tail: StderrTail): ServerChild {
  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      proc.on(event, handler as (...args: unknown[]) => void);
    },
    send(msg: unknown) {
      proc.send!(msg as import('node:child_process').Serializable);
    },
    kill() {
      proc.kill();
    },
    recentErrors: () => tail.lines(),
  } as ServerChild;
}

/**
 * Resolve the server entry script for the current mode. Computed
 * independently per mode rather than derived by string substitution — dev's
 * `src/server-entry.ts` and prod's bundled `dist/server/server-entry.mjs`
 * don't mirror each other's directory depth, so a naive dist→src swap would
 * silently point at the wrong file.
 *
 * `__dirname` here is always `dist/main` — electron-vite compiles the main
 * process to that fixed location in both dev and packaged builds.
 */
function resolveServerEntry(): string {
  if (app.isPackaged) {
    // Bundled by scripts/build-server.ts as ESM (`.mjs` — apps/server's
    // source relies on `import.meta.url`, which esbuild can't polyfill for
    // CJS output; see that script for why). Nested under dist/server/ (not
    // flat dist/) so the bundle's own `__dirname`-relative reads — Drizzle
    // migrations, core-extension source — land inside the desktop package
    // instead of escaping it. See that script for the full layout rationale.
    return path.join(__dirname, '../server/server-entry.mjs');
  }
  // Dev: run the original TypeScript source directly via tsx (system Node),
  // not Electron's UtilityProcess — see spawnServer for why.
  return path.resolve(__dirname, '../../src/server-entry.ts');
}

/**
 * Resolve the `tsx` shim the dev server child runs under.
 *
 * On Windows pnpm writes `tsx.cmd`; the extensionless shim next to it is a
 * shell script Windows cannot execute (`ENOEXEC`). Same branch
 * `scripts/rebuild-natives.ts` makes for `electron-rebuild`.
 *
 * @returns Absolute path to the shim.
 * @throws If the shim is missing — a bare `fork` against a nonexistent
 *   executable dies with a raw stack in the main process, long after the
 *   friendly "DorkOS couldn't start" dialog would have been useful.
 */
function resolveTsxBin(): string {
  const shim = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
  const tsxBin = path.resolve(__dirname, '../../../../node_modules/.bin', shim);
  if (!existsSync(tsxBin)) {
    throw new Error(
      `The dev server needs ${shim} at ${tsxBin}, which is missing. ` +
        'Run `pnpm install` at the repository root and try again.'
    );
  }
  return tsxBin;
}

/**
 * Forward a child's stdout/stderr to electron-log, line by line, so a crash
 * is diagnosable from `~/Library/Logs` even when nothing is attached to the
 * process (a packaged app has no terminal). Requires the child to have been
 * spawned with `stdio: 'pipe'` for stdout/stderr — a `null` stream (any
 * other stdio mode) is a silent no-op.
 */
function forwardOutputToLog(
  stdout: NodeJS.ReadableStream | null,
  stderr: NodeJS.ReadableStream | null,
  tail: StderrTail
): void {
  const logLines = (level: 'info' | 'error') => (chunk: Buffer | string) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) log[level]('[server]', line);
    }
  };
  const logErrors = logLines('error');
  stdout?.on('data', logLines('info'));
  // One stream, two consumers: the log file, for diagnosing after the fact,
  // and a bounded tail the supervisor can put in front of the user right now.
  stderr?.on('data', (chunk: Buffer | string) => {
    tail.record(chunk.toString());
    logErrors(chunk);
  });
}

/**
 * Compose the environment the server child runs with.
 *
 * @param port - The port the server should listen on.
 * @param workingDirectory - Where the packaged server should work, or `null` in
 *   dev, where the child inherits this process's own directory as it always has.
 */
function buildServerEnv(
  port: number,
  workingDirectory: ServerWorkingDirectory | null
): Record<string, string> {
  // In dev, electron-vite serves the renderer over HTTP (ELECTRON_RENDERER_URL,
  // e.g. http://localhost:5173). That cross-origin request is rejected by the
  // server's CORS allowlist, so whitelist the renderer origin explicitly. In a
  // packaged build the renderer loads from the server's own localhost origin
  // (see window-manager.ts's `createWindow`), which is same-origin — no CORS
  // override needed there.
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  // In production, point the server's SPA-serving fallback (app.ts's
  // `finalizeApp`) at the packaged renderer assets. Those must be real files
  // on disk, not virtual asar entries (electron-builder.yml unpacks
  // dist/renderer/** for exactly this), hence `app.asar.unpacked`. Left
  // unset in dev — the server isn't the one serving the renderer there.
  const clientDistPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'renderer')
    : undefined;
  // In a packaged build, point the server at the unpacked, signed Claude Code
  // binary — the bundled server can't `require.resolve` it itself (see
  // resolvePackagedClaudeBinary). Unset in dev, where the server resolves
  // `claude` from PATH or the SDK's optional dependency as usual.
  const claudeCliPath = resolvePackagedClaudeBinary();
  if (app.isPackaged && !claudeCliPath) {
    log.error(
      '[server] Packaged Claude Code binary missing at',
      path.join(process.resourcesPath, PACKAGED_CLAUDE_BINARY_SUBPATH)
    );
  }
  // DORK_HOME is pinned only for a packaged app. The server's
  // `resolveDorkHome()` gives this variable top priority over its own dev
  // default, so passing it unconditionally pointed
  // `pnpm --filter @dorkos/desktop dev` at the real ~/.dork and ran unreleased
  // migrations against live data. Left unset, the child resolves the same
  // project-local `<cwd>/.temp/.dork` every other dev workflow here uses
  // (under apps/desktop, since that is where electron-vite runs) — which is
  // what `resolveDataDirectory()` returns for that mode, so the directory the
  // port scan read `config.json` out of is the one the child opens either way.
  const dorkHome = app.isPackaged ? resolveDataDirectory() : undefined;
  // Same story as the Claude binary, for the compiler the extension host runs
  // on every boot. Unset in dev.
  const esbuildBinaryPath = resolvePackagedEsbuildBinary();
  if (app.isPackaged && !esbuildBinaryPath) {
    log.error(
      '[server] Packaged esbuild binary missing at',
      path.join(process.resourcesPath, PACKAGED_ESBUILD_BINARY_SUBPATH)
    );
  }
  // The PATH a Finder-launched app inherits is launchd's four system
  // directories, which is why the packaged app could not find tools the same
  // machine's terminal finds instantly. See shell-path.ts; a no-op in dev.
  const childPath = resolveChildPath(process.env.PATH);
  // Dev only: tell the child which pid to watch so it can kill itself if the
  // shell dies without cleaning up (see server-entry.ts's exitWhenOrphaned).
  // It has to be handed down explicitly because the child cannot work it out
  // for itself — `tsx` runs the server as a *grandchild* of this process, so
  // from in there `process.ppid` is the tsx wrapper, not us. A packaged build
  // needs none of this: Electron tears a UtilityProcess down with the app.
  //
  // `startedAt` rides alongside the pid (DOR-552) so the watchdog can
  // corroborate it against its actual start time instead of trusting a bare
  // `process.kill(pid, 0)` forever — see `@dorkos/shared/process-liveness`
  // for why a recycled pid needs that. Captured HERE, not read back later
  // from `process`, because by the time the watchdog might ask, this process
  // could be gone; `processStartTime` returns `null` on Windows (no `ps`),
  // in which case the child simply doesn't get the var and degrades to the
  // pid-only check it always did.
  const parentWatchEnv: Record<string, string> = {};
  if (!app.isPackaged) {
    parentWatchEnv.DORKOS_PARENT_PID = String(process.pid);
    const startedAt = processStartTime(process.pid);
    if (startedAt) parentWatchEnv.DORKOS_PARENT_STARTED_AT = startedAt.toISOString();
  }

  return {
    DORKOS_PORT: String(port),
    NODE_ENV: app.isPackaged ? 'production' : 'development',
    DORKOS_MANAGED_BY: MANAGED_BY,
    ...parentWatchEnv,
    ...(dorkHome ? { DORK_HOME: dorkHome } : {}),
    ...(rendererUrl ? { DORKOS_CORS_ORIGIN: new URL(rendererUrl).origin } : {}),
    ...(clientDistPath ? { CLIENT_DIST_PATH: clientDistPath } : {}),
    ...(claudeCliPath ? { DORKOS_CLAUDE_CLI_PATH: claudeCliPath } : {}),
    ...(esbuildBinaryPath ? { ESBUILD_BINARY_PATH: esbuildBinaryPath } : {}),
    ...(childPath ? { PATH: childPath } : {}),
    // Where the cockpit opens, decided here because the server cannot work it
    // out for itself inside an app bundle (see server-cwd.ts). Packaged only:
    // in dev the server's own resolution already lands on the repo.
    ...(workingDirectory ? { DORKOS_DEFAULT_CWD: workingDirectory.cwd } : {}),
    // Only when the person set one. The server defaults the boundary to home,
    // and inventing a value here would turn that default into a setting.
    ...(workingDirectory?.boundary ? { DORKOS_BOUNDARY: workingDirectory.boundary } : {}),
  };
}

/**
 * Spawn the server process on `port`.
 *
 * In production (packaged app): uses Electron UtilityProcess (Electron's Node
 * runtime). electron-builder rebuilds native modules for Electron's ABI during
 * packaging.
 *
 * In development: uses child_process.fork (system Node runtime). This avoids
 * ABI mismatch — the shared better-sqlite3 binary stays compiled for system
 * Node, so both `pnpm dev` (server) and `pnpm dev:desktop` work.
 *
 * @param port - The port the server should listen on.
 * @returns The spawned child, normalized to {@link ServerChild}.
 * @throws If the dev `tsx` shim is missing (see {@link resolveTsxBin}), or if
 *   the spawn itself fails synchronously.
 */
export function spawnServer(port: number): ServerChild {
  const entryPath = resolveServerEntry();
  const workingDirectory = app.isPackaged ? resolveServerCwd() : null;
  const env: NodeJS.ProcessEnv = { ...process.env, ...buildServerEnv(port, workingDirectory) };
  if (app.isPackaged) {
    // A packaged app inherits whatever the launching environment exported, and
    // spreading an object that simply omits this key cannot unset an inherited
    // one. An inherited DORKOS_PARENT_PID would arm the child's orphan watchdog
    // against a stale pid; it would exit 0 a poll later and the shell would
    // report a crash it caused itself. Production never wants that watchdog.
    delete env.DORKOS_PARENT_PID;
    delete env.DORKOS_PARENT_STARTED_AT;
  }
  const tail = createStderrTail();

  if (app.isPackaged) {
    // `cwd` as well as DORKOS_DEFAULT_CWD: anything that reads `process.cwd()`
    // rather than the resolved default — a spawned tool, a relative path in a
    // config file — otherwise gets `/`, which is what a Finder-launched app
    // inherits.
    const proc = utilityProcess.fork(entryPath, [], {
      env,
      stdio: 'pipe',
      cwd: workingDirectory?.cwd,
    });
    forwardOutputToLog(proc.stdout, proc.stderr, tail);
    return wrapUtilityProcess(proc, tail);
  }

  // Dev mode: system Node via child_process.fork. The entry file is
  // TypeScript, so tsx is the executable.
  const cp = fork(entryPath, [], {
    execPath: resolveTsxBin(),
    env,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  forwardOutputToLog(cp.stdout, cp.stderr, tail);
  return wrapChildProcess(cp, tail);
}
