/**
 * `PATCH /api/config` from other devices: the front-door settings need the
 * owner at this computer (DOR-2969), a Wi-Fi caller may only tighten Files &
 * commands (DOR-3037), and the Remote Access switch cuts every other device off
 * (DOR-3650).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { request as httpRequest, type IncomingMessage, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from '@dorkos/test-utils/supertest';
import type { IngressKind } from '../../../services/core/remote/ingress-mark.js';
import type { ApiEnv } from '../../../http/api-chain.js';
import { FIXTURE_BROWSER_HEADER } from '../step-up-fixture.js';
import {
  FRESH_GRAPH_TIMEOUT_MS,
  asBrowser,
  asPerson,
  caller,
  server,
  stepUpGroup,
  store,
  target,
  useFreshConfigApp,
} from './config.fixtures.js';

// The gate lets every request through, so what refuses a remote request is
// the route's own bars and the switch, nothing else.
vi.mock('../../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: 'user_cockpit', name: 'Owner' }),
  readOwnerEmail: () => null,
}));

describe('PATCH /api/config, the front-door settings (DOR-2969)', () => {
  useFreshConfigApp();

  it("refuses the owner's own sign-in over plain-http Wi-Fi", async () => {
    caller.arrivedVia = 'wifi';
    const res = await request(server)
      .patch('/api/config')
      .send({ auth: { enabled: false } })
      .expect(403);
    expect(res.body.code).toBe('operator_only');
    expect(res.body.paths).toEqual(['auth.enabled']);
  });

  // An encrypted connection is the desk, for the owner (DOR-3172).
  it.each([
    ['the own tunnel', 'own-tunnel'],
    ['managed remote access', 'managed'],
  ] as const)("lets the owner's own sign-in over %s change one", async (_l, via) => {
    caller.arrivedVia = via;
    const res = await asPerson(
      request(server)
        .patch('/api/config')
        .send({ tunnel: { domain: 'me.ngrok.app' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.config.tunnel.domain).toBe('me.ngrok.app');
  });

  it('refuses a signed-in person at this computer who is not the owner', async () => {
    caller.signedInUser = { userId: 'user_member', credential: 'cookie' };
    const res = await request(server)
      .patch('/api/config')
      .send({ server: { lanAccess: true } })
      .expect(403);
    expect(res.body.code).toBe('operator_only');
  });

  it('still lets a Wi-Fi sign-in change an ordinary setting', async () => {
    caller.arrivedVia = 'wifi';
    const res = await request(server)
      .patch('/api/config')
      .send({ ui: { theme: 'dark' } })
      .expect(200);
    expect(res.body.config.ui.theme).toBe('dark');
  });
});

describe('PATCH /api/config, a Files & commands stop from Wi-Fi (DOR-3037)', () => {
  useFreshConfigApp();

  it('takes a tighter stop for everyone and for one runtime', async () => {
    caller.arrivedVia = 'wifi';
    await request(server)
      .patch('/api/config')
      .send({ runtimes: { defaultTrustStop: 'act', claudeCode: { defaultTrustStop: 'ask' } } })
      .expect(200);
  });

  it('refuses a looser one, for everyone or for one runtime, and changes nothing', async () => {
    caller.arrivedVia = 'wifi';
    await request(server)
      .patch('/api/config')
      .send({ runtimes: { defaultTrustStop: 'ask' } })
      .expect(200);
    const everyone = await request(server)
      .patch('/api/config')
      .send({ runtimes: { defaultTrustStop: 'autonomy' } })
      .expect(403);
    expect(everyone.body).toMatchObject({
      detail: 'Raising permissions works only at this computer.',
      code: 'not_from_wifi',
    });
    await request(server)
      .patch('/api/config')
      .send({ runtimes: { codex: { defaultTrustStop: 'autonomy' } } })
      .expect(403);
    expect((await store()).get('runtimes')?.defaultTrustStop).toBe('ask');
  });

  it('takes a looser one at this computer', async () => {
    await request(server)
      .patch('/api/config')
      .send({ runtimes: { defaultTrustStop: 'ask' } })
      .expect(200);
    await request(server)
      .patch('/api/config')
      .send({ runtimes: { defaultTrustStop: 'autonomy' } })
      .expect(200);
  });
});

describe('the Remote Access switch (DOR-3650)', () => {
  /** The header this file's listener reads to mark a request's listener, before the chain. */
  const VIA = 'x-test-arrived-via';

  let dorkHome: string;
  /** Stops the switch's change listener this test started. */
  let unwatch: () => void = () => {};

  /**
   * The config route and a probe behind the real chain. A request carrying
   * {@link VIA} is marked as arriving on that listener first, as the own-tunnel,
   * managed and Wi-Fi ingresses mark theirs before the chain sees them.
   */
  async function mount(): Promise<void> {
    const { initConfigManager } = await import('../../../services/core/config-manager.js');
    initConfigManager(dorkHome);
    const { initBoundary } = await import('../../../lib/boundary.js');
    await initBoundary(dorkHome);
    const { honoGroupListener } = await import('../../../http/__tests__/hono-group-listener.js');
    const { markIngress } = await import('../../../services/core/remote/ingress-mark.js');
    const configRouter = (await import('../../config.js')).default;
    const { streamToNodeResponse } = await import('../../../http/raw-node-stream.js');
    const { watchRemoteAccessSwitch } = await import('../../../middleware/remote-access-switch.js');
    unwatch = watchRemoteAccessSwitch();
    const probe = new Hono<ApiEnv>()
      .get('/', (c) => c.json({ ok: true }))
      // An event stream that stays open until the client leaves, as the app's do.
      .get('/stream', (c) =>
        streamToNodeResponse(c, async (res, { signal }) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(': open\n\n');
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        })
      );
    // The owner, signed in at this computer, as the app's own requests are.
    const inner = honoGroupListener(
      [
        { path: '/api/config', routes: configRouter },
        { path: '/api/probe', routes: probe },
        await stepUpGroup(),
      ],
      {
        before: async (c, next) => {
          c.set(
            'user',
            asBrowser(
              { userId: 'user_cockpit', credential: 'cookie' },
              c.req.header(FIXTURE_BROWSER_HEADER)
            )
          );
          await next();
        },
      }
    );
    const listener: RequestListener = (req, res) => {
      const via = req.headers[VIA];
      if (typeof via === 'string') markIngress(req as IncomingMessage, via as IngressKind);
      inner(req, res);
    };
    target.mount(listener);
  }

  /** Turn the switch off as the person at this computer does, through Settings. */
  async function turnOff(): Promise<void> {
    await request(server)
      .patch('/api/config')
      .send({ remoteAccess: { enabled: false } })
      .expect(200);
  }

  beforeEach(async () => {
    dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-remote-off-'));
    process.env.DORK_HOME = dorkHome;
    await mount();
  }, FRESH_GRAPH_TIMEOUT_MS);

  afterEach(async () => {
    unwatch();
    fs.rmSync(dorkHome, { recursive: true, force: true });
    const { resetRemoteStreamsForTests } =
      await import('../../../middleware/remote-access-switch.js');
    resetRemoteStreamsForTests();
    vi.resetModules();
  });

  /** Each way another device reaches DorkOS, as the request arrives. */
  const OTHER_DEVICES: readonly [string, Record<string, string>][] = [
    ['the own tunnel', { [VIA]: 'own-tunnel' }],
    ['managed remote access', { [VIA]: 'managed' }],
    ['Wi-Fi', { [VIA]: 'wifi' }],
    ['a proxy on this computer', { 'x-forwarded-for': '203.0.113.9' }],
  ];

  describe('the Remote Access switch', () => {
    it('starts on, and another device reaches the app', async () => {
      const res = await request(server).get('/api/config').expect(200);
      expect(res.body.remoteAccess).toEqual({ enabled: true });
      await request(server).get('/api/probe').set(VIA, 'own-tunnel').expect(200);
    });

    it.each(OTHER_DEVICES)(
      'turned off, refuses %s on its next request',
      async (_label, headers) => {
        await request(server).get('/api/probe').set(headers).expect(200);
        await turnOff();
        const res = await request(server).get('/api/probe').set(headers).expect(403);
        expect(res.body.code).toBe('forbidden');
      }
    );

    it('turned off, refuses another device before sign-in or the app files', async () => {
      await turnOff();
      for (const url of ['/api/auth/get-session', '/mcp', '/', '/api/health']) {
        await request(server).get(url).set(VIA, 'own-tunnel').expect(403);
      }
    });

    it('turned off, never refuses this computer', async () => {
      await turnOff();
      await request(server).get('/api/probe').expect(200);
      const res = await request(server).get('/api/config').expect(200);
      expect(res.body.remoteAccess).toEqual({ enabled: false });
    });

    it(
      'stays off after a restart',
      async () => {
        await turnOff();
        vi.resetModules();
        await mount();
        const onDisk = JSON.parse(fs.readFileSync(path.join(dorkHome, 'config.json'), 'utf-8'));
        expect(onDisk.remoteAccess).toEqual({ enabled: false });
        await request(server).get('/api/probe').set(VIA, 'wifi').expect(403);
        await request(server).get('/api/probe').expect(200);
      },
      FRESH_GRAPH_TIMEOUT_MS
    );

    it('turns back on for the person at this computer', async () => {
      await turnOff();
      const on = await asPerson(
        request(server)
          .patch('/api/config')
          .send({ remoteAccess: { enabled: true } })
      );
      expect(on.status).toBe(200);
      await request(server).get('/api/probe').set(VIA, 'own-tunnel').expect(200);
    });

    it('refuses an agent caller that tries to turn it on', async () => {
      await turnOff();
      const res = await request(server)
        .patch('/api/config')
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({ remoteAccess: { enabled: true } })
        .expect(403);
      expect(res.body.paths).toEqual(['remoteAccess.enabled']);
      const after = await request(server).get('/api/config').expect(200);
      expect(after.body.remoteAccess).toEqual({ enabled: false });
    });
  });

  /** An open event stream: whether it has ended, and a way to leave it. */
  interface OpenStream {
    ended: () => boolean;
    leave: () => void;
  }

  /** Open the probe's event stream with these headers, and wait for its first bytes. */
  async function openStream(headers: Record<string, string> = {}): Promise<OpenStream> {
    const { port } = server.address() as AddressInfo;
    let ended = false;
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/probe/stream', headers });
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      req.once('response', resolve);
      req.once('error', reject);
      req.end();
    });
    expect(res.statusCode).toBe(200);
    res.on('data', () => {});
    res.once('close', () => (ended = true));
    res.once('error', () => (ended = true));
    return { ended: () => ended, leave: () => req.destroy() };
  }

  describe('the Remote Access switch closes streams already open', () => {
    it.each(OTHER_DEVICES)(
      'closes an event stream %s holds when it turns off',
      async (_l, headers) => {
        const stream = await openStream(headers);
        expect(stream.ended()).toBe(false);
        await turnOff();
        await vi.waitFor(() => expect(stream.ended()).toBe(true));
      }
    );

    it('keeps an event stream from this computer open', async () => {
      const local = await openStream();
      const remote = await openStream({ [VIA]: 'own-tunnel' });
      await turnOff();
      await vi.waitFor(() => expect(remote.ended()).toBe(true));
      expect(local.ended()).toBe(false);
      local.leave();
    });

    it('closes nothing when a different setting changes', async () => {
      const remote = await openStream({ [VIA]: 'own-tunnel' });
      await request(server)
        .patch('/api/config')
        .send({ ui: { theme: 'dark' } })
        .expect(200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(remote.ended()).toBe(false);
      remote.leave();
    });
  });

  describe('the Remote Access switch cuts the listeners only other devices reach', () => {
    it('cuts each one when it turns off, and none for another setting', async () => {
      const { registerRemoteListener } =
        await import('../../../middleware/remote-access-switch.js');
      const tunnel = vi.fn();
      const wifi = vi.fn();
      const unregister = [registerRemoteListener(tunnel), registerRemoteListener(wifi)];

      await request(server)
        .patch('/api/config')
        .send({ ui: { theme: 'dark' } })
        .expect(200);
      expect(tunnel).not.toHaveBeenCalled();

      await turnOff();
      expect(tunnel).toHaveBeenCalledTimes(1);
      expect(wifi).toHaveBeenCalledTimes(1);
      for (const off of unregister) off();
    });
  });
});
