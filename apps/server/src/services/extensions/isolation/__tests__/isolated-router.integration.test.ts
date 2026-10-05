/**
 * An isolated extension's router through DorkOS's mount (DOR-2686 tasks 5.1
 * and 5.2), against a real forked child with the real flags: real HTTP over
 * virtual connections, the header policy both ways, streaming, a person's
 * request going away, a child that dies mid-reply, and `ctx.requirePerson`
 * refusing exactly what the in-process bar refuses.
 *
 * The same fixture source runs in-process beside it, so "matches the
 * in-process case" is measured, not assumed.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import express, { Router, type RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ authEnabled: false }));

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'auth'
        ? { enabled: state.authEnabled }
        : { enabled: [], disabled: [], approvedToRun: [] },
    set: () => {},
  },
}));
vi.mock('../../../../env.js', () => ({ env: { DORKOS_PORT: 7777 } }));
vi.stubEnv('VITE_PORT', '7779');

import { createRequirePerson } from '../../inbox/extension-inbox-context.js';
import { createIsolatedRouter } from '../isolated-router.js';
import { PERSON_VERDICT_HEADER } from '../ipc-protocol.js';
import type { IsolatedExit } from '../isolated-host.js';
import { ROUTER_BUNDLE_SOURCE } from './fixtures/router-bundle.js';
import { cleanup, createHarness, makeHost, startOk, type Harness } from './isolation-harness.js';

const NAME = 'Router Test';
const TRUSTED_ORIGIN = 'http://localhost:7777';

let h: Harness;
let server: http.Server;
let base: string;
let signedIn = false;
const routers = new Map<string, RequestHandler>();

/** Load the fixture in this process, as the in-process lifecycle would. */
function inProcessRouter(): Router {
  const fn = vm.compileFunction(ROUTER_BUNDLE_SOURCE, ['exports', 'require', 'module']);
  const mod: { exports: unknown } = { exports: {} };
  fn(mod.exports, () => ({}), mod);
  const router = Router();
  (mod.exports as (r: Router, c: unknown) => void)(router, {
    requirePerson: createRequirePerson(NAME),
  });
  return router;
}

/** Start the fixture in a real child and mount its isolated router as `id`. */
async function startIsolated(id: string, idleMs?: number) {
  const bundle = path.join(h.tmp, 'bundles', `${id}.js`);
  await fs.writeFile(bundle, ROUTER_BUNDLE_SOURCE);
  const exits: IsolatedExit[] = [];
  const host = makeHost(h, {
    id,
    bundle,
    onExit: (exit) => exits.push(exit),
    overrides: { displayName: NAME },
  });
  await startOk(host);
  routers.set(id, createIsolatedRouter({ displayName: NAME, host, idleMs }));
  return { host, exits };
}

beforeEach(async () => {
  h = await createHarness();
  state.authEnabled = false;
  signedIn = false;
  routers.clear();
  routers.set('inproc', inProcessRouter());
  // DorkOS's own order: the app-wide JSON parser, the session gate (here: a
  // signed-in person when the test says so), then the extension mount.
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((_req, res, next) => {
    if (signedIn) res.locals.user = { userId: 'u1', credential: 'cookie' };
    next();
  });
  app.use('/api/ext/:id', (req, res, next) => {
    const router = routers.get(req.params.id as string);
    if (!router) {
      res.status(404).json({ error: 'none' });
      return;
    }
    router(req, res, next);
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await cleanup(h);
});

describe('requests reach the child as real HTTP', () => {
  // Purpose: a JSON body express.json already consumed still reaches the
  // child whole, re-encoded with a fresh content-length.
  it('round-trips a JSON body', async () => {
    await startIsolated('iso');
    const res = await fetch(`${base}/api/ext/iso/echo-json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world', n: [1, 2] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.body).toEqual({ hello: 'world', n: [1, 2] });
    expect(body.contentLength).toBe(String(JSON.stringify({ hello: 'world', n: [1, 2] }).length));
  });

  // Purpose: a body no parser read is streamed through as is.
  it('streams a raw text body', async () => {
    await startIsolated('iso');
    const res = await fetch(`${base}/api/ext/iso/echo-raw`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'plain words',
    });
    expect(await res.text()).toBe('got:plain words');
  });

  // Purpose: a body over the app-wide 1 MB limit is refused before it
  // reaches the child.
  it('refuses a body over 1 MB', async () => {
    await startIsolated('iso');
    const res = await fetch(`${base}/api/ext/iso/echo-raw`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(1024 * 1024 + 10, 1),
    });
    expect(res.status).toBe(413);
  });

  // Purpose: req.baseUrl, req.path and req.params in the child equal the
  // in-process ones, because the host forwards req.originalUrl.
  it('matches the in-process routing', async () => {
    await startIsolated('iso');
    const iso = (await (await fetch(`${base}/api/ext/iso/items/42?x=1`)).json()) as Record<
      string,
      unknown
    >;
    const inproc = (await (await fetch(`${base}/api/ext/inproc/items/42?x=1`)).json()) as Record<
      string,
      unknown
    >;
    expect(iso.params).toEqual({ itemId: '42' });
    expect(iso.query).toEqual({ x: '1' });
    expect(iso.path).toBe(inproc.path);
    expect(iso.baseUrl).toBe('/api/ext/iso');
    expect(inproc.baseUrl).toBe('/api/ext/inproc');
  });

  // Purpose: server-sent events arrive as they are written, not when the
  // reply ends (the child waits 600 ms between the two events).
  it('streams server-sent events incrementally', async () => {
    await startIsolated('iso');
    const res = await fetch(`${base}/api/ext/iso/sse`);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const arrivals: { at: number; text: string }[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push({ at: Date.now(), text: decoder.decode(value) });
    }
    const all = arrivals.map((a) => a.text).join('');
    expect(all).toBe('data: one\n\ndata: two\n\n');
    const first = arrivals.find((a) => a.text.includes('one'))!;
    const second = arrivals.find((a) => a.text.includes('two'))!;
    expect(second.at - first.at).toBeGreaterThanOrEqual(400);
  });
});

describe('the header policy', () => {
  // Purpose: the person's cookie, authorization, API key and DorkOS headers
  // never reach extension code, and a forged verdict header is replaced by
  // the host's own.
  it('strips credentials and replaces a forged verdict', async () => {
    await startIsolated('iso');
    const res = await fetch(`${base}/api/ext/iso/headers`, {
      headers: {
        cookie: 'better-auth.session_token=secret',
        authorization: 'Bearer secret',
        'x-api-key': 'secret',
        'x-dorkos-agent': 'agent-1',
        'x-dorkos-approval': 'token',
        [PERSON_VERDICT_HEADER]: JSON.stringify({ ok: true }),
        'x-kept': 'yes',
      },
    });
    const seen = (await res.json()) as Record<string, string>;
    expect(seen.cookie).toBeUndefined();
    expect(seen.authorization).toBeUndefined();
    expect(seen['x-api-key']).toBeUndefined();
    expect(seen['x-dorkos-agent']).toBeUndefined();
    expect(seen['x-dorkos-approval']).toBeUndefined();
    expect(seen['x-kept']).toBe('yes');
    // The request named an agent, so the host's verdict is a refusal, not
    // the forged yes.
    expect(JSON.parse(seen[PERSON_VERDICT_HEADER]!)).toMatchObject({ ok: false, status: 403 });
  });

  // Purpose: a reply cannot set cookies, transport policy or CORS on
  // DorkOS's origin, and always carries the sandboxing CSP and nosniff.
  it('strips reply headers and forces the CSP', async () => {
    await startIsolated('iso');
    const res = await fetch(`${base}/api/ext/iso/cookie`);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('strict-transport-security')).toBeNull();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-ext-own')).toBe('kept');
  });
});

describe('the reply header allowlist', () => {
  // Purpose: a header that could sign the person out, prompt for a
  // password, redirect, register a service worker or loosen CORS on
  // DorkOS's origin never reaches the browser; an ordinary one does.
  it('drops every header outside the allowlist', async () => {
    await startIsolated('iso');
    const res = await fetch(`${base}/api/ext/iso/danger`);
    expect(res.status).toBe(200);
    for (const name of [
      'clear-site-data',
      'refresh',
      'www-authenticate',
      'service-worker-allowed',
      'access-control-allow-credentials',
      'cross-origin-opener-policy',
      'link',
      'x-dorkos-agent',
    ]) {
      expect(res.headers.get(name), name).toBeNull();
    }
    expect(res.headers.get('etag')).toBe('"v1"');
  });

  // Purpose: a redirect stays inside the extension's own mount; one to
  // another site or another DorkOS route is dropped.
  it.each([
    ['/api/ext/iso/items/1', '/api/ext/iso/items/1'],
    ['items/2?x=1', '/api/ext/iso/items/2?x=1'],
    ['https://evil.example/', null],
    ['//evil.example/', null],
    ['/api/config', null],
    ['/api/ext/iso/../../config', null],
    ['/api/ext/isomorphic', null],
  ])('a redirect to %s keeps location %s', async (to, expected) => {
    await startIsolated('iso');
    const res = await fetch(`${base}/api/ext/iso/redirect?to=${encodeURIComponent(to)}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(expected);
  });
});

describe('flow control', () => {
  // Purpose: a child writing faster than the person reads is paused, so
  // DorkOS holds a bounded amount; reading again resumes it to the end.
  it('pauses a fast child for a slow reader, then resumes', async () => {
    const { host } = await startIsolated('iso');
    // A plain Node client whose response is paused: a reader that stopped.
    let reply: http.IncomingMessage | null = null;
    const req = http.get(`${base}/api/ext/iso/flood`, (r) => {
      reply = r;
      r.pause();
    });
    await until(() => reply !== null);
    await new Promise((r) => setTimeout(r, 1_500));
    const { flooded } = (await (await fetch(`${base}/api/ext/iso/flooded`)).json()) as {
      flooded: number;
    };
    expect(flooded).toBeLessThan(16 * 1024 * 1024);
    expect(host.bufferedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      reply!.on('data', (chunk: Buffer) => (total += chunk.byteLength));
      reply!.on('end', resolve);
      reply!.on('error', reject);
      reply!.resume();
    });
    req.destroy();
    expect(total).toBe(32 * 1024 * 1024);
  }, 30_000);
});

/** Wait until `check` is true. */
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const began = Date.now();
  while (!check()) {
    if (Date.now() - began > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('when a request or the child goes away', () => {
  // Purpose: a person abandoning a request closes it in the child too.
  it('carries a client abort to the child', async () => {
    await startIsolated('iso');
    const controller = new AbortController();
    const pending = fetch(`${base}/api/ext/iso/hang`, { signal: controller.signal }).catch(
      () => null
    );
    await new Promise((r) => setTimeout(r, 300));
    const before = (await (await fetch(`${base}/api/ext/iso/aborted`)).json()) as {
      aborted: boolean;
    };
    expect(before.aborted).toBe(false);
    controller.abort();
    await pending;
    let aborted = false;
    for (let i = 0; i < 50 && !aborted; i++) {
      await new Promise((r) => setTimeout(r, 50));
      aborted = (
        (await (await fetch(`${base}/api/ext/iso/aborted`)).json()) as { aborted: boolean }
      ).aborted;
    }
    expect(aborted).toBe(true);
  });

  // Purpose: a child that exits before answering yields a 503 with the
  // card's words, and DorkOS keeps serving.
  it('answers 503 when the child exits before its headers', async () => {
    const { exits } = await startIsolated('iso');
    const res = await fetch(`${base}/api/ext/iso/exit-before`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: `${NAME} stopped while answering.` });
    for (let i = 0; i < 40 && exits.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(exits[0]?.reason).toBe('server_crashed');
    const other = await fetch(`${base}/api/ext/inproc/items/1`);
    expect(other.status).toBe(200);
  });

  // Purpose: a child that exits mid-stream cuts the reply off rather than
  // ending it as if it were complete.
  it('cuts off a reply when the child exits after its headers', async () => {
    await startIsolated('iso');
    const res = await fetch(`${base}/api/ext/iso/exit-after`);
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
  });

  // Purpose: a reply with no bytes for the idle limit is answered 504.
  it('answers 504 when the child goes quiet', async () => {
    await startIsolated('iso', 300);
    const res = await fetch(`${base}/api/ext/iso/slow`);
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: `${NAME} didn't answer in time.` });
  });
});

describe('ctx.requirePerson reads the host verdict (task 5.2)', () => {
  /** PUT /settings on both runtimes with the same request. */
  async function both(headers: Record<string, string>) {
    await startIsolated('iso');
    const send = async (id: string) => {
      const res = await fetch(`${base}/api/ext/${id}/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      });
      return { status: res.status, body: await res.json() };
    };
    return { iso: await send('iso'), inproc: await send('inproc') };
  }

  // Purpose: each refusal the in-process bar makes, the isolated one makes
  // with the same status and body; and each actually refuses.
  it.each([
    ['a cross-site origin', { origin: 'https://evil.example' }, false],
    ['an agent', { 'x-dorkos-agent': 'agent-1' }, false],
    ['login on without a cookie', { origin: TRUSTED_ORIGIN }, true],
  ])('refuses %s exactly as in-process', async (_label, headers, login) => {
    state.authEnabled = login;
    const { iso, inproc } = await both(headers);
    expect(inproc.status).toBeGreaterThanOrEqual(400);
    expect(iso).toEqual(inproc);
  });

  // Purpose: a person passes in both runtimes (login on, signed in).
  it('lets a person through', async () => {
    state.authEnabled = true;
    signedIn = true;
    const { iso, inproc } = await both({ origin: TRUSTED_ORIGIN });
    expect(inproc).toEqual({ status: 200, body: { ok: true } });
    expect(iso).toEqual(inproc);
  });
});
