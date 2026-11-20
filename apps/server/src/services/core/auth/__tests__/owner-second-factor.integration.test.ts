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

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { SoftAuthenticator } from '@dorkos/test-utils/soft-authenticator';
import { auditEvents, createDb, ownerFactors, runMigrations, type Db } from '@dorkos/db';

import { getAuth, initAuth, readOwnerAccount } from '../index.js';
import { createApiApp } from '../../../../http/api-chain.js';
import { mountBetterAuth } from '../../../../http/better-auth.js';
import { mountOwnerPasskeySignIn } from '../../../../http/sign-in/owner-passkey-sign-in.js';
import { frontDoorListener } from '../../../../http/front-door.js';
import { createDevicesRoutes } from '../../../../routes/devices.js';
import { createOwnerFactorRoutes } from '../../../../routes/owner-factors.js';
import { createStepUpRoutes } from '../../../../routes/step-up.js';
import { AuditLog } from '../../../audit/audit-log.js';
import { AccountIds } from '../../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../../audit/audit-trail.js';
import {
  setNotificationService,
  type NotificationService,
} from '../../../notifications/notification-service.js';
import { MainRequestAdmission } from '../../lifecycle/main-request-admission.js';
import { configManager, initConfigManager } from '../../config-manager.js';
import { markIngress, type RequestIngress } from '../../remote/ingress-mark.js';
import {
  addPasskey,
  addPendingTotp,
  confirmTotp,
  confirmedFactors,
  removeOwnerFactor,
} from '../factors/owner-factors.js';
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
  app.route('/api/owner-factors', createOwnerFactorRoutes());
  app.route('/api/step-up', createStepUpRoutes());
  const chain = frontDoorListener(app);
  return (req, res) => {
    const via = req.headers[INGRESS_HEADER];
    if (typeof via === 'string') markIngress(req, via as never);
    chain(req, res);
  };
}

/** A JSON POST from the app's own page through one listener. */
function post(url: string, via: RequestIngress, cookie = '', method: 'post' | 'delete' = 'post') {
  let req = request(target.server)
    [method](url)
    .set('Host', LOCAL)
    .set('Origin', ORIGIN)
    .set('Content-Type', 'application/json');
  if (cookie) req = req.set('Cookie', cookie);
  if (via !== 'direct') req = req.set(INGRESS_HEADER, via);
  return req;
}

/** Cookie pairs a response set. */
function cookiesOf(res: { headers: Record<string, unknown> }): string {
  return ((res.headers['set-cookie'] as string[] | undefined) ?? [])
    .map((value) => value.split(';')[0])
    .join('; ');
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

  it('an authenticator app still waiting for its first code asks nothing either', async () => {
    await addPendingTotp(readOwnerAccount()!.id, 'Not yet', newTotpSecret());
    expect((await signIn('own-tunnel')).status).toBe(200);
  });
});

describe('sign-in checks change only at this computer', () => {
  const notices: string[] = [];
  let desk: SoftAuthenticator;
  let deskCookie = '';

  /** The desk passkey answering a check, as the browser sends it. */
  function deskProof(challenge: string) {
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

  /** Confirm a held change with the password, as the app's step-up does. */
  function confirmHeld(heldId: string) {
    return post(`/api/step-up/${heldId}/password`, 'direct', deskCookie).send({
      password: PASSWORD,
    });
  }

  beforeAll(async () => {
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
    setNotificationService({
      notify: vi.fn(async (kind: string) => {
        notices.push(kind);
        return { notification: null, deduped: false };
      }),
    } as unknown as NotificationService);
    desk = new SoftAuthenticator({ rpId: 'localhost', origin: ORIGIN, userHandle: 'ZGVzaw' });
    addPasskey({
      userId: readOwnerAccount()!.id,
      label: 'Desk check',
      credentialId: desk.credentialId,
      publicKey: desk.cosePublicKeyBase64url(),
      alg: desk.coseAlg,
      signCount: 0,
      rpId: 'localhost',
    });
    const signedIn = await signIn('direct');
    expect(signedIn.status).toBe(200);
    deskCookie = cookiesOf(signedIn);
  });

  afterAll(() => {
    setNotificationService(null);
    resetAuditTrail();
  });

  it.each(['own-tunnel', 'managed'] as const)(
    'every change is refused over %s, even signed in there with the password',
    async (via) => {
      const signedIn = await signIn(via);
      expect(signedIn.status).toBe(200);
      const cookie = cookiesOf(signedIn);
      const changes = [
        post('/api/owner-factors/passkeys/options', via, cookie).send({ label: 'x' }),
        post('/api/owner-factors/passkeys/finish', via, cookie).send({ response: {} }),
        post('/api/owner-factors/authenticator/start', via, cookie).send({ label: 'x' }),
        post('/api/owner-factors/authenticator/confirm', via, cookie).send({ id: 'x', code: '1' }),
        post('/api/owner-factors/anything', via, cookie, 'delete').send({}),
      ];
      for (const res of await Promise.all(changes)) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('NEEDS_PERSON_AT_THIS_COMPUTER');
      }
      // Reading them is still the owner's, from there too.
      const read = await request(target.server)
        .get('/api/owner-factors')
        .set('Host', LOCAL)
        .set(INGRESS_HEADER, via)
        .set('Cookie', cookie);
      expect(read.status).toBe(200);
    }
  );

  it('with a passkey on this computer, adding an authenticator app needs a passkey check first', async () => {
    const res = await post('/api/owner-factors/authenticator/start', 'direct', deskCookie).send({
      label: 'Phone',
    });
    expect(res.status).toBe(428);
    expect(res.body.code).toBe('PASSKEY_CHECK_REQUIRED');
    expect(res.body.secret).toBeUndefined();
  });

  it('adding a passkey here writes one Activity line and one notice', async () => {
    const before = db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'auth.passkey_added'))
      .all().length;
    notices.length = 0;
    // A passkey is here already, so another takes a check with it, then the password.
    const asked = await post('/api/owner-factors/passkeys/options', 'direct', deskCookie).send({
      label: 'Laptop',
    });
    expect(asked.status).toBe(428);
    expect(asked.body.code).toBe('PASSKEY_CHECK_REQUIRED');
    const held = await post('/api/owner-factors/passkeys/options', 'direct', deskCookie).send({
      label: 'Laptop',
      passkey: deskProof(asked.body.options.challenge),
    });
    expect(held.status).toBe(428);
    expect(held.body.code).toBe('step_up_required');
    const confirmed = await confirmHeld(held.body.heldActionId);
    expect(confirmed.body).toMatchObject({ ok: true, status: 200 });
    const fresh = new SoftAuthenticator({ rpId: 'localhost', origin: ORIGIN, userHandle: 'bmV3' });
    const made = fresh.attest({ challenge: confirmed.body.result.options.challenge });
    const finish = await post('/api/owner-factors/passkeys/finish', 'direct', deskCookie).send({
      response: {
        id: made.credentialId,
        rawId: made.credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: made.clientDataJSON,
          attestationObject: made.attestationObject,
        },
      },
    });
    expect(finish.status).toBe(200);
    const rows = db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'auth.passkey_added'))
      .all();
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)!.summary).toBe('A passkey was added on this computer');
    expect(notices).toEqual(['signin.check_added']);
  });

  it('removing one takes a passkey check, then the password, and raises a notice', async () => {
    const target = confirmedFactors(readOwnerAccount()!.id, 'passkey').find(
      (row) => row.label === 'Laptop'
    )!;
    notices.length = 0;
    const url = `/api/owner-factors/${target.id}`;
    const asked = await post(url, 'direct', deskCookie, 'delete').send({});
    expect(asked.status).toBe(428);
    expect(asked.body.code).toBe('PASSKEY_CHECK_REQUIRED');
    const held = await post(url, 'direct', deskCookie, 'delete').send({
      passkey: deskProof(asked.body.options.challenge),
    });
    expect(held.status).toBe(428);
    expect(held.body.code).toBe('step_up_required');
    const confirmed = await confirmHeld(held.body.heldActionId);
    expect(confirmed.body).toMatchObject({ ok: true, status: 204 });
    expect(notices).toEqual(['signin.check_removed']);
    expect(confirmedFactors(readOwnerAccount()!.id).some((row) => row.id === target.id)).toBe(
      false
    );
    // Kept on record, marked removed.
    const kept = db.select().from(ownerFactors).where(eq(ownerFactors.id, target.id)).get();
    expect(kept).toBeDefined();
    expect(kept!.removedAt).toBeInstanceOf(Date);
  });

  it('a page at another of this computer’s addresses is asked to use the passkey’s own, never skipped', async () => {
    const at127 = `127.0.0.1:${env.DORKOS_PORT}`;
    const res = await post('/api/owner-factors/authenticator/start', 'direct', deskCookie)
      .set('Host', at127)
      .set('Origin', `http://${at127}`)
      .send({ label: 'Phone' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSKEY_ON_OTHER_ADDRESS');
    expect(res.body.secret).toBeUndefined();
  });

  it('the first check that works from other devices signs out sign-ins made from them before it', async () => {
    const tunnel = cookiesOf(await signIn('own-tunnel'));
    const managed = cookiesOf(await signIn('managed'));
    const otherDesk = cookiesOf(await signIn('direct'));
    const asked = await post('/api/owner-factors/authenticator/start', 'direct', deskCookie).send({
      label: 'Phone',
    });
    expect(asked.status).toBe(428);
    const held = await post('/api/owner-factors/authenticator/start', 'direct', deskCookie).send({
      label: 'Phone',
      passkey: deskProof(asked.body.options.challenge),
    });
    expect(held.body.code).toBe('step_up_required');
    const started = await confirmHeld(held.body.heldActionId);
    expect(started.body).toMatchObject({ ok: true, status: 200 });
    const { id, secret: fresh } = started.body.result as { id: string; secret: string };
    const confirmed = await post(
      '/api/owner-factors/authenticator/confirm',
      'direct',
      deskCookie
    ).send({
      id,
      code: totpCodeAt(fresh, totpStepOf(Date.now())),
    });
    expect(confirmed.status).toBe(200);
    const read = (cookie: string, via: RequestIngress) => {
      let req = request(target.server)
        .get('/api/owner-factors')
        .set('Host', LOCAL)
        .set('Cookie', cookie);
      if (via !== 'direct') req = req.set(INGRESS_HEADER, via);
      return req;
    };
    expect((await read(tunnel, 'own-tunnel')).status).toBe(401);
    expect((await read(managed, 'managed')).status).toBe(401);
    // The sign-in that confirmed it, and this computer's other sign-ins, stay.
    expect((await read(deskCookie, 'direct')).status).toBe(200);
    expect((await read(otherDesk, 'direct')).status).toBe(200);
  });

  it('with no passkey on this computer, a change goes straight to "Confirm it’s you"', async () => {
    const owner = readOwnerAccount()!.id;
    const keys = confirmedFactors(owner, 'passkey');
    for (const row of keys) removeOwnerFactor(owner, row.id);
    try {
      const res = await post('/api/owner-factors/authenticator/start', 'direct', deskCookie).send({
        label: 'Phone',
      });
      expect(res.status).toBe(428);
      expect(res.body.code).toBe('step_up_required');
    } finally {
      for (const row of keys) {
        db.update(ownerFactors).set({ removedAt: null }).where(eq(ownerFactors.id, row.id)).run();
      }
    }
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

  it('its finish is not there over Wi-Fi either, even with a good proof', async () => {
    const asked = await post('/api/owner-sign-in/passkey/options', 'direct').send({});
    expect(asked.status).toBe(200);
    const proof = key.assert({ challenge: asked.body.options.challenge });
    const res = await post('/api/owner-sign-in/passkey/finish', 'wifi').send({
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
    expect(res.status).toBe(404);
    expect(String(res.headers['set-cookie'] ?? '')).not.toMatch(/session_token/);
  });

  it('an address that is not on the fixed list is refused, whatever Host and Origin say', async () => {
    // A Host on another local port, with an Origin that matches it.
    const res = await post('/api/owner-sign-in/passkey/options', 'direct')
      .set('Host', 'localhost:4999')
      .set('Origin', 'http://localhost:4999')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.options).toBeUndefined();
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

describe('once a check that works from another device has existed', () => {
  let spare: string;

  beforeAll(async () => {
    const owner = readOwnerAccount()!.id;
    // Keep one live authenticator, and remove every other.
    spare = newTotpSecret();
    const keep = await addPendingTotp(owner, 'Spare', spare);
    confirmTotp(keep, totpStepOf(Date.now()) - 5);
    for (const row of confirmedFactors(owner, 'totp')) {
      if (row.id !== keep) removeOwnerFactor(owner, row.id);
    }
  });

  it('a removed authenticator’s code no longer signs in, while another is still set up', async () => {
    const res = await signIn('own-tunnel', codeNow(3));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SECOND_FACTOR_REFUSED');
    expect(String(res.headers['set-cookie'] ?? '')).not.toMatch(/session_token=[^;]/);
  });

  it('removing the last one leaves the password alone refused, before any other check', async () => {
    const owner = readOwnerAccount()!.id;
    for (const row of confirmedFactors(owner, 'totp')) removeOwnerFactor(owner, row.id);
    expect(confirmedFactors(owner, 'totp')).toEqual([]);
    // A wrong password still gets the ordinary refusal: the password comes first.
    const wrong = await post('/api/auth/sign-in/email', 'own-tunnel').send({
      email: EMAIL,
      password: 'not-the-password',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).not.toBe('SECOND_FACTOR_GONE');
  });

  it.each(['own-tunnel', 'managed'] as const)(
    'removing the last one never brings back a password alone over %s',
    async (via) => {
      const res = await signIn(via);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('SECOND_FACTOR_GONE');
      expect(String(res.headers['set-cookie'] ?? '')).not.toMatch(/session_token=[^;]/);
    }
  );

  it('still holds after the server starts again: it is read from the database', async () => {
    initAuth(db, tmpDir);
    target.mount(buildApp());
    const res = await signIn('own-tunnel');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SECOND_FACTOR_GONE');
  });

  it('this computer still signs in with the password, to add a new one', async () => {
    expect((await signIn('direct')).status).toBe(200);
  });
});
