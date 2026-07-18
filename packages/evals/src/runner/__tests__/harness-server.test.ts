/**
 * In-process harness server: boots a real DorkOS server against a sandbox
 * `DORK_HOME`, serves `GET /api/health` (200), and frees its port on
 * `dispose()`. This proves the additive `@dorkos/server/app` export path and
 * the `createApp()`/`finalizeApp()` + `listen(0)` boot the spec calls for.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createSandbox, type Sandbox } from '../sandbox.js';
import { startInProcessServer, type HarnessServer } from '../harness-server.js';

let server: HarnessServer | undefined;
let sandbox: Sandbox | undefined;

afterEach(async () => {
  await server?.dispose();
  await sandbox?.cleanup();
  server = undefined;
  sandbox = undefined;
});

describe('startInProcessServer', () => {
  it('boots against the sandbox DORK_HOME and serves GET /api/health with 200', async () => {
    sandbox = await createSandbox();
    server = await startInProcessServer({ dorkHome: sandbox.dorkHome });

    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.dorkHome).toBe(sandbox.dorkHome);

    const res = await fetch(`${server.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('dispose() frees the port so a fresh server can bind and respond', async () => {
    sandbox = await createSandbox();
    const first = await startInProcessServer({ dorkHome: sandbox.dorkHome });
    const url = `${first.baseUrl}/api/health`;
    expect((await fetch(url)).status).toBe(200);

    await first.dispose();

    // After dispose the socket is gone — a fetch to the freed port must fail.
    await expect(fetch(url)).rejects.toThrow();

    // And a brand-new server binds a fresh port and answers.
    server = await startInProcessServer({ dorkHome: sandbox.dorkHome });
    expect((await fetch(`${server.baseUrl}/api/health`)).status).toBe(200);
  });
});
