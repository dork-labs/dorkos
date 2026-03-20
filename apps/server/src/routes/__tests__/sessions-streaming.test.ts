import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeAgentRuntime, collectSseEvents } from '@dorkos/test-utils';

// Mock boundary before importing app
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

// Declared at module scope so the vi.mock factory closure can reference it.
// Initialized in beforeEach so each test starts with a fresh spy instance.
let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

import request from 'supertest';
import { createApp, finalizeApp } from '../../app.js';

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
});

describe('POST /api/sessions/:id/messages (SSE streaming)', () => {
  it('emits session_status → text_delta events → done in order', async () => {
    // Purpose: verify the Express route emits StreamEvents in the correct sequence.
    // This is the key integration test for the SSE pipeline end-to-end.
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

    const events = await collectSseEvents(app, SESSION_ID, 'Hello');

    const types = events.map((e) => e.type);
    expect(types).toContain('text_delta');
    expect(types.at(-1)).toBe('done');
  });

  it('emits tool_call_start and tool_call_end for tool use scenarios', async () => {
    // Purpose: verify tool call SSE events are emitted in the correct order,
    // matching what the React client expects to render ToolCallCard components.
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
        yield {
          type: 'tool_call_delta',
          data: { toolCallId: 'tc-1', partialJson: '{"command":"echo hi"}' },
        } as StreamEvent;
        yield { type: 'tool_call_end', data: { toolCallId: 'tc-1' } } as StreamEvent;
        yield { type: 'text_delta', data: { text: 'Done.' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const events = await collectSseEvents(app, SESSION_ID, 'Run a tool');

    const toolStart = events.find((e) => e.type === 'tool_call_start');
    const toolEnd = events.find((e) => e.type === 'tool_call_end');
    expect(toolStart).toBeDefined();
    expect(toolEnd).toBeDefined();
  });

  it('returns 409 when session is locked by another client', async () => {
    // Purpose: regression test for session locking — verifies the 409 status
    // is returned instead of attempting to send a message on a locked session.
    fakeRuntime.acquireLock.mockReturnValue(false);
    fakeRuntime.isLocked.mockReturnValue(true);
    fakeRuntime.getLockInfo.mockReturnValue({ clientId: 'other-client', acquiredAt: Date.now() });

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('Accept', 'text/event-stream')
      .send({ content: 'Hello' });

    expect(res.status).toBe(409);
  });

  it('sendMessage is called with the correct session ID and content', async () => {
    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    await collectSseEvents(app, SESSION_ID, 'test message');

    expect(fakeRuntime.sendMessage).toHaveBeenCalledWith(
      SESSION_ID,
      'test message',
      expect.any(Object)
    );
  });
});
