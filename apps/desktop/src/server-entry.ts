/**
 * Server entry point for the desktop app's server process.
 *
 * Runs in either:
 * - Electron UtilityProcess (production) — IPC via process.parentPort
 * - child_process.fork via tsx (development) — IPC via process.send
 */

/**
 * Ambient shadow for `@dorkos/server`.
 *
 * The dynamic `import('@dorkos/server')` below exists purely to trigger the
 * module's side effect (starting the Express server) — its exports are
 * never used. `@dorkos/server`'s package.json maps its `.` export straight
 * to TypeScript source, so without this shadow `tsc` traces the entire
 * server source tree as part of this program, which compiles under a
 * different `tsconfig.json` (module/moduleResolution) than this app's and
 * produces spurious cross-program type errors unrelated to the desktop app.
 */
declare module '@dorkos/server';

import { SERVER_READY_TIMEOUT_MS } from './shared/boot-timeouts';

/** How often the dev child re-checks that the process that spawned it is still alive. */
const ORPHAN_CHECK_INTERVAL_MS = 2_000;

// Mark this file as a module so the ambient declaration above and the
// top-level helpers below stay file-scoped instead of leaking into the
// global scope of the whole program.
export {};

/**
 * Poll the health endpoint until the server is responding.
 *
 * The default window rationale lives on {@link SERVER_READY_TIMEOUT_MS}.
 */
async function waitForServer(port: number, timeoutMs = SERVER_READY_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Server did not become ready in time');
}

/** Send a message to the parent process (works in both UtilityProcess and fork). */
function sendToParent(msg: unknown): void {
  if (process.parentPort) {
    // Electron UtilityProcess
    process.parentPort.postMessage(msg);
  } else if (process.send) {
    // child_process.fork
    process.send(msg);
  } else {
    throw new Error('server-entry must run inside a UtilityProcess or child_process.fork');
  }
}

/** Listen for messages from the parent process. */
function onParentMessage(handler: (msg: unknown) => void): void {
  if (process.parentPort) {
    // UtilityProcess: messages arrive as MessageEvent with .data
    process.parentPort.on('message', (event) => handler(event.data));
  } else {
    // child_process.fork: messages arrive directly
    process.on('message', handler);
  }
}

/**
 * Is `pid` still running?
 *
 * Signal 0 runs the kernel's existence and permission checks without
 * delivering anything. `EPERM` means the process is there but owned by someone
 * else — alive is alive; only `ESRCH` means it is gone.
 *
 * Known limit: a pid is not a durable identity. If the shell's pid is recycled
 * by an unrelated process before the next poll, this reads "alive" and the
 * orphan keeps running — and a recycled *root-owned* pid answers `EPERM`
 * forever. Narrowing that needs the pid corroborated against its start time
 * (`ps -o lstart=`), which is the approach the server's instance lock takes;
 * this should adopt that helper rather than grow a second copy of it. Until
 * then the window is small and dev-only, and the failure mode is the one that
 * existed before this watchdog rather than a new one.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Shut down when the desktop shell that spawned this process goes away.
 *
 * Armed only in development, where the shell passes its own pid as
 * `DORKOS_PARENT_PID`. A packaged build leaves that unset and this is a no-op:
 * there the server runs in an Electron UtilityProcess, which Electron tears
 * down with the app. In dev it runs under `child_process.fork` instead, and a
 * fork outlives a parent that dies without cleaning up — it gets reparented to
 * init and keeps the port, the SQLite WAL lock and every live agent session,
 * so the next launch starts against a directory another process still owns.
 *
 * Watching an explicitly-passed pid is the only thing that works here, and the
 * two obvious alternatives were both measured failing before this was written.
 * `tsx` does not run this file in-process: it spawns the real server as a
 * *grandchild* of the shell and proxies IPC through itself. So from in here
 * `process.ppid` is the tsx wrapper, and the peer whose exit would fire
 * `process.on('disconnect')` is the tsx wrapper too. Neither notices Electron
 * dying — with the shell killed hard, a watchdog built on either one never
 * fired and the server was still holding its port seconds later. A pid handed
 * down from the shell sees straight through the wrapper.
 */
function exitWhenOrphaned(): void {
  // Unset, empty and malformed all land here: `Number(undefined)` is NaN and
  // `Number('')` is 0, and neither survives the guard. A packaged build also
  // deletes any inherited value (see server-spawn), so production never arms.
  const parentPid = Number(process.env.DORKOS_PARENT_PID);
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;

  // unref'd: this watchdog must never be the reason the process stays alive.
  setInterval(() => {
    if (isProcessAlive(parentPid)) return;
    console.error('Shutting the server down: the desktop app that started it is gone.');
    process.exit(0);
  }, ORPHAN_CHECK_INTERVAL_MS).unref();
}

async function main() {
  exitWhenOrphaned();
  const port = Number(process.env.DORKOS_PORT);

  // Import triggers server start — the server reads DORKOS_PORT and DORK_HOME from env
  await import('@dorkos/server');

  // Verify server is actually responding
  await waitForServer(port);

  // Signal to main process that server is ready
  sendToParent({ type: 'ready' });

  // Listen for shutdown signal from main process
  onParentMessage((msg) => {
    if (
      msg &&
      typeof msg === 'object' &&
      'type' in msg &&
      (msg as { type: string }).type === 'shutdown'
    ) {
      process.exit(0);
    }
  });
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
