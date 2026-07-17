/**
 * Route tests for `POST /api/sessions/:id/command-intents/:intent` (DOR-109
 * task 2.5). Drives the runtime-fulfilled command-intent trigger end to end with
 * a `FakeAgentRuntime` and asserts the three contract branches: a supported
 * runtime returns 202, drives `executeCommandIntent`, and the resulting
 * `compact_boundary` reaches the durable projector and is observable on the
 * `/events` stream (`collectDurableEvents`); an unsupported runtime returns an
 * honest 422 WITHOUT calling the adapter; and an unknown `:intent` returns 422.
 * Mocking preamble mirrors `sessions-events.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAgentRuntime, collectDurableEvents } from '@dorkos/test-utils';

// Mock the directory boundary so the /events handler's assertBoundary against
// the default cwd doesn't require initBoundary() at startup (mirrors
// sessions-events.test.ts).
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

// Declared at module scope so the vi.mock factory closure can reference it;
// initialized in beforeEach so each test starts with a fresh spy instance.
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
  peekProjector,
  disposeProjector,
} from '../../services/session/session-state-projector.js';

const app = createApp();
finalizeApp(app);

/** Valid UUID for session ID params (routes validate UUID format). */
const SESSION_ID = '00000000-0000-4000-8000-0000000000c1';

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  // A compact operates on live context, so the handler's existence probe must
  // pass: report the session as present.
  fakeRuntime.hasSession.mockReturnValue(true);
  // Route /events through the SAME per-session projector the trigger feeds
  // (mirrors TestModeRuntime.subscribeSession), so collectDurableEvents observes
  // the boundary the adapter produced — the fake's default stub yields nothing.
  fakeRuntime.subscribeSession = vi.fn((ctx, sessionId, sinceCursor, signal) =>
    getOrCreateProjector(sessionId, ctx.cwd).subscribe(sinceCursor, signal)
  );
});

afterEach(() => {
  disposeProjector(SESSION_ID);
});

describe('POST /api/sessions/:id/command-intents/:intent', () => {
  it('supported runtime → 202, drives executeCommandIntent, compact_boundary reaches /events', async () => {
    // The happy path: the fake declares commandIntents.compact.supported (its
    // executeCommandIntent yields a synthetic compact_boundary), so the route
    // accepts the trigger, drives the adapter through the durable projector, and
    // the boundary is replayable on the single delivery path (/events).
    const res = await request(app).post(`/api/sessions/${SESSION_ID}/command-intents/compact`);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ sessionId: SESSION_ID });
    expect(fakeRuntime.executeCommandIntent).toHaveBeenCalledWith(
      SESSION_ID,
      'compact',
      expect.objectContaining({ cwd: expect.any(String) })
    );

    // Wait for the detached run to settle so the replay below is deterministic.
    await vi.waitFor(() => {
      expect(peekProjector(SESSION_ID)?.getStatus().lifecycle).toBe('idle');
    });

    // Resume connect (?after=0) replays the run from the buffer — no snapshot —
    // so the projected boundary is observable on the durable stream.
    const collected = await collectDurableEvents(app, SESSION_ID, {
      after: 0,
      until: (frames) => frames.some((f) => f.event === 'turn_end'),
    });
    const events = collected.frames.map((f) => f.event);
    expect(events).toContain('compact_boundary');
    expect(events).toContain('turn_end');
    expect(collected.frames.some((f) => f.event === 'snapshot')).toBe(false);
  });

  it('unsupported runtime → 422 COMMAND_INTENT_UNSUPPORTED and the adapter is NOT called', async () => {
    // Honest gating: a runtime that declares compact unsupported must surface a
    // 422 and never reach executeCommandIntent — the composer keeps the text on
    // the client; this is the server half of "never a silent no-op".
    const caps = fakeRuntime.getCapabilities();
    fakeRuntime.getCapabilities.mockReturnValue({
      ...caps,
      commandIntents: { compact: { supported: false } },
    });

    const res = await request(app).post(`/api/sessions/${SESSION_ID}/command-intents/compact`);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('COMMAND_INTENT_UNSUPPORTED');
    expect(fakeRuntime.executeCommandIntent).not.toHaveBeenCalled();
  });

  it('unknown :intent → 422 INVALID_COMMAND_INTENT and the adapter is NOT called', async () => {
    // A token that is not a runtime-fulfilled intent (e.g. a typo, or a
    // client-native intent that should never hit this route) is a client bug.
    const res = await request(app).post(`/api/sessions/${SESSION_ID}/command-intents/frobnicate`);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_COMMAND_INTENT');
    expect(fakeRuntime.executeCommandIntent).not.toHaveBeenCalled();
  });
});
