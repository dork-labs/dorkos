import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';

// Declared at module scope so the vi.mock factory closure can reference it.
// Initialized in beforeEach so each test starts with a fresh spy instance.
let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
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

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  },
}));

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(async () => null),
}));

// Mock the directory boundary so route handlers that call assertBoundary
// against the default cwd don't require initBoundary() at startup.
vi.mock('../../lib/boundary.js', () => ({
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

import request from 'supertest';
import { createApp } from '../../app.js';

const app = createApp();

/** Valid UUID for session ID params (routes validate UUID format). */
const SESSION_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
});

describe('POST /api/sessions/:id/submit-answers', () => {
  it('returns 200 when pending question exists', async () => {
    fakeRuntime.submitAnswers.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/submit-answers`)
      .send({ toolCallId: 'tc-1', answers: { '0': 'Option A' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(fakeRuntime.submitAnswers).toHaveBeenCalledWith(SESSION_ID, 'tc-1', {
      '0': 'Option A',
    });
  });

  it('returns 404 when session does not exist (submit-answers)', async () => {
    fakeRuntime.submitAnswers.mockReturnValue(false);
    fakeRuntime.hasSession.mockReturnValue(false);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/submit-answers`)
      .send({ toolCallId: 'tc-1', answers: { '0': 'Option A' } });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No pending question');
  });

  it('returns 409 when session exists but question already resolved', async () => {
    fakeRuntime.submitAnswers.mockReturnValue(false);
    fakeRuntime.hasSession.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/submit-answers`)
      .send({ toolCallId: 'tc-1', answers: { '0': 'Option A' } });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Interaction already resolved');
    expect(res.body.code).toBe('INTERACTION_ALREADY_RESOLVED');
  });

  it('returns 400 when toolCallId is missing', async () => {
    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/submit-answers`)
      .send({ answers: { '0': 'Option A' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
  });

  it('returns 400 when answers is missing', async () => {
    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/submit-answers`)
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
  });
});

describe('POST /api/sessions/:id/approve', () => {
  it('returns 200 when pending approval exists', async () => {
    fakeRuntime.approveTool.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(fakeRuntime.approveTool).toHaveBeenCalledWith(SESSION_ID, 'tc-1', true, undefined);
  });

  it('returns 404 when session does not exist (approve)', async () => {
    fakeRuntime.approveTool.mockReturnValue(false);
    fakeRuntime.hasSession.mockReturnValue(false);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No pending approval');
  });

  it('returns 409 when session exists but approval already resolved', async () => {
    fakeRuntime.approveTool.mockReturnValue(false);
    fakeRuntime.hasSession.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Interaction already resolved');
    expect(res.body.code).toBe('INTERACTION_ALREADY_RESOLVED');
  });
});

describe('POST /api/sessions/:id/deny', () => {
  it('returns 200 when pending approval exists', async () => {
    fakeRuntime.approveTool.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/deny`)
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(fakeRuntime.approveTool).toHaveBeenCalledWith(SESSION_ID, 'tc-1', false);
  });
});

describe('single-resolve guard — stale/duplicate answers are a benign no-op', () => {
  // These tests lock in the double-resolution safety property that makes the
  // recovery feature correct: when multiple surfaces (Path A pull, Path B
  // re-emit, a backgrounded tab, a stale Slack click) can each submit an answer
  // for the same interaction, only the FIRST submit may resolve the blocked SDK
  // `canUseTool` promise. The store deletes the pending entry on first resolve,
  // so every later submit looks up nothing → returns false → the route reports a
  // benign 409 (session still live) or 404 (session gone). The SDK callback can
  // never fire twice, so a tool is never executed twice.

  it('first /approve resolves (200); a second /approve for the same id is 409 with no double-resolve', async () => {
    // Purpose: no double tool-execution from a duplicate/stale answer. Model the
    // runtime's single-resolve semantics — approveTool returns true once (the
    // real entry is found and its resolve closure deletes it), then false on
    // every subsequent call (the entry is gone). The route must surface the
    // first as success and the stale second as 409 INTERACTION_ALREADY_RESOLVED.
    fakeRuntime.hasSession.mockReturnValue(true);
    fakeRuntime.approveTool.mockReturnValueOnce(true).mockReturnValue(false);

    const first = await request(app)
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .send({ toolCallId: 'tc-1' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });

    const second = await request(app)
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .send({ toolCallId: 'tc-1' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('INTERACTION_ALREADY_RESOLVED');

    // Exactly-once semantics: the route forwarded both calls to the runtime, but
    // only the first returned true. The guard — not a re-entrant SDK callback —
    // is what makes the second inert. (The store's delete-on-resolve guarantees
    // the underlying `resolve` closure ran at most once.)
    expect(fakeRuntime.approveTool).toHaveBeenCalledTimes(2);
    expect(fakeRuntime.approveTool.mock.results[0].value).toBe(true);
    expect(fakeRuntime.approveTool.mock.results[1].value).toBe(false);
  });

  it('cross-surface: /deny resolves first, then a stale /approve for the same id is 409 (no double-resolve)', async () => {
    // Purpose: cross-surface stale answer inert. A user denies on one surface
    // (e.g. the live card) and a different surface (a recovered card, a queued
    // Slack click) then approves the same id. The deny resolved and deleted the
    // entry, so the later approve finds nothing → 409, and the agent only ever
    // saw the deny.
    fakeRuntime.hasSession.mockReturnValue(true);
    // deny → first approveTool(…, false) returns true; the subsequent approve
    // call finds the entry already gone and returns false.
    fakeRuntime.approveTool.mockReturnValueOnce(true).mockReturnValue(false);

    const denied = await request(app)
      .post(`/api/sessions/${SESSION_ID}/deny`)
      .send({ toolCallId: 'tc-1' });
    expect(denied.status).toBe(200);
    expect(denied.body).toEqual({ ok: true });

    const staleApprove = await request(app)
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .send({ toolCallId: 'tc-1' });
    expect(staleApprove.status).toBe(409);
    expect(staleApprove.body.code).toBe('INTERACTION_ALREADY_RESOLVED');

    // First call was the deny (approved=false), second the stale approve.
    expect(fakeRuntime.approveTool).toHaveBeenNthCalledWith(1, SESSION_ID, 'tc-1', false);
    expect(fakeRuntime.approveTool).toHaveBeenNthCalledWith(2, SESSION_ID, 'tc-1', true, undefined);
    expect(fakeRuntime.approveTool.mock.results[1].value).toBe(false);
  });

  it('cross-surface stale answer on a session that has since ended is 404, not 409', async () => {
    // Purpose: post-restart safety. If the session itself is gone (server
    // restart dropped the in-memory pending map, or the query ended), a stale
    // answer must report 404 NO_PENDING_APPROVAL rather than 409 — the client
    // treats both as "already handled", but the distinct code keeps the contract
    // honest about whether the session still exists.
    fakeRuntime.approveTool.mockReturnValue(false);
    fakeRuntime.hasSession.mockReturnValue(false);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No pending approval');
    expect(res.body.code).toBe('NO_PENDING_APPROVAL');
  });

  it('stale /submit-answers after the question resolved is 409 (no double-resolve)', async () => {
    // Purpose: the same single-resolve guard covers AskUserQuestion, so a
    // duplicate answer submission never re-injects answers into a resolved
    // question. First submit resolves (true), the stale second finds nothing
    // (false) → 409.
    fakeRuntime.hasSession.mockReturnValue(true);
    fakeRuntime.submitAnswers.mockReturnValueOnce(true).mockReturnValue(false);

    const first = await request(app)
      .post(`/api/sessions/${SESSION_ID}/submit-answers`)
      .send({ toolCallId: 'tc-1', answers: { '0': 'Option A' } });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/sessions/${SESSION_ID}/submit-answers`)
      .send({ toolCallId: 'tc-1', answers: { '0': 'Option A' } });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('INTERACTION_ALREADY_RESOLVED');
    expect(fakeRuntime.submitAnswers).toHaveBeenCalledTimes(2);
  });

  it('stale /submit-elicitation after the elicitation resolved is 409 (no double-resolve)', async () => {
    // Purpose: the guard also covers MCP elicitations, so a duplicate response
    // never resolves a closed elicitation a second time. First submit resolves
    // (true), the stale second finds nothing (false) → 409.
    fakeRuntime.hasSession.mockReturnValue(true);
    fakeRuntime.submitElicitation.mockReturnValueOnce(true).mockReturnValue(false);

    const first = await request(app)
      .post(`/api/sessions/${SESSION_ID}/submit-elicitation`)
      .send({ interactionId: 'el-1', action: 'accept', content: { apiKey: 'x' } });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/sessions/${SESSION_ID}/submit-elicitation`)
      .send({ interactionId: 'el-1', action: 'accept', content: { apiKey: 'x' } });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('INTERACTION_ALREADY_RESOLVED');
    expect(fakeRuntime.submitElicitation).toHaveBeenCalledTimes(2);
  });

  it('stale /deny on a session that has since ended is 404 NO_PENDING_APPROVAL, not 409', async () => {
    // Purpose: completes the single-resolve matrix for the deny verb. The
    // existing cross-surface test covers deny→stale-approve (409); this pins the
    // post-restart branch — when the session itself is gone (in-memory pending
    // map dropped), a stale /deny must report 404 NO_PENDING_APPROVAL, the same
    // session-gone code the approve verb returns, keeping the two verbs
    // contract-symmetric. Not previously covered: no /deny test exercised the
    // hasSession=false branch.
    fakeRuntime.approveTool.mockReturnValue(false);
    fakeRuntime.hasSession.mockReturnValue(false);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/deny`)
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No pending approval');
    expect(res.body.code).toBe('NO_PENDING_APPROVAL');
  });

  it('stale /submit-elicitation on a session that has since ended is 404 NO_PENDING_ELICITATION, not 409', async () => {
    // Purpose: completes the single-resolve matrix for elicitations. The stale
    // (409) branch is covered above; this pins the session-gone (404) branch so
    // all three resolve verbs (approve/deny, submit-answers, submit-elicitation)
    // have BOTH the stale→409 and gone→404 cases. Without this, a recovered
    // elicitation card clicked after a restart could surface an ambiguous status.
    fakeRuntime.submitElicitation.mockReturnValue(false);
    fakeRuntime.hasSession.mockReturnValue(false);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/submit-elicitation`)
      .send({ interactionId: 'el-1', action: 'accept', content: { apiKey: 'x' } });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No pending elicitation');
    expect(res.body.code).toBe('NO_PENDING_ELICITATION');
  });
});
