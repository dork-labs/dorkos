import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const claudeSubagents = [{ name: 'researcher', description: 'Deep research assistant' }];
const testModeSubagents = [{ name: 'test-runner', description: 'Deterministic fixture runner' }];

const claudeRuntime = {
  type: 'claude-code',
  getSupportedSubagents: vi.fn(async () => claudeSubagents),
};
const testModeRuntime = {
  type: 'test-mode',
  getSupportedSubagents: vi.fn(async () => testModeSubagents),
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

describe('Subagents Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/subagents with no sessionId falls back to default runtime (cold discovery)', async () => {
    const res = await request(app).get('/api/subagents');
    expect(res.status).toBe(200);
    expect(res.body.subagents).toEqual(claudeSubagents);
    expect(runtimeRegistry.getDefault).toHaveBeenCalledOnce();
    expect(runtimeRegistry.resolveForSession).not.toHaveBeenCalled();
  });

  it('GET /api/subagents?sessionId=<claude-session> resolves the claude-code runtime', async () => {
    const res = await request(app).get(`/api/subagents?sessionId=${CLAUDE_SESSION}`);
    expect(res.status).toBe(200);
    expect(res.body.subagents).toEqual(claudeSubagents);
    expect(runtimeRegistry.resolveForSession).toHaveBeenCalledWith(CLAUDE_SESSION);
    expect(runtimeRegistry.getDefault).not.toHaveBeenCalled();
  });

  it('GET /api/subagents?sessionId=<test-mode-session> resolves the test-mode runtime', async () => {
    const res = await request(app).get(`/api/subagents?sessionId=${TEST_MODE_SESSION}`);
    expect(res.status).toBe(200);
    expect(res.body.subagents).toEqual(testModeSubagents);
    expect(runtimeRegistry.resolveForSession).toHaveBeenCalledWith(TEST_MODE_SESSION);
    expect(runtimeRegistry.getDefault).not.toHaveBeenCalled();
  });
});
