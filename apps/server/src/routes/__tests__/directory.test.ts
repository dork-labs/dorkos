import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock boundary module
const mockGetBoundary = vi.fn();
const mockValidateBoundary = vi.fn();
const mockValidateBoundaryOrDorkHome = vi.fn();
const mockResolveAgentsRoot = vi.fn();
vi.mock('../../lib/boundary.js', () => ({
  getBoundary: (...args: unknown[]) => mockGetBoundary(...args),
  validateBoundary: (...args: unknown[]) => mockValidateBoundary(...args),
  validateBoundaryOrDorkHome: (...args: unknown[]) => mockValidateBoundaryOrDorkHome(...args),
  resolveAgentsRoot: (...args: unknown[]) => mockResolveAgentsRoot(...args),
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
const mockAccess = vi.fn();
const mockMkdir = vi.fn();
vi.mock('fs/promises', () => ({
  default: {
    realpath: vi.fn(),
    readdir: (...args: unknown[]) => mockReaddir(...args),
    access: (...args: unknown[]) => mockAccess(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
  },
  realpath: vi.fn(),
  readdir: (...args: unknown[]) => mockReaddir(...args),
  access: (...args: unknown[]) => mockAccess(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
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

// Import the mocked BoundaryError for instanceof checks
import { BoundaryError } from '../../lib/boundary.js';
import { DEFAULT_CWD } from '../../lib/resolve-root.js';

const app = createApp();
const BOUNDARY = '/Users/testuser';
const AGENTS_ROOT = '/home/node/.dork/agents';

describe('Directory Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBoundary.mockReturnValue(BOUNDARY);
    mockResolveAgentsRoot.mockResolvedValue(AGENTS_ROOT);
  });

  describe('GET /api/directory', () => {
    it('returns directory listing for a valid path', async () => {
      const testPath = `${BOUNDARY}/projects`;
      mockValidateBoundaryOrDorkHome.mockResolvedValue(testPath);
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
      mockValidateBoundaryOrDorkHome.mockResolvedValue(BOUNDARY);
      mockReaddir.mockResolvedValue([{ name: 'Documents', isDirectory: () => true }]);

      const res = await request(app).get('/api/directory');

      expect(res.status).toBe(200);
      expect(res.body.path).toBe(BOUNDARY);
      expect(mockValidateBoundaryOrDorkHome).toHaveBeenCalledWith(BOUNDARY);
    });

    it('rejects paths outside configured boundary', async () => {
      mockValidateBoundaryOrDorkHome.mockRejectedValue(
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
      mockValidateBoundaryOrDorkHome.mockRejectedValue(err);

      const res = await request(app).get('/api/directory?path=/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('returns 403 for permission errors', async () => {
      mockValidateBoundaryOrDorkHome.mockRejectedValue(
        new BoundaryError('Permission denied', 'PERMISSION_DENIED')
      );

      const res = await request(app).get('/api/directory?path=/restricted');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Permission denied');
    });

    it('returns 400 for null byte paths', async () => {
      mockValidateBoundaryOrDorkHome.mockRejectedValue(
        new BoundaryError('Invalid path: null bytes not allowed', 'NULL_BYTE')
      );

      const res = await request(app).get('/api/directory?path=/foo%00bar');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NULL_BYTE');
    });

    it('filters hidden directories by default', async () => {
      const testPath = `${BOUNDARY}/projects`;
      mockValidateBoundaryOrDorkHome.mockResolvedValue(testPath);
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
      mockValidateBoundaryOrDorkHome.mockResolvedValue(testPath);
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
      mockValidateBoundaryOrDorkHome.mockResolvedValue(BOUNDARY);
      mockReaddir.mockResolvedValue([]);

      const res = await request(app).get('/api/directory');

      expect(res.status).toBe(200);
      expect(res.body.parent).toBeNull();
    });

    it('returns parent for subdirectories within boundary', async () => {
      const testPath = `${BOUNDARY}/projects/deep`;
      mockValidateBoundaryOrDorkHome.mockResolvedValue(testPath);
      mockReaddir.mockResolvedValue([]);

      const res = await request(app).get(`/api/directory?path=${encodeURIComponent(testPath)}`);

      expect(res.status).toBe(200);
      expect(res.body.parent).toBe(`${BOUNDARY}/projects`);
    });

    it('handles path traversal attempts', async () => {
      mockValidateBoundaryOrDorkHome.mockRejectedValue(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get('/api/directory?path=/../../../etc');

      expect(res.status).toBe(403);
    });

    it('does not navigate parent above boundary even with path.sep prefix match', async () => {
      // Boundary is /Users/testuser, resolved path is /Users/testuser itself
      // Parent would be /Users which should NOT be navigable
      mockValidateBoundaryOrDorkHome.mockResolvedValue(BOUNDARY);
      mockReaddir.mockResolvedValue([]);

      const res = await request(app).get(`/api/directory?path=${encodeURIComponent(BOUNDARY)}`);

      expect(res.status).toBe(200);
      // /Users is NOT within boundary, so parent should be null
      expect(res.body.parent).toBeNull();
    });

    it('resolves {dorkHome}/agents even when it sits outside the configured boundary (DOR-437)', async () => {
      // Boundary-scoped install (e.g. DORKOS_BOUNDARY=/workspace in a
      // container): the agents directory lives under dorkHome, not under
      // the project boundary. validateBoundaryOrDorkHome is the seam that
      // makes this resolve instead of 403ing like plain validateBoundary did.
      mockValidateBoundaryOrDorkHome.mockResolvedValue(AGENTS_ROOT);
      mockReaddir.mockResolvedValue([{ name: 'dorkbot', isDirectory: () => true }]);

      const res = await request(app).get(`/api/directory?path=${encodeURIComponent(AGENTS_ROOT)}`);

      expect(res.status).toBe(200);
      expect(res.body.path).toBe(AGENTS_ROOT);
      expect(res.body.entries).toEqual([
        { name: 'dorkbot', path: `${AGENTS_ROOT}/dorkbot`, isDirectory: true },
      ]);
      expect(mockValidateBoundaryOrDorkHome).toHaveBeenCalledWith(AGENTS_ROOT);
      // The plain (boundary-only) validator must not be used for this route.
      expect(mockValidateBoundary).not.toHaveBeenCalled();
      // Browsing the agents root itself has nowhere sanctioned to navigate
      // up to — its parent (dorkHome) sits outside both the boundary and the
      // narrowed agents subtree.
      expect(res.body.parent).toBeNull();
    });

    it('offers a live "navigate up" inside {dorkHome}/agents instead of stranding the picker (DOR-437)', async () => {
      // A subdirectory under the agents root (e.g. a single agent's home)
      // must get an up-button back to the agents root itself, the same way a
      // boundary subdirectory gets one back to the boundary. Before this fix,
      // hasParent only ever compared against `boundary`, so this case fell
      // through to `parent: null` — a dead up-button in the one subtree this
      // route can actually reach under a boundary-scoped install.
      const agentDir = `${AGENTS_ROOT}/dorkbot`;
      mockValidateBoundaryOrDorkHome.mockResolvedValue(agentDir);
      mockReaddir.mockResolvedValue([]);

      const res = await request(app).get(`/api/directory?path=${encodeURIComponent(agentDir)}`);

      expect(res.status).toBe(200);
      expect(res.body.parent).toBe(AGENTS_ROOT);
    });
  });

  describe('GET /api/directory/default', () => {
    it('returns the boundary-resolved default cwd, not the raw process cwd', async () => {
      const res = await request(app).get('/api/directory/default');

      expect(res.status).toBe(200);
      expect(res.body.path).toBe(DEFAULT_CWD);
    });
  });

  describe('POST /api/directory', () => {
    it('creates a directory and returns 201 with path', async () => {
      const parentPath = `${BOUNDARY}/projects`;
      mockValidateBoundary.mockResolvedValue(parentPath);
      // fs.access throws ENOENT — directory does not exist yet
      mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockMkdir.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/api/directory')
        .send({ parentPath, folderName: 'my-new-agent' });

      expect(res.status).toBe(201);
      expect(res.body.path).toBe(`${parentPath}/my-new-agent`);
      expect(mockMkdir).toHaveBeenCalledWith(`${parentPath}/my-new-agent`, { recursive: true });
    });

    it('returns 409 when directory already exists', async () => {
      const parentPath = `${BOUNDARY}/projects`;
      mockValidateBoundary.mockResolvedValue(parentPath);
      // fs.access succeeds — directory exists
      mockAccess.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/api/directory')
        .send({ parentPath, folderName: 'existing-dir' });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already exists');
    });

    it('returns 400 for invalid folder names (uppercase)', async () => {
      const res = await request(app)
        .post('/api/directory')
        .send({ parentPath: `${BOUNDARY}/projects`, folderName: 'MyAgent' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid folder name');
    });

    it('returns 400 for invalid folder names (special chars)', async () => {
      const res = await request(app)
        .post('/api/directory')
        .send({ parentPath: `${BOUNDARY}/projects`, folderName: 'my_agent!' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid folder name');
    });

    it('returns 403 for paths outside boundary', async () => {
      mockValidateBoundary.mockRejectedValue(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app)
        .post('/api/directory')
        .send({ parentPath: '/etc', folderName: 'my-agent' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('returns 400 when parentPath is missing', async () => {
      const res = await request(app).post('/api/directory').send({ folderName: 'my-agent' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Validation failed');
    });
  });
});
