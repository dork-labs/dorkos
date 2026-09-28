/**
 * The four out-of-usage routes, and the limit history beside them (spec
 * `claude-account-ui` §7.1), through the REAL app mount (spec
 * `claude-account-fleet` D9 "Endpoints"): they are mounted at all, a person is
 * the gate, a refusal keeps its status and code, and each body has the shape
 * the UI reads. The decisions behind them are the continue service's, tested
 * in `services/session/fleet/__tests__/continue-service.test.ts`.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { agents, type Db } from '@dorkos/db';
import { BoundaryError, validateBoundaryOrDorkHome } from '../../lib/boundary.js';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    constructor(
      message: string,
      readonly code?: string
    ) {
      super(message);
    }
  },
}));
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));
vi.mock('../../services/session/fleet/continue-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/session/fleet/continue-service.js')>()),
  continueOptions: vi.fn(),
  continueSession: vi.fn(),
  waitForReset: vi.fn(),
  cancelAutoContinue: vi.fn(),
}));

import { createApp, finalizeApp } from '../../app.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { createRoomSubsystem, setRoomService } from '../../services/rooms/index.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import {
  ContinueError,
  cancelAutoContinue,
  continueOptions,
  continueSession,
  waitForReset,
} from '../../services/session/fleet/continue-service.js';
import { rejectUnknownModel } from '../session-model-gate.js';
import {
  SessionLimitStore,
  setSessionLimitStore,
} from '../../services/session/fleet/session-limit-store.js';

const app = createApp();
finalizeApp(app);
const testServer = listeningServer(app);

const SESSION = '0e7270c6-5555-4666-8777-888888888888';
const base = `/api/sessions/${SESSION}`;

describe('the out-of-usage routes', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    runtimeRegistry.setDb(db);
    // The caller gate resolves the person through the rooms domain's owner record.
    setRoomService(createRoomSubsystem({ db }).service);
    vi.mocked(continueOptions).mockReset();
    vi.mocked(continueSession).mockReset();
    vi.mocked(waitForReset).mockReset();
    vi.mocked(cancelAutoContinue).mockReset();
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  it('serves the continue options', async () => {
    const options = {
      plan: { mode: 'ask' },
      ranking: { accounts: [], recommendedId: null },
      advised: false,
    };
    vi.mocked(continueOptions).mockResolvedValue(options as never);
    const res = await request(testServer).get(`${base}/continue-options`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(options);
    expect(continueOptions).toHaveBeenCalledWith(SESSION);
  });

  it('answers a carry-over with 202 and the new session, handing the model gate to the service', async () => {
    vi.mocked(continueSession).mockResolvedValue({ sessionId: 'new-1' });
    const res = await request(testServer)
      .post(`${base}/continue`)
      .set('X-Client-Id', 'client-9')
      .send({ account: 'spare', model: 'sonnet' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ sessionId: 'new-1' });
    const [id, body, deps] = vi.mocked(continueSession).mock.calls[0]!;
    expect(id).toBe(SESSION);
    expect(body).toEqual({ account: 'spare', model: 'sonnet' });
    expect(deps.clientId).toBe('client-9');
    expect(deps.checkModel).toBe(rejectUnknownModel);
  });

  it('answers a claimed session’s continue with 202 and an empty body', async () => {
    vi.mocked(continueSession).mockResolvedValue({});
    const res = await request(testServer).post(`${base}/continue`).send({ account: 'spare' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
  });

  it('keeps a refusal’s status, sentence and code', async () => {
    vi.mocked(continueSession).mockRejectedValue(
      new ContinueError(
        409,
        'WAIT_ONLY',
        'This conversation did not start here, so it can only wait for the reset.'
      )
    );
    const res = await request(testServer).post(`${base}/continue`).send({ account: 'spare' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'This conversation did not start here, so it can only wait for the reset.',
      code: 'WAIT_ONLY',
    });

    vi.mocked(waitForReset).mockRejectedValue(
      new ContinueError(
        503,
        'FLOW_UNREACHABLE',
        'Flow could not be reached, so this was not changed.'
      )
    );
    const waited = await request(testServer).post(`${base}/wait`).send({});
    expect(waited.status).toBe(503);
  });

  it('refuses a malformed body before the service is asked', async () => {
    const res = await request(testServer).post(`${base}/continue`).send({ account: 7 });
    expect(res.status).toBe(400);
    const waited = await request(testServer).post(`${base}/wait`).send({ autoResume: 'yes' });
    expect(waited.status).toBe(400);
    expect(continueSession).not.toHaveBeenCalled();
    expect(waitForReset).not.toHaveBeenCalled();
  });

  it('waits and cancels, answering the new plan', async () => {
    vi.mocked(waitForReset).mockResolvedValue({
      mode: 'waiting',
      resumeAt: null,
      autoResume: true,
    });
    const waited = await request(testServer).post(`${base}/wait`).send({ autoResume: true });
    expect(waited.status).toBe(200);
    expect(waited.body).toEqual({ plan: { mode: 'waiting', resumeAt: null, autoResume: true } });
    expect(waitForReset).toHaveBeenCalledWith(SESSION, { autoResume: true });

    vi.mocked(cancelAutoContinue).mockResolvedValue({ mode: 'ask' });
    const cancelled = await request(testServer).post(`${base}/continue/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ plan: { mode: 'ask' } });
  });

  it('refuses an id that is not a session id', async () => {
    const res = await request(testServer).get('/api/sessions/not-a-session/continue-options');
    expect(res.status).toBe(400);
  });

  it('403s a verified agent on every route', async () => {
    const now = new Date().toISOString();
    db.insert(agents)
      .values({
        id: 'ULID_ANA',
        name: 'ana',
        displayName: 'Ana',
        runtime: 'claude-code',
        projectPath: '/agents/ana',
        behaviorJson: '{"responseMode":"silent"}',
        registeredAt: now,
        updatedAt: now,
      })
      .run();
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({ agentPath: '/agents/ana', displayName: 'Ana' });
    const answers = await Promise.all([
      request(testServer).get(`${base}/continue-options`).set('X-DorkOS-Agent', token),
      request(testServer)
        .post(`${base}/continue`)
        .set('X-DorkOS-Agent', token)
        .send({ account: 'spare' }),
      request(testServer).post(`${base}/wait`).set('X-DorkOS-Agent', token).send({}),
      request(testServer).post(`${base}/continue/cancel`).set('X-DorkOS-Agent', token),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PEOPLE_ONLY');
    }
    expect(continueSession).not.toHaveBeenCalled();
  });
});

describe('GET /api/sessions/:id/limit-history', () => {
  const HOUR = 60 * 60 * 1000;
  let db: Db;
  let store: SessionLimitStore;
  let clock: Date;

  beforeEach(() => {
    db = createTestDb();
    runtimeRegistry.setDb(db);
    // The route places the session through its runtime, as `/events` does.
    runtimeRegistry.register(new FakeAgentRuntime('claude-code') as never);
    clock = new Date();
    store = new SessionLimitStore(db, () => clock);
    setSessionLimitStore(store);
  });

  afterEach(() => {
    setSessionLimitStore(undefined);
  });

  /** One resolved episode, hit `hoursAgo` hours before now and cleared a minute later. */
  function episode(hoursAgo: number): string {
    const since = new Date(Date.now() - hoursAgo * HOUR);
    store.upsert({
      sessionId: SESSION,
      limit: {
        accountId: 'main',
        window: 'five_hour',
        resetsAt: new Date(since.getTime() + 5 * HOUR).toISOString(),
        since: since.toISOString(),
        plan: { mode: 'ask' },
        scope: 'account',
        state: 'limited',
      },
      scope: 'account',
      accountPath: '/accounts/main',
    });
    clock = new Date(since.getTime() + 60_000);
    store.delete(SESSION);
    return since.toISOString();
  }

  it('serves the last 20 episodes, oldest first, in the wire shape', async () => {
    await runtimeRegistry.persistSessionRuntime(SESSION, 'claude-code', {
      kind: 'interactive',
    } as never);
    const sinces = Array.from({ length: 22 }, (_, i) => episode(100 - i));
    const res = await request(testServer).get(`${base}/limit-history`);
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { since: string }) => e.since)).toEqual(sinces.slice(2));
    expect(res.body.entries[0]).toEqual({
      id: expect.any(String),
      sessionId: SESSION,
      since: sinces[2],
      runtime: 'claude-code',
      accountId: 'main',
      window: 'five_hour',
      scope: 'account',
      resetsAt: expect.any(String),
      resolution: 'resumed-early',
      resolvedAt: expect.any(String),
      toSessionId: null,
      toAccountId: null,
      modelFrom: null,
      modelTo: null,
    });
  });

  it('answers an empty list for a known session with no past limits', async () => {
    await runtimeRegistry.saveSessionSettings(SESSION, { model: 'opus' });
    const res = await request(testServer).get(`${base}/limit-history`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [] });
  });

  it('answers 404 for a session this server does not know', async () => {
    const res = await request(testServer).get(`${base}/limit-history`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SESSION_NOT_FOUND');
  });

  it('refuses a session outside the boundary as the other session reads do', async () => {
    await runtimeRegistry.saveSessionSettings(SESSION, { model: 'opus' });
    const outside = () =>
      new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY');
    // The directory the session's runtime places it in…
    vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(outside());
    const placed = await request(testServer).get(`${base}/limit-history`);
    expect(placed.status).toBe(403);
    expect(placed.body.code).toBe('OUTSIDE_BOUNDARY');
    // …and one the caller names.
    vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(outside());
    const named = await request(testServer).get(`${base}/limit-history?cwd=/elsewhere`);
    expect(named.status).toBe(403);
    expect(named.body.code).toBe('OUTSIDE_BOUNDARY');
    expect(validateBoundaryOrDorkHome).toHaveBeenLastCalledWith('/elsewhere');
  });

  it('answers 400 for an invalid id', async () => {
    const res = await request(testServer).get('/api/sessions/not a uuid/limit-history');
    expect(res.status).toBe(400);
  });
});
