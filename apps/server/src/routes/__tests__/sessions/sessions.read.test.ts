/**
 * Reading sessions: the list, one session, its messages and tasks, a fork,
 * and how a rejected runtime lookup reaches the caller.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';

vi.mock('../../../services/core/runtime-registry.js', async () =>
  (await import('./sessions.fixtures.js')).registryModule()
);
vi.mock('../../../lib/boundary.js', async (importOriginal) =>
  (await import('./sessions.fixtures.js')).boundaryModule(await importOriginal<object>())
);

import { listeningServer } from '@dorkos/test-utils/listening-server';
import request from '@dorkos/test-utils/supertest';
import { MainRequestAdmission } from '../../../services/core/lifecycle/main-request-admission.js';
import { composedListener } from '../../../http/__tests__/composed-listener.js';
import { initBoundary } from '../../../lib/boundary.js';
import { initConfigManager } from '../../../services/core/config-manager.js';
import {
  runtimeRegistry,
  RuntimeNotRegisteredError,
} from '../../../services/core/runtime-registry.js';
import { disposeProjector } from '../../../services/session/session-state-projector.js';
import { setAccountUsageStore } from '../../../services/core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../../services/core/usage/account-usage-store.js';
import { S1, runtimeHolder, useSessionsApp } from './sessions.fixtures.js';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  getWorkLinkStore,
  installWorkLinkStore,
  uninstallWorkLinkStore,
} from '../../../services/work-graph/index.js';

const server = listeningServer(composedListener(new MainRequestAdmission(), { sessions: {} }));

useSessionsApp({ runtimeRegistry, disposeProjector, initBoundary, initConfigManager });

let fakeRuntime: FakeAgentRuntime;
beforeEach(() => {
  fakeRuntime = runtimeHolder.current;
});

/** A session as a runtime reports it. */
function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: S1,
    title: 'My session',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    permissionMode: 'default' as const,
    runtime: 'fake',
    ...overrides,
  };
}

describe('GET /api/sessions', () => {
  it('returns sessions from the single registered runtime, with no warnings when healthy', async () => {
    const sessions = [
      sessionRow({ title: 'First question', createdAt: '2024-01-02', updatedAt: '2024-01-02' }),
      sessionRow({ id: 's2', title: 'Second question', permissionMode: 'bypassPermissions' }),
    ];
    fakeRuntime.listSessions.mockResolvedValue(sessions);

    const res = await request(server).get('/api/sessions');
    expect(res.status).toBe(200);
    // Envelope (ADR-0310), one page (DOR-4982): { sessions, nextCursor, warnings? }.
    expect(res.body).toEqual({ sessions, nextCursor: null });
  });
});

describe('GET /api/sessions/:id', () => {
  it('returns session when found', async () => {
    fakeRuntime.getSession.mockResolvedValue(sessionRow());

    const res = await request(server).get(`/api/sessions/${S1}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(sessionRow());
  });

  it("carries the account's cached usage on status before any turn (spec claude-account-fleet §6 U)", async () => {
    const usage = {
      runtime: 'codex',
      accountId: 'default',
      path: '/home/.codex',
      label: null,
      color: '#000',
      subscriptionType: null,
      plan: null,
      credits: null,
      spend: null,
      windows: [],
      state: 'unknown',
      limit: null,
      updatedAt: null,
    };
    const peek = vi.fn(() => [usage]);
    setAccountUsageStore({ peek } as unknown as AccountUsageStore);
    const codex = new FakeAgentRuntime('codex');
    vi.mocked(runtimeRegistry.resolveForSession).mockResolvedValue(codex);
    codex.getInternalSessionId.mockReturnValue(undefined);
    codex.getSession.mockResolvedValue(sessionRow({ title: 'Codex session', runtime: 'codex' }));
    try {
      const res = await request(server).get(`/api/sessions/${S1}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toEqual({ lifecycle: 'idle', limit: null, accountUsage: usage });
      expect(peek).toHaveBeenCalledWith('codex', ['default']);
    } finally {
      setAccountUsageStore(undefined);
    }
  });

  it('fills a missing runtime tag from the resolved runtime type', async () => {
    // The route backstops sloppy adapters so the required field reaches the wire.
    fakeRuntime.getSession.mockResolvedValue(sessionRow({ runtime: undefined }));

    const res = await request(server).get(`/api/sessions/${S1}`);
    expect(res.status).toBe(200);
    expect(res.body.runtime).toBe('fake');
  });

  it('overlays persisted settings over transcript-derived values (ADR-0260: store wins)', async () => {
    fakeRuntime.getSession.mockResolvedValue(
      sessionRow({ runtime: undefined, model: 'transcript-model' })
    );
    vi.mocked(runtimeRegistry.getSessionSettingsMany).mockReturnValue(
      new Map([[S1, { permissionMode: 'bypassPermissions' }]])
    );

    const res = await request(server).get(`/api/sessions/${S1}`);
    expect(res.status).toBe(200);
    expect(res.body.permissionMode).toBe('bypassPermissions');
    expect(res.body.model).toBe('transcript-model');
  });

  it('returns 400 for invalid (non-UUID) session ID', async () => {
    const res = await request(server).get('/api/sessions/nonexistent');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('returns 404 for missing session', async () => {
    const res = await request(server).get('/api/sessions/00000000-0000-4000-8000-ffffffffffff');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('session_not_found');
  });
});

describe('async handler rejections reach the error middleware', () => {
  it('maps a RuntimeNotRegisteredError rejection to 503 runtime_not_available', async () => {
    vi.mocked(runtimeRegistry.resolveForSession).mockRejectedValueOnce(
      new RuntimeNotRegisteredError('codex', S1)
    );

    const res = await request(server).get(`/api/sessions/${S1}`);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('runtime_not_available');
    // The same words a room's `runtime_gone` notice uses (DOR-1720): the
    // program is named as it is everywhere else, and says what to do.
    expect(res.body.detail).toContain('Codex');
    expect(res.body.detail).not.toContain('codex');
    expect(res.body.detail).toContain('Turn Codex back on');
    expect(res.body.detail).not.toMatch(/Error:|undefined/);
  });

  it('maps an unexpected rejection on an interaction route to 500 internal_error', async () => {
    vi.mocked(runtimeRegistry.resolveForSession).mockRejectedValueOnce(
      new Error('settings store unavailable')
    );

    const res = await request(server)
      .post(`/api/sessions/${S1}/approve`)
      .send({ toolCallId: 'tool-1' });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal_error');
  });
});

describe('session ID translation', () => {
  it('GET /messages uses internal session ID when available', async () => {
    fakeRuntime.getInternalSessionId.mockReturnValue('sdk-uuid-123');
    // A live cwd binding is what makes the id "known" without ?cwd= (DOR-1322).
    fakeRuntime.getSessionCwd = vi.fn(() => '/mock/project');
    fakeRuntime.getMessageHistory.mockResolvedValue([]);

    await request(server).get(`/api/sessions/${S1}/messages`);

    expect(fakeRuntime.getMessageHistory).toHaveBeenCalledWith(expect.any(String), 'sdk-uuid-123');
  });

  it('GET /:id uses internal session ID for metadata lookup', async () => {
    fakeRuntime.getInternalSessionId.mockReturnValue('sdk-uuid-456');
    fakeRuntime.getSession.mockResolvedValue(sessionRow({ id: 'sdk-uuid-456' }));

    const res = await request(server).get(`/api/sessions/${S1}`);

    expect(res.status).toBe(200);
    expect(fakeRuntime.getSession).toHaveBeenCalledWith(expect.any(String), 'sdk-uuid-456');
  });

  it('GET /:id/tasks uses internal session ID', async () => {
    fakeRuntime.getInternalSessionId.mockReturnValue('sdk-uuid-789');

    await request(server).get(`/api/sessions/${S1}/tasks`);

    expect(fakeRuntime.getSessionTasks).toHaveBeenCalledWith(expect.any(String), 'sdk-uuid-789');
  });
});

// GET /:id/messages cwd resolution (DOR-1322): with no ?cwd= the route used to
// fall back to the default project directory without checking the session
// lived there, so a session elsewhere read back as a silently empty transcript.
describe('GET /:id/messages cwd resolution', () => {
  const ONE_MESSAGE = [
    { id: 'm1', role: 'user' as const, content: 'hi', timestamp: '2026-01-01T00:00:00Z' },
  ];

  it('returns messages for a known session with no ?cwd= param', async () => {
    fakeRuntime.getSessionCwd = vi.fn(() => '/live/project');
    fakeRuntime.getMessageHistory.mockImplementation(async (projectDir) =>
      projectDir === '/live/project' ? ONE_MESSAGE : []
    );

    const res = await request(server).get(`/api/sessions/${S1}/messages`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(fakeRuntime.getMessageHistory).toHaveBeenCalledWith('/live/project', S1);
  });

  it.each([
    // A cwd-tracking runtime with no live binding, and the session not in the
    // default project directory either: a genuine claude-code cold session.
    ['the session is not in the default directory', () => undefined],
    // claude-code's getSession can throw for reasons unrelated to "not
    // found"; the fallback probe is graceful degradation, never a 500.
    [
      'the fallback probe throws',
      () => fakeRuntime.getSession.mockRejectedValueOnce(new Error('Boundary not initialized')),
    ],
  ])('returns 404 naming the missing cwd when %s', async (_case, arrange) => {
    fakeRuntime.getSessionCwd = vi.fn(() => undefined);
    arrange();

    const res = await request(server).get(`/api/sessions/${S1}/messages`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('session_not_found');
    expect(res.body.detail).toMatch(/cwd/i);
    expect(fakeRuntime.getMessageHistory).not.toHaveBeenCalled();
  });

  it('trusts the default project directory outright for a runtime with no cwd-tracking capability', async () => {
    // No `getSessionCwd` at all: codex, opencode and test-mode read history by
    // id, and their getSession is not a stand-in for "has history". Gating on
    // it would 404 a real, answerable read (DOR-1322 round 2, PR #1191).
    fakeRuntime.getMessageHistory.mockResolvedValue(ONE_MESSAGE);

    const res = await request(server).get(`/api/sessions/${S1}/messages`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(fakeRuntime.getSession).not.toHaveBeenCalled();
    expect(fakeRuntime.getMessageHistory).toHaveBeenCalledWith(expect.any(String), S1);
  });

  it('honours an explicit ?cwd= even when the runtime has no live binding', async () => {
    fakeRuntime.getSessionCwd = vi.fn(() => undefined);
    fakeRuntime.getMessageHistory.mockResolvedValue(ONE_MESSAGE);

    const res = await request(server)
      .get(`/api/sessions/${S1}/messages`)
      .query({ cwd: '/explicit/project' });

    expect(res.status).toBe(200);
    expect(fakeRuntime.getMessageHistory).toHaveBeenCalledWith('/explicit/project', S1);
    expect(fakeRuntime.getSession).not.toHaveBeenCalled();
  });

  it('falls back to the default project directory when a cwd-tracking runtime confirms the session lives there', async () => {
    fakeRuntime.getSessionCwd = vi.fn(() => undefined);
    fakeRuntime.getSession.mockResolvedValue(sessionRow());
    fakeRuntime.getMessageHistory.mockResolvedValue(ONE_MESSAGE);

    const res = await request(server).get(`/api/sessions/${S1}/messages`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    // The fallback is VERIFIED, not assumed.
    expect(fakeRuntime.getSession).toHaveBeenCalledWith(expect.any(String), S1);
  });

  it('returns 500 when getMessageHistory throws', async () => {
    fakeRuntime.getSessionCwd = vi.fn(() => '/mock/project');
    fakeRuntime.getMessageHistory.mockRejectedValueOnce(new Error('I/O error'));

    const res = await request(server).get(`/api/sessions/${S1}/messages`);

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('code', 'internal_error');
  });
});

describe('POST /api/sessions/:id/fork', () => {
  const FORKED = sessionRow({ id: '00000000-0000-4000-8000-000000000099', title: 'Fork' });

  it('returns 400 for invalid session ID', async () => {
    const res = await request(server).post('/api/sessions/not-a-uuid/fork').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('forks the internal session and returns 201 with the new one', async () => {
    const internalId = '00000000-0000-4000-8000-internal00001';
    fakeRuntime.getInternalSessionId.mockReturnValue(internalId);
    fakeRuntime.forkSession.mockResolvedValue(FORKED);

    const res = await request(server)
      .post(`/api/sessions/${S1}/fork`)
      .send({ upToMessageId: 'msg-123', title: 'Fork' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(FORKED);
    expect(fakeRuntime.forkSession).toHaveBeenCalledWith(expect.any(String), internalId, {
      upToMessageId: 'msg-123',
      title: 'Fork',
    });
  });

  it('records the fork forked_from the id actually forked, in the work graph (DOR-4968)', async () => {
    installWorkLinkStore(createTestDb());
    try {
      // The runtime's own id for S1 differs from the request's, so the edge must name it.
      const internalId = '00000000-0000-4000-8000-internal00002';
      fakeRuntime.getInternalSessionId.mockReturnValue(internalId);
      fakeRuntime.forkSession.mockResolvedValue(FORKED);

      const res = await request(server).post(`/api/sessions/${S1}/fork`).send({});
      expect(res.status).toBe(201);
      expect(getWorkLinkStore()!.from({ kind: 'chat', id: FORKED.id })).toEqual([
        expect.objectContaining({ relation: 'forked_from', to: { kind: 'chat', id: internalId } }),
      ]);
    } finally {
      uninstallWorkLinkStore();
    }
  });

  it.each([
    [
      '404 session_not_found when the session is not found',
      () => fakeRuntime.forkSession.mockResolvedValue(null),
      404,
      'session_not_found',
    ],
    [
      '500 internal_error when the runtime throws',
      () => fakeRuntime.forkSession.mockRejectedValue(new Error('SDK crash')),
      500,
      'internal_error',
    ],
  ])('returns %s', async (_case, arrange, status, code) => {
    arrange();
    const res = await request(server).post(`/api/sessions/${S1}/fork`).send({});
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });
});
