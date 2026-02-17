import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock boundary module
const mockGetBoundary = vi.fn();
const mockValidateBoundary = vi.fn();
vi.mock('../../lib/boundary.js', () => ({
  getBoundary: (...args: unknown[]) => mockGetBoundary(...args),
  validateBoundary: (...args: unknown[]) => mockValidateBoundary(...args),
  BoundaryError: class BoundaryError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

// Mock fs/promises
const mockReaddir = vi.fn();
vi.mock('fs/promises', () => ({
  default: {
    realpath: vi.fn(),
    readdir: (...args: unknown[]) => mockReaddir(...args),
  },
  realpath: vi.fn(),
  readdir: (...args: unknown[]) => mockReaddir(...args),
}));

// Mock transcript-reader and agent-manager (required by createApp)
vi.mock('../../services/transcript-reader.js', () => ({
  transcriptReader: {
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn(),
    readTranscript: vi.fn(),
    readTasks: vi.fn(),
    listTranscripts: vi.fn(),
  },
}));

vi.mock('../../services/agent-manager.js', () => ({
  agentManager: {
    ensureSession: vi.fn(),
    sendMessage: vi.fn(),
    approveTool: vi.fn(),
    hasSession: vi.fn(),
    checkSessionHealth: vi.fn(),
    getSdkSessionId: vi.fn(),
    updateSession: vi.fn(),
    submitAnswers: vi.fn(),
  },
}));

vi.mock('../../services/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

import request from 'supertest';
import { createApp } from '../../app.js';

// Import the mocked BoundaryError for instanceof checks
import { BoundaryError } from '../../lib/boundary.js';

const app = createApp();
const BOUNDARY = '/Users/testuser';

describe('Directory Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBoundary.mockReturnValue(BOUNDARY);
  });

  describe('GET /api/directory', () => {
    it('returns directory listing for a valid path', async () => {
      const testPath = `${BOUNDARY}/projects`;
      mockValidateBoundary.mockResolvedValue(testPath);
      mockReaddir.mockResolvedValue([
        { name: 'app-a', isDirectory: () => true },
        { name: 'app-b', isDirectory: () => true },
        { name: 'readme.md', isDirectory: () => false },
      ]);

      const res = await request(app).get(`/api/directory?path=${encodeURIComponent(testPath)}`);

      expect(res.status).toBe(200);
      expect(res.body.path).toBe(testPath);
      expect(res.body.entries).toHaveLength(2);
      expect(res.body.entries[0].name).toBe('app-a');
      expect(res.body.entries[0].isDirectory).toBe(true);
      expect(res.body.parent).toBe(BOUNDARY);
    });

    it('defaults to boundary root when no path given', async () => {
      mockValidateBoundary.mockResolvedValue(BOUNDARY);
      mockReaddir.mockResolvedValue([{ name: 'Documents', isDirectory: () => true }]);

      const res = await request(app).get('/api/directory');

      expect(res.status).toBe(200);
      expect(res.body.path).toBe(BOUNDARY);
      expect(mockValidateBoundary).toHaveBeenCalledWith(BOUNDARY);
    });

    it('rejects paths outside configured boundary', async () => {
      mockValidateBoundary.mockRejectedValue(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get('/api/directory?path=/etc/passwd');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('outside directory boundary');
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('returns 404 for non-existent path', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      mockValidateBoundary.mockRejectedValue(err);

      const res = await request(app).get('/api/directory?path=/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('returns 403 for permission errors', async () => {
      mockValidateBoundary.mockRejectedValue(
        new BoundaryError('Permission denied', 'PERMISSION_DENIED')
      );

      const res = await request(app).get('/api/directory?path=/restricted');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Permission denied');
    });

    it('returns 400 for null byte paths', async () => {
      mockValidateBoundary.mockRejectedValue(
        new BoundaryError('Invalid path: null bytes not allowed', 'NULL_BYTE')
      );

      const res = await request(app).get('/api/directory?path=/foo%00bar');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NULL_BYTE');
    });

    it('filters hidden directories by default', async () => {
      const testPath = `${BOUNDARY}/projects`;
      mockValidateBoundary.mockResolvedValue(testPath);
      mockReaddir.mockResolvedValue([
        { name: '.hidden', isDirectory: () => true },
        { name: 'visible', isDirectory: () => true },
      ]);

      const res = await request(app).get(`/api/directory?path=${encodeURIComponent(testPath)}`);

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].name).toBe('visible');
    });

    it('shows hidden directories when showHidden=true', async () => {
      const testPath = `${BOUNDARY}/projects`;
      mockValidateBoundary.mockResolvedValue(testPath);
      mockReaddir.mockResolvedValue([
        { name: '.hidden', isDirectory: () => true },
        { name: 'visible', isDirectory: () => true },
      ]);

      const res = await request(app).get(
        `/api/directory?path=${encodeURIComponent(testPath)}&showHidden=true`
      );

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(2);
    });

    it('parent navigation stops at boundary root', async () => {
      mockValidateBoundary.mockResolvedValue(BOUNDARY);
      mockReaddir.mockResolvedValue([]);

      const res = await request(app).get('/api/directory');

      expect(res.status).toBe(200);
      expect(res.body.parent).toBeNull();
    });

    it('returns parent for subdirectories within boundary', async () => {
      const testPath = `${BOUNDARY}/projects/deep`;
      mockValidateBoundary.mockResolvedValue(testPath);
      mockReaddir.mockResolvedValue([]);

      const res = await request(app).get(`/api/directory?path=${encodeURIComponent(testPath)}`);

      expect(res.status).toBe(200);
      expect(res.body.parent).toBe(`${BOUNDARY}/projects`);
    });

    it('handles path traversal attempts', async () => {
      mockValidateBoundary.mockRejectedValue(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get('/api/directory?path=/../../../etc');

      expect(res.status).toBe(403);
    });

    it('does not navigate parent above boundary even with path.sep prefix match', async () => {
      // Boundary is /Users/testuser, resolved path is /Users/testuser itself
      // Parent would be /Users which should NOT be navigable
      mockValidateBoundary.mockResolvedValue(BOUNDARY);
      mockReaddir.mockResolvedValue([]);

      const res = await request(app).get(`/api/directory?path=${encodeURIComponent(BOUNDARY)}`);

      expect(res.status).toBe(200);
      // /Users is NOT within boundary, so parent should be null
      expect(res.body.parent).toBeNull();
    });
  });

  describe('GET /api/directory/default', () => {
    it('returns the process cwd', async () => {
      const res = await request(app).get('/api/directory/default');

      expect(res.status).toBe(200);
      expect(res.body.path).toBe(process.cwd());
    });
  });
});
