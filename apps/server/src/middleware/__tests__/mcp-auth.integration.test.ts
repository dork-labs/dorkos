/**
 * @vitest-environment node
 *
 * End-to-end MCP auth over a real Better Auth instance, exercising the full
 * `/mcp` chain the way `index.ts` wires it: `express.json()`, the app-wide
 * session gate (task 1.2), then `createMcpAuth({ surface: 'mcp' })`. Covers both
 * `config.auth.enabled` modes, the login-off read-only carve-out, the helpful
 * 401 body, and every credential acceptor (env override, per-user key, revoked
 * key, legacy compat key, and the per-instance local token).
 *
 * The local-token module is mocked to a known value/path so the acceptor and the
 * 401 body are deterministic; everything else (auth, session gate, the middleware
 * itself) is real.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, user, apikey, eq, type Db } from '@dorkos/db';

/** A valid local token (dork_mcp_local_ + 64 hex) the acceptor should accept. */
const LOCAL_TOKEN = `dork_mcp_local_${'a'.repeat(64)}`;
/** The resolved token file path the 401 body must name (never the value). */
const TOKEN_PATH = '/tmp/dork/mcp-local-token';

// The per-instance local token (DOR-278) — mocked so the acceptor + 401 body are
// deterministic. Auth and the session gate stay real.
vi.mock('../../services/core/auth/mcp-local-token.js', () => ({
  getMcpLocalToken: vi.fn(() => LOCAL_TOKEN),
  getMcpLocalTokenPath: vi.fn(() => TOKEN_PATH),
  resolveMcpLocalToken: vi.fn(),
  rotateMcpLocalToken: vi.fn(),
}));

import { getAuth, initAuth, sessionGate, toNodeHandler } from '../../services/core/auth/index.js';
import { createMcpAuth } from '../mcp-auth.js';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import { env } from '../../env.js';

const DOMAIN = 'dork.test';
const OWNER_EMAIL = 'owner' + '@' + DOMAIN;
const OWNER_PASSWORD = 'correct-horse-battery-staple';
const OWNER_NAME = 'Owner';
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;

/** JSON-RPC bodies used to drive the carve-out. */
const READ_ONLY_CALL = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'ping' }, id: 1 };
const DISCOVERY_LIST = { jsonrpc: '2.0', method: 'tools/list', id: 1 };
const MUTATING_CALL = {
  jsonrpc: '2.0',
  method: 'tools/call',
  params: { name: 'create_extension' },
  id: 1,
};
const RESOURCES_READ = {
  jsonrpc: '2.0',
  method: 'resources/read',
  params: { uri: 'dorkos://sessions' },
  id: 1,
};

/**
 * App mirroring the real `/mcp` chain: the Better Auth handler (mounted before
 * the JSON body parser, as in production), then `express.json()`, then the
 * app-wide session gate, then a `/mcp` route guarded by the real `createMcpAuth`
 * middleware — so `req.body` peeking behaves exactly as production. The stub
 * handler returns `{ ok: true }` only when the middleware calls `next()`.
 */
function buildApp(): express.Express {
  const app = express();
  app.all('/api/auth/*splat', toNodeHandler(getAuth()!));
  app.use(express.json({ limit: '1mb' }));
  app.use(sessionGate);
  app.post('/mcp', createMcpAuth({ surface: 'mcp' }), (_req, res) => res.json({ ok: true }));
  return app;
}

/** Start a POST /mcp request, optionally with a Bearer token or session cookie. */
function postMcp(
  app: express.Express,
  opts: { auth?: string; cookie?: string[] } = {}
): request.Test {
  let r = request(app).post('/mcp').set('Content-Type', 'application/json');
  if (opts.auth) r = r.set('Authorization', opts.auth);
  if (opts.cookie) r = r.set('Cookie', opts.cookie);
  return r;
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

describe('createMcpAuth — /mcp end-to-end (integration)', () => {
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
    const auth = initAuth(db, tmpDir);
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

  describe('auth.enabled = false (gate transparent, the carve-out + local token apply)', () => {
    it('allows a tokenless read-only tools/call (carve-out)', async () => {
      const res = await postMcp(app).send(READ_ONLY_CALL);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('allows a tokenless discovery tools/list', async () => {
      const res = await postMcp(app).send(DISCOVERY_LIST);
      expect(res.status).toBe(200);
    });

    it('401s a tokenless mutating tools/call with a helpful, non-leaking body', async () => {
      const res = await postMcp(app).send(MUTATING_CALL);
      expect(res.status).toBe(401);
      const body = res.body as { jsonrpc: string; error: { code: number; message: string } };
      expect(body.jsonrpc).toBe('2.0');
      expect(body.error.code).toBe(-32001);
      expect(body.error.message).toContain(TOKEN_PATH);
      expect(body.error.message).toContain('Authorization: Bearer');
      // The card lives in the Tools tab — the message must point there exactly.
      expect(body.error.message).toContain('Settings → Tools → External MCP Server');
      expect(body.error.message).not.toContain(LOCAL_TOKEN);
    });

    it('allows the same mutating call WITH the local token', async () => {
      const res = await postMcp(app, { auth: `Bearer ${LOCAL_TOKEN}` }).send(MUTATING_CALL);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('401s a tokenless resources/read (fail-closed on data reads)', async () => {
      const res = await postMcp(app).send(RESOURCES_READ);
      expect(res.status).toBe(401);
    });

    it('accepts the exact MCP_API_KEY env override on a mutating call, rejects a wrong one', async () => {
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'headless-secret';
      const ok = await postMcp(app, { auth: 'Bearer headless-secret' }).send(MUTATING_CALL);
      expect(ok.status).toBe(200);

      const bad = await postMcp(app, { auth: 'Bearer wrong' }).send(MUTATING_CALL);
      expect(bad.status).toBe(401);
    });

    it('accepts a per-user Better Auth API key on a mutating call', async () => {
      const res = await postMcp(app, { auth: `Bearer ${userKey}` }).send(MUTATING_CALL);
      expect(res.status).toBe(200);
    });

    it('rejects a revoked per-user key on a mutating call with a JSON-RPC 401', async () => {
      const auth = getAuth()!;
      const created = await auth.api.createApiKey({ body: { userId: ownerId, name: 'revoke-me' } });
      db.delete(apikey).where(eq(apikey.id, created.id)).run();

      const res = await postMcp(app, { auth: `Bearer ${created.key}` }).send(MUTATING_CALL);
      expect(res.status).toBe(401);
      expect((res.body as { error: { code: number } }).error.code).toBe(-32001);
    });

    it('accepts a not-yet-seeded legacy config key on a mutating call (compat window)', async () => {
      setLegacyKey('dork_mcp_legacy_compat');
      const res = await postMcp(app, { auth: 'Bearer dork_mcp_legacy_compat' }).send(MUTATING_CALL);
      expect(res.status).toBe(200);
    });
  });

  describe('auth.enabled = true (session gate is the front-line authority)', () => {
    it('gate 401s an unauthenticated /mcp request before the middleware runs', async () => {
      setAuthEnabled(true);
      const res = await postMcp(app).send(READ_ONLY_CALL);
      expect(res.status).toBe(401);
      // The gate's shape, not the JSON-RPC shape — it 401s before the middleware.
      expect(res.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    });

    it('does not accept the local token when login is on (gate blocks it)', async () => {
      setAuthEnabled(true);
      const res = await postMcp(app, { auth: `Bearer ${LOCAL_TOKEN}` }).send(READ_ONLY_CALL);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    });

    it('accepts a per-user API key through both the gate and the middleware', async () => {
      setAuthEnabled(true);
      const res = await postMcp(app, { auth: `Bearer ${userKey}` }).send(MUTATING_CALL);
      expect(res.status).toBe(200);
    });

    it('accepts a valid session cookie', async () => {
      setAuthEnabled(true);
      const res = await postMcp(app, { cookie: cookies }).send(MUTATING_CALL);
      expect(res.status).toBe(200);
    });

    it('the MCP_API_KEY env override alone is blocked by the gate when login is on', async () => {
      setAuthEnabled(true);
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'headless-secret';
      const res = await postMcp(app, { auth: 'Bearer headless-secret' }).send(READ_ONLY_CALL);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    });
  });
});
