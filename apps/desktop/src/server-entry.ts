/**
 * Server entry point for the Electron UtilityProcess.
 *
 * This file runs in an isolated process spawned by the main process.
 * It starts the DorkOS Express server and signals readiness via IPC.
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

async function main() {
  if (!process.parentPort) {
    throw new Error('server-entry must run inside an Electron UtilityProcess');
  }
  const parentPort = process.parentPort;
  const port = Number(process.env.DORKOS_PORT);

  // Import triggers server start — the server reads DORKOS_PORT and DORK_HOME from env
  await import('@dorkos/server');

  // Verify server is actually responding
  await waitForServer(port);

  // Signal to main process that server is ready
  parentPort.postMessage({ type: 'ready' });

  // Listen for shutdown signal from main process
  parentPort.on('message', (event) => {
    if (event.data?.type === 'shutdown') {
      process.exit(0);
    }
  });
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
