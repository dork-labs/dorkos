/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, user, type Db } from '@dorkos/db';
import { createAuth, toNodeHandler, isBetterAuthBaseUrlAdvisory } from '../index.js';
import { initConfigManager } from '../../config-manager.js';
import { env } from '../../../../env.js';
import { logger } from '../../../../lib/logger.js';

/**
 * Mounts the Better Auth handler over a throwaway temp SQLite database exactly
 * as `app.ts` does: `app.all('/api/auth/*splat', ...)` BEFORE `express.json()`.
 */
function buildApp(db: Db, dorkHome: string): express.Express {
  const app = express();
  app.all('/api/auth/*splat', toNodeHandler(createAuth(db, dorkHome)));
  app.use(express.json({ limit: '1mb' }));
  return app;
}

// Emails are assembled from parts so the source never contains a literal
// address token. Domain uses a `.test` TLD (RFC 6761 reserved for testing).
const DOMAIN = 'dork.test';
const OWNER_EMAIL = 'owner' + '@' + DOMAIN;
const SECOND_EMAIL = 'second' + '@' + DOMAIN;
const OWNER_PASSWORD = 'correct-horse-battery-staple';
const OWNER_NAME = 'Owner';

// A trusted origin so Better Auth's CSRF origin check accepts the request.
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;

describe('Better Auth — local identity core (integration)', () => {
  let tmpDir: string;
  let db: Db;
  let app: express.Express;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-auth-'));
    // trustedOrigins → tunnelManager.status reads the config singleton, so
    // initialize it against the same temp dir (no tunnel is configured, so the
    // resolved origins are just the static loopback dev origins).
    initConfigManager(tmpDir);
    db = createDb(path.join(tmpDir, 'auth-test.db'));
    runMigrations(db);
    app = buildApp(db, tmpDir);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the first user with role "owner" on sign-up', async () => {
    const res = await request(app)
      .post('/api/auth/sign-up/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: OWNER_NAME });

    expect(res.status).toBe(200);

    const row = db.select().from(user).get();
    expect(row?.email).toBe(OWNER_EMAIL);
    expect(row?.role).toBe('owner');
  });

  it('rejects a second sign-up once an owner exists (registration is owner-only)', async () => {
    const res = await request(app)
      .post('/api/auth/sign-up/email')
      .set('Origin', ORIGIN)
      .send({ email: SECOND_EMAIL, password: 'another-strong-password', name: 'Second' });

    expect(res.status).toBeGreaterThanOrEqual(400);

    // The table still holds exactly the owner — no second user was created.
    const rows = db.select().from(user).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(OWNER_EMAIL);
  });

  it('returns a session cookie on sign-in', async () => {
    const res = await request(app)
      .post('/api/auth/sign-in/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });

    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(cookies).toBeDefined();
    expect(cookies?.join(';')).toMatch(/session_token/);
  });

  it('round-trips the session cookie via get-session', async () => {
    const signIn = await request(app)
      .post('/api/auth/sign-in/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const cookies = signIn.headers['set-cookie'] as unknown as string[];

    const res = await request(app)
      .get('/api/auth/get-session')
      .set('Origin', ORIGIN)
      .set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body?.user?.email).toBe(OWNER_EMAIL);
    expect(res.body?.user?.role).toBe('owner');
  });

  it('does not trust an arbitrary origin (no wildcard leaks into trustedOrigins)', async () => {
    // Regression guard for the wildcard-origin trap. Better Auth's dynamic
    // `baseURL: { allowedHosts }` form merges each host into the same
    // trusted-origins list `isTrustedOrigin` consumes for callbackURL/redirectTo,
    // so `['*']` would inject `https://*` and trust EVERY https origin. Omitting
    // `baseURL` keeps `trustedOrigins` (loopback + live tunnel) the sole
    // authority. Assert the exact seam: no wildcard entry, and an attacker origin
    // is not trusted. With the wildcard config this test fails (evil is trusted).
    const auth = createAuth(db, tmpDir);
    const ctx = await auth.$context;

    expect(ctx.trustedOrigins).not.toContain('https://*');
    expect(ctx.trustedOrigins.some((o) => o.includes('*'))).toBe(false);
    expect(ctx.isTrustedOrigin('https://evil.com', {})).toBe(false);
    // The real loopback origin stays trusted, so legitimate flows are unaffected.
    expect(ctx.isTrustedOrigin(`http://localhost:${env.DORKOS_PORT}`, {})).toBe(true);
  });

  it('verifies an API key header-less without a baseURL error (server-side auth.api path)', async () => {
    // `verifyApiKey` (session-gate.ts) is the one genuine header-less `auth.api`
    // caller — it runs with no incoming request to derive an origin from. With
    // `baseURL` omitted this resolves fine; it must never throw the dynamic
    // "Base URL could not be resolved" error. A bogus key resolving to
    // `valid: false` is the success signal here (no throw).
    const auth = createAuth(db, tmpDir);
    let threw: unknown;
    let result: unknown;
    try {
      result = await auth.api.verifyApiKey({ body: { key: 'dork_not_a_real_key' } });
    } catch (err) {
      threw = err;
    }
    expect(String((threw as Error | undefined)?.message ?? '')).not.toMatch(/base ?URL/i);
    expect(result).toMatchObject({ valid: false });
  });

  it('does not forward the benign "Base URL is not set" advisory to the logger', () => {
    // DorkOS omits `baseURL` on purpose, so Better Auth emits its one-time
    // advisory at init. The custom auth logger must swallow exactly that line —
    // it should never reach the DorkOS logger — while everything else forwards.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      createAuth(db, tmpDir);
    } finally {
      const forwarded = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      warnSpy.mockRestore();
      expect(forwarded).not.toContain('Base URL is not set');
    }
  });

  describe('isBetterAuthBaseUrlAdvisory', () => {
    it('matches the base-URL advisory at warn level', () => {
      expect(
        isBetterAuthBaseUrlAdvisory('warn', '[better-auth] Base URL is not set. Set the baseURL...')
      ).toBe(true);
    });

    it('does not match the same text at a non-warn level', () => {
      expect(isBetterAuthBaseUrlAdvisory('error', 'Base URL is not set')).toBe(false);
    });

    it('does not match other Better Auth warnings (they still forward)', () => {
      expect(
        isBetterAuthBaseUrlAdvisory('warn', '[better-auth] your BETTER_AUTH_SECRET is low-entropy')
      ).toBe(false);
    });
  });
});
