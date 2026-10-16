/**
 * The desktop window signs in by itself (F3, DOR-2966): a code minted in
 * process, traded at `POST /api/desktop/sign-in` for the owner's session
 * cookie, through real Better Auth and a real listener.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { honoListener, listeningServer } from '@dorkos/test-utils/listening-server';
import { createDb, runMigrations } from '@dorkos/db';

const managed = vi.hoisted(() => ({ by: 'desktop' as 'desktop' | undefined }));
vi.mock('../../../../env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../env.js')>();
  const env = new Proxy(original.env, {
    get: (target, key) =>
      key === 'DORKOS_MANAGED_BY'
        ? managed.by
        : key === 'NODE_ENV'
          ? 'production'
          : Reflect.get(target, key),
  });
  return { ...original, env };
});

const { initAuth, readOwnerAccount } = await import('../index.js');
const { initConfigManager } = await import('../../config-manager.js');
const signIn = await import('../desktop-sign-in.js');
const { mountDesktopSignIn } = await import('../../../../http/desktop-sign-in.js');

const LOCAL = 'localhost:4242';
let root: string;
let auth: ReturnType<typeof initAuth>;

// Better Auth is made in beforeAll; the route reads it per request.
const app = new Hono();
mountDesktopSignIn(
  app as never,
  {
    get api() {
      return auth.api;
    },
  } as ReturnType<typeof initAuth>
);
const server = listeningServer(honoListener(app));

beforeAll(async () => {
  vi.stubEnv('BETTER_AUTH_SECRET', undefined);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-desktop-sign-in-'));
  initConfigManager(root);
  const db = createDb(path.join(root, 'auth.db'));
  runMigrations(db);
  auth = initAuth(db, root);
  const origin = 'http://localhost:4242';
  const signedUp = await auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@example.invalid',
        password: 'a-long-password',
        name: 'O',
      }),
    })
  );
  expect(signedUp.status).toBe(200);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

beforeEach(() => {
  managed.by = 'desktop';
  signIn.resetDesktopSignInForTests();
});

/** A fresh code for the owner. */
function mint(): string {
  const code = signIn.mintDesktopSignInCode(readOwnerAccount()?.id ?? null);
  expect(code).toEqual(expect.any(String));
  return code!;
}

/** Post a code as the desktop window would. */
function redeem(code: string, headers: Record<string, string> = {}) {
  return request(server)
    .post('/api/desktop/sign-in')
    .set('Host', LOCAL)
    .set(headers)
    .send({ code });
}

describe('minting', () => {
  it('mints only when the desktop app runs this server and an owner exists', () => {
    expect(signIn.mintDesktopSignInCode(null)).toBeNull();
    managed.by = undefined;
    expect(signIn.mintDesktopSignInCode(readOwnerAccount()!.id)).toBeNull();
  });

  it('hands the desktop entry its mint through the process, and only on the desktop', () => {
    const slot = signIn.DESKTOP_SIGN_IN_MINT;
    delete (globalThis as Record<symbol, unknown>)[slot];
    managed.by = undefined;
    signIn.exposeDesktopSignInMint(() => 'user');
    expect((globalThis as Record<symbol, unknown>)[slot]).toBeUndefined();
    managed.by = 'desktop';
    signIn.exposeDesktopSignInMint(() => readOwnerAccount()?.id ?? null);
    const mintFromEntry = (globalThis as Record<symbol, unknown>)[slot] as () => string | null;
    expect(mintFromEntry()).toEqual(expect.any(String));
  });
});

describe('redeeming', () => {
  it('signs the owner in with a session cookie that never reaches disk', async () => {
    const res = await redeem(mint(), { 'Sec-Fetch-Site': 'none' });
    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith('__Secure-better-auth.session_token='));
    expect(session).toBeDefined();
    expect(session).not.toMatch(/max-age|expires/i);
    const pairs = cookies.map((c) => c.split(';')[0]).join('; ');
    const who = await auth.api.getSession({ headers: new Headers({ cookie: pairs }) });
    expect(who?.user.email).toBe('owner@example.invalid');
  });

  it('takes a code once, and refuses a wrong or expired one', async () => {
    const code = mint();
    expect((await redeem(code)).status).toBe(200);
    expect((await redeem(code)).status).toBe(401);
    mint();
    expect((await redeem('not-the-code')).status).toBe(401);
    const late = signIn.mintDesktopSignInCode(readOwnerAccount()!.id, Date.now() - 61_000);
    expect((await redeem(late!)).status).toBe(401);
  });

  it('refuses another device, or another site`s page, and keeps the code for the window', async () => {
    const code = mint();
    const others: Record<string, string>[] = [
      { 'X-Forwarded-For': '203.0.113.9' },
      { Origin: 'https://elsewhere.example.invalid' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
    ];
    for (const headers of others) {
      expect((await redeem(code, headers)).status, JSON.stringify(headers)).toBe(403);
    }
    const wrongHost = await request(server)
      .post('/api/desktop/sign-in')
      .set('Host', 'studio.example.invalid')
      .send({ code });
    expect(wrongHost.status).toBe(403);
    expect((await redeem(code)).status).toBe(200);
  });

  it('is not there unless the desktop app runs this server', async () => {
    const code = mint();
    managed.by = undefined;
    expect((await redeem(code)).status).toBe(404);
  });
});
