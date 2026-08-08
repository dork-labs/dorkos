import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

/**
 * Does this machine's temp filesystem fold case? macOS and Windows do, Linux
 * (and CI) usually does not — and the case-only self-copy below only exists as
 * a hazard where it does. Probed rather than assumed from `process.platform`,
 * because a case-sensitive volume on macOS is perfectly possible.
 */
const CASE_INSENSITIVE_FS = (() => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'dork-case-probe-'));
  try {
    mkdirSync(path.join(probe, 'src'));
    return existsSync(path.join(probe, 'SRC'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

// Boundary is mocked pass-through so `cwd` + `path` resolve to the real temp
// files and the copy logic runs against a real filesystem. Escape rejection at
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

// The reveal route's one side effect is launching a desktop file manager, which
// a test must never actually do. The launcher's own platform branching is
// covered by `lib/__tests__/reveal-in-file-manager.test.ts`.
vi.mock('../../lib/reveal-in-file-manager.js', () => ({
  revealInFileManager: vi.fn().mockResolvedValue(undefined),
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
import { revealInFileManager } from '../../lib/reveal-in-file-manager.js';

const app = createApp();

/** Make the second validateBoundary call (target-vs-cwd) reject like an escape. */
function mockBoundaryEscape() {
  vi.mocked(validateBoundary)
    .mockImplementationOnce(async (p: string) => p)
    .mockImplementationOnce(async () => {
      throw new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY');
    });
}

describe('File explorer copy + reveal routes', () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(validateBoundary).mockImplementation(async (p: string) => p);
    vi.mocked(revealInFileManager).mockResolvedValue(undefined);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dork-files-copy-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('POST /api/files/copy', () => {
    it('copies a file, leaving the source in place', async () => {
      await fs.writeFile(path.join(dir, 'from.txt'), 'x\n');

      const res = await request(app)
        .post('/api/files/copy')
        .send({ cwd: dir, from: 'from.txt', to: 'to.txt' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(await fs.readFile(path.join(dir, 'to.txt'), 'utf8')).toBe('x\n');
      expect(await fs.readFile(path.join(dir, 'from.txt'), 'utf8')).toBe('x\n');
    });

    it('copies a directory and everything under it', async () => {
      await fs.mkdir(path.join(dir, 'src', 'nested'), { recursive: true });
      await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'a\n');
      await fs.writeFile(path.join(dir, 'src', 'nested', 'b.ts'), 'b\n');

      const res = await request(app)
        .post('/api/files/copy')
        .send({ cwd: dir, from: 'src', to: 'src-copy' });

      expect(res.status).toBe(200);
      expect(await fs.readFile(path.join(dir, 'src-copy', 'a.ts'), 'utf8')).toBe('a\n');
      expect(await fs.readFile(path.join(dir, 'src-copy', 'nested', 'b.ts'), 'utf8')).toBe('b\n');
    });

    it('creates missing destination parents', async () => {
      await fs.writeFile(path.join(dir, 'from.txt'), 'x\n');

      const res = await request(app)
        .post('/api/files/copy')
        .send({ cwd: dir, from: 'from.txt', to: 'deep/nested/to.txt' });

      expect(res.status).toBe(200);
      expect(await fs.readFile(path.join(dir, 'deep', 'nested', 'to.txt'), 'utf8')).toBe('x\n');
    });

    it('returns 404 when the source is missing', async () => {
      const res = await request(app)
        .post('/api/files/copy')
        .send({ cwd: dir, from: 'gone.txt', to: 'to.txt' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('returns 409 when the target already exists', async () => {
      await fs.writeFile(path.join(dir, 'from.txt'), 'x\n');
      await fs.writeFile(path.join(dir, 'to.txt'), 'existing\n');

      const res = await request(app)
        .post('/api/files/copy')
        .send({ cwd: dir, from: 'from.txt', to: 'to.txt' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
      expect(await fs.readFile(path.join(dir, 'to.txt'), 'utf8')).toBe('existing\n');
    });

    it('returns 400 when a directory would be copied into its own subtree', async () => {
      await fs.mkdir(path.join(dir, 'src'));
      await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'a\n');

      const res = await request(app)
        .post('/api/files/copy')
        .send({ cwd: dir, from: 'src', to: 'src/inner' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('COPY_INTO_SELF');
      await expect(fs.access(path.join(dir, 'src', 'inner'))).rejects.toThrow();
    });

    // The occupancy check used `fs.access`, which FOLLOWS symlinks: a dangling
    // symlink read as "free", the copy then failed EEXIST (fs.cp refuses to
    // clobber it), and the rollback deleted the user's link — destroying
    // something the copy never created.
    it('409s on a dangling symlink at the destination and leaves the link alone', async () => {
      await fs.writeFile(path.join(dir, 'from.txt'), 'x\n');
      await fs.symlink(path.join(dir, 'no-such-target'), path.join(dir, 'dangling'));

      const res = await request(app)
        .post('/api/files/copy')
        .send({ cwd: dir, from: 'from.txt', to: 'dangling' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
      // The link still exists and still points where the user pointed it.
      const stat = await fs.lstat(path.join(dir, 'dangling'));
      expect(stat.isSymbolicLink()).toBe(true);
      expect(await fs.readlink(path.join(dir, 'dangling'))).toBe(path.join(dir, 'no-such-target'));
    });

    it('409s on a symlink whose target exists, without following it', async () => {
      await fs.writeFile(path.join(dir, 'from.txt'), 'x\n');
      await fs.writeFile(path.join(dir, 'real.txt'), 'real\n');
      await fs.symlink(path.join(dir, 'real.txt'), path.join(dir, 'alias'));

      const res = await request(app)
        .post('/api/files/copy')
        .send({ cwd: dir, from: 'from.txt', to: 'alias' });

      expect(res.status).toBe(409);
      // The link and its target are both untouched.
      expect((await fs.lstat(path.join(dir, 'alias'))).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(dir, 'real.txt'), 'utf8')).toBe('real\n');
    });

    // The string prefix check compares resolved paths, so any spelling of the
    // destination that it cannot see through slips past it. Node's own check
    // catches those; these pin that its refusal is reported as the honest
    // reason (400 COPY_INTO_SELF) rather than an opaque 500.
    it('400s when a symlinked destination spelling lands inside the source', async () => {
      await fs.mkdir(path.join(dir, 'src'));
      await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'a\n');
      await fs.symlink(path.join(dir, 'src'), path.join(dir, 'link'), 'dir');

      const res = await request(app)
        .post('/api/files/copy')
        .send({ cwd: dir, from: 'src', to: 'link/inner' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('COPY_INTO_SELF');
      // The source is exactly as it was — no partial copy inside it.
      expect(await fs.readdir(path.join(dir, 'src'))).toEqual(['a.ts']);
    });

    it.runIf(CASE_INSENSITIVE_FS)(
      '400s when only the case differs on a case-folding filesystem',
      async () => {
        await fs.mkdir(path.join(dir, 'src'));
        await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'a\n');

        const res = await request(app)
          .post('/api/files/copy')
          .send({ cwd: dir, from: 'src', to: 'SRC/inner' });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('COPY_INTO_SELF');
        expect(await fs.readdir(path.join(dir, 'src'))).toEqual(['a.ts']);
      }
    );

    it('refuses to copy over the working-directory root', async () => {
      await fs.writeFile(path.join(dir, 'from.txt'), 'x\n');

      const res = await request(app)
        .post('/api/files/copy')
        .send({ cwd: dir, from: '.', to: 'copy-of-root' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('REFUSE_ROOT');
    });

    it('rejects a from-path that escapes the working directory with 403', async () => {
      mockBoundaryEscape();

      const res = await request(app)
        .post('/api/files/copy')
        .send({ cwd: dir, from: '../../etc/passwd', to: 'to.txt' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('rejects a body missing `to` with 400', async () => {
      const res = await request(app).post('/api/files/copy').send({ cwd: dir, from: 'a.txt' });

      expect(res.status).toBe(400);
      expect(revealInFileManager).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/files/reveal', () => {
    it('dispatches the file manager for an existing file and answers 204', async () => {
      await fs.writeFile(path.join(dir, 'note.txt'), 'x\n');

      const res = await request(app).post('/api/files/reveal').send({ cwd: dir, path: 'note.txt' });

      expect(res.status).toBe(204);
      expect(revealInFileManager).toHaveBeenCalledWith(path.join(dir, 'note.txt'));
    });

    it('reveals a directory too', async () => {
      await fs.mkdir(path.join(dir, 'src'));

      const res = await request(app).post('/api/files/reveal').send({ cwd: dir, path: 'src' });

      expect(res.status).toBe(204);
      expect(revealInFileManager).toHaveBeenCalledWith(path.join(dir, 'src'));
    });

    it('returns 404 for a path that does not exist, without launching anything', async () => {
      const res = await request(app).post('/api/files/reveal').send({ cwd: dir, path: 'gone.txt' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
      expect(revealInFileManager).not.toHaveBeenCalled();
    });

    it('rejects a path that escapes the working directory with 403', async () => {
      await fs.writeFile(path.join(dir, 'note.txt'), 'x\n');
      mockBoundaryEscape();

      const res = await request(app)
        .post('/api/files/reveal')
        .send({ cwd: dir, path: '../../etc/passwd' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
      expect(revealInFileManager).not.toHaveBeenCalled();
    });

    it('reports 500 when no file manager could be launched', async () => {
      await fs.writeFile(path.join(dir, 'note.txt'), 'x\n');
      vi.mocked(revealInFileManager).mockRejectedValueOnce(new Error('spawn xdg-open ENOENT'));

      const res = await request(app).post('/api/files/reveal').send({ cwd: dir, path: 'note.txt' });

      expect(res.status).toBe(500);
      expect(res.body.code).toBe('REVEAL_UNAVAILABLE');
    });

    it('rejects an empty body with 400', async () => {
      const res = await request(app).post('/api/files/reveal').send();

      expect(res.status).toBe(400);
      expect(revealInFileManager).not.toHaveBeenCalled();
    });
  });
});
