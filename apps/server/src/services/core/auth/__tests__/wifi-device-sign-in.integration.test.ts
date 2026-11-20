/**
 * @vitest-environment node
 *
 * Signing a device in over Wi-Fi with a one-time code from this computer, what
 * that device may do, and how long it lasts (DOR-4744), through real Better
 * Auth and the real chain. Passkeys come from a software authenticator; no
 * real authenticator is ever reached.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RequestListener } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { SoftAuthenticator } from '@dorkos/test-utils/soft-authenticator';
import { createDb, ownerFactors, runMigrations, session, type Db } from '@dorkos/db';

import { getAuth, initAuth, readOwnerAccount } from '../index.js';
import { createApiApp } from '../../../../http/api-chain.js';
import { mountBetterAuth } from '../../../../http/better-auth.js';
import { mountWifiSignIn } from '../../../../http/sign-in/wifi-sign-in.js';
import { frontDoorListener } from '../../../../http/front-door.js';
import { honoRequestFacts } from '../../../../http/request-facts.js';
import { createDevicesRoutes } from '../../../../routes/devices.js';
import { createStepUpRoutes } from '../../../../routes/step-up.js';
import { MainRequestAdmission } from '../../lifecycle/main-request-admission.js';
import { configManager, initConfigManager } from '../../config-manager.js';
import { markIngress } from '../../remote/ingress-mark.js';
import { addPasskey } from '../factors/owner-factors.js';
import { passkeyOrigins } from '../factors/owner-passkeys.js';
import { wifiTurnHeld } from '../sessions/wifi-turn-ceiling.js';
import {
  resetWifiSignInForTests,
  WIFI_SIGN_IN_CODE_TTL_MS,
} from '../sessions/wifi-sign-in-requests.js';
import { resetWifiActivityForTests } from '../sessions/wifi-activity.js';
import { WIFI_SESSION_IDLE_SECONDS } from '../sessions/session-route.js';
import { env } from '../../../../env.js';

const target = swappableServer();
const EMAIL = 'owner' + '@' + 'dork.test';
const PASSWORD = 'correct-horse-battery-staple';
const LOCAL = `localhost:${env.DORKOS_PORT}`;
const ORIGIN = `http://${LOCAL}`;
const INGRESS_HEADER = 'x-test-ingress';

/** The real chain, the devices routes, and a route that says whether a turn is held. */
function buildApp(): RequestListener {
  const app = createApiApp({
    admission: new MainRequestAdmission(),
    beforeBodyParsing: (early) => {
      mountBetterAuth(early, { auth: getAuth()!, maxAttempts: 1000 });
      mountWifiSignIn(early, getAuth()!);
    },
  });
  app.route('/api/step-up', createStepUpRoutes());
  app.route('/api/devices', createDevicesRoutes());
  app.post('/api/sessions', (c) =>
    c.json({ user: c.get('user') ?? null, held: wifiTurnHeld(honoRequestFacts(c)) })
  );
  const chain = frontDoorListener(app);
  return (req, res) => {
    const via = req.headers[INGRESS_HEADER];
    if (typeof via === 'string') markIngress(req, via as never);
    chain(req, res);
  };
}

/** Cookie pairs a response set. */
function cookiesOf(res: { headers: Record<string, unknown> }): string {
  return ((res.headers['set-cookie'] as string[] | undefined) ?? [])
    .map((value) => value.split(';')[0])
    .join('; ');
}

/** A JSON write from this server's own page, through one listener. */
function post(url: string, via: 'wifi' | 'direct', cookie = '', method: 'post' | 'put' = 'post') {
  let req = request(target.server)
    [method](url)
    .set('Host', LOCAL)
    .set('Origin', ORIGIN)
    .set('Content-Type', 'application/json');
  if (cookie) req = req.set('Cookie', cookie);
  if (via !== 'direct') req = req.set(INGRESS_HEADER, via);
  return req;
}

let deskCookie = '';
let desk: SoftAuthenticator;
let db: Db;
let tmpDir: string;

/** The desk's passkey answering a challenge, as the browser sends it. */
function passkeyResponse(challenge: string) {
  const proof = desk.assert({ challenge });
  return {
    id: proof.credentialId,
    rawId: proof.credentialId,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: proof.clientDataJSON,
      authenticatorData: proof.authenticatorData,
      signature: proof.signature,
    },
  };
}

/** Approve a request at the desk with a fresh passkey check; returns the code. */
async function approveAtDesk(viewId: string): Promise<string> {
  const asked = await post(
    `/api/devices/sign-in-requests/${viewId}/approve`,
    'direct',
    deskCookie
  ).send({});
  expect(asked.status).toBe(428);
  const proof = desk.assert({ challenge: asked.body.options.challenge });
  const approved = await post(
    `/api/devices/sign-in-requests/${viewId}/approve`,
    'direct',
    deskCookie
  ).send({
    passkey: {
      id: proof.credentialId,
      rawId: proof.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: proof.clientDataJSON,
        authenticatorData: proof.authenticatorData,
        signature: proof.signature,
      },
    },
  });
  expect(approved.status).toBe(200);
  return approved.body.code as string;
}

/** The view id of the newest open request, as the desk sees it. */
async function newestRequestId(): Promise<string> {
  const listed = await request(target.server)
    .get('/api/devices/sign-in-requests')
    .set('Host', LOCAL)
    .set('Cookie', deskCookie);
  expect(listed.status).toBe(200);
  return listed.body.requests[0].id as string;
}

/** A device on Wi-Fi asks, the desk approves, the device signs in. Returns its cookie. */
async function signInOverWifi(): Promise<string> {
  const started = await post('/api/wifi-sign-in/start', 'wifi').send({});
  expect(started.status).toBe(200);
  const code = await approveAtDesk(await newestRequestId());
  const done = await post('/api/wifi-sign-in/finish', 'wifi').send({
    requestId: started.body.requestId,
    code,
  });
  expect(done.status).toBe(200);
  return cookiesOf(done);
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-wifi-device-'));
  initConfigManager(tmpDir);
  configManager.set('auth', { enabled: true });
  db = createDb(path.join(tmpDir, 'auth.db'));
  runMigrations(db);
  initAuth(db, tmpDir);
  target.mount(buildApp());
  const signUp = await post('/api/auth/sign-up/email', 'direct').send({
    email: EMAIL,
    password: PASSWORD,
    name: 'Owner',
  });
  expect(signUp.status).toBe(200);
  deskCookie = cookiesOf(signUp);
  // A passkey made for this computer's own address, as the owner would add one.
  const origin = passkeyOrigins().find((candidate) => candidate === ORIGIN) ?? ORIGIN;
  desk = new SoftAuthenticator({ rpId: 'localhost', origin, userHandle: 'b3duZXI' });
  addPasskey({
    userId: readOwnerAccount()!.id,
    label: 'Desk',
    credentialId: desk.credentialId,
    publicKey: desk.cosePublicKeyBase64url(),
    alg: desk.coseAlg,
    signCount: 0,
    rpId: 'localhost',
  });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetWifiSignInForTests();
  resetWifiActivityForTests();
});

describe('Wi-Fi takes no password', () => {
  it.each(['/api/auth/sign-in/email', '/api/auth/sign-up/email'])('refuses %s', async (url) => {
    const res = await post(url, 'wifi').send({ email: EMAIL, password: PASSWORD, name: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WIFI_SIGN_IN_NEEDS_CODE');
    expect(cookiesOf(res)).not.toMatch(/session_token/);
  });

  it('still signs in by password at this computer', async () => {
    const res = await post('/api/auth/sign-in/email', 'direct').send({
      email: EMAIL,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
  });
});

describe('a one-time code from this computer', () => {
  it('signs the device in once, as a Wi-Fi sign-in', async () => {
    const started = await post('/api/wifi-sign-in/start', 'wifi').send({});
    const code = await approveAtDesk(await newestRequestId());
    const finish = () =>
      post('/api/wifi-sign-in/finish', 'wifi').send({ requestId: started.body.requestId, code });
    const first = await finish();
    expect(first.status).toBe(200);
    const row = db.select().from(session).where(eq(session.route, 'wifi')).all();
    expect(row.length).toBeGreaterThan(0);
    expect((await finish()).status).toBe(401);
  });

  it('completes only the request it was made for', async () => {
    const mine = await post('/api/wifi-sign-in/start', 'wifi').send({});
    const code = await approveAtDesk(await newestRequestId());
    const other = await post('/api/wifi-sign-in/start', 'wifi').send({});
    const res = await post('/api/wifi-sign-in/finish', 'wifi').send({
      requestId: other.body.requestId,
      code,
    });
    expect(res.status).toBe(401);
    expect(mine.body.requestId).not.toBe(other.body.requestId);
  });

  it('shows the device a match code the desk sees beside the request', async () => {
    const started = await post('/api/wifi-sign-in/start', 'wifi').send({});
    const listed = await request(target.server)
      .get('/api/devices/sign-in-requests')
      .set('Host', LOCAL)
      .set('Cookie', deskCookie);
    expect(listed.body.requests[0].matchCode).toBe(started.body.matchCode);
  });

  it('a code typed for another request ends the request it was made for', async () => {
    const a = await post('/api/wifi-sign-in/start', 'wifi').send({});
    const code = await approveAtDesk(await newestRequestId());
    const b = await post('/api/wifi-sign-in/start', 'wifi').send({});
    const wrong = await post('/api/wifi-sign-in/finish', 'wifi').send({
      requestId: b.body.requestId,
      code,
    });
    expect(wrong.status).toBe(401);
    const late = await post('/api/wifi-sign-in/finish', 'wifi').send({
      requestId: a.body.requestId,
      code,
    });
    expect(late.status).toBe(401);
  });

  it('stops working once its 5 minutes are up', async () => {
    const started = await post('/api/wifi-sign-in/start', 'wifi').send({});
    const code = await approveAtDesk(await newestRequestId());
    const realNow = Date.now;
    Date.now = () => realNow() + WIFI_SIGN_IN_CODE_TTL_MS + 1;
    try {
      const res = await post('/api/wifi-sign-in/finish', 'wifi').send({
        requestId: started.body.requestId,
        code,
      });
      expect(res.status).toBe(401);
    } finally {
      Date.now = realNow;
    }
  });

  it('is never made for a Wi-Fi caller, an agent or a program', async () => {
    await post('/api/wifi-sign-in/start', 'wifi').send({});
    const viewId = await newestRequestId();
    const url = `/api/devices/sign-in-requests/${viewId}/approve`;
    const wifiDevice = await signInOverWifi();
    const refusals = [
      await post(url, 'wifi', wifiDevice).send({}),
      await post(url, 'direct', deskCookie).set('X-DorkOS-Agent', 'agent-token').send({}),
      await post(url, 'direct', deskCookie).set('X-DorkOS-Approval', 'token').send({}),
      await post(url, 'direct').set('Authorization', 'Bearer not-a-key').send({}),
      await post(url, 'direct').send({}),
    ];
    for (const res of refusals) {
      expect([401, 403]).toContain(res.status);
      expect(res.body.code).not.toBe('PASSKEY_CHECK_REQUIRED');
      expect(res.body.options).toBeUndefined();
    }
  });

  it('is refused from another page, with no Origin, or as a form', async () => {
    await post('/api/wifi-sign-in/start', 'wifi').send({});
    const url = `/api/devices/sign-in-requests/${await newestRequestId()}/approve`;
    const other = await post(url, 'direct', deskCookie)
      .set('Origin', 'http://elsewhere.example')
      .send({});
    const none = await request(target.server)
      .post(url)
      .set('Host', LOCAL)
      .set('Cookie', deskCookie)
      .set('Content-Type', 'application/json')
      .send({});
    const form = await post(url, 'direct', deskCookie)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('a=1');
    for (const res of [other, none, form]) {
      expect(res.status).toBe(403);
      expect(res.body.options).toBeUndefined();
    }
  });

  it('answers an unknown and a used request alike', async () => {
    await post('/api/wifi-sign-in/start', 'wifi').send({});
    const viewId = await newestRequestId();
    await approveAtDesk(viewId);
    const used = await post(
      `/api/devices/sign-in-requests/${viewId}/approve`,
      'direct',
      deskCookie
    ).send({});
    const unknown = await post(
      '/api/devices/sign-in-requests/nope/approve',
      'direct',
      deskCookie
    ).send({});
    expect(used.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(used.body).toEqual(unknown.body);
  });

  it('needs a fresh passkey check for each approval', async () => {
    await post('/api/wifi-sign-in/start', 'wifi').send({});
    const first = await newestRequestId();
    await post('/api/wifi-sign-in/start', 'wifi').send({});
    const second = (
      await request(target.server)
        .get('/api/devices/sign-in-requests')
        .set('Host', LOCAL)
        .set('Cookie', deskCookie)
    ).body.requests.find((r: { id: string }) => r.id !== first).id as string;
    const asked = await post(
      `/api/devices/sign-in-requests/${first}/approve`,
      'direct',
      deskCookie
    ).send({});
    const proof = desk.assert({ challenge: asked.body.options.challenge });
    const passkey = {
      id: proof.credentialId,
      rawId: proof.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: proof.clientDataJSON,
        authenticatorData: proof.authenticatorData,
        signature: proof.signature,
      },
    };
    // A check made for the first request never approves the second.
    const reused = await post(
      `/api/devices/sign-in-requests/${second}/approve`,
      'direct',
      deskCookie
    ).send({ passkey });
    expect(reused.status).toBe(401);
    expect(reused.body.code).toBe('PASSKEY_REFUSED');
  });

  it('without a passkey on this computer, says to add one and approves nothing', async () => {
    const saved = db.select().from(ownerFactors).all();
    db.delete(ownerFactors).run();
    try {
      await post('/api/wifi-sign-in/start', 'wifi').send({});
      const url = `/api/devices/sign-in-requests/${await newestRequestId()}/approve`;
      const res = await post(url, 'direct', deskCookie)
        .set('X-DorkOS-Password', PASSWORD)
        .send({ password: PASSWORD });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PASSKEY_NEEDED');
      expect(res.body.code).not.toBe('STEP_UP_REQUIRED');
    } finally {
      for (const row of saved) db.insert(ownerFactors).values(row).run();
    }
  });
});

describe('what a Wi-Fi device may do', () => {
  /** A turn from the device, with the app page's own headers. */
  const turnFrom = (cookie: string, pageHeaders: boolean) => {
    let req = post('/api/sessions', 'wifi', cookie);
    if (pageHeaders) req = req.set('Sec-Fetch-Site', 'same-origin');
    else req = req.unset('Origin');
    return req.send({});
  };

  it('holds the owner’s own turns while the device is not allowed', async () => {
    const device = await signInOverWifi();
    for (const pageHeaders of [true, false]) {
      const res = await turnFrom(device, pageHeaders);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ route: 'wifi' });
      expect(res.body.held).toBe(true);
    }
  });

  it('starts every device off, and only the desk turns it on', async () => {
    const device = await signInOverWifi();
    const list = await request(target.server)
      .get('/api/devices/sessions')
      .set('Host', LOCAL)
      .set('Cookie', deskCookie);
    const row = list.body.sessions.find(
      (s: { route: string; runsAgents?: boolean }) => s.route === 'wifi'
    );
    expect(row.runsAgents).toBe(false);
    const url = `/api/devices/sessions/${row.id}/runs-agents`;
    const fromWifi = await post(url, 'wifi', device, 'put').send({ on: true });
    const asAgent = await post(url, 'direct', deskCookie, 'put')
      .set('X-DorkOS-Agent', 'agent-token')
      .send({ on: true });
    expect(fromWifi.status).toBe(403);
    expect(fromWifi.body.code).toBe('NOT_FROM_WIFI');
    expect(asAgent.status).toBe(403);
    expect((await turnFrom(device, true)).body.held).toBe(true);

    // A password never turns it on: only a fresh passkey check at the desk.
    const asked = await post(url, 'direct', deskCookie, 'put').send({ on: true });
    expect(asked.status).toBe(428);
    expect((await turnFrom(device, true)).body.held).toBe(true);
    const allowed = await post(url, 'direct', deskCookie, 'put').send({
      on: true,
      passkey: passkeyResponse(asked.body.options.challenge),
    });
    expect(allowed.status).toBe(204);
    expect((await turnFrom(device, true)).body.held).toBe(false);

    // Another device is still held, and that check cannot be used again for it.
    const other = await signInOverWifi();
    expect((await turnFrom(other, true)).body.held).toBe(true);
    const otherRow = (
      await request(target.server)
        .get('/api/devices/sessions')
        .set('Host', LOCAL)
        .set('Cookie', deskCookie)
    ).body.sessions.find(
      (s: { id: string; route: string }) => s.route === 'wifi' && s.id !== row.id
    );
    const reused = await post(
      `/api/devices/sessions/${otherRow.id}/runs-agents`,
      'direct',
      deskCookie,
      'put'
    ).send({
      on: true,
      passkey: passkeyResponse(asked.body.options.challenge),
    });
    expect(reused.status).toBe(401);
    expect((await turnFrom(other, true)).body.held).toBe(true);

    // Turning it off answers at once.
    const off = await post(url, 'direct', deskCookie, 'put').send({ on: false });
    expect(off.status).toBe(204);
    expect((await turnFrom(device, true)).body.held).toBe(true);
  });

  it('a passkey check made for approving a sign-in never lets a device run agents', async () => {
    const device = await signInOverWifi();
    await post('/api/wifi-sign-in/start', 'wifi').send({});
    const viewId = await newestRequestId();
    const asked = await post(
      `/api/devices/sign-in-requests/${viewId}/approve`,
      'direct',
      deskCookie
    ).send({});
    const row = (
      await request(target.server)
        .get('/api/devices/sessions')
        .set('Host', LOCAL)
        .set('Cookie', deskCookie)
    ).body.sessions.find((s: { route: string }) => s.route === 'wifi');
    const res = await post(
      `/api/devices/sessions/${row.id}/runs-agents`,
      'direct',
      deskCookie,
      'put'
    ).send({
      on: true,
      passkey: passkeyResponse(asked.body.options.challenge),
    });
    expect(res.status).toBe(401);
    expect((await turnFrom(device, true)).body.held).toBe(true);
  });

  it('a device left unused for 12 hours is signed out, and its choice with it', async () => {
    const device = await signInOverWifi();
    expect((await turnFrom(device, true)).status).toBe(200);
    const id = (await turnFrom(device, true)).body.user.sessionId as string;
    const longAgo = new Date(Date.now() - WIFI_SESSION_IDLE_SECONDS * 1000 - 60_000);
    db.update(session)
      .set({ lastActiveAt: longAgo, createdAt: longAgo, wifiAgentTurnsAt: longAgo })
      .where(eq(session.id, id))
      .run();
    resetWifiActivityForTests();
    const token = device
      .split('; ')
      .filter((pair) => pair.split('=', 1)[0]!.endsWith('.session_token'))
      .join('; ');
    const res = await turnFrom(token, true);
    expect(res.status).toBe(401);
  });

  it('a Wi-Fi sign-in older than 7 days ends, however recently used', async () => {
    const device = await signInOverWifi();
    const id = (await turnFrom(device, true)).body.user.sessionId as string;
    db.update(session)
      .set({
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 - 60_000),
        lastActiveAt: new Date(),
      })
      .where(eq(session.id, id))
      .run();
    const token = device
      .split('; ')
      .filter((pair) => pair.split('=', 1)[0]!.endsWith('.session_token'))
      .join('; ');
    expect((await turnFrom(token, true)).status).toBe(401);
  });
});
