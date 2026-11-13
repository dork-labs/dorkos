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
import type { IncomingMessage, RequestListener } from 'node:http';
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
  const probe = new Hono<ApiEnv>().get('/', (c) => c.json({ ok: true }));
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
