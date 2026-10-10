/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createDb, runMigrations, user, session, apikey, type Db } from '@dorkos/db';
import {
  getAuth,
  initAuth,
  sessionGate,
  toNodeHandler,
  verifyRequestAuth,
  recheckAdmittedRequestAuth,
} from '../index.js';
import { configManager, initConfigManager } from '../../config-manager.js';
import { env } from '../../../../env.js';
import { REQUEST_FACTS_ADAPTERS } from '../../../../http/__tests__/request-facts-adapters.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/**
 * Build an app that mirrors `app.ts`'s middleware order for the gate: the Better
 * Auth handler at `/api/auth/*splat` BEFORE `express.json()`, then the session
 * gate, then a handful of stub routes standing in for the real API surface,
 * `/mcp`, and the SPA. The stub `/api/sessions` route echoes `res.locals.user`
 * so tests can assert the gate attaches the resolved identity.
 */
function buildApp(): express.Express {
  const app = express();
  app.all('/api/auth/*splat', toNodeHandler(getAuth()!));
  app.use(express.json({ limit: '1mb' }));
  app.use(sessionGate);
  // Gated API route (echoes the attached identity).
  app.get('/api/sessions', (_req, res) => {
    res.json({ ok: true, user: res.locals.user ?? null });
  });
  app.post('/api/sessions', (_req, res) => {
    res.json({ changed: true, user: res.locals.user ?? null });
  });
  // Exempt: health probe.
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  // Gated despite the /api/health prefix: the deep report is operator-only.
  // Registered non-strictly and case-insensitively, exactly as the real app
  // mounts it, so the test can prove the alternate spellings are gated too.
  app.get('/api/health/deep', (_req, res) => res.json({ checks: [] }));
  // Gated: stands in for the `/mcp` mount that `index.ts` adds after createApp.
  app.get('/mcp', (_req, res) => res.json({ ok: true }));
  // Gated with no carve-out of its own: the diagnostic read surface is always
  // mounted, so the gate is the only thing standing between it and an
  // unauthenticated caller. It is registered with a trailing wildcard the way a
  // router mount matches, so the spelling variants that once slipped past the
  // health carve-out can be asked of it too.
  app.get('/api/debug/{*splat}', (_req, res) => res.json({ claims: [] }));
  // Non-API path (SPA asset): must never be gated.
  app.get('/', (_req, res) => res.json({ spa: true }));
  return app;
}

// Emails are assembled from parts so the source never contains a literal address.
const DOMAIN = 'dork.test';
const OWNER_EMAIL = 'owner' + '@' + DOMAIN;
const OWNER_PASSWORD = 'correct-horse-battery-staple';
const OWNER_NAME = 'Owner';
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;

/** Flip the runtime `auth.enabled` flag the gate reads per request. */
function setAuthEnabled(enabled: boolean): void {
  configManager.set('auth', { enabled });
}

describe('sessionGate — /api/* and /mcp credential gate (integration)', () => {
  let tmpDir: string;
  let db: Db;
  let app: express.Express;
  let ownerId: string;
  let cookies: string[];
  let apiKey: string;
  let apiKeyId: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-gate-'));
    initConfigManager(tmpDir);
    db = createDb(path.join(tmpDir, 'gate-test.db'));
    runMigrations(db);
    const auth = initAuth(db, tmpDir);
    app = buildApp();

    // Create the owner and capture a real session cookie.
    fixtureTarget.mount(app);
    const signUp = await request(fixtureServer)
      .post('/api/auth/sign-up/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: OWNER_NAME });
    expect(signUp.status).toBe(200);

    const signIn = await request(fixtureServer)
      .post('/api/auth/sign-in/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(signIn.status).toBe(200);
    cookies = signIn.headers['set-cookie'] as unknown as string[];

    ownerId = db.select().from(user).get()!.id;

    // A per-user API key for the owner (plaintext value is returned once).
    const created = await auth.api.createApiKey({
      body: { userId: ownerId, name: 'gate-test-key' },
    });
    apiKey = created.key;
    apiKeyId = created.id;
  });

  afterEach(() => {
    // Default each test back to disabled so an accidental leak is obvious.
    setAuthEnabled(false);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('auth.enabled = false (zero-overhead pass-through)', () => {
    it('lets every route through with no credentials', async () => {
      setAuthEnabled(false);
      expect((await request(fixtureServer).get('/api/sessions')).status).toBe(200);
      expect((await request(fixtureServer).get('/mcp')).status).toBe(200);
      expect((await request(fixtureServer).get('/')).status).toBe(200);
    });

    it('does not attach res.locals.user when disabled', async () => {
      setAuthEnabled(false);
      const res = await request(fixtureServer).get('/api/sessions');
      expect(res.body.user).toBeNull();
    });
  });

  describe('auth.enabled = true', () => {
    it('returns 401 AUTH_REQUIRED on a gated route with no credentials', async () => {
      setAuthEnabled(true);
      const res = await request(fixtureServer).get('/api/sessions');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    });

    it('gates /mcp with no credentials', async () => {
      setAuthEnabled(true);
      const res = await request(fixtureServer).get('/mcp');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    });

    it('gates uppercased path variants (Express routes case-insensitively)', async () => {
      setAuthEnabled(true);
      // `/API/sessions` and `/MCP` resolve to the same handlers as their
      // lowercase forms, so the gate must normalize case — otherwise a mixed-case
      // prefix would slip past the gate yet still reach the protected route.
      for (const p of ['/API/sessions', '/Api/Sessions', '/MCP']) {
        const res = await request(fixtureServer).get(p);
        expect(res.status, `expected ${p} to be gated`).toBe(401);
        expect(res.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
      }
    });

    it('does not gate non-API paths (SPA assets load so login can render)', async () => {
      setAuthEnabled(true);
      const res = await request(fixtureServer).get('/');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ spa: true });
    });

    it('keeps /api/health reachable without credentials', async () => {
      setAuthEnabled(true);
      const res = await request(fixtureServer).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('gates /api/health/deep even though /api/health is exempt', async () => {
      setAuthEnabled(true);
      const res = await request(fixtureServer).get('/api/health/deep');
      expect(res.status).toBe(401);
      expect(res.body?.code).toBe('AUTH_REQUIRED');
    });

    // Express routes non-strictly and case-insensitively, so every spelling
    // below reaches the same handler. An exact-string carve-out out of the
    // `/api/health/` prefix exemption caught only the first one, and the rest
    // returned the whole report with no credential.
    it.each([
      ['trailing slash', '/api/health/deep/'],
      ['doubled trailing slash', '/api/health/deep//'],
      // The normalizer's trailing-slash strip was `/\/+$/` — quadratic in shape
      // on the pre-auth path every request takes (CodeQL js/polynomial-redos).
      // The collapse before it means a single `\/$/` answers identically, and
      // these longer runs are what says so.
      ['tripled trailing slash', '/api/health/deep///'],
      ['a long run of trailing slashes', `/api/health/deep${'/'.repeat(2_000)}`],
      ['internal and trailing runs', '/api/health//deep//'],
      ['uppercase', '/API/HEALTH/DEEP'],
      ['mixed case with trailing slash', '/Api/Health/Deep/'],
    ])('gates /api/health/deep spelled with a %s', async (_name, path) => {
      setAuthEnabled(true);
      const res = await request(fixtureServer).get(path);
      expect(res.status).toBe(401);
      expect(res.body?.code).toBe('AUTH_REQUIRED');
    });

    // The diagnostic surface is ALWAYS mounted — that is the whole posture — so
    // nothing but this gate keeps it operator-only. An exact-string carve-out
    // out of a prefix exemption is precisely how `/api/health/deep/` once
    // leaked the full report with no credential; these pin that this surface
    // has no such carve-out to slip out of, however the path is spelled.
    it.each([
      ['plain', '/api/debug/dispatches'],
      ['trailing slash', '/api/debug/dispatches/'],
      ['doubled trailing slash', '/api/debug/dispatches//'],
      ['doubled inner slash', '/api/debug//dispatches'],
      ['uppercase', '/API/DEBUG/DISPATCHES'],
      ['mixed case with trailing slash', '/Api/Debug/Refusals/'],
      ['dot segment', '/api/debug/./refusals'],
    ])('gates /api/debug spelled with a %s', async (_name, spelling) => {
      setAuthEnabled(true);
      const res = await request(fixtureServer).get(spelling);
      expect(res.status).toBe(401);
      expect(res.body?.code).toBe('AUTH_REQUIRED');
    });

    it('lets the operator through to /api/debug once signed in', async () => {
      // The other half: a gate that refused everybody would pass the test above
      // while making the surface useless.
      setAuthEnabled(true);
      const res = await request(fixtureServer).get('/api/debug/dispatches').set('Cookie', cookies);
      expect(res.status).toBe(200);
    });

    it('still exempts the liveness probe with a trailing slash', async () => {
      setAuthEnabled(true);
      const res = await request(fixtureServer).get('/api/health/');
      expect(res.status).not.toBe(401);
    });

    it('keeps /api/auth/* reachable without credentials (sign-in must work)', async () => {
      setAuthEnabled(true);
      // A bad sign-in body reaches Better Auth (its own 4xx), never the gate's
      // AUTH_REQUIRED — proving the exemption lets the request through.
      const res = await request(fixtureServer)
        .post('/api/auth/sign-in/email')
        .set('Origin', ORIGIN)
        .send({ email: OWNER_EMAIL, password: 'wrong-password' });
      expect(res.body?.code).not.toBe('AUTH_REQUIRED');
    });

    it('allows a gated route with a valid session cookie and attaches the user', async () => {
      setAuthEnabled(true);
      const res = await request(fixtureServer).get('/api/sessions').set('Cookie', cookies);
      expect(res.status).toBe(200);
      // The attached identity says WHICH credential proved it, because a few
      // writes are reserved for a person in the cockpit (DOR-501).
      expect(res.body.user).toEqual({ userId: ownerId, credential: 'cookie' });
    });

    it('allows a gated route with a valid API key Bearer and attaches the user', async () => {
      setAuthEnabled(true);
      const res = await request(fixtureServer)
        .get('/api/sessions')
        .set('Authorization', `Bearer ${apiKey}`);
      expect(res.status).toBe(200);
      expect(res.body.user).toEqual({
        userId: ownerId,
        credential: 'api-key',
        credentialId: apiKeyId,
      });
    });

    it('returns 401 AUTH_REQUIRED with an invalid API key Bearer', async () => {
      setAuthEnabled(true);
      const res = await request(fixtureServer)
        .get('/api/sessions')
        .set('Authorization', 'Bearer not-a-real-key');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    });
  });

  describe('verifyRequestAuth (the shared verifier reused by MCP auth in 1.4)', () => {
    it('charges one genuine API-key admission once and keeps its paid continuation read-only', async () => {
      const created = await getAuth()!.api.createApiKey({
        body: { userId: ownerId, name: 'one-admitted-request', remaining: 1 },
      });
      const req = { headers: { authorization: `Bearer ${created.key}` } };
      const principal = await verifyRequestAuth(req);
      expect(principal).toEqual({
        userId: ownerId,
        credential: 'api-key',
        credentialId: created.id,
      });
      const readKey = () => db.select().from(apikey).where(eq(apikey.id, created.id)).get();
      expect(readKey()?.remaining).toBe(0);
      // Distinct old timestamps make accidental refresh writes observable without sleeps.
      db.update(apikey)
        .set({ lastRequest: new Date(1000), updatedAt: new Date(2000) })
        .where(eq(apikey.id, created.id))
        .run();
      const paid = readKey();
      expect(paid).toBeDefined();
      for (let check = 0; check < 5; check++) {
        expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(true);
        expect(readKey()).toEqual(paid);
      }
      // Neither the same header values on another request nor a copied DTO paid this admission.
      expect(await recheckAdmittedRequestAuth({ headers: { ...req.headers } }, principal!)).toBe(
        false
      );
      expect(await recheckAdmittedRequestAuth(req, { ...principal! })).toBe(false);
      expect(readKey()).toEqual(paid);
      // The next real admission still owes a new unit and the exhausted key cannot pay it.
      expect(await verifyRequestAuth({ headers: { ...req.headers } })).toBeNull();
    });

    it.each([
      'deleted',
      'disabled',
      'expired',
      'hash-changed',
      'config-changed',
      'owner-changed',
    ] as const)(
      'refuses an originally admitted key after its live row is %s without accounting writes',
      async (change) => {
        const created = await getAuth()!.api.createApiKey({
          body: { userId: ownerId, name: `admitted-${change}`, remaining: 2 },
        });
        const req = { headers: { authorization: `Bearer ${created.key}` } };
        const principal = await verifyRequestAuth(req);
        expect(principal).toMatchObject({ userId: ownerId, credentialId: created.id });
        expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(true);
        const readKey = () => db.select().from(apikey).where(eq(apikey.id, created.id)).get();
        const admitted = readKey()!;
        expect(admitted.remaining).toBe(1);
        switch (change) {
          case 'deleted':
            db.delete(apikey).where(eq(apikey.id, created.id)).run();
            break;
          case 'disabled':
            db.update(apikey).set({ enabled: false }).where(eq(apikey.id, created.id)).run();
            break;
          case 'expired':
            db.update(apikey)
              .set({ expiresAt: new Date(1) })
              .where(eq(apikey.id, created.id))
              .run();
            break;
          case 'hash-changed':
            db.update(apikey)
              .set({ key: `${admitted.key}-replaced` })
              .where(eq(apikey.id, created.id))
              .run();
            break;
          case 'config-changed':
            db.update(apikey)
              .set({ configId: 'different-original-config' })
              .where(eq(apikey.id, created.id))
              .run();
            break;
          case 'owner-changed':
            db.update(apikey)
              .set({ referenceId: `${ownerId}-replaced` })
              .where(eq(apikey.id, created.id))
              .run();
            break;
        }
        const changed = readKey();
        expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(false);
        expect(readKey()).toEqual(changed);
      }
    );

    it('rejects changed request headers', async () => {
      const created = await getAuth()!.api.createApiKey({
        body: { userId: ownerId, name: 'admitted-origin' },
      });
      const req = { headers: { authorization: `Bearer ${created.key}` } };
      const principal = await verifyRequestAuth(req);
      expect(principal).toMatchObject({ userId: ownerId, credentialId: created.id });
      expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(true);
      req.headers.authorization = 'Bearer different-key';
      expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(false);
      req.headers.authorization = `Bearer ${created.key}`;
    });

    it('refuses an admitted signed cookie after revocation even while the signed cache remains usable', async () => {
      const signedIn = await request(fixtureServer)
        .post('/api/auth/sign-in/email')
        .set('Origin', ORIGIN)
        .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
      expect(signedIn.status).toBe(200);
      const cookie = (signedIn.headers['set-cookie'] as unknown as string[]).join('; ');
      const req = { headers: { cookie } };
      const auth = getAuth()!;
      const live = await auth.api.getSession({
        headers: new Headers({ cookie }),
        query: { disableCookieCache: true, disableRefresh: true },
      });
      expect(live?.session.id).toEqual(expect.any(String));
      const principal = await verifyRequestAuth(req);
      expect(principal).toEqual({ userId: ownerId, credential: 'cookie' });
      const readSession = () =>
        db.select().from(session).where(eq(session.id, live!.session.id)).get();
      const before = readSession();
      expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(true);
      expect(readSession()).toEqual(before);
      db.delete(session).where(eq(session.id, live!.session.id)).run();
      // This is the actual signed cache, not a mocked getSession response.
      expect((await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.id).toBe(
        ownerId
      );
      expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(false);
      expect(readSession()).toBeUndefined();
    });

    // The `credential` field is asserted, not incidental. A few writes are
    // reserved for a person in the cockpit rather than for anything holding a
    // valid credential, and this is the only place the difference is observable
    // — a per-user API key satisfies the gate exactly as a browser session does
    // (DOR-474), so if these two returned the same shape those writes would have
    // nothing to branch on. The plain-header cases run once per chain
    // (DOR-2794): each adapter's facts must prove the same identity.
    describe.each(REQUEST_FACTS_ADAPTERS)('through the $name adapter', (adapter) => {
      it('resolves a cookie identity, and says the cookie is what proved it', async () => {
        const req = await adapter.facts({ headers: { cookie: cookies.join('; ') } });
        expect(await verifyRequestAuth(req)).toEqual({ userId: ownerId, credential: 'cookie' });
      });

      it('resolves a Bearer API key identity, and says it was NOT a cookie', async () => {
        const req = await adapter.facts({
          headers: { authorization: `Bearer ${apiKey}` },
        });
        expect(await verifyRequestAuth(req)).toEqual({
          userId: ownerId,
          credential: 'api-key',
          credentialId: apiKeyId,
        });
      });

      it('never labels an x-api-key caller a cookie caller (pins a Better Auth default)', async () => {
        // The `credential` label is only honest because Better Auth's apiKey plugin
        // cannot mint a SESSION from an `x-api-key` header. That behavior is gated
        // on `enableSessionForAPIKeys`, which defaults to `false`, and DorkOS calls
        // bare `apiKey()` with no config — so the default is load-bearing for a
        // guard in another module and nothing else in the repo asserts it.
        //
        // If a future version flips that default, `getSession` would answer for a
        // key-bearing request and this identity would come back labelled `cookie`,
        // silently handing a per-user API key the one thing the cookie bar exists
        // to withhold. This test goes red on that day, which is the entire point.
        const req = await adapter.facts({ headers: { 'x-api-key': apiKey } });
        const resolved = await verifyRequestAuth(req);
        expect(resolved?.credential).not.toBe('cookie');
        // Today it resolves to nothing at all: `x-api-key` is not the Bearer header
        // this codebase reads, so neither path claims it.
        expect(resolved).toBeNull();
      });

      it('returns null with no credentials', async () => {
        const req = await adapter.facts({ headers: {} });
        expect(await verifyRequestAuth(req)).toBeNull();
      });

      it('returns null with an invalid Bearer key', async () => {
        const req = await adapter.facts({
          headers: { authorization: 'Bearer nope' },
        });
        expect(await verifyRequestAuth(req)).toBeNull();
      });
    });

    it('leaves a renewal-due original row unchanged while the ordinary verifier can renew it', async () => {
      const signedIn = await request(fixtureServer)
        .post('/api/auth/sign-in/email')
        .set('Origin', ORIGIN)
        .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
      expect(signedIn.status).toBe(200);
      // Keep the actual signed token, omit its snapshot cookie so the default peer
      // also reads this SAME real database row instead of a still-fresh cache.
      const issuedCookies = signedIn.headers['set-cookie'] as unknown as string[];
      const signedToken = issuedCookies
        .map((value) => value.split(';', 1)[0]!)
        .find((value) => value.split('=', 1)[0]!.endsWith('.session_token'));
      expect(signedToken).toEqual(expect.any(String));
      const req = { headers: { cookie: signedToken! } } as unknown as express.Request;
      const auth = getAuth()!;
      const original = await auth.api.getSession({
        headers: new Headers({ cookie: signedToken! }),
        query: { disableCookieCache: true, disableRefresh: true },
      });
      expect(original?.session.id).toEqual(expect.any(String));
      const context = await auth.$context;
      const { expiresIn, updateAge } = context.sessionConfig;
      expect(expiresIn).toBeGreaterThan(updateAge);
      const now = Date.now();
      const dueExpiry = new Date(now + (expiresIn - updateAge) * 1000 - 1000);
      const dueUpdate = new Date(now - updateAge * 1000 - 1000);
      expect(dueExpiry.getTime()).toBeGreaterThan(now);
      db.update(session)
        .set({ expiresAt: dueExpiry, updatedAt: dueUpdate })
        .where(eq(session.id, original!.session.id))
        .run();
      const readOriginal = () =>
        db.select().from(session).where(eq(session.id, original!.session.id)).get()!;
      const before = readOriginal();
      // Exact production renewal condition from Better Auth, with the row still live.
      expect(before.expiresAt.getTime() - expiresIn * 1000 + updateAge * 1000).toBeLessThanOrEqual(
        now
      );
      const observer = vi.spyOn(auth.api, 'getSession');
      try {
        expect(
          await verifyRequestAuth(req, {
            sessionFreshness: 'server-store',
          })
        ).toEqual({ userId: ownerId, credential: 'cookie' });
        expect(observer).toHaveBeenLastCalledWith(
          expect.objectContaining({ query: { disableCookieCache: true, disableRefresh: true } })
        );
        const afterFresh = readOriginal();
        expect(afterFresh.expiresAt).toEqual(before.expiresAt);
        expect(afterFresh.updatedAt).toEqual(before.updatedAt);
        // Healthy ordinary peer proves a due original row actually can renew.
        expect(await verifyRequestAuth(req)).toEqual({ userId: ownerId, credential: 'cookie' });
        expect(observer).toHaveBeenLastCalledWith({ headers: expect.any(Headers) });
        const afterOrdinary = readOriginal();
        expect(afterOrdinary.id).toBe(before.id);
        expect(afterOrdinary.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime());
        expect(afterOrdinary.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
      } finally {
        observer.mockRestore();
      }
    });

    it('refuses a revoked database session even while its signed cookie cache remains usable', async () => {
      const signIn = await request(fixtureServer)
        .post('/api/auth/sign-in/email')
        .set('Origin', ORIGIN)
        .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
      expect(signIn.status).toBe(200);
      const freshCookies = signIn.headers['set-cookie'] as unknown as string[];
      const req = { headers: { cookie: freshCookies.join('; ') } } as unknown as express.Request;
      const original = await getAuth()!.api.getSession({
        headers: new Headers({ cookie: req.headers.cookie! }),
        query: { disableCookieCache: true, disableRefresh: true },
      });
      expect(original?.session.id).toEqual(expect.any(String));
      expect(await verifyRequestAuth(req)).toMatchObject({ userId: ownerId, credential: 'cookie' });
      db.delete(session).where(eq(session.id, original!.session.id)).run();
      expect(await verifyRequestAuth(req)).toMatchObject({ userId: ownerId, credential: 'cookie' });
      expect(
        await verifyRequestAuth(req, {
          sessionFreshness: 'server-store',
        })
      ).toBeNull();
    });

    it('refuses a write with a revoked cached cookie while healthy cookie and API-key writes still work', async () => {
      setAuthEnabled(true);
      const signedIn = await request(fixtureServer)
        .post('/api/auth/sign-in/email')
        .set('Origin', ORIGIN)
        .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
      expect(signedIn.status).toBe(200);
      const cookie = (signedIn.headers['set-cookie'] as unknown as string[]).join('; ');
      const original = await getAuth()!.api.getSession({
        headers: new Headers({ cookie }),
        query: { disableCookieCache: true, disableRefresh: true },
      });
      expect(original?.session.id).toEqual(expect.any(String));
      expect(
        (await request(fixtureServer).post('/api/sessions').set('Cookie', cookie)).status
      ).toBe(200);
      db.delete(session).where(eq(session.id, original!.session.id)).run();
      // Prove the stale credential remains cache-valid, then reach the real HTTP gate.
      expect((await request(fixtureServer).get('/api/sessions').set('Cookie', cookie)).status).toBe(
        200
      );
      const refused = await request(fixtureServer).post('/api/sessions').set('Cookie', cookie);
      expect(refused.status).toBe(401);
      expect(refused.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
      const program = await request(fixtureServer)
        .post('/api/sessions')
        .set('Authorization', `Bearer ${apiKey}`);
      expect(program.status).toBe(200);
      expect(program.body.user.credential).toBe('api-key');
    });

    it('refuses a deleted genuine key owner while the original key row remains unchanged', async () => {
      const admittedOwner = `admitted-owner-deletion-${ownerId}`;
      const now = new Date();
      db.insert(user)
        .values({
          id: admittedOwner,
          name: 'Admitted owner',
          email: admittedOwner + '@' + DOMAIN,
          role: 'user',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const created = await getAuth()!.api.createApiKey({
        body: { userId: admittedOwner, name: 'live-owner-row' },
      });
      const req = { headers: { authorization: `Bearer ${created.key}` } };
      const principal = await verifyRequestAuth(req);
      expect(principal).toMatchObject({ userId: admittedOwner, credentialId: created.id });
      expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(true);
      const readKey = () => db.select().from(apikey).where(eq(apikey.id, created.id)).get();
      const originalKey = readKey();
      expect(originalKey).toBeDefined();
      db.delete(user).where(eq(user.id, admittedOwner)).run();
      expect(readKey()).toEqual(originalKey);
      expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(false);
      expect(readKey()).toEqual(originalKey);
    });

    it('refuses substitution of the original signed-cookie session row by a same-user row', async () => {
      const signedIn = await request(fixtureServer)
        .post('/api/auth/sign-in/email')
        .set('Origin', ORIGIN)
        .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
      expect(signedIn.status).toBe(200);
      const cookie = (signedIn.headers['set-cookie'] as unknown as string[]).join('; ');
      const req = { headers: { cookie } };
      const auth = getAuth()!;
      const original = await auth.api.getSession({
        headers: new Headers({ cookie }),
        query: { disableCookieCache: true, disableRefresh: true },
      });
      expect(original?.session.id).toEqual(expect.any(String));
      const principal = await verifyRequestAuth(req);
      expect(principal).toEqual({ userId: ownerId, credential: 'cookie' });
      expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(true);
      const replacementId = `${original!.session.id}-replacement`;
      db.update(session)
        .set({ id: replacementId })
        .where(eq(session.id, original!.session.id))
        .run();
      const actualReplacement = await auth.api.getSession({
        headers: new Headers({ cookie }),
        query: { disableCookieCache: true, disableRefresh: true },
      });
      expect(actualReplacement?.user.id).toBe(ownerId);
      expect(actualReplacement?.session.id).toBe(replacementId);
      expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(false);
    });

    it('refuses mutation of the exact admitted principal rather than trusting its current DTO fields', async () => {
      const created = await getAuth()!.api.createApiKey({
        body: { userId: ownerId, name: 'admitted-principal-data' },
      });
      const req = { headers: { authorization: `Bearer ${created.key}` } };
      const principal = await verifyRequestAuth(req);
      expect(principal).toEqual({
        userId: ownerId,
        credential: 'api-key',
        credentialId: created.id,
      });
      expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(true);
      principal!.userId = `${ownerId}-substituted`;
      expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(false);
      principal!.userId = ownerId;
      principal!.credentialId = `${created.id}-substituted`;
      expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(false);
      principal!.credentialId = created.id;
      principal!.credential = 'cookie';
      expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(false);
      principal!.credential = 'api-key';
      expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(true);
    });

    // Keep singleton replacement last: the original app's auth handler remains
    // bound to its constructor instance until this fixture is torn down.
    it('rejects an admitted proof after the original auth instance is replaced', async () => {
      const created = await getAuth()!.api.createApiKey({
        body: { userId: ownerId, name: 'admitted-auth-instance' },
      });
      const req = { headers: { authorization: `Bearer ${created.key}` } };
      const principal = await verifyRequestAuth(req);
      expect(principal).toMatchObject({ userId: ownerId, credentialId: created.id });
      expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(true);
      const originalAuth = getAuth();
      initAuth(db, tmpDir);
      expect(getAuth()).not.toBe(originalAuth);
      expect(await recheckAdmittedRequestAuth(req, principal!)).toBe(false);
    });
  });
});
