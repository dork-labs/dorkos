/**
 * @vitest-environment node
 *
 * End-to-end MCP auth over a real Better Auth instance, exercising the full
 * `/mcp` chain the way `index.ts` wires it: the app-wide session gate (task 1.2)
 * followed by `mcpApiKeyAuth`. Covers both `config.auth.enabled` modes and every
 * acceptor in the resolution order (env override, per-user key, revoked key,
 * legacy compat key, pass-through).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, user, apikey, eq, type Db } from '@dorkos/db';
import { getAuth, initAuth, sessionGate, toNodeHandler } from '../../services/core/auth/index.js';
import { mcpApiKeyAuth } from '../mcp-auth.js';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import { env } from '../../env.js';

const DOMAIN = 'dork.test';
const OWNER_EMAIL = 'owner' + '@' + DOMAIN;
const OWNER_PASSWORD = 'correct-horse-battery-staple';
const OWNER_NAME = 'Owner';
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;

const JSON_RPC_401 = {
  jsonrpc: '2.0',
  error: {
    code: -32001,
    message: 'Unauthorized. Provide a valid API key via Authorization: Bearer <key>.',
  },
  id: null,
};

/**
 * App mirroring the real `/mcp` chain: auth handler before `express.json()`, the
 * app-wide session gate, then a `/mcp` route guarded by `mcpApiKeyAuth`.
 */
function buildApp(): express.Express {
  const app = express();
  app.all('/api/auth/*splat', toNodeHandler(getAuth()!));
  app.use(express.json({ limit: '1mb' }));
  app.use(sessionGate);
  app.get('/mcp', mcpApiKeyAuth, (_req, res) => res.json({ ok: true }));
  return app;
}

function setAuthEnabled(enabled: boolean): void {
  configManager.set('auth', { enabled });
}

function setLegacyKey(value: string | null): void {
  configManager.set('mcp', {
    enabled: true,
    apiKey: value,
    rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
  });
}

describe('mcpApiKeyAuth — /mcp end-to-end (integration)', () => {
  let tmpDir: string;
  let db: Db;
  let app: express.Express;
  let ownerId: string;
  let cookies: string[];
  let userKey: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-mcpauth-'));
    initConfigManager(tmpDir);
    db = createDb(path.join(tmpDir, 'mcpauth-test.db'));
    runMigrations(db);
    const auth = initAuth(db);
    app = buildApp();

    const signUp = await request(app)
      .post('/api/auth/sign-up/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: OWNER_NAME });
    expect(signUp.status).toBe(200);

    const signIn = await request(app)
      .post('/api/auth/sign-in/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
    cookies = signIn.headers['set-cookie'] as unknown as string[];
    ownerId = db.select().from(user).get()!.id;

    userKey = (await auth.api.createApiKey({ body: { userId: ownerId, name: 'mcp-test-key' } }))
      .key;
  });

  afterEach(() => {
    // Reset the shared runtime knobs each test toggles.
    setAuthEnabled(false);
    setLegacyKey(null);
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = undefined;
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('auth.enabled = false (gate transparent, mcp-auth is the authority)', () => {
    it('passes through with no credentials when nothing is configured', async () => {
      const res = await request(app).get('/mcp');
      expect(res.status).toBe(200);
    });

    it('accepts the exact MCP_API_KEY env override, rejects a wrong one (JSON-RPC)', async () => {
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'headless-secret';
      const ok = await request(app).get('/mcp').set('Authorization', 'Bearer headless-secret');
      expect(ok.status).toBe(200);

      const bad = await request(app).get('/mcp').set('Authorization', 'Bearer wrong');
      expect(bad.status).toBe(401);
      expect(bad.body).toEqual(JSON_RPC_401);
    });

    it('accepts a per-user Better Auth API key', async () => {
      // With an env override configured, mcp-auth is unambiguously the authority
      // (no localhost pass-through). A valid per-user key resolves via the shared
      // verifier and passes; a revoked one gets the JSON-RPC 401 below.
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'headless-secret';
      const res = await request(app).get('/mcp').set('Authorization', `Bearer ${userKey}`);
      expect(res.status).toBe(200);
    });

    it('rejects a revoked per-user key with a JSON-RPC 401', async () => {
      // Configure an env override so mcp-auth enforces (auth off would otherwise
      // pass anonymous localhost requests through). The revoked key is neither the
      // env key nor a valid credential → mcp-auth's own JSON-RPC 401.
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'headless-secret';
      const auth = getAuth()!;
      const created = await auth.api.createApiKey({
        body: { userId: ownerId, name: 'revoke-me' },
      });
      // Revoke by deleting the row (mirrors a key deleted from the API-key UI).
      db.delete(apikey).where(eq(apikey.id, created.id)).run();

      const res = await request(app).get('/mcp').set('Authorization', `Bearer ${created.key}`);
      expect(res.status).toBe(401);
      expect(res.body).toEqual(JSON_RPC_401);
    });

    it('accepts a not-yet-seeded legacy config key (compat window)', async () => {
      setLegacyKey('dork_mcp_legacy_compat');
      const res = await request(app)
        .get('/mcp')
        .set('Authorization', 'Bearer dork_mcp_legacy_compat');
      expect(res.status).toBe(200);
    });
  });

  describe('auth.enabled = true (session gate is the front-line authority)', () => {
    it('gate 401s an unauthenticated /mcp request before mcp-auth runs', async () => {
      setAuthEnabled(true);
      const res = await request(app).get('/mcp');
      expect(res.status).toBe(401);
      // The gate's shape, not the JSON-RPC shape — it 401s before mcp-auth.
      expect(res.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    });

    it('accepts a per-user API key through both the gate and mcp-auth', async () => {
      setAuthEnabled(true);
      const res = await request(app).get('/mcp').set('Authorization', `Bearer ${userKey}`);
      expect(res.status).toBe(200);
    });

    it('accepts a valid session cookie', async () => {
      setAuthEnabled(true);
      const res = await request(app).get('/mcp').set('Cookie', cookies);
      expect(res.status).toBe(200);
    });

    it('the MCP_API_KEY env override alone is blocked by the gate when login is on', async () => {
      // Documents the boundary: the env override is a login-disabled (headless)
      // mechanism. With login enabled, callers must present a Better Auth credential.
      setAuthEnabled(true);
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'headless-secret';
      const res = await request(app).get('/mcp').set('Authorization', 'Bearer headless-secret');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    });
  });
});
