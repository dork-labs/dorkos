import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';

// Mock fs/promises
const mockRealpath = vi.fn();
const mockReaddir = vi.fn();
vi.mock('fs/promises', () => ({
  default: {
    realpath: (...args: unknown[]) => mockRealpath(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args),
  },
  realpath: (...args: unknown[]) => mockRealpath(...args),
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

const app = createApp();
const HOME = os.homedir();

describe('Directory Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/directory', () => {
    it('returns directory listing for a valid path', async () => {
      const testPath = `${HOME}/projects`;
      mockRealpath.mockResolvedValue(testPath);
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
      expect(res.body.parent).toBe(HOME);
    });

    it('defaults to home directory when no path given', async () => {
      mockRealpath.mockResolvedValue(HOME);
      mockReaddir.mockResolvedValue([
        { name: 'Documents', isDirectory: () => true },
      ]);

      const res = await request(app).get('/api/directory');

      expect(res.status).toBe(200);
      expect(res.body.path).toBe(HOME);
      expect(mockRealpath).toHaveBeenCalledWith(HOME);
    });

    it('returns 403 for path outside home directory', async () => {
      mockRealpath.mockResolvedValue('/etc/passwd');

      const res = await request(app).get('/api/directory?path=/etc/passwd');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('outside home directory');
    });

    it('returns 404 for non-existent path', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      mockRealpath.mockRejectedValue(err);

      const res = await request(app).get('/api/directory?path=/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('returns 403 for permission errors', async () => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      mockRealpath.mockRejectedValue(err);

      const res = await request(app).get('/api/directory?path=/restricted');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Permission denied');
    });

    it('filters hidden directories by default', async () => {
      const testPath = `${HOME}/projects`;
      mockRealpath.mockResolvedValue(testPath);
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
      const testPath = `${HOME}/projects`;
      mockRealpath.mockResolvedValue(testPath);
      mockReaddir.mockResolvedValue([
        { name: '.hidden', isDirectory: () => true },
        { name: 'visible', isDirectory: () => true },
      ]);

      const res = await request(app).get(
        `/api/directory?path=${encodeURIComponent(testPath)}&showHidden=true`,
      );

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(2);
    });

    it('returns null parent at home directory boundary', async () => {
      mockRealpath.mockResolvedValue(HOME);
      mockReaddir.mockResolvedValue([]);

      const res = await request(app).get('/api/directory');

      expect(res.status).toBe(200);
      expect(res.body.parent).toBeNull();
    });

    it('handles path traversal attempts', async () => {
      // realpath resolves to outside home
      mockRealpath.mockResolvedValue('/etc');

      const res = await request(app).get('/api/directory?path=/../../../etc');

      expect(res.status).toBe(403);
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
