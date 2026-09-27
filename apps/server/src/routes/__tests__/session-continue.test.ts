/**
 * The four out-of-usage routes through the REAL app mount (spec
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
import { agents, type Db } from '@dorkos/db';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
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
