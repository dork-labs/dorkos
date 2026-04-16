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

const claudeRuntime = {
  type: 'claude-code',
  getSupportedModels: vi.fn(async () => claudeModels),
};
const testModeRuntime = {
  type: 'test-mode',
  getSupportedModels: vi.fn(async () => testModeModels),
};

const CLAUDE_SESSION = '11111111-1111-4111-8111-111111111111';
const TEST_MODE_SESSION = '22222222-2222-4222-8222-222222222222';

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => claudeRuntime),
    getDefaultType: vi.fn(() => 'claude-code'),
    getAllCapabilities: vi.fn(() => ({})),
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
});
