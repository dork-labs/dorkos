import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// Boundary is mocked pass-through so `cwd` + `path` resolve to the real temp
// files and the stat/read/write/rename logic runs for real. Escape rejection at
// the route layer is exercised by overriding the mock to throw (boundary.ts's
// own symlink/`..` resolution is covered by its dedicated tests).
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

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { validateBoundary, BoundaryError } from '../../lib/boundary.js';

const execFileAsync = promisify(execFile);
const app = createApp();
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** Make the second validateBoundary call (target-vs-cwd) reject like an escape. */
function mockBoundaryEscape() {
  vi.mocked(validateBoundary)
    .mockImplementationOnce(async (p: string) => p)
    .mockImplementationOnce(async () => {
      throw new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY');
    });
}

describe('Workbench file routes', () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dork-workbench-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('GET /api/files/tree', () => {
    beforeEach(async () => {
      await fs.mkdir(path.join(dir, 'src'));
      await fs.writeFile(path.join(dir, 'src', 'index.ts'), 'export {}\n');
      await fs.writeFile(path.join(dir, 'README.md'), '# hi\n');
      await fs.writeFile(path.join(dir, '.hidden'), 'secret\n');
    });

    it('lists the immediate level (depth 1) with directories first', async () => {
      const res = await request(app).get('/api/files/tree').query({ cwd: dir });

      expect(res.status).toBe(200);
      const names = res.body.entries.map((e: { name: string }) => e.name);
      // `src` (dir) sorts before `README.md` (file); `.hidden` is filtered.
      expect(names).toEqual(['src', 'README.md']);
      const src = res.body.entries.find((e: { name: string }) => e.name === 'src');
      expect(src).toMatchObject({ type: 'dir', path: 'src', isSymlink: false });
      const readme = res.body.entries.find((e: { name: string }) => e.name === 'README.md');
      expect(readme).toMatchObject({ type: 'file', path: 'README.md' });
      expect(readme.size).toBeGreaterThan(0);
    });

    it('does not recurse into subdirectories at depth 1 (lazy)', async () => {
      const res = await request(app).get('/api/files/tree').query({ cwd: dir, depth: '1' });
      const paths = res.body.entries.map((e: { path: string }) => e.path);
      expect(paths).not.toContain('src/index.ts');
    });

    it('recurses when depth > 1', async () => {
      const res = await request(app).get('/api/files/tree').query({ cwd: dir, depth: '2' });
      const paths = res.body.entries.map((e: { path: string }) => e.path);
      expect(paths).toContain('src/index.ts');
    });

    it('reveals dotfiles when showHidden is set', async () => {
      const res = await request(app).get('/api/files/tree').query({ cwd: dir, showHidden: 'true' });
      const names = res.body.entries.map((e: { name: string }) => e.name);
      expect(names).toContain('.hidden');
    });

    it('honors .gitignore in a git repo (ignored entries are hidden)', async () => {
      await execFileAsync('git', ['init', '-q'], { cwd: dir });
      await fs.writeFile(path.join(dir, '.gitignore'), 'ignored.txt\n');
      await fs.writeFile(path.join(dir, 'ignored.txt'), 'nope\n');

      const res = await request(app).get('/api/files/tree').query({ cwd: dir });
      const names = res.body.entries.map((e: { name: string }) => e.name);
      expect(names).not.toContain('ignored.txt');
      // A non-ignored, non-hidden sibling still shows.
      expect(names).toContain('README.md');
    });

    it('returns 400 when the target is a file, not a directory', async () => {
      const res = await request(app).get('/api/files/tree').query({ cwd: dir, path: 'README.md' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NOT_A_DIRECTORY');
    });

    it('returns 404 for a missing directory', async () => {
      const res = await request(app).get('/api/files/tree').query({ cwd: dir, path: 'nope' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('rejects a path that escapes the working directory with 403', async () => {
      mockBoundaryEscape();
      const res = await request(app).get('/api/files/tree').query({ cwd: dir, path: '../../etc' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });
  });

  describe('GET /api/files/content', () => {
    it('returns UTF-8 content, its hash, and encoding', async () => {
      const text = 'hello world\n';
      await fs.writeFile(path.join(dir, 'a.txt'), text, 'utf8');

      const res = await request(app).get('/api/files/content').query({ cwd: dir, path: 'a.txt' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ content: text, hash: sha(text), encoding: 'utf-8' });
    });

    it('rejects a binary file (NUL byte) with 415', async () => {
      await fs.writeFile(path.join(dir, 'bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
      const res = await request(app).get('/api/files/content').query({ cwd: dir, path: 'bin' });
      expect(res.status).toBe(415);
      expect(res.body.code).toBe('BINARY_FILE');
    });

    it('rejects a file over the 5 MB text cap with 413', async () => {
      // One byte past the cap — the boundary condition that must fail.
      await fs.writeFile(path.join(dir, 'big.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
      const res = await request(app).get('/api/files/content').query({ cwd: dir, path: 'big.txt' });
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('TOO_LARGE');
    });

    it('returns 404 for a missing file', async () => {
      const res = await request(app).get('/api/files/content').query({ cwd: dir, path: 'gone' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('rejects a path that escapes the working directory with 403', async () => {
      mockBoundaryEscape();
      const res = await request(app)
        .get('/api/files/content')
        .query({ cwd: dir, path: '../../etc/passwd' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });
  });

  describe('POST /api/files (create)', () => {
    it('creates a file with seeded content and returns 201', async () => {
      const res = await request(app)
        .post('/api/files')
        .send({ cwd: dir, path: 'new.txt', type: 'file', content: 'seed\n' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true, path: 'new.txt' });
      expect(await fs.readFile(path.join(dir, 'new.txt'), 'utf8')).toBe('seed\n');
    });

    it('creates a directory', async () => {
      const res = await request(app)
        .post('/api/files')
        .send({ cwd: dir, path: 'newdir', type: 'dir' });
      expect(res.status).toBe(201);
      expect((await fs.stat(path.join(dir, 'newdir'))).isDirectory()).toBe(true);
    });

    it('creates intermediate parent directories for a nested file', async () => {
      const res = await request(app)
        .post('/api/files')
        .send({ cwd: dir, path: 'a/b/c.txt', type: 'file', content: 'x' });
      expect(res.status).toBe(201);
      expect(await fs.readFile(path.join(dir, 'a', 'b', 'c.txt'), 'utf8')).toBe('x');
    });

    it('returns 409 when the target already exists', async () => {
      await fs.writeFile(path.join(dir, 'dupe.txt'), 'old\n');
      const res = await request(app)
        .post('/api/files')
        .send({ cwd: dir, path: 'dupe.txt', type: 'file', content: 'new\n' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
      // The existing file is untouched.
      expect(await fs.readFile(path.join(dir, 'dupe.txt'), 'utf8')).toBe('old\n');
    });

    it('rejects a path that escapes the working directory with 403', async () => {
      mockBoundaryEscape();
      const res = await request(app)
        .post('/api/files')
        .send({ cwd: dir, path: '../evil.txt', type: 'file' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });
  });

  describe('DELETE /api/files', () => {
    it('deletes a file', async () => {
      await fs.writeFile(path.join(dir, 'del.txt'), 'x\n');
      const res = await request(app).delete('/api/files').query({ cwd: dir, path: 'del.txt' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      await expect(fs.access(path.join(dir, 'del.txt'))).rejects.toThrow();
    });

    it('deletes a non-empty directory only with recursive=true', async () => {
      await fs.mkdir(path.join(dir, 'tree'));
      await fs.writeFile(path.join(dir, 'tree', 'f.txt'), 'x\n');

      const refused = await request(app).delete('/api/files').query({ cwd: dir, path: 'tree' });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('DIR_NOT_EMPTY');

      const ok = await request(app)
        .delete('/api/files')
        .query({ cwd: dir, path: 'tree', recursive: 'true' });
      expect(ok.status).toBe(200);
      await expect(fs.access(path.join(dir, 'tree'))).rejects.toThrow();
    });

    it('refuses to delete the cwd root with 400', async () => {
      const res = await request(app).delete('/api/files').query({ cwd: dir, path: '.' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('REFUSE_ROOT');
    });

    it('returns 404 for a missing path', async () => {
      const res = await request(app).delete('/api/files').query({ cwd: dir, path: 'gone' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('rejects a path that escapes the working directory with 403', async () => {
      mockBoundaryEscape();
      const res = await request(app)
        .delete('/api/files')
        .query({ cwd: dir, path: '../../etc/passwd' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });
  });

  describe('POST /api/files/rename', () => {
    it('renames a file', async () => {
      await fs.writeFile(path.join(dir, 'from.txt'), 'x\n');
      const res = await request(app)
        .post('/api/files/rename')
        .send({ cwd: dir, from: 'from.txt', to: 'to.txt' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(await fs.readFile(path.join(dir, 'to.txt'), 'utf8')).toBe('x\n');
      await expect(fs.access(path.join(dir, 'from.txt'))).rejects.toThrow();
    });

    it('moves a file into a not-yet-existing subdirectory', async () => {
      await fs.writeFile(path.join(dir, 'from.txt'), 'x\n');
      const res = await request(app)
        .post('/api/files/rename')
        .send({ cwd: dir, from: 'from.txt', to: 'nested/to.txt' });
      expect(res.status).toBe(200);
      expect(await fs.readFile(path.join(dir, 'nested', 'to.txt'), 'utf8')).toBe('x\n');
    });

    it('returns 409 when the target already exists', async () => {
      await fs.writeFile(path.join(dir, 'from.txt'), 'x\n');
      await fs.writeFile(path.join(dir, 'to.txt'), 'existing\n');
      const res = await request(app)
        .post('/api/files/rename')
        .send({ cwd: dir, from: 'from.txt', to: 'to.txt' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
      // Neither file was touched.
      expect(await fs.readFile(path.join(dir, 'to.txt'), 'utf8')).toBe('existing\n');
      expect(await fs.readFile(path.join(dir, 'from.txt'), 'utf8')).toBe('x\n');
    });

    it('returns 404 when the source is missing', async () => {
      const res = await request(app)
        .post('/api/files/rename')
        .send({ cwd: dir, from: 'gone.txt', to: 'to.txt' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('rejects a from-path that escapes the working directory with 403', async () => {
      mockBoundaryEscape();
      const res = await request(app)
        .post('/api/files/rename')
        .send({ cwd: dir, from: '../../etc/passwd', to: 'to.txt' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });
  });

  describe('GET /api/files/raw (3D model extension)', () => {
    it('streams a .glb file as model/gltf-binary', async () => {
      const bytes = Buffer.from('glTF-fake-binary');
      await fs.writeFile(path.join(dir, 'model.glb'), bytes);
      const res = await request(app)
        .get('/api/files/raw')
        .query({ cwd: dir, path: 'model.glb' })
        .buffer(true);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('model/gltf-binary');
    });
  });
});
