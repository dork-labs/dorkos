import { utilityProcess, BrowserWindow, dialog, app } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

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
  };
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
      proc.send!(msg);
    },
    kill() {
      proc.kill();
    },
  };
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
    return wrapUtilityProcess(
      utilityProcess.fork(entryPath, [], { env: { ...process.env, ...env } })
    );
  }

  // Dev mode: use system Node via child_process.fork.
  // The entry file is TypeScript — use tsx to run it.
  const tsxBin = path.resolve(__dirname, '../../../../node_modules/.bin/tsx');
  const cp = fork(entryPath.replace('.js', '.ts'), [], {
    execPath: tsxBin,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
  });
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

  const serverEntry = path.join(__dirname, '../server-entry.js');
  child = spawnServer(serverEntry, {
    DORKOS_PORT: String(port),
    DORK_HOME: dorkHome,
    NODE_ENV: app.isPackaged ? 'production' : 'development',
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
