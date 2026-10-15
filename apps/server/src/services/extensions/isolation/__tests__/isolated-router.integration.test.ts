/**
 * An isolated extension's fetch handler through DorkOS's mount (DOR-2686
 * tasks 5.1 and 5.2, DOR-2861), against a real forked child with the real
 * flags: real HTTP over virtual connections, the header policy both ways,
 * streaming, backpressure, a person's request going away, a child that dies
 * mid-reply, and `checkPerson` refusing exactly what the in-process bar
 * refuses.
 *
 * The same fixture bundle is served in this process beside it (the
 * in-process lifecycle's own steps: load, start, `createFetchHandler`), so
 * "matches the in-process case" is measured, not assumed.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRegisterResult, serverEntryStart } from '@dorkos/extension-api/server';

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
// CORS lets this test origin through, so it reaches the person bar, which
// judges against the server's static set and not this list.
vi.stubEnv('DORKOS_CORS_ORIGIN', 'https://evil.example');
// The session gate lets every request through: the cases here are about the
// person bar, and a signed-in person is set after the chain (`before` below).
vi.mock('../../../core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));

import { createIsolatedHandler } from '../isolated-router.js';
import { createFetchHandler } from '../../http/fetch-handler.js';
import type { ExtensionHttpHandler } from '../../http/extension-http.js';
import { loadInProcessBundle } from '../../server-bundle/load-in-process.js';
import { createExtensionApiRoutes } from '../../../../routes/extension-api.js';
import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';
import { PERSON_VERDICT_HEADER } from '../ipc-protocol.js';
import type { IsolatedExit } from '../isolated-host.js';
import { FETCH_BUNDLE_SOURCE } from './fixtures/fetch-bundle.js';
import { cleanup, createHarness, makeHost, startOk, type Harness } from './isolation-harness.js';

const NAME = 'Fetch Test';
const TRUSTED_ORIGIN = 'http://localhost:7777';

let h: Harness;
let server: http.Server;
let base: string;
let signedIn = false;
const handlers = new Map<string, ExtensionHttpHandler>();

/** Both runtimes, by mount id, for the cases that compare them. */
const RUNTIMES = [
  ['in the server’s process', 'inproc'],
  ['in its own process', 'iso'],
] as const;

/**
 * Serve the fixture in this process as `inproc`, the in-process lifecycle's
 * own steps: load the bundle, start it, serve what it returned.
 */
async function startInProcess(): Promise<void> {
  const file = path.join(h.tmp, 'bundles', 'inproc.js');
  await fs.writeFile(file, FETCH_BUNDLE_SOURCE);
  const start = serverEntryStart(loadInProcessBundle(file));
  if (!start) throw new Error('the fixture provides no server half');
  const { fetch } = readRegisterResult(await start({} as never));
  if (!fetch) throw new Error('the fixture returned no fetch handler');
  handlers.set('inproc', createFetchHandler(NAME, fetch));
}

/** Start the fixture in a real child and mount its isolated handler as `id`. */
async function startIsolated(id: string, idleMs?: number) {
  const bundle = path.join(h.tmp, 'bundles', `${id}.js`);
  await fs.writeFile(bundle, FETCH_BUNDLE_SOURCE);
  const exits: IsolatedExit[] = [];
  const host = makeHost(h, {
    id,
    bundle,
    onExit: (exit) => exits.push(exit),
    overrides: { displayName: NAME },
  });
  await startOk(host);
  handlers.set(id, createIsolatedHandler({ displayName: NAME, host, idleMs }));
  return { host, exits };
}

/**
 * GET a path below a runtime's mount and read the JSON answer.
 *
 * @param id - The mount id.
 * @param below - The path below the mount, with its query.
 */
async function getJson<T = Record<string, unknown>>(id: string, below: string): Promise<T> {
  return (await (await fetch(`${base}/api/ext/${id}${below}`)).json()) as T;
}

beforeEach(async () => {
  h = await createHarness();
  state.authEnabled = false;
  signedIn = false;
  handlers.clear();
  await startInProcess();
  // DorkOS's own order: the `/api` chain (its JSON parser, the session gate,
  // here letting everyone through, with a signed-in person when the test
  // says so), then the extension mount.
  server = http.createServer(
    honoGroupListener(
      {
        path: '/api/ext',
        routes: createExtensionApiRoutes({ getServerHandler: (id) => handlers.get(id) ?? null }),
      },
      {
        before: async (c, next) => {
          if (signedIn) c.set('user', { userId: 'u1', credential: 'cookie' } as never);
          await next();
        },
      }
    )
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await cleanup(h);
});

describe('requests reach the handler', () => {
  // Purpose: a JSON body the chain's parser already consumed still reaches
  // the handler whole in both runtimes; in the child it arrives as real HTTP
  // with a fresh content-length.
  it('round-trips a JSON body', async () => {
    await startIsolated('iso');
    const sent = { hello: 'world', n: [1, 2] };
    const send = async (id: string) => {
      const res = await fetch(`${base}/api/ext/${id}/echo-json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sent),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };
    const iso = await send('iso');
    const inproc = await send('inproc');
    expect(iso.body).toEqual(sent);
    expect(inproc.body).toEqual(sent);
    expect(iso.contentType).toBe('application/json');
    expect(inproc.contentType).toBe('application/json');
    expect(iso.contentLength).toBe(String(JSON.stringify(sent).length));
  });

  // Purpose: a body no parser read is passed through as is.
  it.each(RUNTIMES)('passes a raw text body through %s', async (_label, id) => {
    await startIsolated('iso');
    const res = await fetch(`${base}/api/ext/${id}/echo-raw`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'plain words',
    });
    expect(await res.text()).toBe('got:plain words');
  });

  // Purpose: a body over the app-wide 1 MB limit is refused before it
  // reaches the handler.
  it.each(RUNTIMES)('refuses a body over 1 MB %s', async (_label, id) => {
    await startIsolated('iso');
    const res = await fetch(`${base}/api/ext/${id}/echo-raw`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(1024 * 1024 + 10, 1),
    });
    expect(res.status).toBe(413);
  });

  // Purpose: the handler in the child gets the same path below the mount and
  // query as in-process, so its own routing matches.
  it('matches the in-process routing', async () => {
    await startIsolated('iso');
    const iso = await getJson('iso', '/items/42?x=1');
    const inproc = await getJson('inproc', '/items/42?x=1');
    expect(iso).toEqual({ path: '/items/42', params: { itemId: '42' }, query: { x: '1' } });
    expect(iso).toEqual(inproc);
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
  /** A request carrying every credential and a forged verdict. */
  const SENT = {
    cookie: 'better-auth.session_token=secret',
    authorization: 'Bearer secret',
    'x-api-key': 'secret',
    'x-dorkos-agent': 'agent-1',
    'x-dorkos-approval': 'token',
    [PERSON_VERDICT_HEADER]: JSON.stringify({ ok: true }),
    'x-kept': 'yes',
  };

  // Purpose: the person's cookie, authorization, API key and DorkOS headers
  // never reach extension code in its own process; no handler in either
  // runtime sees the verdict header, and a forged one changes nothing: the
  // caller is the host's own verdict, the same in both.
  it('strips credentials and ignores a forged verdict', async () => {
    await startIsolated('iso');
    const send = async (id: string) =>
      (await (await fetch(`${base}/api/ext/${id}/headers`, { headers: SENT })).json()) as {
        headers: Record<string, string>;
        person: Record<string, unknown>;
      };
    const iso = await send('iso');
    const inproc = await send('inproc');
    expect(iso.headers.cookie).toBeUndefined();
    expect(iso.headers.authorization).toBeUndefined();
    expect(iso.headers['x-api-key']).toBeUndefined();
    expect(iso.headers['x-dorkos-agent']).toBeUndefined();
    expect(iso.headers['x-dorkos-approval']).toBeUndefined();
    expect(iso.headers['x-kept']).toBe('yes');
    expect(iso.headers[PERSON_VERDICT_HEADER]).toBeUndefined();
    expect(inproc.headers[PERSON_VERDICT_HEADER]).toBeUndefined();
    expect(inproc.headers['x-kept']).toBe('yes');
    // The request named an agent, so the caller is a refusal, not the forged
    // yes, and the same refusal in both runtimes.
    expect(iso.person).toMatchObject({ ok: false, status: 403 });
    expect(iso.person).toEqual(inproc.person);
  });

  // Purpose: a reply cannot set cookies, transport policy or CORS on
  // DorkOS's origin, and always carries the sandboxing CSP and nosniff.
  it.each(RUNTIMES)('strips reply headers and forces the CSP %s', async (_label, id) => {
    await startIsolated('iso');
    const res = await fetch(`${base}/api/ext/${id}/cookie`);
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
  it.each(RUNTIMES)('drops every header outside the allowlist %s', async (_label, id) => {
    await startIsolated('iso');
    const res = await fetch(`${base}/api/ext/${id}/danger`);
    expect(res.status).toBe(200);
    for (const name of [
      'clear-site-data',
      'refresh',
      'www-authenticate',
      'service-worker-allowed',
      'cross-origin-opener-policy',
      'link',
      'x-dorkos-agent',
    ]) {
      expect(res.headers.get(name), name).toBeNull();
    }
    expect(res.headers.get('etag')).toBe('"v1"');
    // The handler's own CORS headers are dropped like the rest. What remains
    // is DorkOS's: the `/api` chain's CORS step answers every request with it.
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  // Purpose: a redirect stays inside the extension's own mount. The handler
  // names locations on its own origin, which is the path below the mount, so
  // even a path that looks like another DorkOS route lands inside the mount;
  // one to another site is dropped. Both runtimes agree.
  it.each([
    ['/items/1', '/api/ext/RT/items/1'],
    ['items/2?x=1', '/api/ext/RT/items/2?x=1'],
    ['/api/config', '/api/ext/RT/api/config'],
    ['/../../config', '/api/ext/RT/config'],
    ['https://evil.example/', null],
    ['//evil.example/', null],
    ['\\\\evil.example/', null],
  ])('a redirect to %s keeps location %s', async (to, expected) => {
    await startIsolated('iso');
    for (const id of ['iso', 'inproc']) {
      const res = await fetch(`${base}/api/ext/${id}/redirect?to=${encodeURIComponent(to)}`, {
        redirect: 'manual',
      });
      expect(res.status, id).toBe(302);
      expect(res.headers.get('location'), id).toBe(expected?.replace('RT', id) ?? null);
    }
  });
});

describe('flow control', () => {
  // Purpose: a child streaming faster than the person reads is paused, so
  // its stream is pulled no further and DorkOS holds a bounded amount;
  // reading again resumes it to the end.
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
    const { flooded } = await getJson<{ flooded: number }>('iso', '/flooded');
    expect(flooded).toBeGreaterThan(0);
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
  // Purpose: a person abandoning a request aborts the handler's
  // `request.signal`, in its own process as in the server's.
  it.each(RUNTIMES)('carries a client abort to the handler %s', async (_label, id) => {
    await startIsolated('iso');
    const controller = new AbortController();
    const pending = fetch(`${base}/api/ext/${id}/hang`, { signal: controller.signal }).catch(
      () => null
    );
    await new Promise((r) => setTimeout(r, 300));
    const before = await getJson<{ aborted: boolean }>(id, '/aborted');
    expect(before.aborted).toBe(false);
    controller.abort();
    await pending;
    let aborted = false;
    for (let i = 0; i < 50 && !aborted; i++) {
      await new Promise((r) => setTimeout(r, 50));
      aborted = (await getJson<{ aborted: boolean }>(id, '/aborted')).aborted;
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

describe('checkPerson reads the host verdict (task 5.2)', () => {
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
