import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { FakeAgentRuntime } from '@dorkos/test-utils';

// Mock boundary before importing app
vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
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
    getSessionSettings: vi.fn(async () => null),
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

import request from 'supertest';
import { createApp, finalizeApp } from '../../app.js';
import {
  getOrCreateProjector,
  disposeProjector,
} from '../../services/session/session-state-projector.js';
import { collectTriggeredTurn } from './helpers/trigger-turn-helpers.js';

const app = createApp();
finalizeApp(app);

/** Valid UUID for session ID params (routes validate UUID format). */
const SESSION_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  fakeRuntime.ensureSession.mockImplementation(() => {});
  fakeRuntime.acquireLock.mockReturnValue(true);
  fakeRuntime.isLocked.mockReturnValue(false);
  fakeRuntime.getLockInfo.mockReturnValue(null);
  fakeRuntime.hasSession.mockReturnValue(true);
  // For an existing session the canonical id equals the request id.
  fakeRuntime.getInternalSessionId.mockReturnValue(SESSION_ID);
  // The fake delegates snapshot/subscribe to the REAL projector registry (the
  // single delivery path), exactly as ClaudeCodeRuntime does — so a triggered
  // turn fed into the projector by the POST is read back on GET /events.
  fakeRuntime.getSessionSnapshot.mockImplementation((_ctx, sessionId) =>
    getOrCreateProjector(sessionId).buildSnapshot(async () => [])
  );
  fakeRuntime.subscribeSession = vi.fn((_ctx, sessionId, sinceCursor, signal) =>
    getOrCreateProjector(sessionId).subscribe(sinceCursor, signal)
  );
});

afterEach(() => {
  // The projector registry is a module singleton — drop this session's projector
  // so seq counters and buffered events do not leak across tests.
  disposeProjector(SESSION_ID);
});

// Migrated from the legacy in-band SSE-streaming contract (ADR-0264): the POST
// is now trigger-only, so these assert the turn surfaces on GET /:id/events
// (the single delivery path), NOT on the POST response.
describe('POST /api/sessions/:id/messages (trigger-only)', () => {
  it('delivers session_status → text_delta → turn_end on the durable stream, in order', async () => {
    // Purpose: migration safety / single delivery path — the route projects
    // StreamEvents through the projector and they replay on /events in order.
    fakeRuntime.withScenarios([
      async function* () {
        yield {
          type: 'session_status',
          data: { status: 'running', model: 'claude-haiku-4-5' },
        } as StreamEvent;
        yield { type: 'text_delta', data: { text: 'Hello' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const frames = await collectTriggeredTurn(app, SESSION_ID, 'Hello');

    const types = frames.map((f) => (f.data as SessionEvent).type);
    expect(types).toContain('turn_start');
    expect(types).toContain('text_delta');
    expect(types.at(-1)).toBe('turn_end');
  });

  it('projects tool_call → tool_result so the durable stream carries them', async () => {
    // Purpose: tool-call events survive the projector normalization and reach
    // /events, matching what the React client renders as ToolCallCard.
    fakeRuntime.withScenarios([
      async function* () {
        yield {
          type: 'session_status',
          data: { status: 'running', model: 'claude-haiku-4-5' },
        } as StreamEvent;
        yield {
          type: 'tool_call_start',
          data: { toolCallId: 'tc-1', toolName: 'Bash', input: {} },
        } as StreamEvent;
        yield { type: 'tool_call_end', data: { toolCallId: 'tc-1' } } as StreamEvent;
        yield { type: 'text_delta', data: { text: 'Done.' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const frames = await collectTriggeredTurn(app, SESSION_ID, 'Run a tool');

    const types = frames.map((f) => (f.data as SessionEvent).type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
  });

  it('returns 409 when session is locked by another client', async () => {
    // Purpose: regression — a locked session is rejected with 409 and the lock
    // info, before any turn is started.
    fakeRuntime.acquireLock.mockReturnValue(false);
    fakeRuntime.isLocked.mockReturnValue(true);
    fakeRuntime.getLockInfo.mockReturnValue({ clientId: 'other-client', acquiredAt: Date.now() });

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'Hello' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SESSION_LOCKED');
    expect(fakeRuntime.sendMessage).not.toHaveBeenCalled();
  });

  it('sendMessage is called with the correct session ID and content', async () => {
    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'test message' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ sessionId: SESSION_ID });
    expect(fakeRuntime.sendMessage).toHaveBeenCalledWith(
      SESSION_ID,
      'test message',
      expect.any(Object)
    );
  });
});
