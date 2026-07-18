/**
 * API oracle: `httpGetAssert` against a stub server — a PASSING case (expected
 * status + body predicate) and FAILING cases (wrong status, failed body
 * predicate) so a broken always-pass oracle is caught.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OracleContext } from '../../types.js';
import { httpGetAssert } from '../api.js';

let server: http.Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** Boot a stub server that answers `path` with `status` + JSON `body`. */
async function startStub(status: number, body: unknown): Promise<string> {
  server = http.createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Build an OracleContext pointed at `baseUrl`. */
function ctx(baseUrl: string): OracleContext {
  return {
    sandbox: { dorkHome: '/unused', projectCwd: '/unused' },
    baseUrl,
    sessionId: 's',
    frames: [],
  };
}

describe('httpGetAssert', () => {
  it('passes on the expected status and a satisfied body predicate', async () => {
    const baseUrl = await startStub(200, { status: 'ok' });
    const result = await httpGetAssert('/api/health', {
      status: 200,
      body: (b) => (b as { status: string }).status === 'ok',
    })(ctx(baseUrl));
    expect(result.passed).toBe(true);
  });

  it('fails on an unexpected status (the endpoint erred)', async () => {
    const baseUrl = await startStub(500, { error: 'boom' });
    const result = await httpGetAssert('/api/tasks', { status: 200 })(ctx(baseUrl));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('expected status 200, got 500');
  });

  it('fails when the body predicate is not satisfied', async () => {
    const baseUrl = await startStub(200, { tasks: [] });
    const result = await httpGetAssert('/api/tasks', {
      status: 200,
      body: (b) => (b as { tasks: unknown[] }).tasks.length > 0,
    })(ctx(baseUrl));
    expect(result.passed).toBe(false);
  });
});
