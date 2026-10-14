/**
 * The guide's fetch handler, written with Hono, end to end (DOR-2857): built
 * by the real compiler from a folder with no `node_modules`, then served in
 * the server's process and in a real isolated child from the SAME bundle,
 * behind DorkOS's real `/api` chain.
 *
 * What it proves, in both runtimes: `hono` is built in, the handler gets the
 * path below its mount and who is asking, `requirePerson()` from
 * `@dorkos/extension-api/server` admits a person and refuses an agent with
 * the extension's own words, a forged verdict header changes nothing, and
 * the one reply-header rule holds.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { readRegisterResult, serverEntryRegister } from '@dorkos/extension-api/server';

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'auth' ? { enabled: false } : { enabled: [], disabled: [], approvedToRun: [] },
    set: () => {},
  },
}));
vi.mock('../../../../env.js', () => ({ env: { DORKOS_PORT: 7777 } }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ExtensionCompiler } from '../../extension-compiler.js';
import { loadInProcessBundle } from '../../server-bundle/load-in-process.js';
import { createFetchHandler } from '../../http/fetch-handler.js';
import type { ExtensionHttpHandler } from '../../http/extension-http.js';
import { createIsolatedHandler } from '../isolated-router.js';
import { PERSON_VERDICT_HEADER } from '../ipc-protocol.js';
import { createExtensionApiRoutes } from '../../../../routes/extension-api.js';
import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';
import { cleanup, createHarness, makeHost, startOk, type Harness } from './isolation-harness.js';

const NAME = 'Hono Test';

/** The extension's source: the shape the docs teach. */
const SOURCE = `
import { Hono } from 'hono';
import { requirePerson } from '@dorkos/extension-api/server';

const app = new Hono();

app.get('/hello', (c) =>
  c.json({
    name: c.req.query('name') ?? null,
    path: c.req.path,
    person: c.env.person.ok,
    verdictHeader: c.req.header('${PERSON_VERDICT_HEADER}') ?? null,
  })
);

app.put('/settings', requirePerson(), async (c) => c.json({ saved: await c.req.json() }));

app.get('/headers', (c) => {
  c.header('set-cookie', 'dorkos.session=stolen; Path=/');
  c.header('x-ext', 'kept');
  return c.text('ok');
});

export default app;
`;

let h: Harness;
let code: string;
let server: http.Server;
let base: string;
const handlers = new Map<string, ExtensionHttpHandler>();

beforeAll(async () => {
  h = await createHarness();
  // A folder with nothing installed in it or above it.
  const extDir = path.join(h.tmp, 'extensions', 'hono-test');
  await fs.mkdir(extDir, { recursive: true });
  await fs.writeFile(path.join(extDir, 'server.ts'), SOURCE);
  const record = {
    id: 'hono-test',
    path: extDir,
    manifest: { id: 'hono-test', name: NAME, version: '1.0.0' },
    status: 'enabled',
    scope: 'global',
    origin: 'user',
    bundleReady: false,
    hasServerEntry: true,
    hasDataProxy: false,
    serverEntryPath: path.join(extDir, 'server.ts'),
  } as ExtensionRecord;
  const compiled = await new ExtensionCompiler(h.dorkHome).compileServer(record);
  if ('error' in compiled) throw new Error(JSON.stringify(compiled.error));
  code = compiled.code;
}, 60_000);

beforeEach(async () => {
  handlers.clear();
  server = http.createServer(
    honoGroupListener({
      path: '/api/ext',
      routes: createExtensionApiRoutes({ getServerHandler: (id) => handlers.get(id) ?? null }),
    })
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await Promise.all(
    h.hosts.splice(0).map(async (host) => {
      host.killNow();
      await host.stop();
    })
  );
});

afterAll(async () => {
  await cleanup(h);
});

/** Serve the bundle in this process as `inproc`, as the lifecycle does. */
async function startInProcess(): Promise<void> {
  const file = path.join(h.tmp, 'bundles', 'inproc.js');
  await fs.writeFile(file, code);
  const register = serverEntryRegister(loadInProcessBundle(file));
  const { fetch } = readRegisterResult(await register!({} as never, {} as never));
  handlers.set('inproc', createFetchHandler(NAME, fetch!));
}

/** Serve the same bundle in a real isolated child as `iso`. */
async function startIsolated(): Promise<void> {
  const bundle = path.join(h.tmp, 'bundles', 'iso.js');
  await fs.writeFile(bundle, code);
  const host = makeHost(h, { id: 'iso', bundle, overrides: { displayName: NAME } });
  await startOk(host);
  handlers.set('iso', createIsolatedHandler({ displayName: NAME, host }));
}

describe('the compiled bundle', () => {
  it('carries hono inline, so it needs nothing installed', () => {
    expect(code).not.toMatch(/require\(["']hono/);
    expect(code).toMatch(/require\(["']@dorkos\/extension-api\/server["']\)/);
    expect(code).toContain('class Hono');
  });
});

describe.each([
  ['in the server’s process', 'inproc', startInProcess],
  ['in its own process', 'iso', startIsolated],
])('a Hono extension %s', (_label, id, start) => {
  beforeEach(async () => {
    await start();
  });

  it('gets the path below its mount and the query, and knows a person is asking', async () => {
    const res = await fetch(`${base}/api/ext/${id}/hello?name=kai`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'kai',
      path: '/hello',
      person: true,
      verdictHeader: null,
    });
  });

  it('lets a person through requirePerson()', async () => {
    const res = await fetch(`${base}/api/ext/${id}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'light' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: { theme: 'light' } });
  });

  it('refuses an agent at requirePerson() with the extension’s own words', async () => {
    const res = await fetch(`${base}/api/ext/${id}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-dorkos-agent': 'agent-1' },
      body: JSON.stringify({ theme: 'light' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: `Only a person can change ${NAME}'s settings.`,
      code: 'extension_person_required',
    });
  });

  it('is not fooled by a verdict header the caller forged', async () => {
    const res = await fetch(`${base}/api/ext/${id}/settings`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-dorkos-agent': 'agent-1',
        [PERSON_VERDICT_HEADER]: JSON.stringify({ ok: true }),
      },
      body: JSON.stringify({ theme: 'light' }),
    });

    expect(res.status).toBe(403);
  });

  it('answers with the one reply-header rule', async () => {
    const res = await fetch(`${base}/api/ext/${id}/headers`);

    expect(await res.text()).toBe('ok');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-ext')).toBe('kept');
    expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers a path it has no route for with its own 404', async () => {
    const res = await fetch(`${base}/api/ext/${id}/nothing-here`);

    expect(res.status).toBe(404);
  });
});
