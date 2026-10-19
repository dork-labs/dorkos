/**
 * Contract for the sign-in surface (specs/server-merge step 1, DOR-2875): the "Continue with
 * DorkOS" button a space offers when its host trusts DorkOS as its single sign-on issuer, the
 * callback path that issuer is registered with (`/api/auth/callback/oidc`), and the linking rule
 * for that trusted issuer: a verified email links to the existing account at once and signs in.
 * A fake issuer over real HTTP stands in for DorkOS. The Better Auth routes themselves are pinned
 * by the route census. A deliberate change updates this file in the same PR, says so in the PR
 * description, and is agreed with Cloud first.
 */
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CommunityWireAuthOptionsSchema } from '@dorkos/shared/community-wire';
import { parseConfig } from '../../config.js';
import { oidcCallbackUrl } from '../../oidc.js';
import { signInLinkComposers } from '../../sign-in/linked.js';
import { startFakeIssuer, type FakeIssuer } from '../fake-oidc-issuer.js';
import { contractSuite, type ContractServer } from './contract.js';
import { CENSUS_ENV } from './route-census.js';
import { startSpace, type SpaceFixture } from './space-fixture.js';

const PUBLIC_URL = CENSUS_ENV.COMMUNITY_PUBLIC_URL;
const CALLBACK = '/api/auth/callback/oidc';

/** A space whose host trusts a (fake) DorkOS issuer, as an official space does. */
async function startTrustingSpace(
  label: string
): Promise<ContractServer<SpaceFixture> & { issuer: FakeIssuer }> {
  const issuer = await startFakeIssuer();
  const settings = {
    COMMUNITY_OIDC_ISSUER_URL: issuer.issuer,
    COMMUNITY_OIDC_CLIENT_ID: issuer.clientId,
    COMMUNITY_OIDC_CLIENT_SECRET: issuer.clientSecret,
    COMMUNITY_OIDC_LABEL: 'Continue with DorkOS',
    COMMUNITY_OIDC_MARK: 'dorkos',
    COMMUNITY_OIDC_LINK_VERIFIED_EMAIL: '1',
    COMMUNITY_SMTP_URL: 'smtps://smtp.example.com',
    COMMUNITY_MAIL_FROM: 'space@example.com',
  };
  const space = await startSpace(
    label,
    {},
    {
      env: settings,
      noticeComposers: signInLinkComposers(parseConfig({ ...CENSUS_ENV, ...settings })),
    }
  ).catch(async (error: unknown) => {
    await issuer.close();
    throw error;
  });
  return {
    ...space,
    issuer,
    close: async () => {
      await space.close();
      await issuer.close();
    },
  };
}

const SignInStartSchema = z.object({ url: z.string(), redirect: z.literal(true) });

contractSuite('sign-in options', () => startTrustingSpace('promises_signin_options'), [
  {
    name: 'GET /auth-options offers "Continue with DorkOS" with the DorkOS mark',
    path: '/api/v1/auth-options',
    expect: {
      status: 200,
      schema: CommunityWireAuthOptionsSchema,
      match: {
        google: false,
        github: false,
        oidc: { label: 'Continue with DorkOS', mark: 'dorkos' },
      },
    },
  },
  {
    name: 'GET /auth-options answers the same under a community',
    path: (f) => `/api/v1/communities/${f.communityId}/auth-options`,
    expect: {
      status: 200,
      match: { oidc: { label: 'Continue with DorkOS', mark: 'dorkos' } },
    },
  },
  {
    name: 'POST /api/auth/sign-in/social starts the sign-in at the issuer, back to the callback path',
    method: 'POST',
    path: '/api/auth/sign-in/social',
    headers: { origin: PUBLIC_URL },
    body: { provider: 'oidc', callbackURL: '/signed-in', errorCallbackURL: '/sign-in-failed' },
    expect: { status: 200, schema: SignInStartSchema },
    keep: (_f, body) => {
      const away = new URL((body as { url: string }).url);
      expect(away.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}${CALLBACK}`);
      expect(away.searchParams.get('code_challenge_method')).toBe('S256');
    },
  },
  {
    name: 'POST /api/auth/sign-in/social refuses a bare ID token',
    method: 'POST',
    path: '/api/auth/sign-in/social',
    headers: { origin: PUBLIC_URL },
    body: { provider: 'oidc', idToken: { token: 'not-a-token' } },
    expect: { status: 400, match: { code: 'id_token_sign_in_disabled' } },
  },
]);

describe('contract: sign-in through the trusted issuer', () => {
  let space: Awaited<ReturnType<typeof startTrustingSpace>>;
  beforeAll(async () => {
    space = await startTrustingSpace('promises_signin_link');
  }, 120_000);
  afterAll(() => space?.close(), 60_000);

  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');

  const call = (path: string, method: string, body?: unknown, cookie = '') =>
    fetch(`${space.baseUrl}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        origin: PUBLIC_URL,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** Drive one sign-in as a browser would: start, the issuer's answer, then the callback. */
  async function signIn(email: string, verified = true) {
    space.issuer.identity = { sub: `sub-${email}`, email, email_verified: verified, name: 'P' };
    const start = await call('/api/auth/sign-in/social', 'POST', {
      provider: 'oidc',
      callbackURL: '/signed-in',
      errorCallbackURL: '/sign-in-failed',
    });
    const { url } = (await start.json()) as { url: string };
    const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
    const callback = await call(
      `${back.pathname}${back.search}`,
      'GET',
      undefined,
      cookieOf(start)
    );
    return { callback, back, cookie: cookieOf(callback) };
  }

  /** An account with a confirmed email and a password, made straight in the database. */
  async function existingAccount(email: string): Promise<string> {
    const userId = randomUUID();
    const { pool } = space.fixture.h;
    await pool.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)', [
      userId,
      'Existing',
      email,
    ]);
    await pool.query(
      `INSERT INTO account(id,"accountId","providerId","userId",password)
       VALUES($1,$2,'credential',$2,$3)`,
      [randomUUID(), userId, await hashPassword('existing-password-1234')]
    );
    return userId;
  }

  it('registers the callback path the issuer is told about', () => {
    // Purpose: fails if the redirect URI a host registered with DorkOS stops being this server's.
    expect(oidcCallbackUrl(PUBLIC_URL)).toBe(`${PUBLIC_URL}${CALLBACK}`);
  });

  it('links a verified email to the existing account at once and signs it in', async () => {
    // Purpose: fails if the trusted issuer's verified email stops linking without the password,
    // or the callback stops answering a redirect to where the sign-in asked to land.
    const userId = await existingAccount('linked@example.com');
    const { callback, back, cookie } = await signIn('linked@example.com');
    expect(back.pathname).toBe(CALLBACK);
    expect(callback.status).toBe(302);
    expect(new URL(callback.headers.get('location')!, PUBLIC_URL).pathname).toBe('/signed-in');
    const session = await call('/api/auth/get-session', 'GET', undefined, cookie);
    expect(((await session.json()) as { user: { id: string } }).user.id).toBe(userId);
    const { rows } = await space.fixture.h.pool.query<{ providerId: string }>(
      'SELECT "providerId" FROM account WHERE "userId"=$1 ORDER BY "providerId"',
      [userId]
    );
    expect(rows.map((row) => row.providerId)).toEqual(['credential', 'oidc']);
  });

  it('refuses an email the issuer did not verify, and links nothing', async () => {
    // Purpose: fails if the linking rule stops requiring a verified email from the issuer.
    const userId = await existingAccount('unverified@example.com');
    const { callback } = await signIn('unverified@example.com', false);
    expect(callback.status).toBe(302);
    const landed = new URL(callback.headers.get('location')!, PUBLIC_URL);
    expect(landed.pathname).toBe('/sign-in-failed');
    expect(landed.searchParams.get('error')).toBe('unable_to_get_user_info');
    const { rows } = await space.fixture.h.pool.query(
      'SELECT 1 FROM account WHERE "userId"=$1 AND "providerId"=\'oidc\'',
      [userId]
    );
    expect(rows).toEqual([]);
  });

  it('creates no account for someone new without an invitation', async () => {
    // Purpose: fails if a sign-in through the issuer becomes a way into a space nobody invited.
    const { callback } = await signIn('stranger@example.com');
    const landed = new URL(callback.headers.get('location')!, PUBLIC_URL);
    expect(landed.searchParams.get('error')).toBe('invitation_required');
    const { rows } = await space.fixture.h.pool.query('SELECT 1 FROM "user" WHERE email=$1', [
      'stranger@example.com',
    ]);
    expect(rows).toEqual([]);
  });
});
