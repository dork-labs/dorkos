import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { hashPassword } from 'better-auth/crypto';
import { createCommunityApp } from '../app.js';
import { createCommunityAuth } from '../auth.js';
import { parseConfig } from '../config.js';
import { migrate } from '../migrate.js';

// specs/spaces-email §1 and T17 (DOR-2710): every HTTP route the Better Auth instance answers is
// one somebody reviewed. A Better Auth upgrade or a new plugin that adds a route fails here until
// the route is added to the allowlist with a reason, or switched off.
const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for Better Auth route tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_auth_routes_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const PUBLIC_URL = 'http://localhost:6481';

/** Every setting that registers routes: all three providers and mail. */
const env = {
  COMMUNITY_DATABASE_URL: dbUrl.toString(),
  COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
  COMMUNITY_PUBLIC_URL: PUBLIC_URL,
  COMMUNITY_STORAGE_PATH: '/tmp/community-auth-routes-blobs',
  COMMUNITY_GOOGLE_CLIENT_ID: 'google-client',
  COMMUNITY_GOOGLE_CLIENT_SECRET: 'google-secret',
  COMMUNITY_GITHUB_CLIENT_ID: 'github-client',
  COMMUNITY_GITHUB_CLIENT_SECRET: 'github-secret',
  COMMUNITY_OIDC_ISSUER_URL: 'https://issuer.example',
  COMMUNITY_OIDC_CLIENT_ID: 'oidc-client',
  COMMUNITY_OIDC_CLIENT_SECRET: 'oidc-secret',
  COMMUNITY_SMTP_URL: 'smtps://smtp.example.com',
  COMMUNITY_MAIL_FROM: 'spaces@example.com',
};

const allowlist = JSON.parse(
  readFileSync(new URL('./better-auth-routes.allowlist.json', import.meta.url), 'utf8')
) as Record<string, string>;

interface Endpoint {
  path?: string;
  options?: { method?: string | string[]; metadata?: { SERVER_ONLY?: boolean } };
}

/**
 * The routes an instance answers over HTTP: every endpoint with a path that is not server-only,
 * not in `disabledPaths`, and not under a prefix the app refuses before Better Auth sees it.
 */
function httpRoutes(
  api: Record<string, unknown>,
  disabledPaths: readonly string[],
  refusedPrefixes: readonly string[]
): string[] {
  const routes = new Set<string>();
  for (const value of Object.values(api)) {
    const endpoint = value as Endpoint;
    if (typeof endpoint.path !== 'string' || endpoint.options?.metadata?.SERVER_ONLY) continue;
    if (disabledPaths.includes(endpoint.path)) continue;
    if (refusedPrefixes.some((prefix) => endpoint.path!.startsWith(prefix))) continue;
    const methods = endpoint.options?.method ?? 'GET';
    for (const method of Array.isArray(methods) ? methods : [methods])
      routes.add(`${method} ${endpoint.path}`);
  }
  return [...routes].sort();
}

/** The app refuses these before Better Auth's handler (app.ts). */
const REFUSED_PREFIXES = ['/reset-password/'];

let pool: Pool;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
});

afterAll(async () => {
  await pool?.end();
  // Wait for the pool's connections to finish closing: FORCE would terminate one mid-close into
  // an uncaught 57P01 (see migrate.integration.test.ts).
  for (let tries = 0; tries < 100; tries++) {
    const open = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1',
      [dbName]
    );
    if (open.rows[0].n === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('Better Auth routes', () => {
  it('answers only reviewed routes over HTTP (T17)', () => {
    // Purpose: fails when a route outside the reviewed allowlist becomes reachable, such as one a
    // Better Auth upgrade adds, or a switched-off path coming back on.
    const config = parseConfig(env);
    const auth = createCommunityAuth(pool, config, { emailLinksOn: true });
    const routes = httpRoutes(
      auth.api as unknown as Record<string, unknown>,
      auth.options.disabledPaths ?? [],
      REFUSED_PREFIXES
    );
    expect(routes).toEqual(Object.keys(allowlist).sort());
  });

  it('notices a route nobody reviewed', () => {
    // Purpose: fails if the census cannot see a new route, which would make the test above pass
    // whatever Better Auth registers.
    const config = parseConfig(env);
    const auth = createCommunityAuth(pool, config);
    const api = {
      ...(auth.api as unknown as Record<string, unknown>),
      sneaky: { path: '/magic-link/verify', options: { method: 'GET' } },
    };
    const routes = httpRoutes(api, auth.options.disabledPaths ?? [], REFUSED_PREFIXES);
    expect(routes.filter((route) => !(route in allowlist))).toEqual(['GET /magic-link/verify']);
  });

  it('keeps the server-side password check working with /verify-password off over HTTP (T17)', async () => {
    // Purpose: fails if switching off the HTTP path also broke the password confirmation every
    // careful action relies on (`password-confirmation.ts` calls `auth.api.verifyPassword`).
    const config = parseConfig(env);
    const app = createCommunityApp({ config, pool });
    const server = serve({ fetch: app.fetch, port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    const url = `http://localhost:${address.port}`;
    try {
      const userId = randomUUID();
      await pool.query(
        `INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,'P','p@example.com',true)`,
        [userId]
      );
      await pool.query(
        `INSERT INTO account(id,"accountId","providerId","userId",password)
         VALUES($1,$2,'credential',$2,$3)`,
        [randomUUID(), userId, await hashPassword('password-12345')]
      );
      const post = (path: string, body: unknown, cookie = '') =>
        fetch(`${url}${path}`, {
          method: 'POST',
          headers: {
            origin: PUBLIC_URL,
            'content-type': 'application/json',
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify(body),
        });
      const signedIn = await post('/api/auth/sign-in/email', {
        email: 'p@example.com',
        password: 'password-12345',
      });
      const cookie = signedIn.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      expect(
        (await post('/api/auth/verify-password', { password: 'password-12345' }, cookie)).status
      ).toBe(404);
      const auth = createCommunityAuth(pool, config);
      const headers = new Headers({ cookie });
      await expect(
        auth.api.verifyPassword({ headers, body: { password: 'password-12345' } })
      ).resolves.toMatchObject({ status: true });
      await expect(
        auth.api.verifyPassword({ headers, body: { password: 'wrong-password-1' } })
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
