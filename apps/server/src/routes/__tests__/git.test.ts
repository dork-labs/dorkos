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

vi.mock('../../services/core/git-status.js', () => ({
  getGitStatus: vi.fn().mockResolvedValue({ branch: 'main', files: [] }),
}));

// Must also mock services imported by other routes in createApp
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

const app = createApp();

describe('Git Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('boundary enforcement', () => {
    it('GET /api/git/status rejects dir outside boundary with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get('/api/git/status').query({ dir: '/etc/shadow' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('GET /api/git/status rejects null byte paths with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Invalid path: null bytes not allowed', 'NULL_BYTE')
      );

      const res = await request(app).get('/api/git/status').query({ dir: '/tmp\0evil' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NULL_BYTE');
    });
  });
});
