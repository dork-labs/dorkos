/**
 * @vitest-environment node
 *
 * The plain-http sign-in loop (F5, DOR-2968): a built DorkOS marks its sign-in
 * cookie `Secure`, and a browser drops a `Secure` cookie over plain http at any
 * address but this computer's own. Rather than "succeed" into a loop, the
 * sign-in answers with why, through the real `/api/auth` mount.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { honoListener, swappableServer } from '@dorkos/test-utils/listening-server';
import { createDb, runMigrations, type Db } from '@dorkos/db';

const { createAuth } = await import('../index.js');
const { initConfigManager } = await import('../../config-manager.js');
const { mountBetterAuth, SIGN_IN_NEEDS_HTTPS } = await import('../../../../http/better-auth.js');
const { env } = await import('../../../../env.js');
const { markIngress } = await import('../../remote/ingress-mark.js');
type ApiEnv = import('../../../../http/api-chain.js').ApiEnv;

const target = swappableServer();
const EMAIL = 'owner' + '@' + 'dork.test';
const PASSWORD = 'correct-horse-battery-staple';
const LOCAL = `localhost:${env.DORKOS_PORT}`;
const LAN = '192.168.1.5:4242';

/** The marked listener the next request arrives through, if any. */
let viaIngress: 'wifi' | 'managed' | 'own-tunnel' | null = null;

describe('a sign-in the browser would drop', () => {
  let tmpDir: string;
  let db: Db;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-dropped-sign-in-'));
    initConfigManager(tmpDir);
    db = createDb(path.join(tmpDir, 'auth.db'));
    runMigrations(db);
    const app = new Hono<ApiEnv>();
    app.use(async (c, next) => {
      if (viaIngress) markIngress(c.env.incoming, viaIngress);
      await next();
    });
    mountBetterAuth(app, { auth: createAuth(db, tmpDir), secureCookies: true, maxAttempts: 1000 });
    target.mount(honoListener(app));
    // The owner, made on this computer.
    await request(target.server)
      .post('/api/auth/sign-up/email')
      .set('Host', LOCAL)
      .set('Origin', `http://${LOCAL}`)
      .send({ email: EMAIL, password: PASSWORD, name: 'Owner' })
      .expect(200);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function signIn(host: string, extra: Record<string, string> = {}) {
    let req = request(target.server)
      .post('/api/auth/sign-in/email')
      .set('Host', host)
      .set('Origin', `${extra['x-forwarded-proto'] ?? 'http'}://${host}`);
    for (const [name, value] of Object.entries(extra)) req = req.set(name, value);
    return req.send({ email: EMAIL, password: PASSWORD });
  }

  it('explains, instead of looping, over plain http at a network address', async () => {
    const res = await signIn(LAN);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(SIGN_IN_NEEDS_HTTPS);
    expect(res.body.message).toMatch(/plain http/);
  });

  it('signs in normally on this computer, where browsers keep Secure cookies over http', async () => {
    const res = await signIn(LOCAL);
    expect(res.status).toBe(200);
  });

  it('signs in normally behind a proxy that says the browser used https', async () => {
    const res = await signIn(LAN, { 'x-forwarded-proto': 'https' });
    expect(res.status).toBe(200);
  });

  it('leaves the Wi-Fi listener alone, since it rewrites the cookie for plain http itself', async () => {
    viaIngress = 'wifi';
    try {
      const res = await signIn(LAN);
      expect(res.status).toBe(200);
    } finally {
      viaIngress = null;
    }
  });

  it.each(['managed', 'own-tunnel'] as const)(
    'signs in normally through %s, which reaches the server as https',
    async (ingress) => {
      viaIngress = ingress;
      try {
        const res = await signIn('box.ngrok.app', { 'x-forwarded-proto': 'https' });
        expect(res.status).toBe(200);
      } finally {
        viaIngress = null;
      }
    }
  );

  it('never refuses when the page itself is https, even with no forwarded scheme', async () => {
    const res = await request(target.server)
      .post('/api/auth/sign-in/email')
      .set('Host', LAN)
      .set('Origin', `https://${LAN}`)
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).not.toBe(409);
  });

  it.each(['127.0.0.2:4242', 'dorkos.localhost:4242'])(
    'treats %s as this computer, where browsers keep the cookie',
    async (host) => {
      const res = await signIn(host);
      expect(res.status).not.toBe(409);
    }
  );

  it('leaves a session refresh alone: only a new sign-in is checked', async () => {
    const signedIn = await signIn(LOCAL);
    const cookies = signedIn.headers['set-cookie'] as unknown as string[];
    const res = await request(target.server)
      .get('/api/auth/get-session')
      .set('Host', LAN)
      .set('Origin', `http://${LAN}`)
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
  });

  it('leaves a wrong password as it was', async () => {
    const res = await request(target.server)
      .post('/api/auth/sign-in/email')
      .set('Host', LAN)
      .set('Origin', `http://${LAN}`)
      .send({ email: EMAIL, password: 'not-the-password' });
    expect(res.status).toBe(401);
  });
});
