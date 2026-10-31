import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiEnv } from '../../http/api-chain.js';
import { AccountSigninPolicy } from '../../services/health/account-signin-policy.js';
import { createAccountSigninRoutes } from '../account-signin.js';
vi.mock('../../services/core/auth/index.js', async (original) => ({
  ...(await original<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: 'owner' }),
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: () => ({ enabled: false }) },
}));
vi.mock('../../services/observability/index.js', () => ({ noteSigninRepaired: vi.fn() }));
const org = '11111111-1111-4111-8111-111111111111';
const blocked = '22222222-2222-4222-8222-222222222222';
const identity = { accountUuid: org, organizationUuid: org, maskedEmail: 'd…@example.com' };
let home: string;
let policy: AccountSigninPolicy;
const metadata = vi.fn(() => identity);
const passwordAvailable = vi.fn(async () => true);
const checkPassword = vi.fn(async (password: string | undefined) =>
  password === 'fresh' ? ('ok' as const) : ('wrong' as const)
);
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-signin-route-'));
  policy = new AccountSigninPolicy(home);
  policy.addOrganization(blocked, 'Art Blocks fixture');
  vi.clearAllMocks();
  metadata.mockReturnValue(identity);
  passwordAvailable.mockResolvedValue(true);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
async function call(
  actor: 'owner' | 'teammate' | 'agent' | 'key' | 'local' | 'remote',
  endpoint: string,
  body: object = {},
  method = 'POST'
) {
  const app = new Hono<ApiEnv>();
  app.use('*', async (c, next) => {
    if (actor !== 'local' && actor !== 'remote')
      c.set('user', {
        userId: actor === 'teammate' ? 'other' : 'owner',
        credential: actor === 'key' ? 'api-key' : 'cookie',
      });
    c.set('body', body);
    await next();
  });
  app.route(
    '/signins',
    createAccountSigninRoutes({
      policy: () => policy,
      accounts: () => [{ accountId: 'five', path: '/fake/five', name: 'Claude5' }],
      metadata,
      checkPassword,
      passwordAvailable,
    })
  );
  const headers = {
    host: 'localhost:4242',
    ...(actor === 'agent' ? { 'x-dorkos-agent': 'agent' } : {}),
  };
  return app.request(
    '/signins' + endpoint,
    { method },
    {
      incoming: {
        headers,
        socket: { remoteAddress: actor === 'local' ? '127.0.0.1' : '192.0.2.1', encrypted: true },
      } as unknown as IncomingMessage,
      outgoing: {} as ServerResponse,
    }
  );
}
describe('owner sign-in policy routes', () => {
  it.each(['agent', 'key', 'teammate'] as const)(
    'refuses %s writes to either entry kind or acceptance',
    async (actor) => {
      for (const endpoint of ['/organizations', '/folders', '/five/accept']) {
        expect(
          (
            await call(actor, endpoint, {
              password: 'fresh',
              orgId: org,
              label: 'Excluded',
              accountId: 'five',
            })
          ).status
        ).toBe(403);
      }
      expect(checkPassword).not.toHaveBeenCalled();
      expect(metadata).not.toHaveBeenCalled();
      expect(policy.assess('/fake/five', identity).state).toBe('unconfirmed');
    }
  );
  it('accepts an owner on another device only with a fresh step-up', async () => {
    expect((await call('owner', '/five/accept', {})).status).toBe(403);
    expect(policy.assess('/fake/five', identity).state).toBe('unconfirmed');
    expect((await call('owner', '/five/accept', { password: 'fresh' })).status).toBe(200);
    expect(policy.assess('/fake/five', identity).state).toBe('confirmed');
  });
  it('confirms explicitly on this computer with login off and no owner password', async () => {
    passwordAvailable.mockResolvedValue(false);
    expect((await call('local', '/five/accept', {})).status).toBe(403);
    expect((await call('local', '/five/accept', { confirmOnThisComputer: true })).status).toBe(200);
    expect(policy.assess('/fake/five', identity).state).toBe('confirmed');
    expect(checkPassword).toHaveBeenCalledTimes(1);
    expect((await call('remote', '/five/accept', { confirmOnThisComputer: true })).status).toBe(
      403
    );
    expect((await call('agent', '/five/accept', { confirmOnThisComputer: true })).status).toBe(403);
    expect((await call('key', '/five/accept', { confirmOnThisComputer: true })).status).toBe(403);
  });
  it('does not let a local-confirm flag bypass an existing password', async () => {
    expect((await call('local', '/five/accept', { confirmOnThisComputer: true })).status).toBe(403);
    expect(policy.assess('/fake/five', identity).state).toBe('unconfirmed');
  });
  it('refuses a denied org even for the owner and exposes no identity', async () => {
    metadata.mockReturnValue({ ...identity, organizationUuid: blocked });
    expect((await call('owner', '/five/accept', { password: 'fresh' })).status).toBe(409);
    const res = await call('owner', '', {}, 'GET');
    expect((await res.json()).accounts[0].identity).toEqual({ state: 'blocked' });
  });
  it('uses its own registry and never reads a never-use folder', async () => {
    expect(
      (
        await call('owner', '/folders', {
          password: 'fresh',
          accountId: 'five',
          path: '/etc/passwd',
        })
      ).status
    ).toBe(400);
    expect(
      (await call('owner', '/folders', { password: 'fresh', accountId: 'unknown' })).status
    ).toBe(404);
    expect((await call('owner', '/folders', { password: 'fresh', accountId: 'five' })).status).toBe(
      200
    );
    expect((await call('owner', '/five/accept', { password: 'fresh' })).status).toBe(409);
    await call('owner', '', {}, 'GET');
    expect(metadata).not.toHaveBeenCalled();
  });
});
