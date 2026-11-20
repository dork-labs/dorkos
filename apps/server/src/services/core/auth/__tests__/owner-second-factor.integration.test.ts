/**
 * @vitest-environment node
 *
 * Once the owner has a passkey or an authenticator app, a password alone no
 * longer signs them in from another device (DOR-3647), through real Better
 * Auth and the real chain. This computer never asks for it. Passkeys come from
 * a software authenticator; no real authenticator is ever reached.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RequestListener } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { SoftAuthenticator } from '@dorkos/test-utils/soft-authenticator';
import { createDb, ownerFactors, runMigrations, type Db } from '@dorkos/db';

import { getAuth, initAuth, readOwnerAccount } from '../index.js';
import { createApiApp } from '../../../../http/api-chain.js';
import { mountBetterAuth } from '../../../../http/better-auth.js';
import { mountOwnerPasskeySignIn } from '../../../../http/sign-in/owner-passkey-sign-in.js';
import { frontDoorListener } from '../../../../http/front-door.js';
import { createDevicesRoutes } from '../../../../routes/devices.js';
import { MainRequestAdmission } from '../../lifecycle/main-request-admission.js';
import { configManager, initConfigManager } from '../../config-manager.js';
import { markIngress, type RequestIngress } from '../../remote/ingress-mark.js';
import { addPasskey, addPendingTotp, confirmTotp } from '../factors/owner-factors.js';
import { resetPasskeyChallengesForTests } from '../factors/owner-passkeys.js';
import { newTotpSecret, totpCodeAt, totpStepOf } from '../factors/totp.js';
import { env } from '../../../../env.js';

const target = swappableServer();
const EMAIL = 'owner' + '@' + 'dork.test';
const PASSWORD = 'correct-horse-battery-staple';
const LOCAL = `localhost:${env.DORKOS_PORT}`;
const ORIGIN = `http://${LOCAL}`;
const INGRESS_HEADER = 'x-test-ingress';

let tmpDir: string;
let db: Db;
let secret: string;
let attempts = 1000;

function buildApp(): RequestListener {
  const app = createApiApp({
    admission: new MainRequestAdmission(),
    beforeBodyParsing: (early) => {
      mountBetterAuth(early, { auth: getAuth()!, maxAttempts: attempts });
      mountOwnerPasskeySignIn(early, getAuth()!);
    },
  });
  app.route('/api/devices', createDevicesRoutes());
  const chain = frontDoorListener(app);
  return (req, res) => {
    const via = req.headers[INGRESS_HEADER];
    if (typeof via === 'string') markIngress(req, via as never);
    chain(req, res);
  };
}

/** A JSON POST from the app's own page through one listener. */
function post(url: string, via: RequestIngress) {
  let req = request(target.server)
    .post(url)
    .set('Host', LOCAL)
    .set('Origin', ORIGIN)
    .set('Content-Type', 'application/json');
  if (via !== 'direct') req = req.set(INGRESS_HEADER, via);
  return req;
}

/** A password sign-in, with or without an authenticator code. */
function signIn(via: RequestIngress, totpCode?: string) {
  return post('/api/auth/sign-in/email', via).send({
    email: EMAIL,
    password: PASSWORD,
    ...(totpCode === undefined ? {} : { totpCode }),
  });
}

/** The current code, `steps` steps from now. */
function codeNow(steps = 0): string {
  return totpCodeAt(secret, totpStepOf(Date.now()) + steps);
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-second-factor-'));
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
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetPasskeyChallengesForTests();
});

describe('before any second factor works remotely', () => {
  it('a password signs in from another device as before', async () => {
    expect((await signIn('own-tunnel')).status).toBe(200);
  });

  it('a passkey made only for this computer asks nothing of another device', async () => {
    const here = new SoftAuthenticator({ rpId: 'localhost', origin: ORIGIN, userHandle: 'aGVyZQ' });
    addPasskey({
      userId: readOwnerAccount()!.id,
      label: 'Desk',
      credentialId: here.credentialId,
      publicKey: here.cosePublicKeyBase64url(),
      alg: here.coseAlg,
      signCount: 0,
      rpId: 'localhost',
    });
    expect((await signIn('own-tunnel')).status).toBe(200);
  });
});

describe('with an authenticator app set up', () => {
  beforeAll(async () => {
    secret = newTotpSecret();
    const id = await addPendingTotp(readOwnerAccount()!.id, 'Phone', secret);
    confirmTotp(id, totpStepOf(Date.now()) - 5);
  });

  it.each(['own-tunnel', 'managed'] as const)('refuses a password alone over %s', async (via) => {
    const res = await signIn(via);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SECOND_FACTOR_REQUIRED');
    expect(res.headers['set-cookie'] ?? []).toEqual([]);
  });

  it.each(['/api/auth/sign-in/email/', '/API/auth/sign-in/email', '/api//auth/sign-in/email'])(
    'asks for it however the path is spelled: %s',
    async (url) => {
      const res = await post(url, 'own-tunnel').send({ email: EMAIL, password: PASSWORD });
      expect(res.status).not.toBe(200);
      expect(String(res.headers['set-cookie'] ?? '')).not.toMatch(/session_token=[^;]/);
    }
  );

  it('a wrong password with any code gets the ordinary refusal, and the code is never tried', async () => {
    const code = codeNow();
    const res = await post('/api/auth/sign-in/email', 'own-tunnel').send({
      email: EMAIL,
      password: 'not-the-password',
      totpCode: code,
    });
    expect(res.status).toBe(401);
    expect(res.body.code).not.toBe('SECOND_FACTOR_REQUIRED');
    expect(res.body.code).not.toBe('SECOND_FACTOR_REFUSED');
    // The step was not spent: the same code still works with the right password.
    expect((await signIn('own-tunnel', code)).status).toBe(200);
  });

  it('never passes on a body it cannot read: one padded past its limit', async () => {
    const res = await post('/api/auth/sign-in/email', 'own-tunnel').send(
      JSON.stringify({ email: EMAIL, password: PASSWORD, pad: ' '.repeat(9000) })
    );
    expect(res.status).not.toBe(200);
    expect(String(res.headers['set-cookie'] ?? '')).not.toMatch(/session_token=[^;]/);
  });

  it('reads a body with a byte-order mark the way Better Auth does', async () => {
    const res = await post('/api/auth/sign-in/email', 'own-tunnel').send(
      '\uFEFF' + JSON.stringify({ email: EMAIL, password: PASSWORD })
    );
    expect(res.status).not.toBe(200);
    expect(String(res.headers['set-cookie'] ?? '')).not.toMatch(/session_token=[^;]/);
  });

  it('refuses a wrong code', async () => {
    const res = await signIn('own-tunnel', '000000' === codeNow() ? '111111' : '000000');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SECOND_FACTOR_REFUSED');
  });

  it('signs in with the password and a current code, once per code', async () => {
    const code = codeNow(1);
    expect((await signIn('own-tunnel', code)).status).toBe(200);
    expect((await signIn('own-tunnel', code)).status).toBe(401);
  });

  it('a remote sign-in is listed with its device in Signed-in devices, and can be signed out there', async () => {
    // Two minutes on, so this test has a time step no other test spent.
    const realNow = Date.now;
    Date.now = () => realNow() + 120_000;
    let res;
    try {
      res = await signIn('own-tunnel', codeNow()).set('User-Agent', 'Mozilla/5.0 (iPhone) Safari');
    } finally {
      Date.now = realNow;
    }
    expect(res.status).toBe(200);
    const cookie = ((res.headers['set-cookie'] as unknown as string[]) ?? [])
      .map((value) => value.split(';')[0])
      .join('; ');
    const listed = await request(target.server)
      .get('/api/devices/sessions')
      .set('Host', LOCAL)
      .set(INGRESS_HEADER, 'own-tunnel')
      .set('Cookie', cookie);
    expect(listed.status).toBe(200);
    const mine = listed.body.sessions.find((row: { current: boolean }) => row.current);
    expect(mine).toMatchObject({ route: 'tunnel' });
    expect(mine.name).not.toBe('');
    const out = await request(target.server)
      .delete(`/api/devices/sessions/${mine.id}`)
      .set('Host', LOCAL)
      .set('Origin', ORIGIN)
      .set(INGRESS_HEADER, 'own-tunnel')
      .set('Cookie', cookie);
    expect(out.status).toBe(204);
  });

  it('never asks at this computer, which is how the owner gets back in', async () => {
    expect((await signIn('direct')).status).toBe(200);
  });

  it('a tunnel request from loopback is still another device', async () => {
    // Every supertest request comes from 127.0.0.1; the listener's mark decides.
    const res = await signIn('own-tunnel');
    expect(res.status).toBe(401);
  });

  it('forwarding headers on this computer’s listener never earn the skip: they only ask more', async () => {
    const res = await post('/api/auth/sign-in/email', 'direct')
      .set('X-Forwarded-For', '203.0.113.9')
      .set('X-Forwarded-Host', 'elsewhere.example')
      .set('X-Forwarded-Proto', 'https')
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SECOND_FACTOR_REQUIRED');
    // Without them, this computer's own listener never asks.
    expect((await signIn('direct')).status).toBe(200);
  });

  it('forwarding headers that name this computer never skip the check for a tunnel', async () => {
    const res = await post('/api/auth/sign-in/email', 'own-tunnel')
      .set('X-Forwarded-For', '127.0.0.1')
      .set('X-Forwarded-Host', 'localhost')
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(401);
  });
});

describe('with a passkey set up', () => {
  let key: SoftAuthenticator;

  beforeAll(() => {
    key = new SoftAuthenticator({ rpId: 'localhost', origin: ORIGIN, userHandle: 'b3duZXI' });
    addPasskey({
      userId: readOwnerAccount()!.id,
      label: 'Laptop',
      credentialId: key.credentialId,
      publicKey: key.cosePublicKeyBase64url(),
      alg: key.coseAlg,
      signCount: 0,
      rpId: 'localhost',
    });
  });

  /** A passkey sign-in through one listener; returns the finish response. */
  async function passkeySignIn(via: RequestIngress, host = LOCAL, origin = ORIGIN) {
    const asked = await post('/api/owner-sign-in/passkey/options', via)
      .set('Host', host)
      .set('Origin', origin)
      .send({});
    if (asked.status !== 200) return asked;
    const proof = key.assert({ challenge: asked.body.options.challenge });
    return post('/api/owner-sign-in/passkey/finish', via)
      .set('Host', host)
      .set('Origin', origin)
      .send({
        response: {
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
  }

  it('signs the owner in with no password', async () => {
    const res = await passkeySignIn('direct');
    expect(res.status).toBe(200);
    expect(String(res.headers['set-cookie'])).toMatch(/session_token/);
  });

  it('is never offered over Wi-Fi', async () => {
    const res = await post('/api/owner-sign-in/passkey/options', 'wifi').send({});
    expect(res.status).toBe(404);
  });

  it('refuses a page on a host that is not one of ours, whatever Host says', async () => {
    const res = await passkeySignIn('direct', 'evil.example', 'http://evil.example');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(String(res.headers['set-cookie'] ?? '')).not.toMatch(/session_token/);
  });
});

describe('the attempt limit', () => {
  it('still counts sign-ins that carry a code', async () => {
    attempts = 2;
    target.mount(buildApp());
    try {
      const results = [];
      for (let i = 0; i < 3; i += 1) results.push((await signIn('own-tunnel', '123456')).status);
      expect(results[2]).toBe(429);
    } finally {
      attempts = 1000;
      target.mount(buildApp());
      db.select().from(ownerFactors).all();
    }
  });
});
