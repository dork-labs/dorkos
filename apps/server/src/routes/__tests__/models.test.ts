import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// Per-runtime models: each runtime reports a distinct set, so a test that
// exercises routing asserts which runtime was selected.
const claudeModels = [
  {
    value: 'claude-sonnet-4-5-20250929',
    displayName: 'Sonnet 4.5',
    description: 'Claude default model',
  },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Claude high-capability' },
];
const testModeModels = [
  { value: 'test-mode-deterministic', displayName: 'Deterministic', description: 'Test runtime' },
];
const codexModels = [
  { value: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Codex flagship' },
  { value: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', description: 'Coding-optimized' },
];

const claudeRuntime = {
  type: 'claude-code',
  getSupportedModels: vi.fn(async () => claudeModels),
};
const testModeRuntime = {
  type: 'test-mode',
  getSupportedModels: vi.fn(async () => testModeModels),
};
const codexRuntime = {
  type: 'codex',
  getSupportedModels: vi.fn(async () => codexModels),
};

const RUNTIMES: Record<string, typeof claudeRuntime> = {
  'claude-code': claudeRuntime,
  'test-mode': testModeRuntime,
  codex: codexRuntime,
};

const CLAUDE_SESSION = '11111111-1111-4111-8111-111111111111';
const TEST_MODE_SESSION = '22222222-2222-4222-8222-222222222222';
// A brand-new session with no `session_metadata` row: resolveForSession would
// INFER claude-code for it, so an explicit `?runtime=` is the only correct path.
const ROWLESS_SESSION = '33333333-3333-4333-8333-333333333333';

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => claudeRuntime),
    getDefaultType: vi.fn(() => 'claude-code'),
    getAllCapabilities: vi.fn(() => ({})),
    has: vi.fn((type: string) => type in RUNTIMES),
    get: vi.fn((type: string) => RUNTIMES[type]),
    // Row-less sessions infer claude-code (the production behavior we must NOT
    // rely on when the caller knows the runtime).
    resolveForSession: vi.fn(async (sessionId: string) => {
      if (sessionId === TEST_MODE_SESSION) return testModeRuntime;
      return claudeRuntime;
    }),
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

import request from 'supertest';
import { createApp } from '../../app.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';

const app = createApp();

describe('Models Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/models with no sessionId falls back to default runtime (cold discovery)', async () => {
    const res = await request(app).get('/api/models');
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(claudeModels);
    expect(runtimeRegistry.getDefault).toHaveBeenCalledOnce();
    expect(runtimeRegistry.resolveForSession).not.toHaveBeenCalled();
  });

  it('GET /api/models?sessionId=<claude-session> resolves the claude-code runtime', async () => {
    const res = await request(app).get(`/api/models?sessionId=${CLAUDE_SESSION}`);
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(claudeModels);
    expect(runtimeRegistry.resolveForSession).toHaveBeenCalledWith(CLAUDE_SESSION);
    expect(runtimeRegistry.getDefault).not.toHaveBeenCalled();
  });

  it('GET /api/models?sessionId=<test-mode-session> resolves the test-mode runtime', async () => {
    const res = await request(app).get(`/api/models?sessionId=${TEST_MODE_SESSION}`);
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(testModeModels);
    expect(runtimeRegistry.resolveForSession).toHaveBeenCalledWith(TEST_MODE_SESSION);
    expect(runtimeRegistry.getDefault).not.toHaveBeenCalled();
  });

  it('GET /api/models?runtime=codex returns the codex catalog without inferring from the session', async () => {
    // A row-less Codex session: `resolveForSession` would infer claude-code and
    // wrongly return Anthropic models. The explicit `runtime` param must win and
    // short-circuit session resolution entirely.
    const res = await request(app).get(`/api/models?runtime=codex&sessionId=${ROWLESS_SESSION}`);
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(codexModels);
    expect(runtimeRegistry.get).toHaveBeenCalledWith('codex');
    expect(runtimeRegistry.resolveForSession).not.toHaveBeenCalled();
    expect(runtimeRegistry.getDefault).not.toHaveBeenCalled();
  });

  it('GET /api/models?runtime=<unknown> returns 400', async () => {
    const res = await request(app).get('/api/models?runtime=bogus-runtime');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown runtime/i);
    expect(runtimeRegistry.get).not.toHaveBeenCalled();
  });
});
