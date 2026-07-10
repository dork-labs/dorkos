/**
 * @vitest-environment node
 *
 * The session gate on the durable SSE endpoint `GET /api/sessions/:id/events`,
 * driven through the REAL sessions route with a `FakeAgentRuntime` (per
 * `.claude/rules/testing.md`). Proves the stream authenticates via a Better Auth
 * session cookie when login is enabled, is a pass-through when disabled, and 401s
 * with no credentials. Uses `createApp()` with a real config + real auth so the
 * gate reads the live `auth.enabled` flag, mirroring production wiring.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { SessionEvent, SessionSnapshot } from '@dorkos/shared/session-stream';

// Mock the directory boundary so the /events handler's assertBoundary against
// the default cwd doesn't require initBoundary() at startup (mirrors
// sessions-events.test.ts).
vi.mock('../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

// Declared at module scope so the vi.mock factory closure can reference it.
let fakeRuntime: FakeAgentRuntime;

vi.mock('../../../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    getSessionSettings: vi.fn(async () => null),
    getSessionSettingsMany: vi.fn(() => new Map()),
    has: vi.fn(() => true),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {
    constructor(
      public readonly runtime: string,
      public readonly sessionId: string
    ) {
      super(`Session '${sessionId}' is owned by runtime '${runtime}', which is not registered.`);
      this.name = 'RuntimeNotRegisteredError';
    }
  },
}));

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(async () => null),
}));

import { createDb, runMigrations, user, type Db } from '@dorkos/db';
import { initAuth } from '../index.js';
import { configManager, initConfigManager } from '../../config-manager.js';
import { createApp, finalizeApp } from '../../../../app.js';
import { env } from '../../../../env.js';

/** Valid UUID for the session id param (routes validate UUID format). */
const SESSION_ID = '00000000-0000-4000-8000-000000000001';

const DOMAIN = 'dork.test';
const OWNER_EMAIL = 'owner' + '@' + DOMAIN;
const OWNER_PASSWORD = 'correct-horse-battery-staple';
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;

/** Build a finite `subscribeSession` mock that yields the given events then ends. */
function finiteSubscribe(events: SessionEvent[]) {
  return vi.fn(async function* (): AsyncIterable<SessionEvent> {
    for (const event of events) yield event;
  });
}

const SNAPSHOT: SessionSnapshot = {
  messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:00Z' }],
  inProgressTurn: null,
  status: {
    contextUsage: null,
    cost: null,
    cacheStats: null,
    model: null,
    permissionMode: 'default',
    todoCounts: null,
    runningSubagentCount: 0,
    lifecycle: 'idle',
  },
  pendingInteractions: [],
  cursor: 0,
};

function setAuthEnabled(enabled: boolean): void {
  configManager.set('auth', { enabled });
}

describe('sessionGate on GET /api/sessions/:id/events (SSE, integration)', () => {
  let tmpDir: string;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let cookies: string[];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-gate-sse-'));
    initConfigManager(tmpDir);
    db = createDb(path.join(tmpDir, 'gate-sse.db'));
    runMigrations(db);
    initAuth(db, tmpDir);
    app = createApp();
    finalizeApp(app);

    // Owner + a real session cookie (auth off during setup so sign-up is clean).
    setAuthEnabled(false);
    await request(app)
      .post('/api/auth/sign-up/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: 'Owner' });
    const signIn = await request(app)
      .post('/api/auth/sign-in/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
    cookies = signIn.headers['set-cookie'] as unknown as string[];
    // Sanity: an owner row exists.
    expect(db.select().from(user).get()).toBeDefined();
  });

  beforeEach(() => {
    fakeRuntime = new FakeAgentRuntime();
    vi.clearAllMocks();
    fakeRuntime.hasSession.mockReturnValue(true);
    fakeRuntime.getSessionSnapshot.mockResolvedValue(SNAPSHOT);
    fakeRuntime.subscribeSession = finiteSubscribe([
      { seq: 1, type: 'turn_start' },
      { seq: 2, type: 'text_delta', text: 'Hello' },
    ]);
  });

  afterAll(() => {
    setAuthEnabled(false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('streams the durable SSE snapshot when login is disabled (pass-through)', async () => {
    setAuthEnabled(false);
    const res = await request(app).get(`/api/sessions/${SESSION_ID}/events`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('event: snapshot');
  });

  it('401s the SSE endpoint with no credentials when login is enabled', async () => {
    setAuthEnabled(true);
    const res = await request(app).get(`/api/sessions/${SESSION_ID}/events`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
  });

  it('authenticates the SSE endpoint via a session cookie and streams', async () => {
    setAuthEnabled(true);
    const res = await request(app).get(`/api/sessions/${SESSION_ID}/events`).set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.text).toContain('event: snapshot');
    expect(res.text).toContain('event: turn_start');
  });

  it('lets the trigger endpoint through the transparent gate when login is disabled', async () => {
    // POST /:id/messages is trigger-only (202, ADR-0264). With login disabled the
    // gate must be transparent: the request reaches the route rather than being
    // 401'd — the only thing this auth-gate test needs to prove.
    setAuthEnabled(false);
    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'hello' });
    expect(res.status).not.toBe(401);
    expect(res.body?.code).not.toBe('AUTH_REQUIRED');
  });
});
