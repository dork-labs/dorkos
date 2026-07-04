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

// Mock runtime that satisfies the AgentRuntime interface methods used by commands.ts
const mockGetCommands = vi.fn();
const mockTestModeGetCommands = vi.fn();
const mockRuntime = {
  type: 'claude-code',
  ensureSession: vi.fn(),
  hasSession: vi.fn(() => false),
  updateSession: vi.fn(() => true),
  sendMessage: vi.fn(),
  approveTool: vi.fn(),
  submitAnswers: vi.fn(() => true),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getMessageHistory: vi.fn(),
  getSessionTasks: vi.fn().mockResolvedValue([]),
  getSessionETag: vi.fn().mockResolvedValue(null),
  readFromOffset: vi.fn().mockResolvedValue({ content: '', newOffset: 0 }),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  isLocked: vi.fn(() => false),
  getLockInfo: vi.fn(),
  getSupportedModels: vi.fn().mockResolvedValue([]),
  getCapabilities: vi.fn(() => ({
    type: 'claude-code',
    supportsToolApproval: true,
    supportsCostTracking: true,
    supportsResume: true,
    supportsMcp: true,
    supportsQuestionPrompt: true,
    supportsPlugins: true,
    permissionModes: {
      supported: true,
      values: [
        { id: 'default', label: 'Default' },
        { id: 'plan', label: 'Plan' },
      ],
    },
    features: {},
  })),
  getInternalSessionId: vi.fn(),
  getCommands: mockGetCommands,
  checkSessionHealth: vi.fn(),
};

const mockTestModeRuntime = {
  type: 'test-mode',
  getCommands: mockTestModeGetCommands,
};

const mockCodexGetCommands = vi.fn();
const mockCodexRuntime = {
  type: 'codex',
  getCommands: mockCodexGetCommands,
};

const RUNTIMES: Record<string, { type: string; getCommands: typeof mockGetCommands }> = {
  'claude-code': mockRuntime as unknown as { type: string; getCommands: typeof mockGetCommands },
  'test-mode': mockTestModeRuntime,
  codex: mockCodexRuntime,
};

const CLAUDE_SESSION = '11111111-1111-4111-8111-111111111111';
const TEST_MODE_SESSION = '22222222-2222-4222-8222-222222222222';
// A brand-new session with no `session_metadata` row: resolveForSession would
// INFER claude-code for it, so an explicit `?runtime=` is the only correct path.
const ROWLESS_SESSION = '33333333-3333-4333-8333-333333333333';

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => mockRuntime),
    has: vi.fn((type: string) => type in RUNTIMES),
    get: vi.fn((type: string) => RUNTIMES[type] ?? mockRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'claude-code'),
    // Row-less sessions infer claude-code (the production behavior we must NOT
    // rely on when the caller knows the runtime).
    resolveForSession: vi.fn(async (sessionId: string) => {
      if (sessionId === TEST_MODE_SESSION) return mockTestModeRuntime;
      return mockRuntime;
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
import { validateBoundary, BoundaryError } from '../../lib/boundary.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';

const app = createApp();

describe('Commands Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/commands', () => {
    it('returns cached commands', async () => {
      const registry = {
        commands: [
          {
            namespace: 'daily',
            command: 'plan',
            fullCommand: '/daily:plan',
            description: 'Plan day',
            filePath: 'x.md',
          },
        ],
        lastScanned: '2024-01-01T00:00:00.000Z',
      };
      mockGetCommands.mockResolvedValue(registry);

      const res = await request(app).get('/api/commands');
      expect(res.status).toBe(200);
      expect(res.body.commands).toHaveLength(1);
      expect(res.body.commands[0].fullCommand).toBe('/daily:plan');
      expect(mockGetCommands).toHaveBeenCalledWith(false, undefined);
    });

    it('passes refresh=true to registry', async () => {
      mockGetCommands.mockResolvedValue({ commands: [], lastScanned: '2024-01-01' });

      const res = await request(app).get('/api/commands?refresh=true');
      expect(res.status).toBe(200);
      expect(mockGetCommands).toHaveBeenCalledWith(true, undefined);
    });

    it('returns empty when no commands exist', async () => {
      mockGetCommands.mockResolvedValue({ commands: [], lastScanned: '2024-01-01' });

      const res = await request(app).get('/api/commands');
      expect(res.status).toBe(200);
      expect(res.body.commands).toEqual([]);
    });
  });

  describe('schema validation for SDK-only commands', () => {
    it('accepts commands with optional namespace, command, and filePath', async () => {
      const registry = {
        commands: [
          { fullCommand: '/compact', description: 'Compact conversation history' },
          { fullCommand: '/help', description: 'Show help', argumentHint: '[topic]' },
        ],
        lastScanned: '2024-01-01T00:00:00.000Z',
      };
      mockGetCommands.mockResolvedValue(registry);

      const res = await request(app).get('/api/commands');
      expect(res.status).toBe(200);
      expect(res.body.commands).toHaveLength(2);
      expect(res.body.commands[0]).toEqual({
        fullCommand: '/compact',
        description: 'Compact conversation history',
      });
    });

    it('accepts mixed commands with and without filesystem metadata', async () => {
      const registry = {
        commands: [
          { fullCommand: '/compact', description: 'Compact conversation history' },
          {
            namespace: 'daily',
            command: 'plan',
            fullCommand: '/daily:plan',
            description: 'Plan day',
            filePath: '.claude/commands/daily/plan.md',
            allowedTools: ['Read', 'Write'],
          },
        ],
        lastScanned: '2024-01-01T00:00:00.000Z',
      };
      mockGetCommands.mockResolvedValue(registry);

      const res = await request(app).get('/api/commands');
      expect(res.status).toBe(200);
      expect(res.body.commands[0].namespace).toBeUndefined();
      expect(res.body.commands[1].namespace).toBe('daily');
      expect(res.body.commands[1].allowedTools).toEqual(['Read', 'Write']);
    });
  });

  describe('boundary enforcement', () => {
    it('GET /api/commands rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get('/api/commands').query({ cwd: '/etc/shadow' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });
  });

  describe('session-scoped resolution', () => {
    it('falls back to default runtime when no sessionId is provided (cold discovery)', async () => {
      mockGetCommands.mockResolvedValue({ commands: [], lastScanned: '2024-01-01' });

      const res = await request(app).get('/api/commands');
      expect(res.status).toBe(200);
      expect(runtimeRegistry.getDefault).toHaveBeenCalled();
      expect(runtimeRegistry.resolveForSession).not.toHaveBeenCalled();
    });

    it('resolves the claude-code runtime for a claude-code session', async () => {
      mockGetCommands.mockResolvedValue({ commands: [], lastScanned: '2024-01-01' });

      const res = await request(app).get('/api/commands').query({ sessionId: CLAUDE_SESSION });
      expect(res.status).toBe(200);
      expect(runtimeRegistry.resolveForSession).toHaveBeenCalledWith(CLAUDE_SESSION);
      expect(mockGetCommands).toHaveBeenCalled();
      expect(mockTestModeGetCommands).not.toHaveBeenCalled();
    });

    it('resolves the test-mode runtime for a test-mode session', async () => {
      mockTestModeGetCommands.mockResolvedValue({
        commands: [{ fullCommand: '/test-mode-cmd', description: 'Test-mode command' }],
        lastScanned: '2024-01-01',
      });

      const res = await request(app).get('/api/commands').query({ sessionId: TEST_MODE_SESSION });
      expect(res.status).toBe(200);
      expect(res.body.commands).toHaveLength(1);
      expect(res.body.commands[0].fullCommand).toBe('/test-mode-cmd');
      expect(runtimeRegistry.resolveForSession).toHaveBeenCalledWith(TEST_MODE_SESSION);
      expect(mockTestModeGetCommands).toHaveBeenCalled();
      expect(mockGetCommands).not.toHaveBeenCalled();
    });
  });

  describe('runtime-scoped resolution', () => {
    it('resolves the explicit runtime without inferring from a row-less session', async () => {
      // A row-less Codex session: `resolveForSession` would infer claude-code and
      // wrongly return Claude's commands. The explicit `runtime` param must win
      // and short-circuit session resolution entirely.
      mockCodexGetCommands.mockResolvedValue({
        commands: [{ fullCommand: '/codex-skill', description: 'Codex project skill' }],
        lastScanned: '2024-01-01',
      });

      const res = await request(app)
        .get('/api/commands')
        .query({ runtime: 'codex', sessionId: ROWLESS_SESSION });

      expect(res.status).toBe(200);
      expect(res.body.commands).toHaveLength(1);
      expect(res.body.commands[0].fullCommand).toBe('/codex-skill');
      expect(runtimeRegistry.get).toHaveBeenCalledWith('codex');
      expect(mockCodexGetCommands).toHaveBeenCalled();
      expect(runtimeRegistry.resolveForSession).not.toHaveBeenCalled();
      expect(runtimeRegistry.getDefault).not.toHaveBeenCalled();
      expect(mockGetCommands).not.toHaveBeenCalled();
    });

    it('returns 400 for an unknown runtime', async () => {
      const res = await request(app).get('/api/commands').query({ runtime: 'bogus-runtime' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/unknown runtime/i);
      expect(runtimeRegistry.get).not.toHaveBeenCalled();
      expect(runtimeRegistry.resolveForSession).not.toHaveBeenCalled();
    });
  });
});
