/**
 * The wire-boundary kickoff suppression seam (M4, agent-creation-redesign
 * contract item 6): `GET /api/sessions/:id/messages` must never serve the
 * auto-first-turn kickoff as a user message, for ANY runtime — the filter
 * lives at the route, not in per-runtime parsers. Exercised through two
 * differently-typed fake runtimes (standing in for codex/opencode, whose
 * stores keep the kickoff verbatim) plus the adversarial preservation cases:
 * genuine content that merely touches the marker must pass through the route
 * untouched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { wrapKickoff } from '@dorkos/shared/kickoff';

// Mock boundary before importing app (same pattern as sessions.test.ts)
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

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    listRuntimes: vi.fn(() => [fakeRuntime]),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    has: vi.fn(() => true),
    getSessionSettings: vi.fn(async () => null),
    saveSessionSettings: vi.fn(async () => {}),
    getSessionSettingsMany: vi.fn(() => new Map()),
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
import { runtimeRegistry } from '../../services/core/runtime-registry.js';

const app = createApp();
finalizeApp(app);

const S1 = '00000000-0000-4000-8000-000000000001';
const ENVELOPE = wrapKickoff('Read your SOUL.md and introduce yourself. Offer a first action.');
const GREETING = { id: 'a1', role: 'assistant' as const, content: "Hi — I'm Keeper." };

/** Point session resolution at a fake runtime of the given type. */
function useRuntime(type: string): FakeAgentRuntime {
  fakeRuntime = new FakeAgentRuntime(type);
  fakeRuntime.getSessionETag.mockResolvedValue(null);
  fakeRuntime.getInternalSessionId.mockReturnValue(undefined);
  vi.mocked(runtimeRegistry.resolveForSession).mockResolvedValue(fakeRuntime);
  return fakeRuntime;
}

describe('GET /api/sessions/:id/messages — kickoff suppression at the route (all runtimes)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRuntime('fake');
  });

  // The route path is runtime-agnostic by construction; exercising it with two
  // differently-typed runtimes pins that no per-runtime branch can leak the
  // kickoff (finding 2: codex/opencode stores keep it verbatim).
  it.each(['codex-like', 'opencode-like'])(
    'filters a kickoff envelope out of %s history',
    async (type) => {
      const rt = useRuntime(type);
      rt.getMessageHistory.mockResolvedValue([
        { id: 'kick', role: 'user', content: ENVELOPE },
        GREETING,
      ]);

      const res = await request(app).get(`/api/sessions/${S1}/messages`);

      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(1);
      expect(res.body.messages[0].role).toBe('assistant');
      expect(JSON.stringify(res.body)).not.toContain('dork-kickoff');
    }
  );

  it('filters a kickoff stored with prepended context blocks (ADR-0273)', async () => {
    const rt = useRuntime('codex-like');
    rt.getMessageHistory.mockResolvedValue([
      {
        id: 'kick',
        role: 'user',
        content: `<git_status>\nIs git repo: true\n</git_status>\n\n${ENVELOPE}`,
      },
      GREETING,
    ]);

    const res = await request(app).get(`/api/sessions/${S1}/messages`);

    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].role).toBe('assistant');
  });

  // Adversarial preservation at the wire: genuine content survives the route.
  it('serves a user message that only STARTS with the open tag', async () => {
    fakeRuntime.getMessageHistory.mockResolvedValue([
      { id: 'u1', role: 'user', content: '<dork-kickoff> what is this?' },
      GREETING,
    ]);

    const res = await request(app).get(`/api/sessions/${S1}/messages`);

    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0].content).toBe('<dork-kickoff> what is this?');
  });

  it('serves a user message that only ENDS with the close tag', async () => {
    fakeRuntime.getMessageHistory.mockResolvedValue([
      { id: 'u1', role: 'user', content: 'notes on fences ... </dork-kickoff>' },
      GREETING,
    ]);

    const res = await request(app).get(`/api/sessions/${S1}/messages`);

    expect(res.body.messages).toHaveLength(2);
  });

  it('serves an ASSISTANT message shaped like the envelope (role scope)', async () => {
    fakeRuntime.getMessageHistory.mockResolvedValue([
      { id: 'u1', role: 'user', content: 'hi' },
      { id: 'a1', role: 'assistant', content: ENVELOPE },
    ]);

    const res = await request(app).get(`/api/sessions/${S1}/messages`);

    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[1].content).toBe(ENVELOPE);
  });

  it('serves a full-envelope user paste later in the conversation (first-user-record scope)', async () => {
    fakeRuntime.getMessageHistory.mockResolvedValue([
      { id: 'u1', role: 'user', content: 'hello' },
      GREETING,
      { id: 'u2', role: 'user', content: ENVELOPE },
    ]);

    const res = await request(app).get(`/api/sessions/${S1}/messages`);

    expect(res.body.messages).toHaveLength(3);
  });
});
