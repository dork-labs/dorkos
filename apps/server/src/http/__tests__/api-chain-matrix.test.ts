/**
 * The chain matrix: what the chain (`http/api-chain.ts`) answers in every cell
 * of login on/off × `Origin` × `Host` × credential × request, and for odd
 * bodies, thrown errors, a stopping server and a managed hostname.
 *
 * Each answer is checked against a snapshot RECORDED FROM THE EXPRESS CHAIN
 * the server ran until DOR-2818, when this file was the chain-parity matrix
 * (`plans/2026-10-express-to-hono.md`, item 4) and required the Hono chain to
 * answer every cell exactly as Express did: the status, the body, the headers
 * a browser or a client acts on, who the probe was told is calling, and the
 * audit row the request left. Express is gone; its answers stay the bar. A
 * snapshot that changes is a change to how every route is gated, attributed
 * or recorded, and must be argued for as one, never updated in passing.
 *
 * The run's random ids (the owner, its API key, their hashes) are replaced by
 * placeholders before comparing (`stable`).
 *
 * Better Auth is real, on a throwaway database, so the cookie and the API key
 * are the genuine article. The agent-token store is faked at its seam
 * (`getAgentIdentityService`), since minting a token needs a registered agent.
 *
 * @vitest-environment node
 */
import { createServer, request as httpRequest, type RequestListener, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { createDb, runMigrations, user } from '@dorkos/db';

const state = vi.hoisted(() => ({ login: false }));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'auth' ? { enabled: state.login } : undefined)),
    set: vi.fn(),
  },
}));
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../services/core/agent-identity/agent-identity-service.js', async (original) => {
  const actual =
    await original<typeof import('../../services/core/agent-identity/agent-identity-service.js')>();
  return {
    ...actual,
    getAgentIdentityService: () => ({
      resolve: async (token: string) =>
        token === GOOD_AGENT_TOKEN
          ? { agentPath: '/agents/scout', displayName: 'Scout', createdAt: '2026-10-10T00:00:00Z' }
          : undefined,
    }),
  };
});

import { createApiApp, type ApiEnv } from '../api-chain.js';
import { frontDoorListener } from '../front-door.js';
import { readJsonBody } from '../request-body.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { tunnelManager } from '../../services/core/tunnel-manager.js';
import { currentAuditActor } from '../../services/audit/audit-context.js';
import { initAuditTrail, resetAuditTrail } from '../../services/audit/audit-trail.js';
import { recordAudit } from '../../services/audit/audit-trail.js';
import { BoundaryError } from '../../lib/boundary.js';
import { logger } from '../../lib/logger.js';
import { initAuth } from '../../services/core/auth/index.js';
import type { Context } from 'hono';

const GOOD_AGENT_TOKEN = 'good-agent-token';
/**
 * Set once the owner has signed in, before any cell runs. Made in process, so
 * it counts only at this computer: at a foreign `Host` it is no session at all
 * (DOR-2969).
 */
let GOOD_COOKIE = '';
/** A real per-user API key for the owner. */
let GOOD_API_KEY = '';
let ownerId = '';
/** The owner's API key record id. */
let apiKeyId = '';
const authHome = mkdtempSync(path.join(tmpdir(), 'dorkos-chain-parity-'));
afterAll(() => rmSync(authHome, { recursive: true, force: true }));

// Driving hundreds of real requests is slow on a machine running other suites.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

/** Every audit row the chain wrote, in order. */
const recorded: unknown[] = [];

beforeAll(() => {
  const actor = (type: string, id: string) => ({ type, id, name: id });
  initAuditTrail({
    log: {
      record: (input: unknown) => {
        recorded.push(input);
        return input;
      },
    },
    accounts: {
      installAccountId: () => 'install',
      owner: () => actor('person', 'owner'),
      system: () => actor('system', 'dorkos'),
      forUser: (userId: string) => actor('person', userId),
      forAgentIdentity: (identity?: { agentPath: string }) =>
        identity ? actor('agent', identity.agentPath) : actor('agent', 'unidentified'),
    },
  } as never);
});
afterAll(() => resetAuditTrail());

/** What the probe reports about the request it was handed. */
function probeReport(method: string, body: unknown, user: unknown, agent: unknown) {
  const scope = currentAuditActor();
  return {
    method,
    body: body ?? null,
    user: user ?? null,
    agent: (agent as { agentPath?: string } | undefined)?.agentPath ?? null,
    actor: scope?.actor ?? null,
    surface: scope?.surface ?? null,
    credential: scope?.credential ?? null,
  };
}

/** What the probe can throw, by name. */
const THROWABLE: Record<string, () => unknown> = {
  plain: () => new Error('the probe broke'),
  'not-an-error': () => 'a thrown string',
  boundary: () => new BoundaryError('outside', 'OUTSIDE_BOUNDARY'),
  'too-large': () => Object.assign(new Error('too big'), { type: 'entity.too.large' }),
};

/**
 * A route that records its own audit row, so the fallback must stay quiet.
 * (Not `/probe`: the fallback skips paths ending in it as checks, not actions.)
 */
const RECORDING_PATH = '/api/chain-probe/records';
/** A route that writes the Node response itself, as an event stream does. */
const RAW_PATH = '/api/chain-probe/raw';
/** A route that fails after its response has started. */
const MIDSTREAM_PATH = '/api/chain-probe/midstream';

function buildChain(admission: MainRequestAdmission) {
  const app = createApiApp({ admission });
  const probe = (c: Context<ApiEnv>) =>
    c.json(probeReport(c.req.method, readJsonBody(c), c.get('user'), c.get('agentIdentity')));
  app.all('/api/chain-probe', probe);
  app.all('/api/health/chain-probe', probe);
  app.all('/api/health/deep/chain-probe', probe);
  app.post(RECORDING_PATH, (c) => {
    recordAudit({ action: 'probe.recorded', operation: 'execute', summary: 'probe' } as never);
    return probe(c);
  });
  app.all('/api/chain-probe/throw/:kind', (c) => {
    throw THROWABLE[c.req.param('kind')]!();
  });
  app.get(RAW_PATH, (c) => {
    c.env.outgoing.writeHead(200, { 'content-type': 'text/plain' });
    c.env.outgoing.end('written to the Node response');
    return new Response(null, { headers: RESPONSE_ALREADY_SENT.headers });
  });
  app.get(MIDSTREAM_PATH, (c) => {
    c.env.outgoing.writeHead(200, { 'content-type': 'text/plain' });
    c.env.outgoing.write('partly ');
    throw new Error('failed mid-stream');
  });
  return app;
}

/** One request, as raw bytes go out: `fetch` would rewrite `Host`. */
interface Probe {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  /** Send the body chunked, with no `Content-Length`. */
  chunked?: boolean;
}

/** The parts of an answer the matrix compares. */
interface Answer {
  status: number;
  /** `Set-Cookie`, kept out of the comparison: Better Auth signs each one afresh. */
  cookies: string[];
  body: unknown;
  headers: Record<string, string | null>;
  /** Whether the whole response arrived, or the server cut it off. */
  complete: boolean;
  audit: unknown[];
}

/** Headers a client or browser acts on; nothing else is compared. */
const COMPARED_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'x-content-type-options',
  'cache-control',
];

/**
 * `Vary` as a set, the allowed headers without spacing, and the content type
 * without its charset: the recorded answers came from Express, which wrote
 * `application/json; charset=utf-8` where Hono writes `application/json`, and
 * reflected the requested header list as sent where `hono/cors` trims it.
 */
function normalizeHeaders(raw: Record<string, string | string[] | undefined>) {
  const one = (name: string) => {
    const value = raw[name];
    return value === undefined ? null : Array.isArray(value) ? value.join(', ') : value;
  };
  const headers: Record<string, string | null> = {};
  for (const name of COMPARED_HEADERS) headers[name] = one(name);
  const allowHeaders = headers['access-control-allow-headers'];
  if (allowHeaders) headers['access-control-allow-headers'] = allowHeaders.replace(/\s+/g, '');
  const vary = one('vary');
  headers.vary = vary
    ? [...new Set(vary.split(',').map((v) => v.trim().toLowerCase()))].sort().join(',')
    : null;
  headers['content-type'] = one('content-type')?.split(';')[0]?.trim() ?? null;
  return headers;
}

/**
 * The same, for a whole response. A `204` drops its content type: the Hono
 * Node adapter labels every bodiless response `text/plain`, Express labeled
 * none, and there is no body for the label to describe.
 */
function normalizeResponse(status: number, raw: Record<string, string | string[] | undefined>) {
  const headers = normalizeHeaders(raw);
  if (status === 204) headers['content-type'] = null;
  return headers;
}

async function send(port: number, probe: Probe): Promise<Answer> {
  const before = recorded.length;
  const answer = await new Promise<Omit<Answer, 'audit'>>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: probe.method, path: probe.path, headers: probe.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        // A response the server cuts off ends in `close` and an `error`, not `end`.
        res.on('error', () => {});
        res.on('close', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            // Not JSON: compare the text.
          }
          resolve({
            status: res.statusCode ?? 0,
            cookies: res.headers['set-cookie'] ?? [],
            body,
            headers: normalizeResponse(res.statusCode ?? 0, res.headers),
            complete: res.complete,
          });
        });
      }
    );
    // A connection closed before any response arrived is an answer too.
    req.on('error', (error: NodeJS.ErrnoException) =>
      error.code === 'ECONNRESET'
        ? resolve({ status: 0, cookies: [], body: null, headers: {}, complete: false })
        : reject(error)
    );
    if (probe.body !== undefined && !probe.chunked)
      req.setHeader('content-length', Buffer.byteLength(probe.body));
    req.end(probe.body);
  });
  // The fallback writes on the server's `finish`, which can land just after
  // the client has the last byte.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { ...answer, audit: recorded.slice(before) };
}

async function listen(listener: RequestListener): Promise<{ server: Server; port: number }> {
  const server = createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: (server.address() as AddressInfo).port };
}

const admission = new MainRequestAdmission();
let port = 0;
const servers: Server[] = [];

beforeAll(async () => {
  const db = createDb(path.join(authHome, 'auth.db'));
  runMigrations(db);
  const auth = initAuth(db, authHome);
  // A real owner, a real session cookie and a real API key, from Better Auth
  // itself: what is under test is the chain around it, not its routes.
  const account = { email: 'owner' + '@' + 'dork.test', password: 'correct-horse-battery-staple' };
  const signUp = await auth.api.signUpEmail({
    body: { ...account, name: 'Owner' },
    asResponse: true,
  });
  expect(signUp.status).toBe(200);
  GOOD_COOKIE = signUp.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
  ownerId = db.select().from(user).get()!.id;
  const created = await auth.api.createApiKey({ body: { userId: ownerId, name: 'parity' } });
  GOOD_API_KEY = created.key;
  apiKeyId = created.id;
  recorded.length = 0;
  // Served the way the server serves it (`http/front-door.ts`).
  const served = await listen(frontDoorListener(buildChain(admission)));
  servers.push(served.server);
  port = served.port;
});
afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});
beforeEach(() => {
  state.login = false;
});

/** An answer without its cookies, which Better Auth signs afresh each time. */
type Comparable = Omit<Answer, 'cookies'>;

/** An answer with the run's random ids (the owner, its API key) replaced, for a snapshot. */
function stable(answer: Comparable): Comparable {
  const keyId = apiKeyId;
  const hash = (id: string) => createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 12);
  let text = JSON.stringify(answer)
    .replaceAll(ownerId, '<owner>')
    .replaceAll(hash(ownerId), '<owner-hash>')
    .replace(/"sessionId":"[^"]+"/g, '"sessionId":"<session>"');
  if (keyId) text = text.replaceAll(keyId, '<key>').replaceAll(hash(keyId), '<key-hash>');
  return JSON.parse(text) as Comparable;
}

/** Send one request to the chain and return its answer, ready to compare. */
async function answer(probe: Probe, to = port): Promise<Comparable> {
  const { cookies: _cookies, ...rest } = await send(to, probe);
  return rest;
}

const HOSTS = { loopback: 'localhost:4242', foreign: 'rebound.example:4242' } as const;
const ORIGINS = {
  none: undefined,
  loopback: 'http://localhost:4242',
  foreign: 'https://evil.example',
} as const;
/** The credentials a caller can present; read after the owner has signed in. */
function credentials(): Record<string, Record<string, string>> {
  return {
    none: {},
    'good cookie': { cookie: GOOD_COOKIE },
    'bad cookie': { cookie: 'better-auth.session_token=forged' },
    'good api key': { authorization: `Bearer ${GOOD_API_KEY}` },
    'bad api key': { authorization: 'Bearer forged' },
    'good agent token': { 'x-dorkos-agent': GOOD_AGENT_TOKEN },
    'unknown agent token': { 'x-dorkos-agent': 'forged' },
    'agent token and api key': {
      'x-dorkos-agent': GOOD_AGENT_TOKEN,
      authorization: `Bearer ${GOOD_API_KEY}`,
    },
  };
}
const REQUESTS: Record<string, Probe> = {
  'GET the probe': { method: 'GET', path: '/api/chain-probe' },
  'POST JSON to the probe': {
    method: 'POST',
    path: '/api/chain-probe',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  },
  'DELETE the probe': { method: 'DELETE', path: '/api/chain-probe' },
  'POST to a route that records itself': {
    method: 'POST',
    path: RECORDING_PATH,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  },
  'preflight the probe': {
    method: 'OPTIONS',
    path: '/api/chain-probe',
    headers: {
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, x-client-id',
    },
  },
  'GET an exempt health path': { method: 'GET', path: '/api/health/chain-probe' },
  'GET under the deep health report': { method: 'GET', path: '/api/health/deep/chain-probe' },
  'GET an unknown /api path': { method: 'GET', path: '/api/no-such-route' },
  'POST to an unknown /api path': { method: 'POST', path: '/api/no-such-route' },
  'GET the probe with a trailing slash': { method: 'GET', path: '/api/chain-probe/' },
  'GET the probe with a query': { method: 'GET', path: '/api/chain-probe?x=1' },
  'HEAD the probe': { method: 'HEAD', path: '/api/chain-probe' },
  'GET a route that writes the Node response itself': { method: 'GET', path: RAW_PATH },
};

describe('the chain matrix', () => {
  for (const login of [false, true]) {
    for (const [hostName, host] of Object.entries(HOSTS)) {
      for (const [originName, origin] of Object.entries(ORIGINS)) {
        it(`login ${login ? 'on' : 'off'}, ${hostName} host, ${originName} origin`, async () => {
          state.login = login;
          for (const [credentialName, credential] of Object.entries(credentials())) {
            for (const [requestName, request] of Object.entries(REQUESTS)) {
              const headers = {
                host,
                ...(origin ? { origin } : {}),
                ...credential,
                ...request.headers,
              };
              const answered = await answer({ ...request, headers });
              expect(stable(answered)).toMatchSnapshot(`${credentialName}, ${requestName}`);
            }
          }
        });
      }
    }
  }

  it('really varies: the cells it compares do not all answer alike', async () => {
    // A snapshot of one status for everything would match in every cell. Pin a few
    // cells that must differ from each other.
    const loopback = { host: HOSTS.loopback };
    state.login = false;
    expect(
      (await answer({ method: 'GET', path: '/api/chain-probe', headers: loopback })).status
    ).toBe(200);
    expect(
      (await answer({ method: 'GET', path: '/api/chain-probe', headers: { host: HOSTS.foreign } }))
        .status
    ).toBe(403);
    expect(
      (
        await answer({
          method: 'GET',
          path: '/api/chain-probe',
          headers: { ...loopback, origin: ORIGINS.foreign },
        })
      ).status
    ).toBe(403);
    state.login = true;
    expect(
      (await answer({ method: 'GET', path: '/api/chain-probe', headers: loopback })).status
    ).toBe(401);
    const signedIn = await answer({
      method: 'POST',
      path: '/api/chain-probe',
      headers: { ...loopback, cookie: GOOD_COOKIE },
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toMatchObject({ user: { userId: ownerId, credential: 'cookie' } });
    expect(signedIn.audit).toHaveLength(1);
    const withKey = await answer({
      method: 'GET',
      path: '/api/chain-probe',
      headers: { ...loopback, authorization: `Bearer ${GOOD_API_KEY}` },
    });
    expect(withKey.body).toMatchObject({
      user: { userId: ownerId, credential: 'api-key' },
      surface: 'http',
    });
    const asAgent = await answer({
      method: 'GET',
      path: '/api/chain-probe',
      headers: { ...loopback, cookie: GOOD_COOKIE, 'x-dorkos-agent': GOOD_AGENT_TOKEN },
    });
    expect(asAgent.body).toMatchObject({
      agent: '/agents/scout',
      actor: { type: 'agent', id: '/agents/scout' },
    });
  });
});

describe('bodies', () => {
  const json = { host: HOSTS.loopback, 'content-type': 'application/json' };
  const BODIES: Record<string, Probe> = {
    'well-formed JSON': {
      method: 'POST',
      path: '/api/chain-probe',
      headers: json,
      body: '{"a":[1,2]}',
    },
    'malformed JSON': { method: 'POST', path: '/api/chain-probe', headers: json, body: '{"a":' },
    'a top-level string (strict mode)': {
      method: 'POST',
      path: '/api/chain-probe',
      headers: json,
      body: '"just a string"',
    },
    'a body over the 1 MB limit': {
      method: 'POST',
      path: '/api/chain-probe',
      headers: json,
      body: JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }),
    },
    'an empty body with a length': {
      method: 'POST',
      path: '/api/chain-probe',
      headers: json,
      body: '',
    },
    'an empty chunked body': {
      method: 'POST',
      path: '/api/chain-probe',
      headers: json,
      body: '',
      chunked: true,
    },
    'no body at all': {
      method: 'POST',
      path: '/api/chain-probe',
      headers: { host: HOSTS.loopback },
    },
    'a body that is not JSON': {
      method: 'POST',
      path: '/api/chain-probe',
      headers: { host: HOSTS.loopback, 'content-type': 'text/plain' },
      body: 'hello',
    },
    'a gzipped JSON body': {
      method: 'POST',
      path: '/api/chain-probe',
      headers: { ...json, 'content-encoding': 'gzip' },
      body: gzipSync('{"zipped":true}'),
    },
    'a charset JSON may not use': {
      method: 'POST',
      path: '/api/chain-probe',
      headers: { host: HOSTS.loopback, 'content-type': 'application/json; charset=latin1' },
      body: '{"a":1}',
    },
    'an oversized body from a caller with no credential, login on': {
      method: 'POST',
      path: '/api/chain-probe',
      headers: json,
      body: JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }),
    },
  };

  for (const [name, probe] of Object.entries(BODIES)) {
    it(`reads ${name} the same way`, async () => {
      state.login = name.endsWith('login on');
      expect(stable(await answer(probe))).toMatchSnapshot();
    });
  }
});

describe('errors', () => {
  for (const kind of Object.keys(THROWABLE)) {
    it(`answers a route that throws a ${kind} error the same way`, async () => {
      const answered = await answer({
        method: 'GET',
        path: `/api/chain-probe/throw/${kind}`,
        headers: { host: HOSTS.loopback },
      });
      expect(answered.status).toBeGreaterThanOrEqual(400);
      expect(stable(answered)).toMatchSnapshot();
    });
  }
});

describe('a stopping server', () => {
  it('refuses every request alike once the server is stopping', async () => {
    const closing = new MainRequestAdmission();
    const served = await listen(frontDoorListener(buildChain(closing)));
    try {
      closing.close();
      const probe = { method: 'GET', path: '/api/chain-probe', headers: { host: HOSTS.loopback } };
      const answered = await answer(probe, served.port);
      expect(answered.status).toBe(503);
      expect(stable(answered)).toMatchSnapshot();
    } finally {
      served.server.close();
    }
  });
});

describe('a managed hostname that skipped the managed ingress', () => {
  it('is refused alike, before any route', async () => {
    const managed = tunnelManager as unknown as { managedHosts?: string[] };
    managed.managedHosts = ['abc.remote.example'];
    const served = await listen(frontDoorListener(buildChain(new MainRequestAdmission())));
    try {
      const probe = {
        method: 'GET',
        path: '/api/chain-probe',
        headers: { host: 'abc.remote.example' },
      };
      const answered = await answer(probe, served.port);
      expect(answered.status).toBe(403);
      expect(answered.body).toEqual({ error: 'Forbidden.' });
      expect(stable(answered)).toMatchSnapshot();
    } finally {
      delete managed.managedHosts;
      served.server.close();
    }
  });
});

describe('a route that fails after its response has started', () => {
  it('is cut off the same way, and the Hono chain still logs it', async () => {
    vi.mocked(logger.error).mockClear();
    const answered = await answer({
      method: 'GET',
      path: MIDSTREAM_PATH,
      headers: { host: HOSTS.loopback },
    });
    expect(answered).toMatchObject({ status: 200, body: 'partly ', complete: false });
    expect(stable(answered)).toMatchSnapshot();
    expect(logger.error).toHaveBeenCalledWith(
      '[DorkOS Error]',
      'failed mid-stream',
      expect.objectContaining({ path: MIDSTREAM_PATH })
    );
  });
});

describe('odd spellings of a gated path', () => {
  // The gate must refuse the path the router would route, however it is
  // spelled: Hono decodes first and has already folded dot segments. No
  // spelling may hand a credential-less caller a 2xx.
  const SPELLINGS = [
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

  for (const spelling of SPELLINGS) {
    it(`never answers ${spelling} without a credential, login on`, async () => {
      state.login = true;
      const answered = await answer({
        method: 'GET',
        path: spelling,
        headers: { host: HOSTS.loopback },
      });
      // The gate runs before the 404 and judges the folded path, so it
      // refuses every one.
      expect(answered.status).toBe(401);
    });
  }

  it('pins the one routing difference from Express: paths are case-sensitive', async () => {
    // Express routed `/API/chain-probe` to the probe; Hono finds no route.
    // Every group inherits this (see the module doc of `http/api-chain.ts`).
    const answered = await answer({
      method: 'GET',
      path: '/API/chain-probe',
      headers: { host: HOSTS.loopback },
    });
    expect(answered.status).toBe(404);
  });
});
