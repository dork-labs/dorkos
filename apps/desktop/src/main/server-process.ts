import { utilityProcess, BrowserWindow, dialog, app } from 'electron';
import net from 'node:net';
import path from 'node:path';

let child: Electron.UtilityProcess | null = null;
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
 * Spawn the Express server in an Electron UtilityProcess.
 *
 * @returns The port number the server is listening on.
 * @throws If the server fails to start within 15 seconds.
 */
export async function startServer(): Promise<number> {
  const port = await getFreePort();
  const dorkHome = path.join(app.getPath('home'), '.dork');

  child = utilityProcess.fork(path.join(__dirname, '../server-entry.js'), [], {
    env: {
      ...process.env,
      DORKOS_PORT: String(port),
      DORK_HOME: dorkHome,
      NODE_ENV: 'production',
    },
  });

  // Wait for the server to signal readiness
  const onEarlyExit = (code: number) => {
    clearTimeout(timeout);
    if (code !== 0) reject(new Error(`Server exited with code ${code}`));
  };
  let reject: (reason: Error) => void;
  let timeout: NodeJS.Timeout;

  await new Promise<void>((res, rej) => {
    reject = rej;
    timeout = setTimeout(() => rej(new Error('Server start timeout')), 15_000);
    child!.on('message', (msg: { type: string }) => {
      if (msg.type === 'ready') {
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
  child.on('exit', (code) => {
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
    child.postMessage({ type: 'shutdown' });
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
