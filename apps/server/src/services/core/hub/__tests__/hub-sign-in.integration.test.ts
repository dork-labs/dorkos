/**
 * "Continue with DorkOS" on a hub (`hub-sign-in.ts`), through real Better
 * Auth against an in-process public-client issuer: the owner signs in, nobody
 * else does, and no password works on a hub.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, user, type Db } from '@dorkos/db';

const role = vi.hoisted(() => ({ value: 'hub' as 'computer' | 'hub' }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));

const { initAuth, verifyRequestAuth } = await import('../../auth/index.js');
const { withRegistrationCaller } = await import('../../auth/registration-policy.js');
const { initConfigManager } = await import('../../config-manager.js');
const runner = await import('../hub-assignment-runner.js');
const serving = await import('../hub-serving.js');
const { HUB_SIGN_IN_CALLBACK_PATH, isTheOwner } = await import('../hub-sign-in.js');
const { startFakePublicIssuer } = await import('./fake-public-issuer.js');

const ADDRESS = 'https://hub-1.example.invalid';
const OWNER = 'acct_owner';

let issuer: Awaited<ReturnType<typeof startFakePublicIssuer>>;
let root: string;
let db: Db;
let auth: ReturnType<typeof initAuth>;

/** Serve with an assignment that names the fake issuer and `signIn`. */
function serve(signIn: { clientId: string; redirectUri: string } | undefined) {
  serving.resetHubServingStateForTests();
  serving.setHubServingState({
    state: 'serving',
    assignment: {
      state: 'assigned',
      assignmentId: 'asg_1',
      assignedAt: '2026-11-03T09:00:00Z',
      ownerAccountId: OWNER,
      issuer: issuer.issuer,
      address: ADDRESS,
      frontDoorProof: { header: 'x-example-proof', secret: 's'.repeat(40) },
      ...(signIn ? { signIn } : {}),
    },
  } as never);
}

const RIGHT_CLIENT = () => ({
  clientId: issuer.clientId,
  redirectUri: `${ADDRESS}${HUB_SIGN_IN_CALLBACK_PATH}`,
});

/** One request to Better Auth, as the front door hands it on. */
function call(route: string, init: { method?: string; cookie?: string; body?: unknown } = {}) {
  return auth.handler(
    new Request(`${ADDRESS}/api/auth/${route}`, {
      method: init.method ?? 'GET',
      redirect: 'manual',
      headers: {
        origin: ADDRESS,
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    })
  );
}

function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

/** Drive a whole sign-in as a browser would; returns the callback's answer. */
async function signIn(): Promise<{ start: Response; back?: Response; cookie: string }> {
  const start = await call('sign-in/social', {
    method: 'POST',
    body: { provider: 'dorkos', callbackURL: '/', errorCallbackURL: '/signed-out' },
  });
  if (start.status !== 200) return { start, cookie: '' };
  const { url } = (await start.json()) as { url: string };
  const authorize = await fetch(url, { redirect: 'manual' });
  const location = new URL(authorize.headers.get('location')!);
  // Inside the request's class, as `http/better-auth.ts` runs the handler.
  const back = await withRegistrationCaller({ kind: 'hub', route: 'hub' }, () =>
    auth.handler(
      new Request(location.href, { redirect: 'manual', headers: { cookie: cookiesOf(start) } })
    )
  );
  return { start, back, cookie: cookiesOf(back) };
}

beforeAll(async () => {
  vi.stubEnv('BETTER_AUTH_SECRET', undefined);
  issuer = await startFakePublicIssuer();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-hub-sign-in-'));
  initConfigManager(root);
  db = createDb(path.join(root, 'auth.db'));
  runMigrations(db);
  auth = initAuth(db, root);
  await runner.createHubOwner(auth, { email: 'owner@hub-1.example.invalid', name: 'Owner' });
  await runner.linkHubOwner(auth, OWNER);
  // Linking again changes nothing.
  await runner.linkHubOwner(auth, OWNER);
});

afterAll(async () => {
  await issuer.close();
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

beforeEach(() => {
  role.value = 'hub';
  issuer.identity = { sub: OWNER, email: 'owner@example.com', email_verified: true, name: 'Owner' };
  issuer.discovery = {};
  issuer.nonceOverride = null;
  serve(RIGHT_CLIENT());
});

describe('continue with DorkOS on a hub', () => {
  it('signs the owner in, with a public client and PKCE', async () => {
    const { back, cookie } = await signIn();
    expect(back?.status).toBe(302);
    expect(back?.headers.get('location')).toBe('/');
    const who = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(who?.user.email).toBe('owner@hub-1.example.invalid');
    expect(db.select().from(user).all()).toHaveLength(1);
    // Made on the hub, so it keeps working on the hub (DOR-2969).
    expect(who?.session.route).toBe('hub');
    const facts = { headers: { cookie }, peerAddress: '203.0.113.7', ingress: 'direct' as const };
    expect(await verifyRequestAuth(facts)).toMatchObject({
      userId: who!.user.id,
      credential: 'cookie',
      route: 'hub',
    });
  });

  it('turns away anyone else, and makes no account for them', async () => {
    issuer.identity = {
      sub: 'acct_someone_else',
      email: 'owner@example.com',
      email_verified: true,
      name: 'X',
    };
    const { back, cookie } = await signIn();
    expect(back?.headers.get('location')).toContain('/signed-out');
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
    expect(db.select().from(user).all()).toHaveLength(1);
  });

  it('never matches by email: a stranger with the owner account`s email is turned away', async () => {
    issuer.identity = {
      sub: 'acct_stranger',
      email: 'owner@hub-1.example.invalid',
      email_verified: true,
      name: 'Stranger',
    };
    const { back, cookie } = await signIn();
    expect(back?.headers.get('location')).toContain('/signed-out');
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
  });

  it('turns away anyone but the pinned owner, even one linked to the owner account', async () => {
    // Only the subject check stands between this stranger and a session.
    const context = await auth.$context;
    const ownerId = db.select().from(user).all()[0]!.id;
    await context.internalAdapter.createAccount({
      userId: ownerId,
      providerId: 'dorkos',
      accountId: 'acct_linked_stranger',
    });
    issuer.identity = {
      sub: 'acct_linked_stranger',
      email: 'x@example.com',
      email_verified: true,
      name: 'X',
    };
    const { back, cookie } = await signIn();
    expect(back?.headers.get('location')).toContain('/signed-out');
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
  });

  it('refuses an ID token whose nonce is not this sign-in`s', async () => {
    issuer.nonceOverride = 'a-nonce-from-another-sign-in';
    const { back, cookie } = await signIn();
    expect(back?.headers.get('location')).toContain('/signed-out');
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
  });

  it('never signs in from a bare ID token, even the owner`s', async () => {
    // Set the provider up first, as a real sign-in would have.
    await signIn();
    const res = await call('sign-in/social', {
      method: 'POST',
      body: {
        provider: 'dorkos',
        idToken: { token: issuer.mintIdToken({ ...issuer.identity, sub: OWNER }) },
      },
    });
    expect(res.status).not.toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.includes('session_token='))).toBe(false);
  });

  it('refuses an issuer that sends tokens or people anywhere but https', async () => {
    issuer.discovery = { userinfo_endpoint: 'http://userinfo.example.invalid/userinfo' };
    serve({ ...RIGHT_CLIENT(), clientId: 'a-third-client' });
    expect((await signIn()).start.status).toBe(503);
  });

  it('is closed with no sign-in client, or one whose redirect is not this hub`s callback', async () => {
    for (const client of [
      undefined,
      {
        ...RIGHT_CLIENT(),
        redirectUri: 'https://elsewhere.example.invalid/api/auth/callback/dorkos',
      },
      { ...RIGHT_CLIENT(), redirectUri: `${ADDRESS}/api/auth/callback/other` },
    ]) {
      serve(client);
      const { start } = await signIn();
      expect(start.status, JSON.stringify(client)).toBe(503);
    }
  });

  it('is closed while the hub does not serve', async () => {
    serving.resetHubServingStateForTests();
    expect((await signIn()).start.status).toBe(503);
  });

  it('refuses an issuer whose discovery names another issuer', async () => {
    issuer.discovery = { issuer: 'https://impostor.example.invalid' };
    // A fresh client key, so the plugin discovers again rather than reusing.
    serve({ ...RIGHT_CLIENT(), clientId: 'another-client' });
    expect((await signIn()).start.status).toBe(503);
  });

  it('has no passwords: sign-in, sign-up and resets by password are gone', async () => {
    for (const route of ['sign-in/email', 'sign-up/email', 'request-password-reset']) {
      const res = await call(route, {
        method: 'POST',
        body: { email: 'owner@hub-1.example.invalid', password: 'a-long-password', name: 'X' },
      });
      expect([400, 404], route).toContain(res.status);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });
});

describe('isTheOwner', () => {
  /** An unsigned token with these claims; the provider checks signatures before this runs. */
  const token = (claims: object) =>
    `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

  it('is the pinned subject, and only that', () => {
    expect(isTheOwner(token({ sub: OWNER }), { data: { sub: OWNER } }, OWNER)).toBe(true);
    expect(isTheOwner(token({ sub: OWNER }), { data: {} }, OWNER)).toBe(true);
    expect(
      isTheOwner(
        token({ sub: 'acct_other', email: 'owner@hub-1.example.invalid' }),
        { data: {} },
        OWNER
      )
    ).toBe(false);
    expect(isTheOwner(token({ sub: OWNER }), { data: { sub: 'acct_other' } }, OWNER)).toBe(false);
    expect(isTheOwner(undefined, { data: {} }, OWNER)).toBe(false);
    expect(isTheOwner('not-a-token', { data: {} }, OWNER)).toBe(false);
    expect(isTheOwner(token({ sub: OWNER }), null, OWNER)).toBe(false);
  });
});
