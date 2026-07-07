/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, user, type Db } from '@dorkos/db';
import { createAuth, toNodeHandler } from '../index.js';
import { initConfigManager } from '../../config-manager.js';
import { env } from '../../../../env.js';

/**
 * Mounts the Better Auth handler over a throwaway temp SQLite database exactly
 * as `app.ts` does: `app.all('/api/auth/*splat', ...)` BEFORE `express.json()`.
 */
function buildApp(db: Db): express.Express {
  const app = express();
  app.all('/api/auth/*splat', toNodeHandler(createAuth(db)));
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
    app = buildApp(db);
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
});
