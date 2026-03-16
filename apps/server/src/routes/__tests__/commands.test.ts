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
  watchSession: vi.fn(() => () => {}),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  isLocked: vi.fn(() => false),
  getLockInfo: vi.fn(),
  getSupportedModels: vi.fn().mockResolvedValue([]),
  getCapabilities: vi.fn(() => ({
    type: 'claude-code',
    supportsPermissionModes: true,
    supportsToolApproval: true,
    supportsCostTracking: true,
    supportsResume: true,
    supportsMcp: true,
    supportsQuestionPrompt: true,
  })),
  getInternalSessionId: vi.fn(),
  getCommands: mockGetCommands,
  checkSessionHealth: vi.fn(),
};

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => mockRuntime),
    get: vi.fn(() => mockRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'claude-code'),
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { validateBoundary, BoundaryError } from '../../lib/boundary.js';

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
});
