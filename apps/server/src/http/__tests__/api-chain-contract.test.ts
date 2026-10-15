/**
 * Native Hono successor to the retired Express/Hono chain-parity matrix.
 * Public protocol, caller attribution, original credential admission and raw
 * Node response behavior are asserted directly; there is no obsolete router oracle.
 * @vitest-environment node
 */
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { tunnelManager } from '../../services/core/tunnel-manager.js';
import { logger } from '../../lib/logger.js';
import {
  openContractFixture,
  RECORDING_PATH,
  RAW_PATH,
  MIDSTREAM_PATH,
  THROWABLE,
  type Probe,
  type Answer,
} from './api-chain-contract-fixture.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
let fixture: Awaited<ReturnType<typeof openContractFixture>>;
beforeAll(async () => {
  fixture = await openContractFixture();
});
afterAll(async () => {
  await fixture?.close();
});
beforeEach(() => {
  fixture.setLogin(false);
  fixture.recorded.length = 0;
});
const HOSTS = { loopback: 'localhost:4242', foreign: 'rebound.example:4242' } as const;
const ORIGINS = {
  none: undefined,
  loopback: 'http://localhost:4242',
  foreign: 'https://evil.example',
} as const;
function credentials(): Record<string, Record<string, string>> {
  return {
    none: {},
    'good cookie': { cookie: fixture.cookie },
    'bad cookie': { cookie: 'better-auth.session_token=forged' },
    'good api key': { authorization: `Bearer ${fixture.apiKey}` },
    'bad api key': { authorization: 'Bearer forged' },
    'good agent token': { 'x-dorkos-agent': fixture.agentToken },
    'unknown agent token': { 'x-dorkos-agent': 'forged' },
    'agent token and api key': {
      'x-dorkos-agent': fixture.agentToken,
      authorization: `Bearer ${fixture.apiKey}`,
    },
  };
}
const REQUESTS: Record<string, Probe> = {
  'GET the probe': { method: 'GET', path: '/api/chain-probe' },
  'POST JSON': {
    method: 'POST',
    path: '/api/chain-probe',
    headers: { 'content-type': 'application/json' },
    body: '{"hello":"world"}',
  },
  'DELETE the probe': { method: 'DELETE', path: '/api/chain-probe' },
  'POST self-recording route': {
    method: 'POST',
    path: RECORDING_PATH,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  },
  preflight: {
    method: 'OPTIONS',
    path: '/api/chain-probe',
    headers: {
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, x-client-id',
    },
  },
  'public health': { method: 'GET', path: '/api/health/chain-probe' },
  'gated deep health': { method: 'GET', path: '/api/health/deep/chain-probe' },
  'unknown GET': { method: 'GET', path: '/api/no-such-route' },
  'unknown POST': { method: 'POST', path: '/api/no-such-route' },
  'trailing slash': { method: 'GET', path: '/api/chain-probe/' },
  query: { method: 'GET', path: '/api/chain-probe?x=1' },
  HEAD: { method: 'HEAD', path: '/api/chain-probe' },
  'raw Node response': { method: 'GET', path: RAW_PATH },
};

function assertCell(
  answer: Answer,
  probe: Probe,
  login: boolean,
  host: string,
  origin: string | undefined,
  credential: string
) {
  const signedIn = ['good cookie', 'good api key', 'agent token and api key'].includes(credential);
  const publicHealth = probe.path === '/api/health/chain-probe';
  const expected =
    origin === ORIGINS.foreign
      ? 500
      : probe.method === 'OPTIONS'
        ? 204
        : !login && host === HOSTS.foreign
          ? 403
          : login && !publicHealth && !signedIn
            ? 401
            : probe.path === '/api/no-such-route'
              ? 404
              : 200;
  expect(answer.status).toBe(expected);
  expect(answer.complete).toBe(true);
  if (origin !== ORIGINS.foreign && probe.method !== 'OPTIONS') {
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(answer.headers['access-control-allow-origin']).toBe(origin ?? null);
    if (origin) expect(answer.headers['access-control-allow-credentials']).toBe('true');
  }
  if (origin !== ORIGINS.foreign && probe.method === 'OPTIONS') {
    expect(answer.headers['access-control-allow-methods']).toBe('GET,HEAD,PUT,PATCH,POST,DELETE');
    expect(answer.headers['access-control-allow-headers']).toBe('content-type,x-client-id');
  }
  if (origin === ORIGINS.loopback) expect(answer.headers.vary?.split(',')).toContain('origin');
  if (expected === 200) {
    expect(answer.headers['cache-control']).toBeNull();
    expect(answer.headers['content-type']).toBe(
      probe.path === RAW_PATH ? 'text/plain' : 'application/json'
    );
  }
  if (expected === 404 && probe.method === 'POST') expect(answer.audit).toHaveLength(1);
  if ([204, 401, 403, 500].includes(expected)) expect(answer.audit).toEqual([]);
  if (expected === 401 && probe.method !== 'HEAD')
    expect(answer.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
  if (expected !== 200 || probe.method === 'HEAD' || probe.path === RAW_PATH) return;
  const hasAgent = ['good agent token', 'agent token and api key'].includes(credential);
  const presentsAgent = hasAgent || credential === 'unknown agent token';
  // Main attributes browser/owner calls to app; an agent header or admitted API key is http.
  const surface =
    presentsAgent || (login && !publicHealth && credential === 'good api key') ? 'http' : 'app';
  expect(answer.body).toMatchObject({
    method: probe.method,
    agent: hasAgent ? '/agents/scout' : null,
    surface,
  });
  if (login && !publicHealth && signedIn) {
    expect(answer.body).toMatchObject({
      user: {
        userId: fixture.ownerId,
        credential: credential === 'good cookie' ? 'cookie' : 'api-key',
      },
      credentialCurrent: true,
    });
  } else expect(answer.body).toMatchObject({ user: null, credentialCurrent: null });
  if (hasAgent)
    expect(answer.body).toMatchObject({
      actor: { kind: 'agent', accountId: 'unregistered:0d8063fc76a8798e', name: 'Scout' },
    });
  else if (credential === 'unknown agent token')
    expect(answer.body).toMatchObject({ actor: { kind: 'external', accountId: 'unidentified' } });
  else expect(answer.body).toMatchObject({ actor: { kind: 'person', accountId: fixture.ownerId } });
  if (['POST', 'DELETE'].includes(probe.method)) {
    expect(answer.audit).toHaveLength(1);
    const report = answer.body as { actor: unknown; credential: unknown };
    expect(answer.audit[0]).toMatchObject({ actor: report.actor, source: { surface } });
    if (report.credential) expect(answer.audit[0]).toMatchObject({ credential: report.credential });
  } else expect(answer.audit).toEqual([]);
  if (probe.path === RECORDING_PATH)
    expect(answer.audit[0]).toMatchObject({ action: 'probe.recorded' });
}

describe('login × host × origin × real credential × request contract', () => {
  for (const login of [false, true])
    for (const [hostName, host] of Object.entries(HOSTS))
      for (const [originName, origin] of Object.entries(ORIGINS))
        it(`login ${login}, ${hostName} host, ${originName} origin`, async () => {
          fixture.setLogin(login);
          for (const [credentialName, credential] of Object.entries(credentials()))
            for (const probe of Object.values(REQUESTS)) {
              const answer = await fixture.send({
                ...probe,
                headers: { host, ...(origin ? { origin } : {}), ...credential, ...probe.headers },
              });
              assertCell(answer, probe, login, host, origin, credentialName);
            }
        });
});

describe('request bodies before the session gate', () => {
  const json = { host: HOSTS.loopback, 'content-type': 'application/json' };
  const cases: Array<[string, Probe, number, unknown?]> = [
    [
      'JSON',
      { method: 'POST', path: '/api/chain-probe', headers: json, body: '{"a":[1,2]}' },
      200,
      { a: [1, 2] },
    ],
    [
      'malformed JSON',
      { method: 'POST', path: '/api/chain-probe', headers: json, body: '{"a":' },
      500,
    ],
    [
      'top-level string',
      { method: 'POST', path: '/api/chain-probe', headers: json, body: '"just a string"' },
      500,
    ],
    [
      'oversized JSON',
      {
        method: 'POST',
        path: '/api/chain-probe',
        headers: json,
        body: JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }),
      },
      413,
    ],
    [
      'empty length',
      { method: 'POST', path: '/api/chain-probe', headers: json, body: '' },
      200,
      {},
    ],
    [
      'empty chunked',
      { method: 'POST', path: '/api/chain-probe', headers: json, body: '', chunked: true },
      200,
      {},
    ],
    [
      'absent',
      { method: 'POST', path: '/api/chain-probe', headers: { host: HOSTS.loopback } },
      200,
      null,
    ],
    [
      'not JSON',
      {
        method: 'POST',
        path: '/api/chain-probe',
        headers: { ...json, 'content-type': 'text/plain' },
        body: 'hello',
      },
      200,
      null,
    ],
    [
      'gzip',
      {
        method: 'POST',
        path: '/api/chain-probe',
        headers: { ...json, 'content-encoding': 'gzip' },
        body: gzipSync('{"zipped":true}'),
      },
      200,
      { zipped: true },
    ],
    [
      'unsupported charset',
      {
        method: 'POST',
        path: '/api/chain-probe',
        headers: { ...json, 'content-type': 'application/json; charset=latin1' },
        body: '{"a":1}',
      },
      500,
    ],
    [
      'oversized without credentials',
      {
        method: 'POST',
        path: '/api/chain-probe',
        headers: json,
        body: JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }),
      },
      413,
    ],
  ];
  for (const [name, probe, status, body] of cases)
    it(name, async () => {
      fixture.setLogin(name === 'oversized without credentials');
      const answer = await fixture.send(probe);
      expect(answer.status).toBe(status);
      if (status === 200) expect((answer.body as { body: unknown }).body).toEqual(body);
      else
        expect(answer.body).toMatchObject({
          code: status === 413 ? 'REQUEST_TOO_LARGE' : 'INTERNAL_ERROR',
        });
    });
});

describe('errors, native response and shutdown', () => {
  for (const kind of Object.keys(THROWABLE))
    it(`handles ${kind}`, async () => {
      const answer = await fixture.send({
        method: 'GET',
        path: `/api/chain-probe/throw/${kind}`,
        headers: { host: HOSTS.loopback },
      });
      expect(answer.status).toBe(kind === 'boundary' ? 403 : kind === 'too-large' ? 413 : 500);
    });
  it('writes raw response bytes with the browser headers', async () => {
    const answer = await fixture.send({
      method: 'GET',
      path: RAW_PATH,
      headers: { host: HOSTS.loopback, origin: ORIGINS.loopback },
    });
    expect(answer).toMatchObject({
      status: 200,
      body: 'written to the Node response',
      complete: true,
    });
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(answer.headers['access-control-allow-origin']).toBe(ORIGINS.loopback);
  });
  it('cuts off a failed stream and logs its original error', async () => {
    vi.mocked(logger.error).mockClear();
    const answer = await fixture.send({
      method: 'GET',
      path: MIDSTREAM_PATH,
      headers: { host: HOSTS.loopback },
    });
    expect(answer).toMatchObject({ status: 200, body: 'partly ', complete: false });
    expect(logger.error).toHaveBeenCalledWith(
      '[DorkOS Error]',
      'failed mid-stream',
      expect.objectContaining({ path: MIDSTREAM_PATH })
    );
  });
  it('refuses an unmanaged arrival at a managed host', async () => {
    const managed = tunnelManager as unknown as { managedHosts?: string[] };
    managed.managedHosts = ['abc.remote.example'];
    try {
      const answer = await fixture.send({
        method: 'GET',
        path: '/api/chain-probe',
        headers: { host: 'abc.remote.example' },
      });
      expect(answer.status).toBe(403);
      expect(answer.body).toEqual({ error: 'Forbidden.' });
    } finally {
      delete managed.managedHosts;
    }
  });
  // Hono decodes the path and folds dot segments before the gate; the gate
  // also folds case and slash runs for the private deep-health carve-out.
  const spellings = [
    '/API/chain-probe',
    '/api/CHAIN-PROBE',
    '/api/chain-probe/',
    '/api//chain-probe',
    '/api/chain%2Dprobe',
    '/api/health/deep/chain-probe/',
    '/api/health//deep/chain-probe',
    '/api/HEALTH/DEEP/chain-probe',
    '/api/health/%64eep/chain-probe',
    '/api/health/./deep/chain-probe',
    '/api/health/x/../deep/chain-probe',
  ];
  for (const path of spellings)
    it(`gates ${path}`, async () => {
      fixture.setLogin(true);
      expect(
        (await fixture.send({ method: 'GET', path, headers: { host: HOSTS.loopback } })).status
      ).toBe(401);
    });
  it('keeps case-sensitive native routing with login off', async () => {
    expect(
      (
        await fixture.send({
          method: 'GET',
          path: '/API/chain-probe',
          headers: { host: HOSTS.loopback },
        })
      ).status
    ).toBe(404);
  });
  it('refuses the next request when its real admission closes', async () => {
    fixture.admission.close();
    const answer = await fixture.send({
      method: 'GET',
      path: '/api/chain-probe',
      headers: { host: HOSTS.loopback },
    });
    expect(answer.status).toBe(503);
  });
});
