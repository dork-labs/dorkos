/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, user, apikey, eq, type Db } from '@dorkos/db';
import { defaultKeyHasher } from '@better-auth/api-key';
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

  describe('API keys are not throttled per key (DOR-489)', () => {
    // The plugin's own default is 10 verifications per 24h per key, written into
    // the key's columns at creation. The CLI carries no cookie and presents its
    // key on every request, so that default turned the eleventh `dorkos` command
    // of the day into a 401 that reads like a revoked key. These tests drive the
    // real `auth.api` seam, not a stub: with `apiKey()` registered optionless
    // they fail on verification 11.

    /** Comfortably past the plugin's 10-per-day default — an ordinary session. */
    const VERIFICATIONS = 25;

    let keyDir: string;
    let keyDb: Db;
    let auth: ReturnType<typeof createAuth>;
    const ownerId = 'rate-limit-owner';

    beforeAll(() => {
      keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-auth-keys-'));
      keyDb = createDb(path.join(keyDir, 'keys-test.db'));
      runMigrations(keyDb);
      // A key needs an owner to reference. Inserted directly rather than through
      // sign-up: registration is owner-only and this db exists only to hold keys.
      keyDb
        .insert(user)
        .values({
          id: ownerId,
          name: OWNER_NAME,
          email: OWNER_EMAIL,
          role: 'owner',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
      auth = createAuth(keyDb, keyDir);
    });

    afterAll(() => {
      fs.rmSync(keyDir, { recursive: true, force: true });
    });

    /**
     * Verify `key` {@link VERIFICATIONS} times and return the 1-based number of
     * the first verification that did not hand back the owner, or `null` when
     * all of them did. A rate-limited verification resolves to `{ valid: false }`
     * rather than throwing, so both shapes are folded into one answer.
     */
    async function firstRejection(key: string): Promise<number | null> {
      for (let attempt = 1; attempt <= VERIFICATIONS; attempt++) {
        try {
          const result = await auth.api.verifyApiKey({ body: { key } });
          // Resolving to the owner is part of "accepted": `session-gate.ts`
          // requires a non-empty `referenceId`, so a bare `valid: true` with no
          // key attached would still 401 the caller.
          if (!result.valid || result.key?.referenceId !== ownerId) return attempt;
        } catch {
          return attempt;
        }
      }
      return null;
    }

    it('accepts a freshly minted key far past the plugin default of ten a day', async () => {
      const created = await auth.api.createApiKey({ body: { userId: ownerId, name: 'cli-key' } });

      expect(await firstRejection(created.key)).toBeNull();
    });

    it('mints keys with per-key throttling off, so no new row carries a day quota', async () => {
      const created = await auth.api.createApiKey({
        body: { userId: ownerId, name: 'column-key' },
      });

      const row = keyDb.select().from(apikey).where(eq(apikey.id, created.id)).get();
      expect(row?.rateLimitEnabled).toBe(false);
    });

    it('accepts a key that predates the fix, so no migration or backfill is owed', async () => {
      // The shape `seedLegacyMcpApiKey` inserts and the shape every key created
      // before this change already has on disk: the schema's rate-limit defaults,
      // which say "10 per 24h". The plugin option is checked before those columns
      // are read, so the row is exempt without being rewritten.
      const plaintext = 'dork_mcp_legacy_key_from_before_the_fix';
      const now = new Date();
      keyDb
        .insert(apikey)
        .values({
          id: 'legacy-key-row',
          referenceId: ownerId,
          name: 'Legacy MCP key',
          key: await defaultKeyHasher(plaintext),
          enabled: true,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const stored = keyDb.select().from(apikey).where(eq(apikey.id, 'legacy-key-row')).get();
      expect(stored?.rateLimitEnabled).toBe(true);
      expect(stored?.rateLimitMax).toBe(10);

      expect(await firstRejection(plaintext)).toBeNull();
    });
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
