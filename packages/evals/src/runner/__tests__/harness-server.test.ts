/**
 * In-process harness server: boots a real DorkOS server against a sandbox
 * `DORK_HOME`, serves `GET /api/health` (200), and frees its port on
 * `dispose()`. This proves the additive `@dorkos/server/harness-boot` export
 * path — `bootInProcessTestServer()` wiring the config store, sandbox DB,
 * session-event store, and a default `TestModeRuntime` — plus the `listen(0)`
 * bind a real driven turn needs.
 *
 * Also pins the PR #331 hardening: `dispose()` restores the `process.env` the
 * boot mutated (`DORK_HOME`, `DORKOS_TEST_RUNTIME`) — a prior value is put back,
 * a prior-unset var is deleted again — so a torn-down server never leaves the
 * env pointing at its deleted sandbox.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createSandbox, type Sandbox } from '../sandbox.js';
import {
  startInProcessServer,
  startChildProcessServer,
  DEFAULT_CHEAP_MODEL,
  type HarnessServer,
} from '../harness-server.js';
import type { IsolationLauncher, ServerExit, ServerLaunchSpec } from '../isolation/index.js';
import { driveTurn } from '../drive.js';

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
/** Throwaway HTTP servers a test spun up; closed after each test. */
let scratchServers: http.Server[] = [];

afterEach(async () => {
  await server?.dispose();
  await sandbox?.cleanup();
  await Promise.all(
    scratchServers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
  scratchServers = [];
  server = undefined;
  sandbox = undefined;
});

/** A stub launched-server that stands in for a real credentialed boot (no process spawned). */
function fakeLaunched(
  baseUrl: string,
  opts: { exited?: Promise<ServerExit>; onKill?: () => void } = {}
): {
  launcher: IsolationLauncher;
  spec: () => ServerLaunchSpec | undefined;
  killed: () => boolean;
} {
  let killed = false;
  let captured: ServerLaunchSpec | undefined;
  const launcher: IsolationLauncher = {
    id: 'fake',
    launch: async (s) => {
      captured = s;
      return {
        baseUrl,
        kill: async () => {
          killed = true;
          opts.onKill?.();
        },
        exited: opts.exited ?? new Promise<ServerExit>(() => {}),
      };
    },
  };
  return { launcher, spec: () => captured, killed: () => killed };
}

/** A throwaway server that answers `GET /api/health` with 200 (a healthy stand-in). */
async function startHealthyServer(): Promise<string> {
  const s = http.createServer((req, res) => {
    if ((req.url ?? '').endsWith('/api/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  scratchServers.push(s);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

/** Bind then release a port so nothing listens there — a connect yields ECONNREFUSED. */
async function closedBaseUrl(): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

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

describe('startChildProcessServer (isolation seam)', () => {
  it('allocates a port, launches through the injected launcher, polls to health, and dispose() kills it', async () => {
    const baseUrl = await startHealthyServer();
    const fake = fakeLaunched(baseUrl);

    const booted = await startChildProcessServer({
      dorkHome: '/tmp/sandbox-dork',
      anthropicApiKey: 'sk-test',
      launcher: fake.launcher,
      readyTimeoutMs: 5_000,
    });

    expect(booted.baseUrl).toBe(baseUrl);
    expect(booted.dorkHome).toBe('/tmp/sandbox-dork');
    // The launch spec carried the sandbox, a pre-allocated port, and the
    // credentialed env (the key + the cheap default model).
    const spec = fake.spec();
    expect(spec?.dorkHome).toBe('/tmp/sandbox-dork');
    expect(spec?.host).toBe('127.0.0.1');
    expect(spec?.port).toBeGreaterThan(0);
    expect(spec?.env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(spec?.env.ANTHROPIC_MODEL).toBe(DEFAULT_CHEAP_MODEL);

    await booted.dispose();
    expect(fake.killed()).toBe(true);
  });

  it('passes an explicit model through as ANTHROPIC_MODEL', async () => {
    const baseUrl = await startHealthyServer();
    const fake = fakeLaunched(baseUrl);

    const booted = await startChildProcessServer({
      dorkHome: '/tmp/sandbox-dork',
      model: 'claude-sonnet-4-5',
      launcher: fake.launcher,
      readyTimeoutMs: 5_000,
    });
    expect(fake.spec()?.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-5');
    await booted.dispose();
  });

  it('rejects — and kills the launch — when the server exits before becoming healthy', async () => {
    const baseUrl = await closedBaseUrl();
    const fake = fakeLaunched(baseUrl, {
      exited: Promise.resolve({ code: 1, signal: null, stderr: 'boom: boot crashed' }),
    });

    await expect(
      startChildProcessServer({
        dorkHome: '/tmp/x',
        anthropicApiKey: 'k',
        launcher: fake.launcher,
        readyTimeoutMs: 3_000,
      })
    ).rejects.toThrow(/exited before becoming healthy/);
    // A failed boot must still tear the launch down — no leaked process/port.
    expect(fake.killed()).toBe(true);
  });

  it('rejects — and kills the launch — when health never goes green within the budget', async () => {
    const baseUrl = await closedBaseUrl();
    const fake = fakeLaunched(baseUrl);

    await expect(
      startChildProcessServer({
        dorkHome: '/tmp/x',
        anthropicApiKey: 'k',
        launcher: fake.launcher,
        readyTimeoutMs: 300,
      })
    ).rejects.toThrow(/did not become healthy/);
    expect(fake.killed()).toBe(true);
  });
});

// Gated: only runs when a real ANTHROPIC_API_KEY is present (the judgment CI
// tier), never in the default vitest run. Proves the real child-process boot
// end-to-end: spawn the server from its TS source (via tsx), drive a trivial
// prompt, collect a terminal `done`.
// eslint-disable-next-line no-restricted-syntax -- gating on the real credentialed secret is the whole point of this test.
const HAS_ANTHROPIC_KEY = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!HAS_ANTHROPIC_KEY)('startChildProcessServer (credentialed, real)', () => {
  it('boots the real server as a child process and drives a trivial prompt to a terminal done', async () => {
    sandbox = await createSandbox();
    // eslint-disable-next-line no-restricted-syntax -- the gated test reads the real secret to pass it to the credentialed boot.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    server = await startChildProcessServer({ dorkHome: sandbox.dorkHome, anthropicApiKey: apiKey });

    const res = await driveTurn({
      baseUrl: server.baseUrl,
      sessionId: randomUUID(),
      content: 'Reply with the single word: pong.',
      cwd: sandbox.projectCwd,
      timeoutMs: 90_000,
    });

    expect(res.outcome).toBe('done');
  }, 180_000);
});
