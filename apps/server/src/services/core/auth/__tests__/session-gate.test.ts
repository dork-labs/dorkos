/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, user, type Db } from '@dorkos/db';
import { getAuth, initAuth, sessionGate, toNodeHandler, verifyRequestAuth } from '../index.js';
import { configManager, initConfigManager } from '../../config-manager.js';
import { env } from '../../../../env.js';

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

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-gate-'));
    initConfigManager(tmpDir);
    db = createDb(path.join(tmpDir, 'gate-test.db'));
    runMigrations(db);
    const auth = initAuth(db, tmpDir);
    app = buildApp();

    // Create the owner and capture a real session cookie.
    const signUp = await request(app)
      .post('/api/auth/sign-up/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: OWNER_NAME });
    expect(signUp.status).toBe(200);

    const signIn = await request(app)
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
      expect((await request(app).get('/api/sessions')).status).toBe(200);
      expect((await request(app).get('/mcp')).status).toBe(200);
      expect((await request(app).get('/')).status).toBe(200);
    });

    it('does not attach res.locals.user when disabled', async () => {
      setAuthEnabled(false);
      const res = await request(app).get('/api/sessions');
      expect(res.body.user).toBeNull();
    });
  });

  describe('auth.enabled = true', () => {
    it('returns 401 AUTH_REQUIRED on a gated route with no credentials', async () => {
      setAuthEnabled(true);
      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    });

    it('gates /mcp with no credentials', async () => {
      setAuthEnabled(true);
      const res = await request(app).get('/mcp');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    });

    it('gates uppercased path variants (Express routes case-insensitively)', async () => {
      setAuthEnabled(true);
      // `/API/sessions` and `/MCP` resolve to the same handlers as their
      // lowercase forms, so the gate must normalize case — otherwise a mixed-case
      // prefix would slip past the gate yet still reach the protected route.
      for (const p of ['/API/sessions', '/Api/Sessions', '/MCP']) {
        const res = await request(app).get(p);
        expect(res.status, `expected ${p} to be gated`).toBe(401);
        expect(res.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
      }
    });

    it('does not gate non-API paths (SPA assets load so login can render)', async () => {
      setAuthEnabled(true);
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ spa: true });
    });

    it('keeps /api/health reachable without credentials', async () => {
      setAuthEnabled(true);
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('gates /api/health/deep even though /api/health is exempt', async () => {
      setAuthEnabled(true);
      const res = await request(app).get('/api/health/deep');
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
      const res = await request(app).get(path);
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
      const res = await request(app).get(spelling);
      expect(res.status).toBe(401);
      expect(res.body?.code).toBe('AUTH_REQUIRED');
    });

    it('lets the operator through to /api/debug once signed in', async () => {
      // The other half: a gate that refused everybody would pass the test above
      // while making the surface useless.
      setAuthEnabled(true);
      const res = await request(app).get('/api/debug/dispatches').set('Cookie', cookies);
      expect(res.status).toBe(200);
    });

    it('still exempts the liveness probe with a trailing slash', async () => {
      setAuthEnabled(true);
      const res = await request(app).get('/api/health/');
      expect(res.status).not.toBe(401);
    });

    it('keeps /api/auth/* reachable without credentials (sign-in must work)', async () => {
      setAuthEnabled(true);
      // A bad sign-in body reaches Better Auth (its own 4xx), never the gate's
      // AUTH_REQUIRED — proving the exemption lets the request through.
      const res = await request(app)
        .post('/api/auth/sign-in/email')
        .set('Origin', ORIGIN)
        .send({ email: OWNER_EMAIL, password: 'wrong-password' });
      expect(res.body?.code).not.toBe('AUTH_REQUIRED');
    });

    it('allows a gated route with a valid session cookie and attaches the user', async () => {
      setAuthEnabled(true);
      const res = await request(app).get('/api/sessions').set('Cookie', cookies);
      expect(res.status).toBe(200);
      // The attached identity says WHICH credential proved it, because a few
      // writes are reserved for a person in the cockpit (DOR-501).
      expect(res.body.user).toEqual({ userId: ownerId, credential: 'cookie' });
    });

    it('allows a gated route with a valid API key Bearer and attaches the user', async () => {
      setAuthEnabled(true);
      const res = await request(app).get('/api/sessions').set('Authorization', `Bearer ${apiKey}`);
      expect(res.status).toBe(200);
      expect(res.body.user).toEqual({ userId: ownerId, credential: 'api-key' });
    });

    it('returns 401 AUTH_REQUIRED with an invalid API key Bearer', async () => {
      setAuthEnabled(true);
      const res = await request(app)
        .get('/api/sessions')
        .set('Authorization', 'Bearer not-a-real-key');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    });
  });

  describe('verifyRequestAuth (the shared verifier reused by MCP auth in 1.4)', () => {
    // The `credential` field is asserted, not incidental. A few writes are
    // reserved for a person in the cockpit rather than for anything holding a
    // valid credential, and this is the only place the difference is observable
    // — a per-user API key satisfies the gate exactly as a browser session does
    // (DOR-474), so if these two returned the same shape those writes would have
    // nothing to branch on.
    it('resolves a cookie identity, and says the cookie is what proved it', async () => {
      const req = { headers: { cookie: cookies.join('; ') } } as unknown as express.Request;
      expect(await verifyRequestAuth(req)).toEqual({ userId: ownerId, credential: 'cookie' });
    });

    it('resolves a Bearer API key identity, and says it was NOT a cookie', async () => {
      const req = {
        headers: { authorization: `Bearer ${apiKey}` },
      } as unknown as express.Request;
      expect(await verifyRequestAuth(req)).toEqual({ userId: ownerId, credential: 'api-key' });
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
      const req = { headers: { 'x-api-key': apiKey } } as unknown as express.Request;
      const resolved = await verifyRequestAuth(req);
      expect(resolved?.credential).not.toBe('cookie');
      // Today it resolves to nothing at all: `x-api-key` is not the Bearer header
      // this codebase reads, so neither path claims it.
      expect(resolved).toBeNull();
    });

    it('returns null with no credentials', async () => {
      const req = { headers: {} } as unknown as express.Request;
      expect(await verifyRequestAuth(req)).toBeNull();
    });

    it('returns null with an invalid Bearer key', async () => {
      const req = {
        headers: { authorization: 'Bearer nope' },
      } as unknown as express.Request;
      expect(await verifyRequestAuth(req)).toBeNull();
    });
  });
});
