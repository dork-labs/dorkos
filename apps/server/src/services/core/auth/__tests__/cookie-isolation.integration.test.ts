/**
 * @vitest-environment node
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, runMigrations } from '@dorkos/db';
import { createAuth } from '../index.js';
import { initConfigManager } from '../../config-manager.js';

// Exercise the production secure-cookie spelling and the normal env default.
// Both request origins are explicitly trusted through the existing CORS setting.
vi.mock('../../../../env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../env.js')>();
  return { ...original, env: { ...original.env, NODE_ENV: 'production', DORKOS_PORT: 4882 } };
});

const EMAIL = 'owner' + '@' + 'cookie-isolation.test';
const PASSWORD = 'synthetic-cookie-isolation-password';

describe('local sign-in cookie isolation across server ports', () => {
  let root: string;
  let primary: ReturnType<typeof instance>;
  let alternate: ReturnType<typeof instance>;
  let other: ReturnType<typeof instance>;

  function instance(port: number, home = path.join(root, String(port))) {
    fs.mkdirSync(home, { recursive: true });
    const db = createDb(path.join(home, 'auth.db'));
    runMigrations(db);
    // The alternate exercises the real env default rather than an explicit port.
    const auth = port === 4882 ? createAuth(db, home) : createAuth(db, home, port);
    return { port, db, auth };
  }

  async function call(
    target: ReturnType<typeof instance>,
    route: string,
    cookie = '',
    body?: object
  ) {
    const origin = `http://localhost:${target.port}`;
    return target.auth.handler(
      new Request(`${origin}/api/auth/${route}`, {
        method: body ? 'POST' : 'GET',
        headers: { origin, cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
    );
  }

  function cookiePairs(response: Response) {
    return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]);
  }

  beforeAll(() => {
    vi.stubEnv('BETTER_AUTH_SECRET', undefined);
    vi.stubEnv(
      'DORKOS_CORS_ORIGIN',
      [4242, 4882, 6242, 6243, 6244].map((port) => `http://localhost:${port}`).join(',')
    );
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-cookie-isolation-'));
    initConfigManager(root);
    primary = instance(4242);
    alternate = instance(4882);
    other = instance(6242);
  });

  afterAll(() => {
    primary?.db.$client.close();
    alternate?.db.$client.close();
    other?.db.$client.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('preserves both real sessions in a shared cookie jar, isolates sign-out, and survives reload', async () => {
    const primarySignUp = await call(primary, 'sign-up/email', '', {
      email: EMAIL,
      password: PASSWORD,
      name: 'Primary owner',
    });
    const alternateSignUp = await call(alternate, 'sign-up/email', '', {
      email: EMAIL,
      password: PASSWORD,
      name: 'Alternate owner',
    });
    const otherSignUp = await call(other, 'sign-up/email', '', {
      email: EMAIL,
      password: PASSWORD,
      name: 'Other owner',
    });
    expect(otherSignUp.status).toBe(200);
    expect(primarySignUp.status).toBe(200);
    expect(alternateSignUp.status).toBe(200);
    const primaryCookies = cookiePairs(primarySignUp);
    const alternateCookies = cookiePairs(alternateSignUp);
    const otherCookies = cookiePairs(otherSignUp);
    expect(primaryCookies.map((cookie) => cookie.split('=')[0])).toEqual([
      '__Secure-better-auth.session_token',
      '__Secure-better-auth.session_data',
    ]);
    expect(alternateCookies.map((cookie) => cookie.split('=')[0])).toEqual([
      expect.stringMatching(/^__Secure-better-auth-[a-f0-9]{32}\.session_token$/),
      expect.stringMatching(/^__Secure-better-auth-[a-f0-9]{32}\.session_data$/),
    ]);

    expect(otherCookies[0].split('=')[0]).not.toBe(alternateCookies[0].split('=')[0]);

    // Host-only Path=/ cookies share a jar across TCP ports. Applying Set-Cookie
    // overwrites the same NAME; concatenating two response arrays would hide that bug.
    const jar = new Map<string, string>();
    const apply = (pairs: string[]) => {
      for (const pair of pairs) {
        const separator = pair.indexOf('=');
        const name = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        if (value) jar.set(name, value);
        else jar.delete(name);
      }
    };
    const allCookies = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    apply(primaryCookies);
    apply(alternateCookies);
    apply(otherCookies);
    expect(jar.size).toBe(6);
    for (const [target, own, foreign, name] of [
      [primary, primaryCookies, alternateCookies, 'Primary owner'],
      [alternate, alternateCookies, otherCookies, 'Alternate owner'],
      [other, otherCookies, alternateCookies, 'Other owner'],
    ] as const) {
      for (const cookie of [own.join('; '), allCookies()]) {
        const response = await call(target, 'get-session', cookie);
        expect(response.status).toBe(200);
        expect((await response.json()).user.name).toBe(name);
      }
      const denied = await call(target, 'get-session', foreign.join('; '));
      expect(denied.status).toBe(200);
      expect(await denied.json()).toBeNull();
    }

    // Reopen the same persistent synthetic home/database. Token-only forces the
    // durable lookup rather than accepting the five-minute session cache alone.
    alternate.db.$client.close();
    alternate = instance(6243, path.join(root, '4882'));
    const reloaded = await call(alternate, 'get-session', alternateCookies[0]);
    expect(reloaded.status).toBe(200);
    expect((await reloaded.json()).user.name).toBe('Alternate owner');

    alternate.db.$client.close();
    const alias = path.join(root, 'alternate-alias');
    fs.symlinkSync(path.join(root, '4882'), alias, 'junction');
    alternate = instance(6244, alias);
    const throughAlias = await call(alternate, 'get-session', alternateCookies[0]);
    expect((await throughAlias.json()).user.name).toBe('Alternate owner');
    expect(cookiePairs(throughAlias).map((cookie) => cookie.split('=')[0])).toContain(
      alternateCookies[1].split('=')[0]
    );

    primary.db.$client.close();
    primary = instance(4242);
    const primaryReloaded = await call(primary, 'get-session', primaryCookies[0]);
    expect((await primaryReloaded.json()).user.name).toBe('Primary owner');

    const signOut = await call(alternate, 'sign-out', allCookies(), {});
    expect(signOut.status).toBe(200);
    apply(cookiePairs(signOut));
    const primaryAfter = await call(primary, 'get-session', allCookies());
    expect((await primaryAfter.json()).user.name).toBe('Primary owner');
    const alternateAfter = await call(alternate, 'get-session', allCookies());
    expect(await alternateAfter.json()).toBeNull();
  });

  it('refuses an unresolved non-default home instead of using a shared namespace', () => {
    expect(() => createAuth(primary.db, path.join(root, 'missing-home'), 6242)).toThrow();
  });
});
