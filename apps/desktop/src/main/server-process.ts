import { utilityProcess, BrowserWindow, dialog, app } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import log from 'electron-log';

/**
 * Unified interface for server child process, abstracting the difference
 * between Electron UtilityProcess (production) and child_process.fork (dev).
 */
interface ServerChild {
  on(event: 'message', handler: (msg: unknown) => void): void;
  on(event: 'exit', handler: (code: number | null) => void): void;
  off(event: 'exit', handler: (code: number | null) => void): void;
  send(msg: unknown): void;
  kill(): void;
}

let child: ServerChild | null = null;
let serverPort: number | null = null;

/** Find a free port by binding to port 0 and immediately releasing it. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * Wrap an Electron UtilityProcess to conform to the ServerChild interface.
 * UtilityProcess uses postMessage/on('message') with MessageEvent.
 *
 * `ServerChild`'s `on`/`off` are overloaded per event name so callers get a
 * precisely-typed handler; a single-signature object literal can't satisfy
 * an overloaded interface member structurally, so the whole object is cast
 * once at the boundary instead of per-call.
 */
function wrapUtilityProcess(proc: Electron.UtilityProcess): ServerChild {
  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      proc.on(event as 'exit', handler as (code: number) => void);
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      proc.off(event as 'exit', handler as (code: number) => void);
    },
    send(msg: unknown) {
      proc.postMessage(msg);
    },
    kill() {
      proc.kill();
    },
  } as ServerChild;
}

/**
 * Wrap a Node.js ChildProcess to conform to the ServerChild interface.
 * ChildProcess uses send/on('message') with direct message objects.
 */
function wrapChildProcess(proc: ChildProcess): ServerChild {
  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      proc.on(event, handler as (...args: unknown[]) => void);
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      proc.off(event, handler as (...args: unknown[]) => void);
    },
    send(msg: unknown) {
      proc.send!(msg as import('node:child_process').Serializable);
    },
    kill() {
      proc.kill();
    },
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
 * Forward a child's stdout/stderr to electron-log, line by line, so a crash
 * is diagnosable from `~/Library/Logs` even when nothing is attached to the
 * process (a packaged app has no terminal). Requires the child to have been
 * spawned with `stdio: 'pipe'` for stdout/stderr — a `null` stream (any
 * other stdio mode) is a silent no-op.
 */
function forwardOutputToLog(
  stdout: NodeJS.ReadableStream | null,
  stderr: NodeJS.ReadableStream | null
): void {
  const logLines = (level: 'info' | 'error') => (chunk: Buffer | string) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) log[level]('[server]', line);
    }
  };
  stdout?.on('data', logLines('info'));
  stderr?.on('data', logLines('error'));
}

/**
 * Spawn the server process.
 *
 * In production (packaged app): uses Electron UtilityProcess (Electron's Node runtime).
 * electron-builder rebuilds native modules for Electron's ABI during packaging.
 *
 * In development: uses child_process.fork (system Node runtime).
 * This avoids ABI mismatch — the shared better-sqlite3 binary stays compiled
 * for system Node, so both `pnpm dev` (server) and `pnpm dev:desktop` work.
 */
function spawnServer(entryPath: string, env: Record<string, string>): ServerChild {
  if (app.isPackaged) {
    const proc = utilityProcess.fork(entryPath, [], {
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
    forwardOutputToLog(proc.stdout, proc.stderr);
    return wrapUtilityProcess(proc);
  }

  // Dev mode: use system Node via child_process.fork. The entry file is
  // TypeScript — use tsx to run it.
  const tsxBin = path.resolve(__dirname, '../../../../node_modules/.bin/tsx');
  const cp = fork(entryPath, [], {
    execPath: tsxBin,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  forwardOutputToLog(cp.stdout, cp.stderr);
  return wrapChildProcess(cp);
}

/**
 * Start the Express server in an isolated process.
 *
 * @returns The port number the server is listening on.
 * @throws If the server fails to start within 15 seconds.
 */
export async function startServer(): Promise<number> {
  const port = await getFreePort();
  const dorkHome = path.join(app.getPath('home'), '.dork');

  const serverEntry = resolveServerEntry();
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
  child = spawnServer(serverEntry, {
    DORKOS_PORT: String(port),
    DORK_HOME: dorkHome,
    NODE_ENV: app.isPackaged ? 'production' : 'development',
    ...(rendererUrl ? { DORKOS_CORS_ORIGIN: new URL(rendererUrl).origin } : {}),
    ...(clientDistPath ? { CLIENT_DIST_PATH: clientDistPath } : {}),
  });

  // Wait for the server to signal readiness
  const onEarlyExit = (code: number | null) => {
    clearTimeout(timeout);
    if (code !== 0) reject(new Error(`Server exited with code ${code}`));
  };
  let reject: (reason: Error) => void;
  let timeout: NodeJS.Timeout;

  await new Promise<void>((res, rej) => {
    reject = rej;
    timeout = setTimeout(() => rej(new Error('Server start timeout')), 15_000);
    child!.on('message', (msg: unknown) => {
      if (
        msg &&
        typeof msg === 'object' &&
        'type' in msg &&
        (msg as { type: string }).type === 'ready'
      ) {
        clearTimeout(timeout);
        res();
      }
    });
    child!.on('exit', onEarlyExit);
  });

  // Remove startup listener before attaching crash monitor
  child.off('exit', onEarlyExit);
  serverPort = port;

  // Monitor for unexpected crashes after successful startup
  child.on('exit', (code: number | null) => {
    if (code !== 0 && code !== null) {
      const win = BrowserWindow.getFocusedWindow();
      if (win) {
        dialog
          .showMessageBox(win, {
            type: 'error',
            title: 'Server Error',
            message: 'The DorkOS server stopped unexpectedly.',
            detail: `Exit code: ${code}. Your data is safe.`,
            buttons: ['Restart Server', 'Quit'],
          })
          .then(async ({ response }) => {
            if (response === 0) {
              const newPort = await startServer();
              win.loadURL(`http://localhost:${newPort}`);
            } else {
              app.quit();
            }
          });
      }
    }
  });

  return port;
}

/** Gracefully stop the server process. Forcibly kills after 5 seconds. */
export async function stopServer(): Promise<void> {
  if (child) {
    child.send({ type: 'shutdown' });
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child?.kill();
        resolve();
      }, 5_000);
      child!.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    child = null;
    serverPort = null;
  }
}

/** Get the current server port, or null if server is not running. */
export function getServerPort(): number | null {
  return serverPort;
}
