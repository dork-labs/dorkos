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

// Mock the directory boundary so the persistent /stream handler (which calls
// assertBoundary against the default cwd) doesn't require initBoundary() at
// startup. Mirrors sessions-streaming.test.ts.
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
import type { StreamEvent } from '@dorkos/shared/types';
import { createApp } from '../../app.js';

const app = createApp();

/** Valid UUID for session ID params (routes validate UUID format). */
const SESSION_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Open the persistent sync stream (`GET /:id/stream`) and collect the SSE
 * frames it writes synchronously on connect (sync_connected + Path B re-emits),
 * then abort. The stream stays open via heartbeat, so we resolve after a short
 * idle window once the connect-time frames have landed and tear the socket down
 * so the test never hangs.
 *
 * @param sessionId - Target session UUID.
 * @returns Ordered StreamEvents parsed from the connect-time frames.
 */
async function collectStreamConnectEvents(sessionId: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];

  await new Promise<void>((resolve, reject) => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const req = request(app)
      .get(`/api/sessions/${sessionId}/stream`)
      .set('Accept', 'text/event-stream')
      .buffer(false)
      .parse((res, callback) => {
        let buffer = '';
        let currentType = '';
        const finish = () => {
          if (settled) return;
          settled = true;
          // Destroy the response socket directly to tear down the heartbeat-kept
          // stream. Errors from the closing socket are swallowed below so the
          // teardown never surfaces as an unhandled rejection.
          res.destroy();
          callback(null, events);
          resolve();
        };
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentType = line.slice(7).trim();
            } else if (line.startsWith('data: ') && currentType) {
              try {
                const data = JSON.parse(line.slice(6)) as unknown;
                events.push({ type: currentType, data } as StreamEvent);
              } catch {
                // Non-JSON SSE lines (e.g., comments) are ignored.
              }
              currentType = '';
            }
          }
          // Connect-time frames arrive in one burst; once a frame lands, wait a
          // short idle then tear down (heartbeat would otherwise keep us open).
          clearTimeout(idleTimer);
          idleTimer = setTimeout(finish, 50);
        });
        // Swallow the expected post-destroy socket error so it doesn't become an
        // unhandled exception.
        res.on('error', () => {});
      });
    // superagent surfaces the destroyed socket as a request-level error; ignore
    // it once we've already resolved, otherwise propagate a genuine failure.
    req.on('error', (err) => {
      if (settled) return;
      reject(err);
    });
    void req.end(() => {});
  });

  return events;
}

/** Build a non-expired approval DTO for re-emit tests. */
function approvalDto(overrides: Record<string, unknown> = {}) {
  return {
    type: 'approval' as const,
    id: 'tc-1',
    startedAt: 1_700_000_000_000,
    remainingMs: 540_000,
    toolName: 'Bash',
    input: JSON.stringify({ command: 'mkdir /tmp/foo' }),
    hasSuggestions: false,
    ...overrides,
  };
}

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
});

describe('GET /api/sessions/:id/stream — Path B re-emit on connect', () => {
  it('re-emits a pending approval as approval_required after sync_connected', async () => {
    // Purpose: Path B order + shape — on (re)subscribe the stream must first
    // send sync_connected, then replay the live approval as its native
    // approval_required event carrying remainingMs and toolCallId === dto.id, so
    // a reconnecting/backgrounded client rebuilds the Approve/Deny card with the
    // countdown resumed (not reset) and no manual refetch.
    const dto = approvalDto();
    fakeRuntime.getPendingInteractions.mockReturnValue([dto]);

    const events = await collectStreamConnectEvents(SESSION_ID);

    const connectedIdx = events.findIndex((e) => e.type === 'sync_connected');
    const approvalIdx = events.findIndex((e) => e.type === 'approval_required');
    expect(connectedIdx).toBeGreaterThanOrEqual(0);
    expect(approvalIdx).toBeGreaterThan(connectedIdx);

    const approval = events[approvalIdx];
    expect(approval.data).toMatchObject({
      toolCallId: dto.id,
      toolName: 'Bash',
      input: dto.input,
      remainingMs: 540_000,
      startedAt: dto.startedAt,
      hasSuggestions: false,
    });
    expect(fakeRuntime.getPendingInteractions).toHaveBeenCalledWith(SESSION_ID);
  });

  it('emits only sync_connected when there are no pending interactions', async () => {
    // Purpose: no false positives — an idle session must not surface any
    // spurious interaction card on connect; the default empty list yields
    // sync_connected alone.
    fakeRuntime.getPendingInteractions.mockReturnValue([]);

    const events = await collectStreamConnectEvents(SESSION_ID);

    expect(events.some((e) => e.type === 'sync_connected')).toBe(true);
    expect(
      events.some((e) =>
        ['approval_required', 'question_prompt', 'elicitation_prompt'].includes(e.type)
      )
    ).toBe(false);
  });

  it('re-emits a pending question as question_prompt with its toolCallId', async () => {
    // Purpose: question type on Path B — an AskUserQuestion prompt recovers as
    // question_prompt keyed by toolCallId so its card is rebuilt on reconnect.
    fakeRuntime.getPendingInteractions.mockReturnValue([
      {
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
      },
    ]);

    const events = await collectStreamConnectEvents(SESSION_ID);

    const question = events.find((e) => e.type === 'question_prompt');
    expect(question).toBeDefined();
    expect(question?.data).toMatchObject({
      toolCallId: 'q-1',
      remainingMs: 300_000,
      startedAt: 1_700_000_000_000,
    });
  });

  it('re-emits a pending elicitation as elicitation_prompt with its interactionId', async () => {
    // Purpose: elicitation type on Path B — an MCP elicitation recovers as
    // elicitation_prompt keyed by interactionId (the elicitation's routing
    // field) so its card is rebuilt on reconnect.
    fakeRuntime.getPendingInteractions.mockReturnValue([
      {
        type: 'elicitation' as const,
        id: 'el-1',
        startedAt: 1_700_000_000_000,
        remainingMs: 120_000,
        serverName: 'my-mcp',
        message: 'Provide your API key',
      },
    ]);

    const events = await collectStreamConnectEvents(SESSION_ID);

    const elicitation = events.find((e) => e.type === 'elicitation_prompt');
    expect(elicitation).toBeDefined();
    expect(elicitation?.data).toMatchObject({
      interactionId: 'el-1',
      serverName: 'my-mcp',
      message: 'Provide your API key',
      remainingMs: 120_000,
      startedAt: 1_700_000_000_000,
    });
  });

  it('re-emits only the live interactions returned by getPendingInteractions', async () => {
    // Purpose: expiry exclusion is owned by getPendingInteractions (which drops
    // remainingMs <= 0), so Path B re-emits exactly the list it is handed — an
    // already-expired/auto-denied interaction is never replayed. Returning a
    // single live DTO must yield exactly one interaction event.
    fakeRuntime.getPendingInteractions.mockReturnValue([approvalDto({ id: 'live-only' })]);

    const events = await collectStreamConnectEvents(SESSION_ID);

    const interactionEvents = events.filter((e) =>
      ['approval_required', 'question_prompt', 'elicitation_prompt'].includes(e.type)
    );
    expect(interactionEvents).toHaveLength(1);
    expect(interactionEvents[0].data).toMatchObject({ toolCallId: 'live-only' });
  });
});
