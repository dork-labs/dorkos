/**
 * The Remote Access switch on the real `/api` chain (DOR-3650): turned off,
 * every request from another device is refused at the server on its next
 * request, this computer keeps working, the setting outlives a restart, and an
 * agent caller cannot turn it back on.
 *
 * The config is real, on a throwaway data directory, and so is the config
 * route a person uses in Settings. The session gate lets every request through,
 * so what refuses a remote request here is the switch and nothing else.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest, type IncomingMessage, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { IngressKind } from '../../services/core/remote/ingress-mark.js';
import type { ApiEnv } from '../api-chain.js';

vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => null,
  hasAnyUser: () => false,
}));
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));
vi.mock('../../services/runtimes/claude-code/sdk/sdk-utils.js', () => ({
  resolveClaudeCliPath: () => '/usr/local/bin/claude',
  createHeldUserPrompt: vi.fn(() => ({
    prompt: (async function* () {})(),
    close: vi.fn(),
    push: vi.fn(),
  })),
}));
vi.mock('../../lib/boundary.js', () => ({
  getBoundary: () => '/Users/test-user',
  expandTilde: (p: string) => (p.startsWith('~/') ? `/Users/test-user/${p.slice(2)}` : p),
}));

/** The header this file's listener reads to mark a request's listener, before the chain. */
const VIA = 'x-test-arrived-via';

const target = swappableServer();
const server = target.server;
let dorkHome: string;
/** Stops the switch's change listener this test started. */
let unwatch: () => void = () => {};

/**
 * The config route and a probe behind the real chain. A request carrying
 * {@link VIA} is marked as arriving on that listener first, as the own-tunnel,
 * managed and Wi-Fi ingresses mark theirs before the chain sees them.
 */
async function mount(): Promise<void> {
  const { initConfigManager } = await import('../../services/core/config-manager.js');
  initConfigManager(dorkHome);
  const { honoGroupListener } = await import('./hono-group-listener.js');
  const { markIngress } = await import('../../services/core/remote/ingress-mark.js');
  const configRouter = (await import('../../routes/config.js')).default;
  const { streamToNodeResponse } = await import('../raw-node-stream.js');
  const { watchRemoteAccessSwitch } = await import('../../middleware/remote-access-switch.js');
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
  const inner = honoGroupListener([
    { path: '/api/config', routes: configRouter },
    { path: '/api/probe', routes: probe },
  ]);
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
});

afterEach(() => {
  unwatch();
  fs.rmSync(dorkHome, { recursive: true, force: true });
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

  it.each(OTHER_DEVICES)('turned off, refuses %s on its next request', async (_label, headers) => {
    await request(server).get('/api/probe').set(headers).expect(200);
    await turnOff();
    const res = await request(server).get('/api/probe').set(headers).expect(403);
    expect(res.body.code).toBe('REMOTE_ACCESS_OFF');
  });

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

  it('stays off after a restart', async () => {
    await turnOff();
    vi.resetModules();
    await mount();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dorkHome, 'config.json'), 'utf-8'));
    expect(onDisk.remoteAccess).toEqual({ enabled: false });
    await request(server).get('/api/probe').set(VIA, 'wifi').expect(403);
    await request(server).get('/api/probe').expect(200);
  });

  it('turns back on for the person at this computer', async () => {
    await turnOff();
    await request(server)
      .patch('/api/config')
      .send({ remoteAccess: { enabled: true } })
      .expect(200);
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
    const { registerRemoteListener } = await import('../../middleware/remote-access-switch.js');
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
