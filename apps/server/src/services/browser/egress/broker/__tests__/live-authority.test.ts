import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { createDb, runMigrations, user, workspaces } from '@dorkos/db';
import { createAuth } from '../../../../core/auth/index.js';
import { initConfigManager, configManager } from '../../../../core/config-manager.js';
import {
  createLiveBrowserAuthority,
  type PrivateLiveNetworkPreparation,
} from '../live/live-authority.js';
import { createServerInventory } from '../server-inventory.js';
import { createBrokerIssuer } from '../issuer.js';
import { createPrivateBroker } from '../broker.js';
import { FakeSocket, FakeBody, fakeTransport } from './fake-transport.js';
import { turns } from './broker-fixture.js';
// This constructor seam is a semantic lifecycle control, not native/Chromium evidence.
// SQL, Better Auth, config subscriptions, inventory listener and broker are actual services.
const lifecycle = vi.hoisted(() => ({
  custody: true,
  ordinary: true,
  runtime: 'a'.repeat(64) as string | null,
  retire: vi.fn(),
}));
vi.mock('@dorkos/browser/server-owner', () => ({
  constructOwnedBrowserEngine: (
    _config: unknown,
    owner: {
      registerBirth(value: object): void;
      network?: {
        bindBeforeLaunch(value: object): Promise<object>;
        activateReady(value: object, peer: object): Promise<void>;
      };
    }
  ) => {
    let finish!: () => void;
    const observation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      async open() {
        const receiver = {
          browserId: 'fixture-browser',
          browserGeneration: 1,
          isOrdinary: () => lifecycle.ordinary,
          isAuthorityCurrent: () => lifecycle.custody && lifecycle.ordinary,
          verifiedRuntimeBinding: () =>
            lifecycle.runtime === null
              ? null
              : { runtimeIdentity: lifecycle.runtime, policyRevision: 1 },
          observation,
          authorityRevoked() {
            lifecycle.ordinary = false;
            lifecycle.retire();
            finish();
            return observation;
          },
        };
        owner.registerBirth(receiver);
        if (owner.network) {
          const peer = await owner.network.bindBeforeLaunch(receiver);
          await owner.network.activateReady(receiver, peer);
        }
        return { browserId: 'fixture-browser', browserGeneration: 1 };
      },
      async shutdown() {
        lifecycle.ordinary = false;
        finish();
        return [{ cleanup: 'observed' }];
      },
    };
  },
}));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  let failed = false;
  let first: unknown;
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      if (!failed) first = error;
      failed = true;
    }
  }
  lifecycle.custody = true;
  lifecycle.runtime = 'a'.repeat(64);
  lifecycle.ordinary = true;
  lifecycle.retire.mockReset();
  if (failed) throw first;
});
async function fixture(
  mode: 'CONNECT' | 'HTTP' | 'WS' = 'CONNECT',
  network?: PrivateLiveNetworkPreparation
) {
  const home = await mkdtemp(join(tmpdir(), 'browser-live-authority-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  initConfigManager(home);
  configManager.set('auth', { enabled: true });
  const db = createDb(join(home, 'fixture.db'));
  cleanup.push(async () => db.$client.close());
  runMigrations(db);
  const auth = createAuth(db, home);
  const response = await auth.api.signUpEmail({
    body: {
      name: 'Fixture owner',
      email: 'fixture' + '@' + 'dork.test',
      password: 'fixture-password-not-personal',
    },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const owner = db.select().from(user).get()!;
  db.insert(workspaces)
    .values({
      id: 'fixture-workspace',
      projectKey: 'fixture-project',
      key: 'fixture',
      path: join(home, 'workspace'),
      source: home,
      provider: 'clone',
      status: 'ready',
      portBase: 6400,
      portBlockSize: 10,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    })
    .run();
  const inventory = createServerInventory({
    instances: [{ id: 'fixture', listeners: ['http'] }],
    adminAuthorities: [],
    now: () => 0,
  });
  const listener = inventory.acquire(
    'fixture',
    'http',
    () => {
      const original = createServer();
      cleanup.push(
        () =>
          new Promise<void>((resolve, reject) =>
            original.close((error) => (error ? reject(error) : resolve()))
          )
      );
      return original;
    },
    (server) => server.listen(0, '127.0.0.1')
  );
  await once(listener, 'listening');
  const authority = createLiveBrowserAuthority({
    scope: 'private-fixture',
    db,
    auth,
    config: configManager,
    inventory,
    policyRevision: 1,
    now: () => 0,
  });
  cleanup.push(async () => authority.stop());
  const grant = await authority.authorizeWorkspace(
    { cookie },
    'fixture-workspace',
    new AbortController().signal
  );
  const { binding } = await authority.openEngine(
    grant,
    network ? { network: { kind: 'owned' } } : {},
    {},
    network
  );
  const issuer = createBrokerIssuer({ ports: authority.ports, now: () => 0 });
  const run = await issuer.retainRun(binding);
  const fake = fakeTransport();
  const broker = createPrivateBroker({
    issuer,
    run,
    transport: fake.transport,
    policy: {
      revision: 1,
      ...inventory.observe().policyInputs!,
      resolver: async () => ({ a: ['8.8.8.8'], aaaa: [], cname: [] }),
    },
  });
  if (mode === 'WS') {
    const accept = createHash('sha1')
      .update('dGhlIHNhbXBsZSBub25jZQ==' + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    vi.mocked(fake.transport.exchange).mockResolvedValue({
      status: 101,
      headers: { connection: 'upgrade', upgrade: 'websocket', 'sec-websocket-accept': accept },
      websocketAccept: accept,
      body: fake.responseBody,
      head: new Uint8Array(),
    });
  }
  const descriptor = await broker.start();
  cleanup.push(() => broker.close());
  const client = new FakeSocket();
  expect(
    fake.accept(client, {
      raw: {
        method: mode === 'CONNECT' ? 'CONNECT' : 'GET',
        target:
          mode === 'CONNECT'
            ? 'example.test:443'
            : mode === 'WS'
              ? 'ws://example.test/'
              : 'http://example.test/',
        head: new Uint8Array(),
        rawHeaders: [
          'Host',
          mode === 'CONNECT' ? 'example.test:443' : 'example.test',
          ...(mode === 'WS'
            ? [
                'Connection',
                'Upgrade',
                'Upgrade',
                'websocket',
                'Sec-WebSocket-Version',
                '13',
                'Sec-WebSocket-Key',
                'dGhlIHNhbXBsZSBub25jZQ==',
              ]
            : []),
          'Proxy-Authorization',
          `Bearer ${descriptor.credential}`,
        ],
      },
      body: new FakeBody(),
    })
  ).toBe(true);
  await turns();
  expect(client.writes.join('')).toContain(
    mode === 'CONNECT' ? '200 Connection Established' : mode === 'WS' ? '101 Origin' : '200 Origin'
  );
  return {
    db,
    auth,
    cookie,
    authority,
    grant,
    issuer,
    run,
    client,
    origin: fake.origins[0]!,
    owner,
    fake,
  };
}
it('refuses copied grant DTOs and reuse of original one-use consent', async () => {
  const f = await fixture();
  await expect(f.authority.openEngine({ ...f.grant }, {}, {})).rejects.toThrow('AUTHORITY_REFUSED');
  await expect(f.authority.openEngine(f.grant, {}, {})).rejects.toThrow('AUTHORITY_REFUSED');
});

it('refuses missing verified original runtime proof', async () => {
  lifecycle.runtime = null;
  await expect(fixture()).rejects.toThrow('AUTHORITY_REFUSED');
  expect(lifecycle.retire).toHaveBeenCalledOnce();
});
