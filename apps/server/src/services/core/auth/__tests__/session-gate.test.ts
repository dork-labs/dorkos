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
  // Gated: stands in for the `/mcp` mount that `index.ts` adds after createApp.
  app.get('/mcp', (_req, res) => res.json({ ok: true }));
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
    const auth = initAuth(db);
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
      expect(res.body.user).toEqual({ userId: ownerId });
    });

    it('allows a gated route with a valid API key Bearer and attaches the user', async () => {
      setAuthEnabled(true);
      const res = await request(app).get('/api/sessions').set('Authorization', `Bearer ${apiKey}`);
      expect(res.status).toBe(200);
      expect(res.body.user).toEqual({ userId: ownerId });
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
    it('resolves { userId } from a session cookie', async () => {
      const req = { headers: { cookie: cookies.join('; ') } } as unknown as express.Request;
      expect(await verifyRequestAuth(req)).toEqual({ userId: ownerId });
    });

    it('resolves { userId } from a Bearer API key', async () => {
      const req = {
        headers: { authorization: `Bearer ${apiKey}` },
      } as unknown as express.Request;
      expect(await verifyRequestAuth(req)).toEqual({ userId: ownerId });
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
