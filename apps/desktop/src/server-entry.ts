/**
 * Server entry point for the desktop app's server process.
 *
 * Runs in either:
 * - Electron UtilityProcess (production) — IPC via process.parentPort
 * - child_process.fork via tsx (development) — IPC via process.send
 */

/** Poll the health endpoint until the server is responding. */
async function waitForServer(port: number, timeoutMs = 10_000): Promise<void> {
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

async function main() {
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
