/**
 * API oracle: `httpGetAssert` against a stub server — a PASSING case (expected
 * status + body predicate) and FAILING cases (wrong status, failed body
 * predicate) so a broken always-pass oracle is caught.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { emptyApprovalLog, type OracleContext } from '../../types.js';
import { httpGetAssert, httpRequestAssert } from '../api.js';

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
    approvals: emptyApprovalLog(),
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

/** What the echo stub saw of the last request. */
interface Seen {
  method?: string;
  agent?: string | string[];
  contentType?: string | string[];
  body?: string;
}

/**
 * Boot a stub that records the request and answers 403 to a caller carrying
 * `x-dorkos-agent`, 204 to anyone else — the shape of a person-only write.
 */
async function startPersonOnlyStub(seen: Seen): Promise<string> {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      seen.method = req.method;
      seen.agent = req.headers['x-dorkos-agent'];
      seen.contentType = req.headers['content-type'];
      seen.body = raw;
      if (req.headers['x-dorkos-agent']) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'extension_person_required' }));
        return;
      }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('httpRequestAssert', () => {
  it('sends the method, headers and JSON body it was given', async () => {
    const seen: Seen = {};
    const baseUrl = await startPersonOnlyStub(seen);
    const result = await httpRequestAssert(
      { method: 'PUT', path: '/api/ext/x/quotes', json: { quotes: ['a'] } },
      { status: [200, 204] }
    )(ctx(baseUrl));
    expect(result.passed).toBe(true);
    expect(seen.method).toBe('PUT');
    expect(seen.contentType).toBe('application/json');
    expect(JSON.parse(seen.body ?? '')).toEqual({ quotes: ['a'] });
    expect(seen.agent).toBeUndefined();
  });

  it('passes a refusal it expects, and only when the header made it one', async () => {
    const seen: Seen = {};
    const baseUrl = await startPersonOnlyStub(seen);
    const asAgent = httpRequestAssert(
      { method: 'PUT', path: '/q', headers: { 'x-dorkos-agent': 'eval-agent' }, json: {} },
      { status: 403 }
    );
    expect((await asAgent(ctx(baseUrl))).passed).toBe(true);
    expect(seen.agent).toBe('eval-agent');

    // The same expectation without the header is a failure: the write went through.
    const asPerson = httpRequestAssert({ method: 'PUT', path: '/q', json: {} }, { status: 403 });
    const result = await asPerson(ctx(baseUrl));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('expected status 403, got 204');
  });

  it('names every status it would have accepted when none matched', async () => {
    const baseUrl = await startStub(500, { error: 'boom' });
    const result = await httpRequestAssert(
      { method: 'POST', path: '/api/extensions/x/init-server' },
      { status: [200, 201] }
    )(ctx(baseUrl));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('expected status one of 200, 201, got 500');
    expect(result.label).toBe('POST /api/extensions/x/init-server');
  });

  it('fails when the server cannot be reached', async () => {
    const result = await httpRequestAssert({ method: 'POST', path: '/x' })(
      ctx('http://127.0.0.1:1')
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toBeDefined();
  });
});
