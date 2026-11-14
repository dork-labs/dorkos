import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb, runMigrations } from '@dorkos/db';
import { createApiApp } from '../api-chain.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import { initAuth } from '../../services/core/auth/index.js';
import { env } from '../../env.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';

/**
 * The real chain, config, session gate and Better Auth, in a throwaway data folder, with one real
 * per-user API key. For a remote caller the gate is the verifier the throttle sits in front of,
 * and `verifyApiKey` (spied on the auth object, not mocked) counts every check it makes, so a test
 * can tell a throttled request never reached it. A request at this computer passes the gate
 * without a key, so the stub routes check the key too: that keeps a local or other-path 401 that
 * the throttle must not count.
 */
let tmpDir: string;
let auth: ReturnType<typeof initAuth>;
/** The real key's bearer header; every other key is made up and refused. */
let VALID = '';
let verifyApiKey: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-mcp-throttle-'));
  initConfigManager(tmpDir);
  const db = createDb(path.join(tmpDir, 'throttle-test.db'));
  runMigrations(db);
  auth = initAuth(db, tmpDir);
  const owner = await auth.api.signUpEmail({
    body: { email: 'owner' + '@' + 'dork.test', password: 'made-up-password-123', name: 'Owner' },
  });
  const created = await auth.api.createApiKey({
    body: { userId: owner.user.id, name: 'throttle' },
  });
  VALID = created.key;
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
beforeEach(() => {
  env.DORKOS_TRUST_PROXY = false;
  verifyApiKey = vi.spyOn(auth.api, 'verifyApiKey');
});
afterEach(() => vi.restoreAllMocks());

/** A stub route that checks its credential, for the requests the gate lets through unasked. */
function verified(c: Context) {
  return c.req.header('authorization') === `Bearer ${VALID}`
    ? c.json({ ok: true })
    : c.json({ error: 'Unauthorized' }, 401);
}

function fixture() {
  const app = createApiApp({ admission: new MainRequestAdmission() });
  app.all('/mcp', verified);
  app.all('/api/test', verified);
  return (
    options: {
      key?: string;
      peer?: string;
      forwarded?: string;
      path?: string;
      /** A request through a marked listener: ngrok forwards it from loopback. */
      ingress?: 'own-tunnel' | 'managed';
    } = {}
  ) => {
    const headers: Record<string, string> = {
      host: options.ingress ? 'example.ngrok.app' : 'localhost:4242',
    };
    if (options.key) headers.authorization = `Bearer ${options.key}`;
    if (options.forwarded) headers['x-forwarded-for'] = options.forwarded;
    const outgoing = Object.assign(new EventEmitter(), { setHeader: vi.fn() });
    const incoming = {
      headers,
      socket: { remoteAddress: options.peer ?? (options.ingress ? '127.0.0.1' : '198.51.100.5') },
      url: options.path ?? '/mcp',
    };
    if (options.ingress) markIngress(incoming as never, options.ingress);
    return app.request(options.path ?? '/mcp', { method: 'POST', headers }, { incoming, outgoing });
  };
}

// DOR-4205, Security's Must on #3667: both marked listeners forward from loopback, so a
// peer-keyed bucket was one bucket for every remote caller, and a stranger could lock the
// owner out. ngrok's edge appends the address it saw to `X-Forwarded-For` (made-up ones here).
describe.each(['own-tunnel', 'managed'] as const)('the throttle through %s', (ingress) => {
  it('keeps a stranger from locking the owner’s valid key out', async () => {
    const send = fixture();
    expect((await send({ ingress, key: VALID, forwarded: '203.0.113.20' })).status).toBe(200);
    for (let i = 0; i < 10; i++)
      expect((await send({ ingress, key: `junk-${i}`, forwarded: '198.51.100.66' })).status).toBe(
        401
      );
    expect((await send({ ingress, key: VALID, forwarded: '203.0.113.20' })).status).toBe(200);
  });

  it('still throttles the stranger, whatever it puts left of the edge’s entry', async () => {
    const send = fixture();
    for (let i = 0; i < 10; i++)
      await send({ ingress, key: `junk-${i}`, forwarded: `192.0.2.${i}, 198.51.100.66` });
    verifyApiKey.mockClear();
    const blocked = await send({
      ingress,
      key: VALID,
      forwarded: '192.0.2.99, 198.51.100.66',
    });
    expect(blocked.status).toBe(401);
    expect(verifyApiKey).not.toHaveBeenCalled();
  });
});

describe('remote /mcp bad-key throttle on the real API chain', () => {
  it('stops verification after ten failures, even with rotating keys and forwarding headers', async () => {
    const send = fixture();
    let first: Response | undefined;
    for (let i = 0; i < 10; i++) {
      const response = await send({ key: `wrong-${i}`, forwarded: `203.0.113.${i + 1}` });
      expect(response.status).toBe(401);
      first ??= response;
    }
    const blocked = await send({ key: VALID, forwarded: '203.0.113.99' });
    expect(blocked.status).toBe(401);
    expect(await blocked.text()).toBe(await first!.text());
    expect([...blocked.headers]).toEqual([...first!.headers]);
    expect(verifyApiKey).toHaveBeenCalledTimes(10);
    expect((await send({ key: VALID, peer: '198.51.100.6' })).status).toBe(200);
  });

  it('names the next step in one body for a missing, bad or throttled key (DOR-4264)', async () => {
    const send = fixture();
    const missing = await send({ peer: '198.51.100.40' });
    const bad = await send({ key: 'made-up-wrong-key', peer: '198.51.100.41' });
    for (let i = 0; i < 10; i++) await send({ key: `wrong-${i}`, peer: '198.51.100.42' });
    const throttled = await send({ key: VALID, peer: '198.51.100.42' });
    // Login is off here, so the next step starts with turning it on (QA S2).
    const expected = {
      error: 'Unauthorized',
      code: 'AUTH_REQUIRED',
      message:
        'Unauthorized. Other devices need a personal API key, and keys need login. ' +
        'In DorkOS, turn on login in Settings → Login & security, create a key under API keys, ' +
        'then send it as "Authorization: Bearer <key>".',
    };
    for (const response of [missing, bad, throttled]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(expected);
    }
    // No token value and no file path in it.
    expect(expected.message).not.toMatch(/[/\\]|dork_|mcp-local-token/);
  });

  it('sends a remote caller straight to API keys once login is on (QA S2)', async () => {
    configManager.set('auth', { enabled: true });
    try {
      const response = await fixture()({ peer: '198.51.100.50' });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: 'Unauthorized',
        code: 'AUTH_REQUIRED',
        message:
          'Unauthorized. Send a personal API key as "Authorization: Bearer <key>". ' +
          'Create one in DorkOS: Settings → Login & security → API keys.',
      });
    } finally {
      configManager.set('auth', { enabled: false });
    }
  });

  it('gives successful requests their budget back', async () => {
    const send = fixture();
    for (let i = 0; i < 15; i++) {
      expect((await send({ key: VALID })).status).toBe(200);
    }
    for (let i = 0; i < 9; i++) expect((await send()).status).toBe(401);
    expect((await send({ key: VALID })).status).toBe(200);
  });

  it('expires the failure window after fifteen minutes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const send = fixture();
    for (let i = 0; i < 10; i++) await send();
    expect((await send({ key: VALID })).status).toBe(401);
    now.mockReturnValue(1_000_000 + 15 * 60_000);
    expect((await send({ key: VALID })).status).toBe(200);
  });

  it('leaves local callers and other API paths outside this throttle', async () => {
    const send = fixture();
    for (let i = 0; i < 12; i++) {
      await send({ peer: '127.0.0.1' });
      await send({ path: '/api/test' });
    }
    expect((await send({ peer: '127.0.0.1', key: VALID })).status).toBe(200);
    expect((await send({ path: '/api/test', key: VALID })).status).toBe(200);
  });
});
