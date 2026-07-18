/**
 * In-process harness server: boots a real DorkOS server against a sandbox
 * `DORK_HOME`, serves `GET /api/health` (200), and frees its port on
 * `dispose()`. This proves the additive `@dorkos/server/app` export path and
 * the `createApp()`/`finalizeApp()` + `listen(0)` boot the spec calls for.
 *
 * Also pins the PR #331 hardening: `dispose()` restores the `process.env` the
 * boot mutated (`DORK_HOME`, `DORKOS_TEST_RUNTIME`) — a prior value is put back,
 * a prior-unset var is deleted again — so a torn-down server never leaves the
 * env pointing at its deleted sandbox.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createSandbox, type Sandbox } from '../sandbox.js';
import { startInProcessServer, type HarnessServer } from '../harness-server.js';

// The env-restoration test necessarily reads and writes process.env directly to
// assert the harness's own env bookkeeping; the app's env.ts indirection does
// not apply here. Centralize those touches behind this disabled block.
/* eslint-disable no-restricted-syntax -- this test asserts process.env restoration directly */
function readEnv(key: string): string | undefined {
  return process.env[key];
}
function writeEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
/* eslint-enable no-restricted-syntax */

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

  it('dispose() restores process.env: a prior value is put back and a prior-unset var is deleted', async () => {
    const priorDorkHome = readEnv('DORK_HOME');
    const priorTestRuntime = readEnv('DORKOS_TEST_RUNTIME');
    try {
      // Prior state: DORK_HOME holds a sentinel; DORKOS_TEST_RUNTIME is unset.
      writeEnv('DORK_HOME', '/prior/dork-home');
      writeEnv('DORKOS_TEST_RUNTIME', undefined);

      sandbox = await createSandbox();
      const booted = await startInProcessServer({ dorkHome: sandbox.dorkHome });

      // While booted, the boot env points at the sandbox.
      expect(readEnv('DORK_HOME')).toBe(sandbox.dorkHome);
      expect(readEnv('DORKOS_TEST_RUNTIME')).toBe('true');

      await booted.dispose();

      // After dispose: the prior value is restored and the prior-unset var is gone.
      expect(readEnv('DORK_HOME')).toBe('/prior/dork-home');
      expect(readEnv('DORKOS_TEST_RUNTIME')).toBeUndefined();
    } finally {
      // Fully restore the ambient env so no other test inherits the sentinel.
      writeEnv('DORK_HOME', priorDorkHome);
      writeEnv('DORKOS_TEST_RUNTIME', priorTestRuntime);
    }
  });
});
