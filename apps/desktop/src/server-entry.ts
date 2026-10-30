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

import path from 'node:path';
import {
  applyExtraCaCerts,
  shareCompanyCertificatesWithAgents,
  COMPANY_CERTIFICATES_STATUS,
  readCompanyCertificatesPath,
} from './extra-ca-certs';
import { exitWhenOrphaned } from './orphan-watchdog';
import { SERVER_READY_TIMEOUT_MS } from './shared/boot-timeouts';

// Mark this file as a module so the ambient declaration above and the
// top-level helpers below stay file-scoped instead of leaking into the
// global scope of the whole program.
export {};

/**
 * The data directory whose `config.json` names the company certificates.
 *
 * The same answer as `main/dork-home.ts`'s `resolveDataDirectory`, reached from
 * inside the child. In a packaged app `DORK_HOME` is always the one the main
 * process set when it forked this process (`buildServerEnv` overwrites
 * whatever the launching environment exported), so an exported variable can
 * not move it. The certificate path itself is read from that file, never from
 * the environment, which is what keeps `launchctl setenv` from choosing what
 * this process trusts (DOR-3361). In dev, `DORK_HOME` passes through and the
 * fallback is the project-local `<cwd>/.temp/.dork` the main process uses too.
 */
function serverDataDirectory(): string {
  return process.env.DORK_HOME ?? path.join(process.cwd(), '.temp', '.dork');
}

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

/** Whether a parent message is `{ type }`. */
function isMessage(msg: unknown, type: string): boolean {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as { type: unknown }).type === type
  );
}

async function main() {
  // Before the server opens any connection: a company network's certificates,
  // which the fused app binary no longer reads by itself (DOR-3361), and only
  // from the file a person set. The server reports the result in Settings.
  const companyCertificates = applyExtraCaCerts({
    file: readCompanyCertificatesPath(serverDataDirectory()),
  });
  (globalThis as Record<symbol, unknown>)[COMPANY_CERTIFICATES_STATUS] = companyCertificates;
  shareCompanyCertificatesWithAgents(companyCertificates);
  exitWhenOrphaned();
  const port = Number(process.env.DORKOS_PORT);

  // Import triggers server start — the server reads DORKOS_PORT and DORK_HOME from env
  await import('@dorkos/server');

  // Verify server is actually responding
  await waitForServer(port);

  // Signal to main process that server is ready
  sendToParent({ type: 'ready' });

  // Listen for shutdown signal from main process
  let shutdownRequested = false;
  onParentMessage((msg) => {
    // The window signs in by itself (F3): the server's mint lives in this
    // process, under a global it sets only when the desktop app runs it.
    if (isMessage(msg, 'mint-sign-in-code')) {
      const mint = (globalThis as Record<symbol, unknown>)[
        Symbol.for('dorkos.desktop.mintSignInCode')
      ] as (() => string | null) | undefined;
      sendToParent({ type: 'sign-in-code', code: mint ? mint() : null });
      return;
    }
    if (
      msg &&
      typeof msg === 'object' &&
      'type' in msg &&
      (msg as { type: string }).type === 'shutdown' &&
      !shutdownRequested
    ) {
      // The server's signal handler joins runtime/computer cleanup before exit.
      // Repeated IPC must not become the second signal that forces an early exit.
      shutdownRequested = true;
      process.emit('SIGTERM');
    }
  });
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
