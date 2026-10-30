/**
 * @vitest-environment node
 *
 * The person bar at this computer once an owner exists (DOR-3330), through
 * real Better Auth, the real chain and the real step-up route: with "Ask for a
 * password on this computer too" off, a caller with no headers and no session
 * is refused by every shared person bar, the owner's password leaves a
 * session for this computer, and from then on the same bars let them through
 * without asking again. Reads and chat never ask.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RequestListener } from 'node:http';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { PERSON_PROOF_HEADER, PERSON_SESSION_REQUIRED_CODE } from '@dorkos/shared/person-session';
import { createDb, runMigrations, session, type Db } from '@dorkos/db';

import { getAuth, initAuth } from '../index.js';
import { resetOwnerPasswordFailuresForTests } from '../owner-password.js';
import { createApiApp } from '../../../../http/api-chain.js';
import { mountBetterAuth } from '../../../../http/better-auth.js';
import { frontDoorListener } from '../../../../http/front-door.js';
import { honoRequestFacts } from '../../../../http/request-facts.js';
import {
  clearsTheAgentBar,
  isPersonTurn,
  readCallerAuthority,
  refuseUnlessAccountOwner,
  requireOperatorCookieUnderLogin,
  requirePersonAtThisComputer,
} from '../../../../lib/caller-authority.js';
import { refuseRoomWrite } from '../../../../routes/extensions-rooms-bar.js';
import { createPersonSessionRoutes } from '../../../../routes/person-session.js';
import { trustedCaller } from '../../capabilities/trusted-caller.js';
import type { RequestFacts } from '../../../../http/request-facts.js';
import { MainRequestAdmission } from '../../lifecycle/main-request-admission.js';
import { configManager, initConfigManager } from '../../config-manager.js';
import { markIngress } from '../../remote/ingress-mark.js';
import { env } from '../../../../env.js';

const target = swappableServer();
const EMAIL = 'owner' + '@' + 'dork.test';
const PASSWORD = 'correct-horse-battery-staple';
const LOCAL = `localhost:${env.DORKOS_PORT}`;
const ORIGIN = `http://${LOCAL}`;
/** Test-only: names the listener the next request arrives through. */
const INGRESS_HEADER = 'x-test-ingress';

/** Every shared person bar, as a yes or no for one request. */
const BARS: Record<string, (facts: RequestFacts) => boolean> = {
  'the agent bar': (facts) => clearsTheAgentBar(facts),
  'the cookie bar': (facts) => requireOperatorCookieUnderLogin(facts, 'this') === undefined,
  'a trusted caller': (facts) => trustedCaller(readCallerAuthority(facts)) !== undefined,
  'the account owner bar': (facts) => refuseUnlessAccountOwner(facts) === undefined,
  'the front-door bar': (facts) => requirePersonAtThisComputer(facts) === undefined,
  'the mini app room bar': (facts) => refuseRoomWrite(facts) === undefined,
};

/** The real chain, the step-up route, and one probe per bar. */
function buildApp(): RequestListener {
  const app = createApiApp({
    admission: new MainRequestAdmission(),
    beforeBodyParsing: (early) => mountBetterAuth(early, { auth: getAuth()!, maxAttempts: 1000 }),
  });
  app.route('/api/person-session', createPersonSessionRoutes());
  Object.entries(BARS).forEach(([name, passes], index) => {
    app.post(`/api/test/bar/${index}`, (c) =>
      passes(honoRequestFacts(c)) ? c.json({ ok: true }) : c.json({ error: name }, 403)
    );
  });
  app.get('/api/test/read', (c) => c.json({ ok: true }));
  app.post('/api/test/turn', (c) => c.json({ person: isPersonTurn(honoRequestFacts(c)) }));
  const chain = frontDoorListener(app);
  return (req, res) => {
    const via = req.headers[INGRESS_HEADER];
    if (typeof via === 'string') markIngress(req, via as never);
    chain(req, res);
  };
}

/** What the app at this computer sends, plus `extra`. */
function appHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { host: LOCAL, origin: ORIGIN, 'x-client-id': 'window-1', ...extra };
}

/** The cookie pairs a response set. */
function cookiesOf(res: { headers: Record<string, unknown> }): string {
  return ((res.headers['set-cookie'] as string[] | undefined) ?? [])
    .map((value) => value.split(';')[0])
    .join('; ');
}

describe('the person bar at this computer, with an owner and no password asked', () => {
  let tmpDir: string;
  let db: Db;
  let ownerId: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-person-step-up-'));
    initConfigManager(tmpDir);
    configManager.set('auth', { enabled: true });
    db = createDb(path.join(tmpDir, 'auth.db'));
    runMigrations(db);
    initAuth(db, tmpDir);
    target.mount(buildApp());
    const signUp = await request(target.server)
      .post('/api/auth/sign-up/email')
      .set({ host: LOCAL, origin: ORIGIN })
      .send({ email: EMAIL, password: PASSWORD, name: 'Owner' });
    expect(signUp.status).toBe(200);
    ownerId = signUp.body.user.id;
    // This Mac's posture: an owner, and no password asked at this computer.
    configManager.set('auth', { enabled: false });
  });

  afterEach(() => resetOwnerPasswordFailuresForTests());

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(Object.keys(BARS).map((name, index) => [name, index] as const))(
    'refuses a caller with no headers and no session at %s',
    async (_name, index) => {
      const res = await request(target.server)
        .post(`/api/test/bar/${index}`)
        .set({ host: LOCAL })
        .send({});
      // The mini app bar refuses a request from no app window before it asks
      // who it is; every other bar asks for the step-up.
      expect([401, 403]).toContain(res.status);
      if (res.status === 401) expect(res.body.code).toBe(PERSON_SESSION_REQUIRED_CODE);
    }
  );

  it.each(Object.keys(BARS).map((name, index) => [name, index] as const))(
    'refuses the app’s own headers without a session at %s too',
    async (_name, index) => {
      const res = await request(target.server)
        .post(`/api/test/bar/${index}`)
        .set(appHeaders())
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.code).toBe(PERSON_SESSION_REQUIRED_CODE);
    }
  );

  it('refuses a caller naming itself an agent in its own words, never with a step-up', async () => {
    const res = await request(target.server)
      .post('/api/test/bar/0')
      .set(appHeaders({ 'x-dorkos-agent': 'not-a-real-token' }))
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe(PERSON_SESSION_REQUIRED_CODE);
  });

  it('never asks for a read', async () => {
    const res = await request(target.server).get('/api/test/read').set({ host: LOCAL });
    expect(res.status).toBe(200);
  });

  it('runs a chat message with no session as agent work, never as the person', async () => {
    const res = await request(target.server).post('/api/test/turn').set(appHeaders()).send({});
    expect(res.status).toBe(200);
    expect(res.body.person).toBe(false);
  });

  describe('the step-up', () => {
    it('refuses a wrong password and leaves no session', async () => {
      const res = await request(target.server)
        .post('/api/person-session')
        .set(appHeaders())
        .send({ password: 'not-it' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('wrong-password');
      expect(cookiesOf(res)).toBe('');
    });

    it('says how long to wait after too many wrong passwords', async () => {
      for (let i = 0; i < 5; i += 1) {
        await request(target.server)
          .post('/api/person-session')
          .set(appHeaders())
          .send({ password: 'not-it' });
      }
      const res = await request(target.server)
        .post('/api/person-session')
        .set(appHeaders())
        .send({ password: PASSWORD });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('too-many-attempts');
      expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(Number(res.headers['retry-after'])).toBe(res.body.retryAfterSeconds);
    });

    it.each([
      ['an agent', { 'x-dorkos-agent': 'not-a-real-token' }],
      ['a key', { authorization: 'Bearer some-key' }],
      ['another site’s page', { 'sec-fetch-site': 'cross-site' }],
    ])('refuses %s even with the right password', async (_label, extra) => {
      const res = await request(target.server)
        .post('/api/person-session')
        .set(appHeaders(extra))
        .send({ password: PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not-a-person');
      expect(cookiesOf(res)).toBe('');
    });

    it('refuses another device, even with the right password', async () => {
      const res = await request(target.server)
        .post('/api/person-session')
        .set(appHeaders({ [INGRESS_HEADER]: 'wifi' }))
        .send({ password: PASSWORD });
      // Wi-Fi always needs a sign-in at the gate, before this route is reached.
      expect(res.status).toBe(401);
      expect(cookiesOf(res)).toBe('');
    });

    it('asks once, then every bar lets the owner through without asking again', async () => {
      const stepUp = await request(target.server)
        .post('/api/person-session')
        .set(appHeaders())
        .send({ password: PASSWORD });
      expect(stepUp.status).toBe(200);
      const cookie = cookiesOf(stepUp);
      expect(cookie).toMatch(/session_token=/);
      const proof = stepUp.body.proof as string;
      expect(proof).toMatch(/^[\w-]{20,}$/);

      // The cookie alone is nobody's: it reaches every port on this computer.
      for (const index of Object.keys(BARS).keys()) {
        const res = await request(target.server)
          .post(`/api/test/bar/${index}`)
          .set(appHeaders({ cookie }))
          .send({});
        expect(res.status).not.toBe(200);
      }
      // Nor beside a proof made up.
      const forged = await request(target.server)
        .post('/api/test/bar/0')
        .set(appHeaders({ cookie, [PERSON_PROOF_HEADER]: proof.slice(1) + 'A' }))
        .send({});
      expect(forged.status).not.toBe(200);

      // Nor at sign-in's own endpoints: no key is made for the cookie alone.
      const keyFromCookie = await request(target.server)
        .post('/api/auth/api-key/create')
        .set(appHeaders({ cookie }))
        .send({ name: 'k' });
      expect(keyFromCookie.status).not.toBe(200);
      const keyFromApp = await request(target.server)
        .post('/api/auth/api-key/create')
        .set(appHeaders({ cookie, [PERSON_PROOF_HEADER]: proof }))
        .send({ name: 'k' });
      expect(keyFromApp.status).toBe(200);

      // Bound to this computer, and lasting: a remembered cookie.
      const rows = db.select().from(session).where(eq(session.userId, ownerId)).all();
      expect(rows.some((row) => (row as { route?: string | null }).route === 'local')).toBe(true);
      const setCookie = (stepUp.headers['set-cookie'] as unknown as string[]).find((value) =>
        value.includes('session_token=')
      );
      expect(setCookie).toMatch(/Max-Age=\d+/i);

      for (let round = 0; round < 2; round += 1) {
        for (const index of Object.keys(BARS).keys()) {
          const res = await request(target.server)
            .post(`/api/test/bar/${index}`)
            .set(appHeaders({ cookie, [PERSON_PROOF_HEADER]: proof }))
            .send({});
          expect(res.status).toBe(200);
        }
      }
      const turn = await request(target.server)
        .post('/api/test/turn')
        .set(appHeaders({ cookie, [PERSON_PROOF_HEADER]: proof }))
        .send({});
      expect(turn.body.person).toBe(true);

      // The same cookie from another device is nobody's.
      const wifi = await request(target.server)
        .post('/api/test/bar/0')
        .set(appHeaders({ cookie, [PERSON_PROOF_HEADER]: proof, [INGRESS_HEADER]: 'wifi' }))
        .send({});
      expect(wifi.status).toBe(401);
      expect(wifi.body.code).not.toBe(PERSON_SESSION_REQUIRED_CODE);
    });
  });
});
