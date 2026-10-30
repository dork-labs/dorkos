/**
 * Contract for the extension routes, which move to Hono in DOR-2810: managing
 * extensions (`/api/extensions`: list, enable, disable, approve, revoke, "Not
 * now", trusted sources, init-server, reload, the working-folder notice, the
 * bundle, an extension's data, secrets, settings, decisions, project settings
 * and start-work) and each running extension's own API under `/api/ext/:id`:
 * its router, its `dataProxy`, and the router of one that runs in its own
 * process. That PR must pass this file unchanged.
 *
 * Extensions are code from strangers, so most of this file is the trust
 * surface: an extension nobody approved serves nothing, one that is turned
 * off serves nothing, only a person may turn one on or allow it to run, and
 * an agent that names itself is refused all of those. What an approved
 * extension's router sees is pinned too, since authors build on it: its mount
 * (`req.baseUrl`), its path, the JSON body DorkOS already parsed for it, a
 * body DorkOS did not parse still readable as a stream, and what a route that
 * throws answers.
 *
 * Four servers:
 *
 * 1. Login off, nothing installed: shapes, validation answers, 404s and the
 *    refusals a caller earns with headers alone.
 * 2. Login off, driven by hand: three extensions copied into the server's
 *    data directory (one with a router, one with only a `dataProxy` to an
 *    upstream this file runs, one that runs in its own process), turned on,
 *    approved, used, turned off.
 * 3. Login off, extensions that serve with a `fetch` handler (DOR-2687):
 *    beside a router, as the server entry's only export, and in its own
 *    process.
 * 4. Login on: no credential is refused at the gate; an API key may not do
 *    what only a signed-in person does; the owner's cookie may.
 */
import http from 'node:http';
import { once } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  contractSuite,
  type ComposedServer,
  type ContractCase,
  stepUpAt,
} from './harness.js';

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
const CROSS_SITE = { Origin: 'https://evil.example' };
/** CORS refuses a page from another site before any route's own bar runs. */
const CORS_REFUSED = {
  error: 'Origin https://evil.example not allowed by CORS',
  code: 'INTERNAL_ERROR',
};
/** A DELETE's JSON body, framed: Node sends a DELETE body only with a length. */
const deleteBody = (body: object) => ({
  'content-length': String(Buffer.byteLength(JSON.stringify(body))),
});
const MALFORMED_JSON = z.object({ code: z.literal('INTERNAL_ERROR') }).loose();
const HOST_REFUSED = z.object({ code: z.literal('HOST_NOT_ALLOWED') }).loose();
const AUTH_REQUIRED = z.object({ code: z.literal('AUTH_REQUIRED') }).loose();
const COOKIE_REQUIRED = z.object({ code: z.literal('operator_cookie_required') }).loose();
const INVALID_ID = { error: 'Invalid extension ID' };
const refusal = (code: string) =>
  z.object({ error: z.string(), code: z.literal(code), message: z.string() }).strict();
const TOGGLE_REFUSED = refusal('operator_only_config');
const APPROVAL_REFUSED = refusal('extension_not_approved_to_run');
const TRUST_REFUSED = refusal('trusted_source_person_only');
const NO_ROUTES = (id: string) => ({ error: `Extension '${id}' has no server routes` });
const EXTENSION_LIST = z.array(
  z.object({ id: z.string(), status: z.string(), approvedToRun: z.boolean() }).loose()
);

/** The extension with a router, one with only a proxy, one in its own process. */
const ROUTED = 'contract-routed';
const PROXIED = 'contract-proxied';
const ISOLATED = 'contract-isolated';
/** An id nothing installs. */
const MISSING = 'contract-missing';

const CASES: ContractCase[] = [
  {
    name: 'lists the installed extensions: none but what DorkOS ships',
    path: '/api/extensions',
    expect: { status: 200, headers: JSON_TYPE, schema: EXTENSION_LIST },
  },
  {
    name: 'a trailing slash reaches the same list',
    path: '/api/extensions/',
    expect: { status: 200, schema: EXTENSION_LIST },
  },
  {
    name: 'nothing is waiting for approval',
    path: '/api/extensions/pending-approvals',
    expect: { status: 200, body: { approvals: [] } },
  },
  {
    name: 'no source is trusted yet',
    path: '/api/extensions/trusted-sources',
    expect: { status: 200, body: { sources: [] } },
  },
  {
    name: 'reload answers the list as it stands',
    method: 'POST',
    path: '/api/extensions/reload',
    expect: { status: 200, schema: EXTENSION_LIST },
  },
  {
    name: 'the working-folder notice validates its body',
    method: 'POST',
    path: '/api/extensions/cwd-changed',
    body: { cwd: 42 },
    expect: {
      status: 400,
      schema: z.object({ error: z.literal('Validation failed'), details: z.unknown() }),
    },
  },
  {
    name: 'the working-folder notice with no folder changes nothing',
    method: 'POST',
    path: '/api/extensions/cwd-changed',
    body: { cwd: null },
    expect: {
      status: 200,
      schema: z.object({ changed: z.boolean(), added: z.array(z.unknown()) }).loose(),
    },
  },
  {
    name: 'an id outside the manifest pattern is refused on enable',
    method: 'POST',
    path: '/api/extensions/Not_An_Id/enable',
    expect: { status: 400, body: INVALID_ID },
  },
  {
    name: 'an id outside the manifest pattern is refused on the bundle',
    path: '/api/extensions/Not_An_Id/bundle',
    expect: { status: 400, body: INVALID_ID },
  },
  {
    name: 'enable refuses an agent before saying whether the extension exists',
    method: 'POST',
    path: `/api/extensions/${MISSING}/enable`,
    headers: AGENT,
    expect: { status: 403, schema: TOGGLE_REFUSED },
  },
  {
    name: 'disable refuses an agent too: turning code off is a person’s call',
    method: 'POST',
    path: `/api/extensions/${MISSING}/disable`,
    headers: AGENT,
    expect: { status: 403, schema: TOGGLE_REFUSED },
  },
  {
    name: 'enable refuses a page from another site',
    method: 'POST',
    path: `/api/extensions/${MISSING}/enable`,
    headers: CROSS_SITE,
    expect: { status: 500, body: CORS_REFUSED },
  },
  {
    name: 'enable of an extension that is not installed is a 404',
    method: 'POST',
    path: `/api/extensions/${MISSING}/enable`,
    expect: {
      status: 404,
      body: { error: `Extension '${MISSING}' not found or cannot be enabled` },
    },
  },
  {
    name: 'disable of an extension that is not installed is a 404',
    method: 'POST',
    path: `/api/extensions/${MISSING}/disable`,
    expect: { status: 404, body: { error: `Extension '${MISSING}' not found` } },
  },
  {
    name: 'approve refuses an agent: it is the code being approved',
    method: 'POST',
    path: `/api/extensions/${MISSING}/approve`,
    headers: AGENT,
    expect: { status: 403, schema: APPROVAL_REFUSED },
  },
  {
    name: 'approve refuses a page from another site',
    method: 'POST',
    path: `/api/extensions/${MISSING}/approve`,
    headers: CROSS_SITE,
    expect: { status: 500, body: CORS_REFUSED },
  },
  {
    name: 'approve of an extension that is not installed is a 404',
    method: 'POST',
    path: `/api/extensions/${MISSING}/approve`,
    expect: { status: 404, body: { error: `Extension '${MISSING}' not found` } },
  },
  {
    name: 'revoke refuses an agent',
    method: 'POST',
    path: `/api/extensions/${MISSING}/revoke`,
    headers: AGENT,
    expect: { status: 403, schema: APPROVAL_REFUSED },
  },
  {
    name: 'revoke of an extension that is not installed is a 404',
    method: 'POST',
    path: `/api/extensions/${MISSING}/revoke`,
    expect: { status: 404, body: { error: `Extension '${MISSING}' not found` } },
  },
  {
    name: '"Not now" refuses an agent',
    method: 'POST',
    path: `/api/extensions/${MISSING}/dismiss-approval`,
    headers: AGENT,
    body: {},
    expect: { status: 403, schema: APPROVAL_REFUSED },
  },
  {
    name: '"Not now" needs the copy the person was shown',
    method: 'POST',
    path: `/api/extensions/${MISSING}/dismiss-approval`,
    body: {},
    expect: {
      status: 400,
      body: { error: 'Send the path and version of the extension you were shown' },
    },
  },
  {
    name: 'trusting a source refuses an agent',
    method: 'POST',
    path: '/api/extensions/trusted-sources',
    headers: AGENT,
    body: { source: 'dork-labs/marketplace' },
    expect: { status: 403, schema: TRUST_REFUSED },
  },
  {
    name: 'trusting a source needs one',
    method: 'POST',
    path: '/api/extensions/trusted-sources',
    body: {},
    expect: { status: 400, body: { error: 'Send the source to trust, like owner/repo' } },
  },
  {
    name: 'a source nothing came from cannot be trusted',
    method: 'POST',
    path: '/api/extensions/trusted-sources',
    body: { source: 'dork-labs/marketplace' },
    expect: {
      status: 409,
      schema: z.object({ code: z.literal('unproven_source') }).loose(),
    },
  },
  {
    name: 'stop trusting refuses an agent',
    method: 'DELETE',
    path: '/api/extensions/trusted-sources',
    headers: { ...AGENT, ...deleteBody({ source: 'dork-labs/marketplace' }) },
    body: { source: 'dork-labs/marketplace' },
    expect: { status: 403, schema: TRUST_REFUSED },
  },
  {
    name: 'stop trusting a source that is not trusted is a 404',
    method: 'DELETE',
    path: '/api/extensions/trusted-sources',
    headers: deleteBody({ source: 'dork-labs/marketplace' }),
    body: { source: 'dork-labs/marketplace' },
    expect: { status: 404, body: { error: "dork-labs/marketplace isn't a trusted source" } },
  },
  {
    name: 'starting a server half of an extension that is not installed says why',
    method: 'POST',
    path: `/api/extensions/${MISSING}/init-server`,
    expect: { status: 400, schema: z.object({ error: z.string() }).strict() },
  },
  {
    name: 'the bundle of an extension that is not installed is a 404',
    path: `/api/extensions/${MISSING}/bundle`,
    expect: { status: 404, body: { error: `Bundle not available for '${MISSING}'` } },
  },
  {
    name: 'the data of an extension that is not installed is a 404',
    path: `/api/extensions/${MISSING}/data`,
    expect: { status: 404, body: { error: `Extension '${MISSING}' not found` } },
  },
  {
    name: 'writing the data of an extension that is not installed is a 404',
    method: 'PUT',
    path: `/api/extensions/${MISSING}/data`,
    body: { a: 1 },
    expect: { status: 404, body: { error: `Extension '${MISSING}' not found` } },
  },
  {
    name: 'secrets of an extension that is not installed is a 404',
    path: `/api/extensions/${MISSING}/secrets`,
    expect: { status: 404, body: { error: `Extension '${MISSING}' not found` } },
  },
  {
    name: 'a secret needs a value',
    method: 'PUT',
    path: `/api/extensions/${MISSING}/secrets/token`,
    body: { value: '' },
    expect: { status: 400, schema: z.object({ error: z.literal('Validation failed') }).loose() },
  },
  {
    name: 'deleting a secret of an extension that is not installed is a 404',
    method: 'DELETE',
    path: `/api/extensions/${MISSING}/secrets/token`,
    expect: { status: 404, body: { error: `Extension '${MISSING}' not found` } },
  },
  {
    name: 'settings of an extension that is not installed is a 404',
    path: `/api/extensions/${MISSING}/settings`,
    expect: { status: 404, body: { error: `Extension '${MISSING}' not found` } },
  },
  {
    name: 'a setting needs a string, number or boolean',
    method: 'PUT',
    path: `/api/extensions/${MISSING}/settings/name`,
    body: { value: { nested: true } },
    expect: { status: 400, schema: z.object({ error: z.literal('Validation failed') }).loose() },
  },
  {
    name: 'resetting a setting of an extension that is not installed is a 404',
    method: 'DELETE',
    path: `/api/extensions/${MISSING}/settings/name`,
    expect: { status: 404, body: { error: `Extension '${MISSING}' not found` } },
  },
  {
    name: 'an extension’s open decisions',
    path: `/api/extensions/${MISSING}/decisions`,
    expect: { status: 200, body: { decisions: [], offers: [] } },
  },
  {
    name: 'answering a decision refuses an agent',
    method: 'POST',
    path: `/api/extensions/${MISSING}/decisions/01J00000000000000000000000/action`,
    headers: AGENT,
    body: { action: 'approve' },
    expect: { status: 403, schema: refusal('decision_person_required') },
  },
  {
    name: 'project settings need a folder',
    path: `/api/extensions/${MISSING}/project-settings`,
    expect: { status: 400, body: { error: 'Send ?project=<folder>' } },
  },
  {
    name: 'writing project settings refuses an agent',
    method: 'PUT',
    path: `/api/extensions/${MISSING}/project-settings`,
    headers: AGENT,
    body: { project: '/tmp', value: {} },
    expect: { status: 403, schema: refusal('extension_person_required') },
  },
  {
    name: 'starting work refuses an agent',
    method: 'POST',
    path: `/api/extensions/${MISSING}/start-work`,
    headers: AGENT,
    body: {},
    expect: { status: 403, schema: refusal('start_work_person_required') },
  },
  {
    name: 'starting work from an extension that is not installed is a 404',
    method: 'POST',
    path: `/api/extensions/${MISSING}/start-work`,
    body: {},
    expect: { status: 404, body: { error: `Extension '${MISSING}' not found` } },
  },
  {
    name: 'malformed JSON is the chain’s error',
    method: 'POST',
    path: '/api/extensions/cwd-changed',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
    expect: { status: 500, schema: MALFORMED_JSON },
  },
  {
    name: 'a foreign Host is refused before any route',
    path: '/api/extensions',
    headers: { host: 'evil.example' },
    expect: { status: 403, schema: HOST_REFUSED },
  },
  {
    name: 'an unknown path under the group is the /api 404',
    path: '/api/extensions/x/y/z/nothing',
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'an extension that is not running has no routes',
    path: `/api/ext/${MISSING}/anything`,
    expect: { status: 404, headers: JSON_TYPE, body: NO_ROUTES(MISSING) },
  },
  {
    name: 'nor at its mount itself',
    path: `/api/ext/${MISSING}`,
    expect: { status: 404, body: NO_ROUTES(MISSING) },
  },
  {
    name: 'nor for a POST with a body',
    method: 'POST',
    path: `/api/ext/${MISSING}/anything`,
    body: { a: 1 },
    expect: { status: 404, body: NO_ROUTES(MISSING) },
  },
  {
    name: 'nor behind a foreign Host, which is refused first',
    path: `/api/ext/${MISSING}/anything`,
    headers: { host: 'evil.example' },
    expect: { status: 403, schema: HOST_REFUSED },
  },
];

contractSuite('the extension routes (login off)', CASES);

/** One answer: its status, JSON body (or text) and headers. */
interface Answer {
  status: number;
  json: Record<string, unknown>;
  text: string;
  headers: http.IncomingHttpHeaders;
}

/** Send one request with `node:http` and return what it answered, whatever the status. */
/**
 * Approve an extension as the app does: the yes names the version and the
 * files its waiting card showed (DOR-3068), so a copy that changed since is
 * refused rather than approved unseen.
 */
async function approveAsThePerson(server: ComposedServer | undefined, id: string): Promise<Answer> {
  const pending = await call(server, 'GET', '/api/extensions/pending-approvals');
  const card = (
    pending.json as { approvals: { id: string; version: string; digest?: string }[] }
  ).approvals.find((approval) => approval.id === id);
  expect(card?.digest, `no waiting card with a digest for ${id}`).toMatch(/^sha256:/);
  return call(server, 'POST', `/api/extensions/${id}/approve`, {
    version: card!.version,
    expectedDigest: card!.digest,
  });
}

function call(
  server: ComposedServer | undefined,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Answer> {
  const payload =
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const sent: Record<string, string> = {
    ...(body !== undefined && typeof body !== 'string'
      ? { 'content-type': 'application/json' }
      : {}),
    ...headers,
  };
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(url, server!.baseUrl), { method, headers: sent }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => {
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // Not JSON.
        }
        resolve({ status: res.statusCode ?? 0, json, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Send one setup request, failing loudly when the server refuses it. */
async function setup(
  server: ComposedServer | undefined,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Answer> {
  const answer = await call(server, method, url, body, headers);
  if (answer.status >= 300) {
    throw new Error(`${method} ${url} answered ${answer.status}: ${answer.text}`);
  }
  return answer;
}

/** Check one case against a server booted in this file. */
async function check(server: ComposedServer | undefined, testCase: Omit<ContractCase, 'name'>) {
  await checkContractCase(server!.baseUrl, { name: testCase.path, ...testCase });
}

/**
 * The router extension's server half. No imports: DorkOS compiles it with
 * esbuild and `require`s it, and only the router and ctx are handed in.
 */
const ROUTED_SERVER = `
export default function register(router: any, ctx: any) {
  router.get('/where', (req: any, res: any) =>
    res.json({
      baseUrl: req.baseUrl,
      path: req.path,
      url: req.url,
      originalUrl: req.originalUrl,
      query: req.query,
      method: req.method,
    })
  );
  router.get('/items/:itemId', (req: any, res: any) => res.json({ params: req.params }));
  router.post('/echo', (req: any, res: any) =>
    res.json({ body: req.body === undefined ? 'none' : req.body })
  );
  router.post('/raw', (req: any, res: any) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (text += chunk));
    req.on('end', () => res.json({ text, body: req.body === undefined ? 'none' : req.body }));
  });
  router.post('/person', ctx.requirePerson, (_req: any, res: any) => res.json({ ok: true }));
  router.get('/status', (_req: any, res: any) =>
    res.status(418).set('x-contract', 'yes').type('text/plain').send('short and stout')
  );
  router.get('/boom', () => {
    throw new Error('the extension route broke');
  });
  router.get('/boom-later', async () => {
    throw new Error('the extension route broke later');
  });
  router.get('/handed-on', (_req: any, _res: any, next: any) => next(new Error('handed on')));
  router.get('/cookie', (req: any, res: any) => res.json({ cookie: req.headers.cookie ?? null }));
}
`;

/** The isolated extension's server half: the same shape, in its own process. */
const ISOLATED_SERVER = `
export default function register(router: any) {
  router.get('/where', (req: any, res: any) =>
    res.json({ baseUrl: req.baseUrl, path: req.path, originalUrl: req.originalUrl })
  );
  router.post('/echo', (req: any, res: any) =>
    res.json({ body: req.body === undefined ? 'none' : req.body })
  );
  router.get('/cookie', (req: any, res: any) => res.json({ cookie: req.headers.cookie ?? null }));
  router.get('/boom', () => {
    throw new Error('the isolated route broke');
  });
}
`;

/** Write one extension into the server's data directory. */
function install(dorkHome: string, id: string, manifest: object, server?: string): void {
  const dir = path.join(dorkHome, 'extensions', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'extension.json'),
    JSON.stringify({
      id,
      name: id,
      version: '1.0.0',
      description: 'A contract fixture',
      ...manifest,
    })
  );
  writeFileSync(path.join(dir, 'index.ts'), 'export function activate() {}\n');
  if (server) writeFileSync(path.join(dir, 'server.ts'), server);
}

describe('contract: the extension routes, driven by hand (login off)', () => {
  let server: ComposedServer | undefined;
  let upstream: http.Server | undefined;
  /** What the upstream last received. */
  let received: { url?: string; headers: http.IncomingHttpHeaders; body: string } | undefined;
  let dorkHome = '';

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        received = { url: req.url, headers: req.headers, body };
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-upstream-only', 'dropped');
        res.end(JSON.stringify({ upstream: true, url: req.url, method: req.method }));
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const port = (upstream.address() as AddressInfo).port;

    server = await bootComposedServer();
    const config = await setup(server, 'GET', '/api/config');
    dorkHome = config.json.dorkHome as string;
    install(
      dorkHome,
      ROUTED,
      { serverCapabilities: { serverEntry: './server.ts' } },
      ROUTED_SERVER
    );
    install(dorkHome, PROXIED, {
      serverCapabilities: {
        secrets: [{ key: 'token', label: 'Token' }],
        settings: [{ key: 'region', type: 'text', label: 'Region' }],
      },
      dataProxy: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        authHeader: 'X-Api-Key',
        authType: 'Custom',
        authSecret: 'token',
      },
    });
    install(
      dorkHome,
      ISOLATED,
      { serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' } },
      ISOLATED_SERVER
    );
    await setup(server, 'POST', '/api/extensions/reload', {});
    // The reload answers before its scan finishes; wait until all three are listed.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const listed = await setup(server, 'GET', '/api/extensions');
      const ids = (listed.json as unknown as { id: string }[]).map((e) => e.id);
      if ([ROUTED, PROXIED, ISOLATED].every((id) => ids.includes(id))) break;
      if (Date.now() > deadline) throw new Error(`Never listed: ${ids.join(', ')}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }, BOOT_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await server?.close();
    upstream?.close();
    if (dorkHome) rmSync(dorkHome, { recursive: true, force: true });
  }, 30_000);

  it('serves nothing for an extension nobody approved, even once it is turned on', async () => {
    for (const id of [ROUTED, PROXIED, ISOLATED]) {
      const enabled = await call(server, 'POST', `/api/extensions/${id}/enable`, {});
      expect(enabled.status, enabled.text).toBe(200);
      const started = await call(server, 'POST', `/api/extensions/${id}/init-server`, {});
      expect(started.status).toBe(400);
      expect(started.json.error).toEqual(expect.any(String));
      await check(server, {
        path: `/api/ext/${id}/where`,
        expect: { status: 404, body: NO_ROUTES(id) },
      });
    }
    await check(server, {
      path: '/api/extensions/pending-approvals',
      expect: {
        status: 200,
        schema: z.object({ approvals: z.array(z.object({ id: z.string() }).loose()).min(3) }),
      },
    });
  });

  it('refuses an agent the approval, and serves nothing after it', async () => {
    await check(server, {
      method: 'POST',
      path: `/api/extensions/${ROUTED}/approve`,
      headers: AGENT,
      body: {},
      expect: { status: 403, schema: APPROVAL_REFUSED },
    });
    await check(server, {
      path: `/api/ext/${ROUTED}/where`,
      expect: { status: 404, body: NO_ROUTES(ROUTED) },
    });
  });

  it('approves each extension for a person, and starts it', async () => {
    for (const id of [ROUTED, PROXIED, ISOLATED]) {
      const approved = await approveAsThePerson(server, id);
      expect(approved.status, approved.text).toBe(200);
      expect(approved.json.extension).toMatchObject({ id, approvedToRun: true });
      const started = await call(server, 'POST', `/api/extensions/${id}/init-server`, {});
      expect(started.status, started.text).toBe(200);
      expect(started.json).toEqual({ ok: true });
    }
  });

  it('lists them as approved', async () => {
    const listed = await setup(server, 'GET', '/api/extensions');
    const mine = (listed.json as unknown as { id: string; approvedToRun: boolean }[]).filter((e) =>
      [ROUTED, PROXIED, ISOLATED].includes(e.id)
    );
    expect(mine.map((e) => e.approvedToRun)).toEqual([true, true, true]);
  });

  it('shows an extension’s router its mount, path and query', async () => {
    await check(server, {
      path: `/api/ext/${ROUTED}/where?x=1&y=two`,
      expect: {
        status: 200,
        headers: { ...JSON_TYPE, 'x-content-type-options': 'nosniff' },
        body: {
          baseUrl: `/api/ext/${ROUTED}`,
          path: '/where',
          url: '/where?x=1&y=two',
          originalUrl: `/api/ext/${ROUTED}/where?x=1&y=two`,
          query: { x: '1', y: 'two' },
          method: 'GET',
        },
      },
    });
    await check(server, {
      path: `/api/ext/${ROUTED}/items/abc-123`,
      expect: { status: 200, body: { params: { itemId: 'abc-123' } } },
    });
  });

  it('hands an extension the JSON body DorkOS already parsed', async () => {
    await check(server, {
      method: 'POST',
      path: `/api/ext/${ROUTED}/echo`,
      body: { hello: 'world', n: 3 },
      expect: { status: 200, body: { body: { hello: 'world', n: 3 } } },
    });
    await check(server, {
      method: 'POST',
      path: `/api/ext/${ROUTED}/echo`,
      expect: { status: 200, body: { body: 'none' } },
    });
  });

  it('leaves a body DorkOS does not parse for the extension to read', async () => {
    await check(server, {
      method: 'POST',
      path: `/api/ext/${ROUTED}/raw`,
      headers: { 'content-type': 'text/plain' },
      body: 'plain words, not JSON',
      expect: { status: 200, body: { text: 'plain words, not JSON', body: 'none' } },
    });
  });

  it('refuses malformed JSON before the extension sees it', async () => {
    await check(server, {
      method: 'POST',
      path: `/api/ext/${ROUTED}/echo`,
      headers: { 'content-type': 'application/json' },
      body: '{not json',
      expect: { status: 500, schema: MALFORMED_JSON },
    });
  });

  it('passes the extension’s own status, type and headers through', async () => {
    await check(server, {
      path: `/api/ext/${ROUTED}/status`,
      expect: {
        status: 418,
        headers: { 'content-type': /^text\/plain\b/, 'x-contract': 'yes' },
        body: 'short and stout',
      },
    });
  });

  it('answers a route that throws with the server’s own error, and keeps serving', async () => {
    const thrown = z.object({ error: z.string(), code: z.literal('INTERNAL_ERROR') }).strict();
    await check(server, {
      path: `/api/ext/${ROUTED}/boom`,
      expect: {
        status: 500,
        body: { error: 'the extension route broke', code: 'INTERNAL_ERROR' },
        schema: thrown,
      },
    });
    await check(server, {
      path: `/api/ext/${ROUTED}/boom-later`,
      expect: {
        status: 500,
        body: { error: 'the extension route broke later', code: 'INTERNAL_ERROR' },
      },
    });
    await check(server, {
      path: `/api/ext/${ROUTED}/handed-on`,
      expect: { status: 500, body: { error: 'handed on', code: 'INTERNAL_ERROR' } },
    });
    await check(server, { path: '/api/health', expect: { status: 200 } });
  });

  it('answers a path the extension does not serve with the /api 404', async () => {
    await check(server, {
      path: `/api/ext/${ROUTED}/nothing-here`,
      expect: { status: 404, body: NOT_FOUND },
    });
  });

  it('gives an in-process extension the request as sent, cookie included', async () => {
    await check(server, {
      path: `/api/ext/${ROUTED}/cookie`,
      headers: { cookie: 'a=b' },
      expect: { status: 200, body: { cookie: 'a=b' } },
    });
  });

  it('runs the person bar for an extension route that asks for it', async () => {
    await check(server, {
      method: 'POST',
      path: `/api/ext/${ROUTED}/person`,
      headers: AGENT,
      body: {},
      expect: { status: 403, schema: refusal('extension_person_required') },
    });
    await check(server, {
      method: 'POST',
      path: `/api/ext/${ROUTED}/person`,
      headers: CROSS_SITE,
      body: {},
      expect: { status: 500, body: CORS_REFUSED },
    });
    await check(server, {
      method: 'POST',
      path: `/api/ext/${ROUTED}/person`,
      body: {},
      expect: { status: 200, body: { ok: true } },
    });
  });

  it('keeps an extension’s data, secrets and settings', async () => {
    await check(server, { path: `/api/extensions/${ROUTED}/data`, expect: { status: 204 } });
    await check(server, {
      method: 'PUT',
      path: `/api/extensions/${ROUTED}/data`,
      body: { visits: 2 },
      expect: { status: 200, body: { ok: true } },
    });
    await check(server, {
      path: `/api/extensions/${ROUTED}/data`,
      expect: { status: 200, body: { visits: 2 } },
    });
    await check(server, {
      path: `/api/extensions/${PROXIED}/secrets`,
      expect: {
        status: 200,
        body: [{ key: 'token', label: 'Token', required: false, isSet: false }],
      },
    });
    await check(server, {
      method: 'PUT',
      path: `/api/extensions/${PROXIED}/secrets/undeclared`,
      body: { value: 'x' },
      expect: {
        status: 400,
        body: { error: "Secret 'undeclared' not declared in extension manifest" },
      },
    });
    await check(server, {
      method: 'PUT',
      path: `/api/extensions/${PROXIED}/settings/region`,
      body: { value: 'eu' },
      expect: { status: 200, body: { ok: true } },
    });
    await check(server, {
      path: `/api/extensions/${PROXIED}/settings`,
      expect: {
        status: 200,
        schema: z.array(
          z
            .object({
              key: z.literal('region'),
              value: z.literal('eu'),
              isDefault: z.literal(false),
            })
            .loose()
        ),
      },
    });
    await check(server, {
      method: 'DELETE',
      path: `/api/extensions/${PROXIED}/settings/region`,
      expect: { status: 200, body: { ok: true } },
    });
  });

  it('serves the compiled bundle without caching', async () => {
    await check(server, {
      path: `/api/extensions/${ROUTED}/bundle`,
      expect: {
        status: 200,
        headers: { 'content-type': /^application\/javascript\b/, 'cache-control': 'no-store' },
      },
    });
  });

  it('says the proxy has no credential before one is set', async () => {
    await check(server, {
      path: `/api/ext/${PROXIED}/proxy/things`,
      expect: {
        status: 503,
        body: {
          error: `Secret 'token' not configured for extension '${PROXIED}'`,
          hint: `Set the secret via PUT /api/extensions/${PROXIED}/secrets/token`,
        },
      },
    });
  });

  it('proxies to the upstream with the stored credential, and none of the caller’s', async () => {
    await check(server, {
      method: 'PUT',
      path: `/api/extensions/${PROXIED}/secrets/token`,
      body: { value: 's3cret' },
      expect: { status: 200, body: { ok: true } },
    });
    await check(server, {
      path: `/api/ext/${PROXIED}/proxy/things/1?page=2`,
      headers: { cookie: 'session=mine', authorization: 'Bearer mine', ...AGENT },
      expect: {
        status: 200,
        headers: {
          ...JSON_TYPE,
          'ratelimit-limit': '120',
          'ratelimit-remaining': /^\d+$/,
          'x-upstream-only': null,
        },
        body: { upstream: true, url: '/v1/things/1?page=2', method: 'GET' },
      },
    });
    expect(received?.headers['x-api-key']).toBe('s3cret');
    expect(received?.headers.cookie).toBeUndefined();
    expect(received?.headers.authorization).toBeUndefined();
    expect(received?.headers['x-dorkos-agent']).toBeUndefined();

    await check(server, {
      method: 'POST',
      path: `/api/ext/${PROXIED}/proxy/things`,
      body: { make: 'one' },
      expect: { status: 200, body: { upstream: true, url: '/v1/things', method: 'POST' } },
    });
    expect(JSON.parse(received!.body)).toEqual({ make: 'one' });
  });

  it('refuses a proxy path that climbs out of the upstream base', async () => {
    await check(server, {
      path: `/api/ext/${PROXIED}/proxy/..%2f..%2fadmin`,
      expect: {
        status: 400,
        body: {
          error: 'Proxy path is outside the extension upstream',
          code: 'PROXY_PATH_NOT_ALLOWED',
        },
      },
    });
  });

  it('answers anything but the proxy on a proxy-only extension with the /api 404', async () => {
    await check(server, {
      path: `/api/ext/${PROXIED}/where`,
      expect: { status: 404, body: NOT_FOUND },
    });
  });

  it('forwards to an extension in its own process, without the person’s credentials', async () => {
    await check(server, {
      path: `/api/ext/${ISOLATED}/where?q=1`,
      expect: {
        status: 200,
        headers: {
          ...JSON_TYPE,
          'content-security-policy': "sandbox; default-src 'none'",
          'x-content-type-options': 'nosniff',
        },
        body: {
          baseUrl: `/api/ext/${ISOLATED}`,
          path: '/where',
          originalUrl: `/api/ext/${ISOLATED}/where?q=1`,
        },
      },
    });
    await check(server, {
      method: 'POST',
      path: `/api/ext/${ISOLATED}/echo`,
      body: { across: 'the boundary' },
      expect: { status: 200, body: { body: { across: 'the boundary' } } },
    });
    await check(server, {
      path: `/api/ext/${ISOLATED}/cookie`,
      headers: { cookie: 'session=mine' },
      expect: { status: 200, body: { cookie: null } },
    });
    await check(server, {
      path: `/api/ext/${ISOLATED}/boom`,
      expect: { status: 500, body: { error: 'the isolated route broke' } },
    });
    await check(server, {
      path: `/api/ext/${ISOLATED}/nothing-here`,
      expect: {
        status: 404,
        body: {
          error: `Extension '${ISOLATED}' has no route for /api/ext/${ISOLATED}/nothing-here`,
        },
      },
    });
  });

  it('serves nothing once an extension is turned off, and refuses an agent the switch', async () => {
    await check(server, {
      method: 'POST',
      path: `/api/extensions/${ROUTED}/disable`,
      headers: AGENT,
      body: {},
      expect: { status: 403, schema: TOGGLE_REFUSED },
    });
    await check(server, { path: `/api/ext/${ROUTED}/where`, expect: { status: 200 } });
    for (const id of [ROUTED, ISOLATED]) {
      const disabled = await call(server, 'POST', `/api/extensions/${id}/disable`, {});
      expect(disabled.status, disabled.text).toBe(200);
      await check(server, {
        path: `/api/ext/${id}/where`,
        expect: { status: 404, body: NO_ROUTES(id) },
      });
    }
  });

  it('serves nothing once its approval is withdrawn', async () => {
    const revoked = await call(server, 'POST', `/api/extensions/${PROXIED}/revoke`, {});
    expect(revoked.status, revoked.text).toBe(200);
    expect(revoked.json.extension).toMatchObject({ id: PROXIED, approvedToRun: false });
    await check(server, {
      path: `/api/ext/${PROXIED}/proxy/things`,
      expect: { status: 404, body: NO_ROUTES(PROXIED) },
    });
  });

  it('streams the deprecated lifecycle events', async () => {
    const opened = await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      first: string;
    }>((resolve, reject) => {
      const req = http.get(
        new URL('/api/extensions/events', server!.baseUrl),
        { agent: false },
        (res) => {
          res.setEncoding('utf8');
          res.once('data', (chunk: string) => {
            resolve({ status: res.statusCode ?? 0, headers: res.headers, first: chunk });
            req.destroy();
          });
        }
      );
      req.on('error', reject);
    });
    expect(opened.status).toBe(200);
    expect(opened.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(opened.headers['cache-control']).toBe('no-cache');
    expect(opened.first).toBe(':ok\n\n');
  });
});

/** An extension that serves with a router and a fetch handler together. */
const FETCHED = 'contract-fetched';
/** An extension whose server entry exports nothing but a fetch handler. */
const FETCH_DEFAULT = 'contract-fetch-default';
/** An extension in its own process that serves with a fetch handler. */
const ISOLATED_FETCHED = 'contract-isolated-fetched';

/** A fetch handler that describes the request it was given, or throws on `/boom`. */
const DESCRIBE_REQUEST = `
async (request: any) => {
  const url = new URL(request.url);
  if (url.pathname === '/boom') throw new Error('the fetch handler broke');
  return Response.json({
    method: request.method,
    path: url.pathname,
    search: url.search,
    cookie: request.headers.get('cookie'),
    body: request.method === 'GET' ? null : await request.text(),
  });
}`;

describe('contract: an extension served with a fetch handler (login off)', () => {
  let server: ComposedServer | undefined;
  let dorkHome = '';

  beforeAll(async () => {
    server = await bootComposedServer();
    const config = await setup(server, 'GET', '/api/config');
    dorkHome = config.json.dorkHome as string;
    install(
      dorkHome,
      FETCHED,
      { serverCapabilities: { serverEntry: './server.ts' } },
      `export default function register(router: any) {
  router.get('/from-router', (_req: any, res: any) => res.json({ from: 'router' }));
  return { fetch: ${DESCRIBE_REQUEST}, cleanup() {} };
}
`
    );
    install(
      dorkHome,
      FETCH_DEFAULT,
      { serverCapabilities: { serverEntry: './server.ts' } },
      `export default {
  fetch(request: any) {
    return new Response('plain:' + new URL(request.url).pathname, {
      headers: { 'content-type': 'text/plain' },
    });
  },
};
`
    );
    install(
      dorkHome,
      ISOLATED_FETCHED,
      { serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' } },
      `export default function register() {
  return { fetch: ${DESCRIBE_REQUEST} };
}
`
    );
    await setup(server, 'POST', '/api/extensions/reload', {});
    const deadline = Date.now() + 30_000;
    for (;;) {
      const listed = await setup(server, 'GET', '/api/extensions');
      const ids = (listed.json as unknown as { id: string }[]).map((e) => e.id);
      if ([FETCHED, FETCH_DEFAULT, ISOLATED_FETCHED].every((id) => ids.includes(id))) break;
      if (Date.now() > deadline) throw new Error(`Never listed: ${ids.join(', ')}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }, BOOT_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await server?.close();
    if (dorkHome) rmSync(dorkHome, { recursive: true, force: true });
  }, 30_000);

  it('serves nothing before a person approves it', async () => {
    for (const id of [FETCHED, FETCH_DEFAULT, ISOLATED_FETCHED]) {
      await setup(server, 'POST', `/api/extensions/${id}/enable`, {});
      await check(server, {
        path: `/api/ext/${id}/items`,
        expect: { status: 404, body: NO_ROUTES(id) },
      });
    }
  });

  it('starts each once a person approves it', async () => {
    for (const id of [FETCHED, FETCH_DEFAULT, ISOLATED_FETCHED]) {
      const approved = await approveAsThePerson(server, id);
      expect(approved.status, approved.text).toBe(200);
      const started = await call(server, 'POST', `/api/extensions/${id}/init-server`, {});
      expect(started.status, started.text).toBe(200);
    }
  });

  it('hands the fetch handler the path below the mount, with the query', async () => {
    await check(server, {
      path: `/api/ext/${FETCHED}/items/7?page=2`,
      headers: { cookie: 'session=mine' },
      expect: {
        status: 200,
        headers: { ...JSON_TYPE, 'x-content-type-options': 'nosniff' },
        body: {
          method: 'GET',
          path: '/items/7',
          search: '?page=2',
          cookie: 'session=mine',
          body: null,
        },
      },
    });
  });

  it('hands it a JSON body the chain parsed as JSON again, and any other body as sent', async () => {
    await check(server, {
      method: 'POST',
      path: `/api/ext/${FETCHED}/things`,
      body: { make: 'one' },
      expect: {
        status: 200,
        body: { method: 'POST', path: '/things', search: '', cookie: null, body: '{"make":"one"}' },
      },
    });
    await check(server, {
      method: 'POST',
      path: `/api/ext/${FETCHED}/notes`,
      headers: { 'content-type': 'text/plain' },
      body: 'plain words',
      expect: {
        status: 200,
        body: { method: 'POST', path: '/notes', search: '', cookie: null, body: 'plain words' },
      },
    });
  });

  it('asks the router first when an extension has both', async () => {
    await check(server, {
      path: `/api/ext/${FETCHED}/from-router`,
      expect: { status: 200, body: { from: 'router' } },
    });
  });

  it('answers a fetch handler that throws with the server’s own error, and keeps serving', async () => {
    await check(server, {
      path: `/api/ext/${FETCHED}/boom`,
      expect: { status: 500, body: { error: 'the fetch handler broke', code: 'INTERNAL_ERROR' } },
    });
    await check(server, { path: '/api/health', expect: { status: 200 } });
  });

  it('serves a server entry that exports only a fetch handler', async () => {
    await check(server, {
      path: `/api/ext/${FETCH_DEFAULT}/hello`,
      expect: { status: 200, headers: { 'content-type': /^text\/plain\b/ }, body: 'plain:/hello' },
    });
  });

  it('serves a fetch handler in its own process, without the person’s credentials', async () => {
    await check(server, {
      path: `/api/ext/${ISOLATED_FETCHED}/items?q=1`,
      headers: { cookie: 'session=mine' },
      expect: {
        status: 200,
        headers: { 'content-security-policy': "sandbox; default-src 'none'" },
        body: { method: 'GET', path: '/items', search: '?q=1', cookie: null, body: null },
      },
    });
    await check(server, {
      method: 'POST',
      path: `/api/ext/${ISOLATED_FETCHED}/things`,
      body: { across: 'the boundary' },
      expect: {
        status: 200,
        body: {
          method: 'POST',
          path: '/things',
          search: '',
          cookie: null,
          body: '{"across":"the boundary"}',
        },
      },
    });
    await check(server, {
      path: `/api/ext/${ISOLATED_FETCHED}/boom`,
      expect: { status: 500, body: { error: 'the fetch handler broke' } },
    });
  });

  it('serves nothing once it is turned off', async () => {
    for (const id of [FETCHED, FETCH_DEFAULT, ISOLATED_FETCHED]) {
      await setup(server, 'POST', `/api/extensions/${id}/disable`, {});
      await check(server, {
        path: `/api/ext/${id}/items`,
        expect: { status: 404, body: NO_ROUTES(id) },
      });
    }
  });
});

describe('contract: the extension routes with login on', () => {
  let server: ComposedServer | undefined;
  let cookie: Record<string, string>;
  let apiKey: Record<string, string>;
  const OWNER = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };

  /** Read the session cookie off a sign-in answer. */
  const cookieOf = (headers: http.IncomingHttpHeaders): string =>
    (headers['set-cookie'] ?? []).map((value) => value.split(';')[0]!).join('; ');

  beforeAll(async () => {
    server = await bootComposedServer();
    const origin = { origin: server.baseUrl };
    await setup(server, 'POST', '/api/auth/sign-up/email', { ...OWNER, name: 'Owner' }, origin);
    const signedIn = await setup(server, 'POST', '/api/auth/sign-in/email', OWNER, origin);
    cookie = { cookie: cookieOf(signedIn.headers) };
    // Asking for a password is the owner's own act, after their step-up (DOR-3330).
    const person = await stepUpAt(server.baseUrl, OWNER.password);
    await setup(
      server,
      'PATCH',
      '/api/config',
      { auth: { enabled: true } },
      { ...person, ...origin }
    );
    const created = await setup(
      server,
      'POST',
      '/api/auth/api-key/create',
      { name: 'c' },
      { ...cookie, ...origin }
    );
    apiKey = { authorization: `Bearer ${created.json.key as string}` };
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it('refuses a caller with no credential at the session gate', async () => {
    for (const [method, url] of [
      ['GET', '/api/extensions'],
      ['POST', `/api/extensions/${MISSING}/enable`],
      ['POST', `/api/extensions/${MISSING}/approve`],
      ['GET', `/api/extensions/${MISSING}/data`],
      ['GET', `/api/ext/${MISSING}/anything`],
      ['POST', `/api/ext/${MISSING}/anything`],
    ] as const) {
      await check(server, { method, path: url, expect: { status: 401, schema: AUTH_REQUIRED } });
    }
  });

  it('lets an API key read the list', async () => {
    await check(server, {
      path: '/api/extensions',
      headers: apiKey,
      expect: { status: 200, schema: EXTENSION_LIST },
    });
    await check(server, {
      path: `/api/ext/${MISSING}/anything`,
      headers: apiKey,
      expect: { status: 404, body: NO_ROUTES(MISSING) },
    });
  });

  it('refuses an API key what only a signed-in person decides; the owner’s cookie may', async () => {
    for (const url of [
      `/api/extensions/${MISSING}/enable`,
      `/api/extensions/${MISSING}/disable`,
      `/api/extensions/${MISSING}/approve`,
      `/api/extensions/${MISSING}/revoke`,
    ]) {
      await check(server, {
        method: 'POST',
        path: url,
        headers: apiKey,
        body: {},
        expect: { status: 403, schema: COOKIE_REQUIRED },
      });
    }
    await check(server, {
      method: 'POST',
      path: '/api/extensions/trusted-sources',
      headers: apiKey,
      body: { source: 'dork-labs/marketplace' },
      expect: { status: 403, schema: COOKIE_REQUIRED },
    });
    await check(server, {
      method: 'POST',
      path: `/api/extensions/${MISSING}/enable`,
      headers: { ...cookie, origin: server!.baseUrl },
      body: {},
      expect: {
        status: 404,
        body: { error: `Extension '${MISSING}' not found or cannot be enabled` },
      },
    });
    await check(server, {
      method: 'POST',
      path: `/api/extensions/${MISSING}/approve`,
      headers: { ...cookie, origin: server!.baseUrl },
      body: {},
      expect: { status: 404, body: { error: `Extension '${MISSING}' not found` } },
    });
  });

  it('refuses the owner’s cookie from a page on another site', async () => {
    await check(server, {
      method: 'POST',
      path: `/api/extensions/${MISSING}/approve`,
      headers: { ...cookie, ...CROSS_SITE },
      body: {},
      expect: { status: 500, body: CORS_REFUSED },
    });
  });
});
