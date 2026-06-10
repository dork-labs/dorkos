import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import type { PendingInteractionDTO } from '@dorkos/shared/types';
import { createApp } from '../../app.js';
import { pendingInteractionToStreamEvent } from '../../lib/pending-interaction-events.js';
import {
  handleToolApproval,
  type InteractiveSession,
} from '../../services/runtimes/claude-code/messaging/interactive-handlers.js';
import { listPendingInteractions } from '../../services/runtimes/claude-code/messaging/pending-interactions.js';
import { SESSIONS } from '../../config/constants.js';

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

describe('GET /api/sessions/:id/pending-interactions', () => {
  it('returns 200 with the active approval interaction and its remainingMs', async () => {
    // Purpose: happy path — Path A re-presents a live approval prompt with the
    // server-authoritative remainingMs so a (re)entering client can rebuild the
    // Approve/Deny card and resume the countdown without resetting it.
    fakeRuntime.hasSession.mockReturnValue(true);
    const dto = {
      type: 'approval' as const,
      id: 'tc-1',
      startedAt: 1_700_000_000_000,
      remainingMs: 540_000,
      toolName: 'Bash',
      input: 'mkdir /tmp/foo',
      hasSuggestions: false,
    };
    fakeRuntime.getPendingInteractions.mockReturnValue([dto]);

    const res = await request(app).get(`/api/sessions/${SESSION_ID}/pending-interactions`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ interactions: [dto] });
    expect(fakeRuntime.getPendingInteractions).toHaveBeenCalledWith(SESSION_ID);
  });

  it('returns 200 with an empty list for a known session with nothing pending', async () => {
    // Purpose: empty case — a known, idle session recovers no cards (must be a
    // benign 200, not a 404, so mount-time recovery stays silent).
    fakeRuntime.hasSession.mockReturnValue(true);
    fakeRuntime.getPendingInteractions.mockReturnValue([]);

    const res = await request(app).get(`/api/sessions/${SESSION_ID}/pending-interactions`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ interactions: [] });
  });

  it('returns 404 SESSION_NOT_FOUND for an unknown session id', async () => {
    // Purpose: post-restart/unknown case — the active query (and its pending
    // map) is gone, so the session is unknown to the runtime; 404 is the
    // correct answer and the client treats it as "nothing to recover".
    fakeRuntime.hasSession.mockReturnValue(false);

    const res = await request(app).get(`/api/sessions/${SESSION_ID}/pending-interactions`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SESSION_NOT_FOUND');
    // Read-only guard: an unknown session never reaches the pending-map read.
    expect(fakeRuntime.getPendingInteractions).not.toHaveBeenCalled();
  });

  it('returns 200 with an active question interaction and its remainingMs', async () => {
    // Purpose: question type on Path A — Path B already re-emits all three types,
    // but the endpoint test only covered approvals. Pin that the pull path also
    // surfaces an AskUserQuestion DTO (keyed by id, carrying remainingMs and its
    // questions) so a (re)entering client can rebuild the question card on mount.
    fakeRuntime.hasSession.mockReturnValue(true);
    const dto = {
      type: 'question' as const,
      id: 'q-1',
      startedAt: 1_700_000_000_000,
      remainingMs: 300_000,
      questions: [
        {
          header: 'Pick one',
          question: 'Which option?',
          multiSelect: false,
          options: [{ label: 'A', description: 'Option A' }],
        },
      ],
    };
    fakeRuntime.getPendingInteractions.mockReturnValue([dto]);

    const res = await request(app).get(`/api/sessions/${SESSION_ID}/pending-interactions`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ interactions: [dto] });
  });

  it('returns 200 with an active elicitation interaction and its remainingMs', async () => {
    // Purpose: elicitation type on Path A — same coverage gap as questions. Pin
    // that the pull path surfaces an MCP elicitation DTO with remainingMs so a
    // recovered elicitation card is rebuilt on mount, matching Path B's
    // three-type re-emit coverage.
    fakeRuntime.hasSession.mockReturnValue(true);
    const dto = {
      type: 'elicitation' as const,
      id: 'el-1',
      startedAt: 1_700_000_000_000,
      remainingMs: 120_000,
      serverName: 'my-mcp',
      message: 'Provide your API key',
    };
    fakeRuntime.getPendingInteractions.mockReturnValue([dto]);

    const res = await request(app).get(`/api/sessions/${SESSION_ID}/pending-interactions`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ interactions: [dto] });
  });
});

describe('Path A endpoint through the REAL selector (selector→endpoint expiry)', () => {
  // These tests drive the GET /pending-interactions endpoint through the REAL
  // listPendingInteractions selector over a REAL session whose pending map was
  // populated by the REAL handleToolApproval handler — not a canned
  // FakeAgentRuntime DTO. This proves the remainingMs math + expiry exclusion
  // end-to-end across the HTTP layer (route → runtime.getPendingInteractions →
  // selector → InteractiveSession.pendingInteractions), so a regression in the
  // selector's clock math or its `remainingMs <= 0` exclusion would surface here,
  // not just in the isolated selector unit test. The canned-DTO endpoint tests
  // above prove the route contract; these prove the selector is actually wired
  // into that contract.

  /** Live AbortControllers whose handlers must be torn down after each test. */
  let controllers: AbortController[];

  /**
   * Seed a real pending approval into a fresh InteractiveSession via the real
   * handler, then point fakeRuntime.getPendingInteractions at the real selector
   * evaluated against an injectable `now`. Returns the session and a clock
   * setter so a test can advance time across the expiry boundary.
   */
  function seedRealApproval(toolCallId: string): {
    session: InteractiveSession;
    setNow: (now: number) => void;
    startedAt: number;
  } {
    const session: InteractiveSession = {
      pendingInteractions: new Map(),
      eventQueue: [],
    };
    const controller = new AbortController();
    controllers.push(controller);

    // handleToolApproval returns a Promise that only settles on
    // approve/deny/timeout/abort; we want only its side effect (registering the
    // pending interaction), so we deliberately do not await it. The abort in
    // afterEach settles it and clears the 10-minute timeout.
    void handleToolApproval(
      session,
      toolCallId,
      'Bash',
      { command: 'mkdir /tmp/foo' },
      {
        signal: controller.signal,
        toolUseID: toolCallId,
        title: 'Run command',
      }
    );

    const startedAt = session.pendingInteractions.get(toolCallId)?.startedAt ?? Date.now();

    let currentNow = startedAt;
    const setNow = (now: number) => {
      currentNow = now;
    };
    fakeRuntime.hasSession.mockReturnValue(true);
    fakeRuntime.getPendingInteractions.mockImplementation(() =>
      listPendingInteractions(session, currentNow)
    );

    return { session, setNow, startedAt };
  }

  beforeEach(() => {
    controllers = [];
  });

  afterEach(() => {
    // Settle the dangling handler promises and clear their 10-minute timeouts.
    for (const c of controllers) c.abort();
  });

  it('includes a live interaction with the selector-computed remainingMs', async () => {
    // Purpose: prove the endpoint returns the REAL selector's remainingMs (not a
    // canned value). With now one minute past startedAt, remainingMs must equal
    // the full timeout minus one minute — the selector's arithmetic, observed
    // through the HTTP response.
    const { setNow, startedAt } = seedRealApproval('tc-live');
    setNow(startedAt + 60_000);

    const res = await request(app).get(`/api/sessions/${SESSION_ID}/pending-interactions`);

    expect(res.status).toBe(200);
    expect(res.body.interactions).toHaveLength(1);
    const dto = res.body.interactions[0] as PendingInteractionDTO;
    expect(dto.id).toBe('tc-live');
    expect(dto.type).toBe('approval');
    expect(dto.startedAt).toBe(startedAt);
    expect(dto.remainingMs).toBe(SESSIONS.INTERACTION_TIMEOUT_MS - 60_000);
  });

  it('excludes the interaction once now reaches the exact expiry boundary', async () => {
    // Purpose: prove the `remainingMs <= 0` exclusion fires through the HTTP
    // layer. At exactly startedAt + timeout the entry's remainingMs is 0 and the
    // selector drops it — the endpoint must return an empty list, not a card
    // with remainingMs 0. This is the boundary the unit test pins, now proven
    // end-to-end so the route can never re-present an already-auto-denied prompt.
    const { setNow, startedAt } = seedRealApproval('tc-expired');
    setNow(startedAt + SESSIONS.INTERACTION_TIMEOUT_MS);

    const res = await request(app).get(`/api/sessions/${SESSION_ID}/pending-interactions`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ interactions: [] });
  });

  it('Path A DTO and Path B re-emit describe the same interaction identically', async () => {
    // Purpose: cross-path consistency. The pull DTO (Path A) and the re-emit
    // StreamEvent (Path B) are produced by two different code paths from the
    // SAME pending interaction. A reconnecting client may receive both (pull +
    // push) and upsert by id — so they MUST agree on identity, payload, and the
    // server-authoritative countdown, or the client would render two divergent
    // cards or reset the timer. Feed one real selector DTO into the Path B mapper
    // and assert the re-emit's routing field, toolName, input, startedAt, and
    // remainingMs match the Path A DTO exactly. Not previously covered: no test
    // compared the two paths' output for one fixture.
    const { setNow, startedAt } = seedRealApproval('tc-shared');
    setNow(startedAt + 30_000);

    const res = await request(app).get(`/api/sessions/${SESSION_ID}/pending-interactions`);
    const dtoA = res.body.interactions[0] as PendingInteractionDTO;

    const eventB = pendingInteractionToStreamEvent(dtoA);

    expect(eventB.type).toBe('approval_required');
    // Path B mirrors dto.id onto the routing field; everything else is shared.
    expect(eventB.data).toMatchObject({
      toolCallId: dtoA.id,
      toolName: dtoA.type === 'approval' ? dtoA.toolName : undefined,
      input: dtoA.type === 'approval' ? dtoA.input : undefined,
      startedAt: dtoA.startedAt,
      remainingMs: dtoA.remainingMs,
    });
    // The countdown must be identical across paths — the load-bearing guarantee
    // that an upsert from either path never resets the timer.
    expect((eventB.data as { remainingMs: number }).remainingMs).toBe(dtoA.remainingMs);
  });
});
