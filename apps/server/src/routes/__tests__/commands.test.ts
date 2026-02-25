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

vi.mock('../../services/core/command-registry.js', () => {
  const mockGetCommands = vi.fn();
  const mockInvalidateCache = vi.fn();
  return {
    CommandRegistryService: vi.fn().mockImplementation(() => ({
      getCommands: mockGetCommands,
      invalidateCache: mockInvalidateCache,
    })),
    __mockGetCommands: mockGetCommands,
  };
});

// Must also mock transcript-reader and agent-manager since createApp imports session routes
vi.mock('../../services/session/transcript-reader.js', () => ({
  transcriptReader: {
    listSessions: vi.fn(),
    getSession: vi.fn(),
    readTranscript: vi.fn(),
    listTranscripts: vi.fn(),
  },
}));

vi.mock('../../services/core/agent-manager.js', () => ({
  agentManager: {
    ensureSession: vi.fn(),
    sendMessage: vi.fn(),
    approveTool: vi.fn(),
    hasSession: vi.fn(),
    checkSessionHealth: vi.fn(),
    getSdkSessionId: vi.fn(),
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

// Get a reference to the mock function
const { __mockGetCommands: mockGetCommands } =
  (await import('../../services/core/command-registry.js')) as any;

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
      expect(mockGetCommands).toHaveBeenCalledWith(false);
    });

    it('passes refresh=true to registry', async () => {
      mockGetCommands.mockResolvedValue({ commands: [], lastScanned: '2024-01-01' });

      const res = await request(app).get('/api/commands?refresh=true');
      expect(res.status).toBe(200);
      expect(mockGetCommands).toHaveBeenCalledWith(true);
    });

    it('returns empty when no commands exist', async () => {
      mockGetCommands.mockResolvedValue({ commands: [], lastScanned: '2024-01-01' });

      const res = await request(app).get('/api/commands');
      expect(res.status).toBe(200);
      expect(res.body.commands).toEqual([]);
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
