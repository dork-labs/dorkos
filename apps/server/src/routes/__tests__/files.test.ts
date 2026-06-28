import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

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

vi.mock('../../services/core/file-lister.js', () => ({
  fileLister: {
    listFiles: vi.fn().mockResolvedValue({ files: [] }),
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

const app = createApp();

describe('Files Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('boundary enforcement', () => {
    it('GET /api/files rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get('/api/files').query({ cwd: '/etc/shadow' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('GET /api/files rejects null byte paths with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Invalid path: null bytes not allowed', 'NULL_BYTE')
      );

      const res = await request(app).get('/api/files').query({ cwd: '/home/user\0' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NULL_BYTE');
    });
  });

  describe('PUT /api/files/content', () => {
    // Boundary is mocked pass-through (see top of file), so cwd + path resolve to
    // the real temp file and the read/write/hash/conflict logic runs for real.
    const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    const original = '# Title\n\nbody\n';
    let dir: string;
    let file: string;

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dork-write-'));
      file = path.join(dir, 'doc.md');
      await fs.writeFile(file, original, 'utf8');
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('writes new content when expectedHash matches and returns the new hash', async () => {
      const next = '# Title\n\nbody edited\n';
      const res = await request(app)
        .put('/api/files/content')
        .send({ cwd: dir, path: 'doc.md', content: next, expectedHash: sha(original) });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, hash: sha(next) });
      expect(await fs.readFile(file, 'utf8')).toBe(next);
    });

    it('rejects with 409 and returns current content when the file changed underneath', async () => {
      const changed = '# Title\n\nchanged by agent\n';
      await fs.writeFile(file, changed, 'utf8');

      const res = await request(app)
        .put('/api/files/content')
        .send({ cwd: dir, path: 'doc.md', content: 'mine\n', expectedHash: sha(original) });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
      expect(res.body.currentContent).toBe(changed);
      expect(res.body.currentHash).toBe(sha(changed));
      // The file is left untouched on conflict.
      expect(await fs.readFile(file, 'utf8')).toBe(changed);
    });

    it('overwrites unconditionally when no expectedHash is sent (forced save)', async () => {
      await fs.writeFile(file, 'whatever\n', 'utf8');
      const next = 'forced\n';

      const res = await request(app)
        .put('/api/files/content')
        .send({ cwd: dir, path: 'doc.md', content: next });

      expect(res.status).toBe(200);
      expect(await fs.readFile(file, 'utf8')).toBe(next);
    });

    it('returns 404 for a file that does not exist (never creates files)', async () => {
      const res = await request(app)
        .put('/api/files/content')
        .send({ cwd: dir, path: 'missing.md', content: 'x\n' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('treats identical content as a successful no-op', async () => {
      const res = await request(app)
        .put('/api/files/content')
        .send({ cwd: dir, path: 'doc.md', content: original, expectedHash: sha(original) });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, hash: sha(original) });
    });

    it('accepts a first save conditioned on baseline content (server hashes it)', async () => {
      const next = '# Title\n\nbody edited\n';
      const res = await request(app)
        .put('/api/files/content')
        .send({ cwd: dir, path: 'doc.md', content: next, expectedContent: original });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, hash: sha(next) });
      expect(await fs.readFile(file, 'utf8')).toBe(next);
    });

    it('409s when the baseline content no longer matches disk', async () => {
      await fs.writeFile(file, '# Title\n\nchanged\n', 'utf8');
      const res = await request(app)
        .put('/api/files/content')
        .send({ cwd: dir, path: 'doc.md', content: 'mine\n', expectedContent: original });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
    });

    it('rejects a path that escapes the working directory with 403', async () => {
      // First call validates cwd (pass through); second validates the target
      // against cwd and rejects, mirroring a `..` escape.
      vi.mocked(validateBoundary)
        .mockImplementationOnce(async (p: string) => p)
        .mockImplementationOnce(async () => {
          throw new BoundaryError(
            'Access denied: path outside directory boundary',
            'OUTSIDE_BOUNDARY'
          );
        });

      const res = await request(app)
        .put('/api/files/content')
        .send({ cwd: dir, path: '../../etc/passwd', content: 'x\n' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });
  });
});
