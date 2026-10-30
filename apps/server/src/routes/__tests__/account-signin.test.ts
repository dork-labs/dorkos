/**
 * The person's Claude sign-in routes (DOR-3245): only the person, in the app,
 * may confirm a sign-in, keep a changed one, or change the Never use lists.
 * An agent, an API key and a teammate get 403. At this computer with login
 * off, the person confirms with their session once an owner exists: the app
 * is asked for the one password step-up first (DOR-3330). With no owner yet
 * there is nobody to sign in as, and the person confirms with no session.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiEnv } from '../../http/api-chain.js';
import { AccountSigninPolicy } from '../../services/health/account-signin-policy.js';
import { personSessionRefusal } from '../../http/person-session-refusal.js';
import { PERSON_SESSION_REQUIRED_CODE } from '@dorkos/shared/person-session';
import { createAccountSigninRoutes } from '../account-signin.js';

/** Whether the install has an owner; the step-up is asked for only once one does. */
const install = vi.hoisted(() => ({ hasOwner: true }));

vi.mock('../../services/core/auth/index.js', async (original) => ({
  ...(await original<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => (install.hasOwner ? { id: 'owner' } : null),
}));
vi.mock('../../services/core/auth/install-owner.js', () => ({
  isInstallOwner: (user?: { userId: string }) => user?.userId === 'owner',
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: () => ({ enabled: false }) },
}));
vi.mock('../../services/observability/index.js', () => ({ noteSigninRepaired: vi.fn() }));

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ORG = '33333333-3333-4333-8333-333333333333';
const DENIED = '22222222-2222-4222-8222-222222222222';
const identity = { accountUuid: ACCOUNT, organizationUuid: ORG, maskedEmail: 'd…@example.com' };
let home: string;
let policy: AccountSigninPolicy;
const metadata = vi.fn(() => identity);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-signin-route-'));
  policy = new AccountSigninPolicy(home);
  policy.seed([], new Date('2026-10-30T00:00:00Z'));
  vi.clearAllMocks();
  metadata.mockReturnValue(identity);
  install.hasOwner = true;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

type Actor = 'owner' | 'teammate' | 'agent' | 'key' | 'here' | 'here-signed-in';

/**
 * One request as `actor`: the owner's browser session, a teammate's, an
 * agent (its header on the owner's session), an API key, the person at this
 * computer with login off and no credential at all (`here`, from an app window),
 * or that person after their one step-up (`here-signed-in`, the session it left).
 */
async function call(actor: Actor, endpoint: string, body: object = {}, method = 'POST') {
  const app = new Hono<ApiEnv>();
  app.use('*', async (c, next) => {
    if (actor !== 'here')
      c.set('user', {
        userId: actor === 'teammate' ? 'other' : 'owner',
        credential: actor === 'key' ? 'api-key' : 'cookie',
      });
    c.set('body', body);
    await next();
  });
  // The chain step that turns a person bar's refusal into the app's step-up ask.
  app.use('*', personSessionRefusal());
  app.route(
    '/signins',
    createAccountSigninRoutes({
      policy: () => policy,
      accounts: () => [{ accountId: 'five', path: '/fake/five', name: 'Claude5' }],
      metadata,
    })
  );
  const here = actor === 'here' || actor === 'here-signed-in';
  const headers: Record<string, string> =
    actor === 'agent'
      ? { 'x-dorkos-agent': 'agent' }
      : here
        ? { host: 'localhost', 'x-client-id': 'window-1' }
        : {};
  return app.request(
    '/signins' + endpoint,
    { method, headers },
    {
      incoming: {
        headers,
        socket: here
          ? { remoteAddress: '127.0.0.1' }
          : { remoteAddress: '192.0.2.1', encrypted: true },
      } as unknown as IncomingMessage,
      outgoing: {} as ServerResponse,
    }
  );
}

describe('the sign-in routes take the person bar', () => {
  it.each(['agent', 'key', 'teammate'] as const)(
    'refuses %s on confirm, keep and both Never use lists',
    async (actor) => {
      // Confirm (a new sign-in) and keep (a changed one) are the same route.
      for (const endpoint of ['/organizations', '/folders', '/five/accept']) {
        const res = await call(actor, endpoint, {
          orgId: DENIED,
          label: 'Excluded',
          accountId: 'five',
        });
        expect(res.status).toBe(403);
      }
      expect((await call(actor, '/folders/five', {}, 'DELETE')).status).toBe(403);
      expect((await call(actor, `/organizations/${DENIED}`, {}, 'DELETE')).status).toBe(403);
      expect(metadata).not.toHaveBeenCalled();
      expect(policy.snapshot()).toEqual({ deniedOrganizations: [], folders: [] });
      expect(policy.assess('/fake/five', identity).state).toBe('unconfirmed');
    }
  );

  it('the owner confirms a new sign-in with no password', async () => {
    expect((await call('owner', '/five/accept')).status).toBe(200);
    expect(policy.assess('/fake/five', identity).state).toBe('confirmed');
  });

  it('the owner keeps a changed sign-in', async () => {
    await call('owner', '/five/accept');
    const changed = { ...identity, accountUuid: DENIED };
    metadata.mockReturnValue(changed);
    expect(policy.assess('/fake/five', changed).state).toBe('changed');
    expect((await call('owner', '/five/accept')).status).toBe(200);
    expect(policy.assess('/fake/five', changed).state).toBe('confirmed');
  });

  it('the person at this computer with login off confirms after their one step-up', async () => {
    const res = await call('here-signed-in', '/five/accept');
    expect(res.status).toBe(200);
    expect(policy.assess('/fake/five', identity).state).toBe('confirmed');
  });

  it('asks the app at this computer for the step-up first, and changes nothing', async () => {
    const res = await call('here', '/five/accept');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe(PERSON_SESSION_REQUIRED_CODE);
    expect(policy.assess('/fake/five', identity).state).toBe('unconfirmed');
  });

  it('with no owner yet, the person at this computer confirms with no session', async () => {
    install.hasOwner = false;
    const res = await call('here', '/five/accept');
    expect(res.status).toBe(200);
    expect(policy.assess('/fake/five', identity).state).toBe('confirmed');
  });

  it('refuses a denied organization even for the owner, and shows no identity', async () => {
    policy.addOrganization(DENIED, 'Ruled out');
    metadata.mockReturnValue({ ...identity, organizationUuid: DENIED });
    expect((await call('owner', '/five/accept')).status).toBe(409);
    const res = await call('owner', '', {}, 'GET');
    expect((await res.json()).accounts[0].identity).toEqual({ state: 'blocked' });
  });

  it('uses its own registry and never reads a never-use folder', async () => {
    expect(
      (await call('owner', '/folders', { accountId: 'five', path: '/etc/passwd' })).status
    ).toBe(400);
    expect((await call('owner', '/folders', { accountId: 'unknown' })).status).toBe(404);
    expect((await call('owner', '/folders', { accountId: 'five' })).status).toBe(200);
    expect((await call('owner', '/five/accept')).status).toBe(409);
    await call('owner', '', {}, 'GET');
    expect(metadata).not.toHaveBeenCalled();
  });
});
