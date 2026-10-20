/**
 * @vitest-environment node
 *
 * A sign-in works only on the route it was made on (F4 part 1, DOR-2969),
 * through real Better Auth, the real chain and the real stream and MCP gates.
 */
import { NOT_FROM_WIFI } from '../sessions/wifi-level.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, RequestListener } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { apikey, createDb, runMigrations, session, type Db } from '@dorkos/db';

import { getAuth, initAuth } from '../index.js';
import { WIFI_SESSION_MAX_SECONDS } from '../sessions/session-route.js';
import { createApiApp } from '../../../../http/api-chain.js';
import {
  API_KEY_NEEDS_THIS_COMPUTER,
  mayWriteApiKeys,
  mountBetterAuth,
} from '../../../../http/better-auth.js';
import { frontDoorListener } from '../../../../http/front-door.js';
import { MainRequestAdmission } from '../../lifecycle/main-request-admission.js';
import { configManager, initConfigManager } from '../../config-manager.js';
import { markIngress, type RequestIngress } from '../../remote/ingress-mark.js';
import { authorizeStreamUpgrade } from '../../streams/stream-upgrade-auth.js';
import { decideMcpAuth } from '../../../../middleware/mcp-auth.js';
import { env } from '../../../../env.js';

const target = swappableServer();
const EMAIL = 'owner' + '@' + 'dork.test';
const PASSWORD = 'correct-horse-battery-staple';
const LOCAL = `localhost:${env.DORKOS_PORT}`;
const ORIGIN = `http://${LOCAL}`;
/** Test-only: names the listener the next request arrives through. */
const INGRESS_HEADER = 'x-test-ingress';

/** The real chain, behind a stand-in for the marked listeners. */
function buildApp(): RequestListener {
  const app = createApiApp({
    admission: new MainRequestAdmission(),
    beforeBodyParsing: (early) => mountBetterAuth(early, { auth: getAuth()!, maxAttempts: 1000 }),
  });
  app.get('/api/sessions', (c) => c.json({ user: c.get('user') ?? null }));
  app.post('/api/sessions', (c) => c.json({ user: c.get('user') ?? null }));
  const chain = frontDoorListener(app);
  return (req, res) => {
    const via = req.headers[INGRESS_HEADER];
    if (typeof via === 'string') markIngress(req, via as never);
    chain(req, res);
  };
}

/** Sign in through one route; returns the cookie pairs it set. */
async function signInVia(ingress: RequestIngress, body: Record<string, unknown> = {}) {
  let req = request(target.server)
    .post('/api/auth/sign-in/email')
    .set('Host', LOCAL)
    .set('Origin', ORIGIN);
  if (ingress !== 'direct') req = req.set(INGRESS_HEADER, ingress);
  const res = await req.send({ email: EMAIL, password: PASSWORD, ...body });
  return {
    status: res.status,
    cookie: ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .map((value) => value.split(';')[0])
      .join('; '),
  };
}

/** Call a gated route through one route with a cookie. */
function callVia(method: 'get' | 'post', ingress: RequestIngress, cookie: string) {
  let req = request(target.server)
    [method]('/api/sessions')
    .set('Host', LOCAL)
    .set('Cookie', cookie);
  if (ingress !== 'direct') req = req.set(INGRESS_HEADER, ingress);
  return req;
}

/** Call a Better Auth endpoint through one route with a cookie. */
function authCall(method: 'get' | 'post', url: string, ingress: RequestIngress, cookie: string) {
  let req = request(target.server)
    [method](`/api/auth/${url}`)
    .set('Host', LOCAL)
    .set('Origin', ORIGIN)
    .set('Cookie', cookie);
  if (ingress !== 'direct') req = req.set(INGRESS_HEADER, ingress);
  return req;
}

/** The facts a request through `ingress` carries, for the stream and MCP gates. */
function factsVia(ingress: RequestIngress, cookie: string) {
  return { headers: { host: LOCAL, cookie }, peerAddress: '127.0.0.1', ingress };
}

/** An upgrade through `ingress`, marked as its listener would mark it. */
function upgradeVia(ingress: RequestIngress, cookie: string): IncomingMessage {
  const req = { headers: { host: LOCAL, cookie }, socket: { remoteAddress: '127.0.0.1' } };
  if (ingress !== 'direct') markIngress(req as IncomingMessage, ingress);
  return req as IncomingMessage;
}

/** Only the session token: no signed snapshot, so every read sees the row. */
function tokenOnly(cookie: string): string {
  return cookie
    .split('; ')
    .filter((pair) => pair.split('=', 1)[0]!.endsWith('.session_token'))
    .join('; ');
}

/** The session row a cookie names. */
async function rowOf(db: Db, cookie: string) {
  const who = await getAuth()!.api.getSession({
    headers: new Headers({ cookie }),
    query: { disableCookieCache: true, disableRefresh: true },
  });
  return db.select().from(session).where(eq(session.id, who!.session.id)).get()!;
}

describe('a sign-in works only on the route it was made on', () => {
  let tmpDir: string;
  let db: Db;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-session-route-'));
    initConfigManager(tmpDir);
    // Ask at this computer too, so a local request needs a credential as well.
    configManager.set('auth', { enabled: true });
    db = createDb(path.join(tmpDir, 'auth.db'));
    runMigrations(db);
    initAuth(db, tmpDir);
    target.mount(buildApp());
    // The owner, made on this computer, with a route the client has no say in.
    const signUp = await request(target.server)
      .post('/api/auth/sign-up/email')
      .set('Host', LOCAL)
      .set('Origin', ORIGIN)
      .send({ email: EMAIL, password: PASSWORD, name: 'Owner', route: 'tunnel' });
    expect(signUp.status).toBe(200);
    const made = (signUp.headers['set-cookie'] as unknown as string[])
      .map((value) => value.split(';')[0])
      .join('; ');
    expect((await rowOf(db, made)).route).toBe('local');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ignores a route the client sends at sign-in', async () => {
    const { status, cookie } = await signInVia('direct', { route: 'wifi' });
    expect(status).toBe(200);
    expect((await rowOf(db, cookie)).route).toBe('local');
  });

  it('refuses a Wi-Fi cookie replayed at the tunnel or managed address', async () => {
    const { status, cookie } = await signInVia('wifi');
    expect(status).toBe(200);
    expect((await rowOf(db, cookie)).route).toBe('wifi');

    const ok = await callVia('post', 'wifi', cookie);
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ credential: 'cookie', route: 'wifi' });
    expect(ok.body.user.sessionId).toEqual(expect.any(String));

    for (const elsewhere of ['own-tunnel', 'managed', 'direct'] as const) {
      expect((await callVia('get', elsewhere, cookie)).status).toBe(401);
      expect((await callVia('post', elsewhere, cookie)).status).toBe(401);
      expect(await authorizeStreamUpgrade(upgradeVia(elsewhere, cookie))).toMatchObject({
        ok: false,
        status: 401,
      });
      const mcp = await decideMcpAuth('mcp', {
        method: 'POST',
        body: undefined,
        ...factsVia(elsewhere, cookie),
      });
      expect(mcp.allowed).toBe(false);
    }
    expect(await authorizeStreamUpgrade(upgradeVia('wifi', cookie))).toMatchObject({ ok: true });
    const mcp = await decideMcpAuth('mcp', {
      method: 'POST',
      body: undefined,
      ...factsVia('wifi', cookie),
    });
    // On its own route a Wi-Fi sign-in is still no identity at `/mcp`: only a
    // key speaks for an agent tool there (DOR-2969 part 3).
    expect(mcp.allowed).toBe(false);
  });

  it('reads with the whole cookie jar, snapshot included, only on its own route', async () => {
    const { cookie } = await signInVia('wifi');
    expect(cookie).toMatch(/\.session_data=/);
    const ok = await callVia('get', 'wifi', cookie);
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ credential: 'cookie', route: 'wifi' });
    for (const elsewhere of ['own-tunnel', 'managed', 'direct'] as const) {
      expect((await callVia('get', elsewhere, cookie)).status).toBe(401);
    }
  });

  it('is nobody at the sign-in endpoints on another route, and somebody on its own', async () => {
    const { cookie } = await signInVia('wifi');
    // The whole jar, the signed snapshot included, which could answer by itself.
    expect(cookie).toMatch(/\.session_data=/);
    const keys = () => db.select().from(apikey).all().length;

    for (const elsewhere of ['own-tunnel', 'managed', 'direct'] as const) {
      const before = keys();
      const created = await authCall('post', 'api-key/create', elsewhere, cookie).send({
        name: 'stolen',
      });
      // At this computer the key bar lets it through, and the session is nobody.
      expect(created.status).toBe(elsewhere === 'direct' ? 401 : 403);
      expect(keys()).toBe(before);
      const listed = await authCall('get', 'list-sessions', elsewhere, cookie);
      expect(listed.status).toBe(401);
      expect(listed.text).not.toMatch(/token/i);
      const who = await authCall('get', 'get-session', elsewhere, cookie);
      expect(who.status).toBe(200);
      expect(who.body).toBeNull();
      expect((await authCall('post', 'revoke-sessions', elsewhere, cookie).send({})).status).toBe(
        401
      );
      expect(
        (await authCall('post', 'update-user', elsewhere, cookie).send({ name: 'Taken' })).status
      ).toBe(401);
    }

    const listed = await authCall('get', 'list-sessions', 'wifi', cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.length).toBeGreaterThan(0);
    const who = await authCall('get', 'get-session', 'wifi', cookie);
    expect(who.body).toMatchObject({ session: { route: 'wifi' } });
  });

  it('reads a session cookie name the way Better Auth does: spaces, tabs, repeats', async () => {
    const { cookie } = await signInVia('wifi');
    const token = tokenOnly(cookie);
    const [name, value] = [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)];
    for (const disguised of [
      `${name} =${value}`,
      `${name}\t=${value}`,
      `theme=dark; ${name}=${value}; ${name} =${value}`,
    ]) {
      expect((await authCall('get', 'list-sessions', 'own-tunnel', disguised)).status).toBe(401);
      const who = await authCall('get', 'get-session', 'own-tunnel', disguised);
      expect(who.body).toBeNull();
      expect((await callVia('post', 'own-tunnel', disguised)).status).toBe(401);
    }
  });

  it('gets nothing from a revoked session’s cookie jar on another route', async () => {
    const { cookie } = await signInVia('wifi');
    const row = await rowOf(db, cookie);
    db.delete(session).where(eq(session.id, row.id)).run();
    for (const elsewhere of ['own-tunnel', 'direct'] as const) {
      expect((await authCall('get', 'api-key/list', elsewhere, cookie)).status).toBe(401);
      expect((await authCall('get', 'list-sessions', elsewhere, cookie)).status).toBe(401);
      expect(
        (await authCall('post', 'update-user', elsewhere, cookie).send({ name: 'Taken' })).status
      ).toBe(401);
      expect((await authCall('get', 'get-session', elsewhere, cookie)).body).toBeNull();
    }
  });

  it('makes and changes API keys only at this computer', async () => {
    const local = await signInVia('direct');
    const keys = () => db.select().from(apikey).all().length;
    const before = keys();
    const made = await authCall('post', 'api-key/create', 'direct', local.cookie).send({
      name: 'here',
    });
    expect(made.status).toBe(200);
    expect(keys()).toBe(before + 1);

    for (const ingress of ['wifi', 'own-tunnel', 'managed'] as const) {
      const { cookie } = await signInVia(ingress);
      for (const url of ['api-key/create', 'API-KEY/create/', 'api-key/update']) {
        const refused = await authCall('post', url, ingress, cookie).send({
          name: 'there',
          keyId: made.body.id,
        });
        expect(refused.status).toBe(403);
        // Wi-Fi meets the Wi-Fi level first, which refuses every key route there.
        expect(refused.body).toEqual(
          ingress === 'wifi'
            ? {
                code: NOT_FROM_WIFI,
                error: 'API keys are managed only at this computer.',
              }
            : {
                code: API_KEY_NEEDS_THIS_COMPUTER,
                message: 'API keys can only be made on this computer.',
              }
        );
      }
    }
    expect(keys()).toBe(before + 1);
  });

  it('cannot be steered to another endpoint by a forwarded scheme', async () => {
    const { cookie } = await signInVia('wifi');
    const keys = () => db.select().from(apikey).all().length;
    const before = keys();
    for (const smuggled of [
      `http://${LOCAL}/api/auth/api-key/create#`,
      `http://${LOCAL}/api/auth/api-key/create?`,
    ]) {
      const res = await authCall('post', 'get-session', 'wifi', cookie)
        .set('X-Forwarded-Proto', smuggled)
        .send({ name: 'smuggled' });
      // The garbage scheme is ignored, so this is the get-session it says it
      // is, which takes no POST: never the key endpoint.
      expect(res.status).toBe(405);
      expect(res.body?.key).toBeUndefined();
    }
    expect(keys()).toBe(before);
  });

  it('takes a plain forwarded scheme, and refuses a Host that is not a plain address', async () => {
    const local = await signInVia('direct');
    const https = await authCall('get', 'get-session', 'direct', local.cookie).set(
      'X-Forwarded-Proto',
      'https, http'
    );
    expect(https.body).toMatchObject({ session: { route: 'local' } });
    const garbage = await authCall('get', 'get-session', 'direct', local.cookie).set(
      'X-Forwarded-Proto',
      'javascript'
    );
    expect(garbage.body).toMatchObject({ session: { route: 'local' } });
    const before = db.select().from(apikey).all().length;
    const pathInHost = await authCall('post', 'get-session', 'wifi', local.cookie)
      .set('Host', `${LOCAL}/api/auth/api-key/create?`)
      .send({ name: 'smuggled' });
    expect(pathInHost.status).not.toBe(200);
    expect(db.select().from(apikey).all().length).toBe(before);
  });

  it('lets a hub’s owner make API keys there', () => {
    expect(mayWriteApiKeys({ kind: 'hub', route: 'hub' })).toBe(true);
    expect(mayWriteApiKeys({ kind: 'this-computer', route: 'local' })).toBe(true);
    expect(mayWriteApiKeys({ kind: 'other-device', route: 'wifi', reason: 'ingress' })).toBe(false);
    expect(mayWriteApiKeys({ kind: 'relayed', route: 'relay' })).toBe(false);
  });

  it('signs in at the tunnel while holding a Wi-Fi cookie, for the tunnel', async () => {
    const wifi = await signInVia('wifi');
    const res = await request(target.server)
      .post('/api/auth/sign-in/email')
      .set('Host', LOCAL)
      .set('Origin', ORIGIN)
      .set(INGRESS_HEADER, 'own-tunnel')
      .set('Cookie', wifi.cookie)
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    const tunnel = (res.headers['set-cookie'] as unknown as string[])
      .map((value) => value.split(';')[0])
      .join('; ');
    expect((await rowOf(db, tunnel)).route).toBe('tunnel');
    expect((await callVia('post', 'own-tunnel', tunnel)).status).toBe(200);
    // The Wi-Fi sign-in is untouched.
    expect((await callVia('post', 'wifi', wifi.cookie)).status).toBe(200);
  });

  it('refuses a cookie from this computer replayed over Wi-Fi', async () => {
    const { cookie } = await signInVia('direct');
    expect((await callVia('post', 'direct', cookie)).status).toBe(200);
    expect((await callVia('get', 'wifi', cookie)).status).toBe(401);
    expect((await callVia('post', 'wifi', cookie)).status).toBe(401);
    expect(await authorizeStreamUpgrade(upgradeVia('wifi', cookie))).toMatchObject({
      ok: false,
    });
  });

  it('keeps a sign-in from before this release working on this computer only', async () => {
    const { cookie } = await signInVia('direct');
    const row = await rowOf(db, cookie);
    db.update(session).set({ route: null }).where(eq(session.id, row.id)).run();
    const token = tokenOnly(cookie);
    expect((await callVia('get', 'direct', token)).status).toBe(200);
    expect((await callVia('post', 'direct', token)).status).toBe(200);
    for (const elsewhere of ['wifi', 'own-tunnel', 'managed'] as const) {
      expect((await callVia('post', elsewhere, token)).status).toBe(401);
    }
  });

  it('holds a Wi-Fi sign-in to 7 days from when it was made', async () => {
    const { cookie } = await signInVia('wifi');
    const row = await rowOf(db, cookie);
    const week = WIFI_SESSION_MAX_SECONDS * 1000;
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(week);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(week - 60_000);
    // Renewed by use, but made 8 days ago.
    db.update(session)
      .set({ createdAt: new Date(Date.now() - week - 86_400_000) })
      .where(eq(session.id, row.id))
      .run();
    expect((await callVia('post', 'wifi', tokenOnly(cookie))).status).toBe(401);
  });

  it('never signs anyone in through the session relay', async () => {
    const before = db.select().from(session).all().length;
    const { status, cookie } = await signInVia('relay');
    expect(status).toBe(403);
    expect(cookie).not.toMatch(/session_token=[^;]/);
    expect(db.select().from(session).all()).toHaveLength(before);
  });
});
