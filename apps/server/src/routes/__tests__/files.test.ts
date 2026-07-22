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

  describe('GET /api/files/raw', () => {
    // Boundary is mocked pass-through (see top of file), so cwd + path resolve to
    // the real temp files and the extension/stat/stream logic runs for real.
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const pdfBytes = Buffer.from('%PDF-1.4\n%%EOF\n');
    // Deterministic ASCII bytes so Range slices are trivial to assert.
    const mp4Bytes = Buffer.from('0123456789ABCDEFGHIJ');
    let dir: string;

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dork-raw-'));
      await fs.writeFile(path.join(dir, 'pic.png'), pngBytes);
      await fs.writeFile(path.join(dir, 'doc.pdf'), pdfBytes);
      await fs.writeFile(path.join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      await fs.writeFile(path.join(dir, 'notes.txt'), 'secret');
      await fs.writeFile(path.join(dir, 'clip.mp4'), mp4Bytes);
      await fs.writeFile(path.join(dir, 'song.mp3'), Buffer.from('ID3'));
      await fs.writeFile(path.join(dir, 'part.3mf'), Buffer.from('3MF'));
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('streams an image with the correct content type', async () => {
      const res = await request(app)
        .get('/api/files/raw')
        .query({ cwd: dir, path: 'pic.png' })
        .buffer(true);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(Number(res.headers['content-length'])).toBe(pngBytes.length);
    });

    it('streams a PDF with the correct content type', async () => {
      const res = await request(app)
        .get('/api/files/raw')
        .query({ cwd: dir, path: 'doc.pdf' })
        .buffer(true);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe('inline');
      expect(Number(res.headers['content-length'])).toBe(pdfBytes.length);
      expect(res.body).toEqual(pdfBytes);
    });

    it('serves SVG under a script-neutering CSP sandbox', async () => {
      const res = await request(app).get('/api/files/raw').query({ cwd: dir, path: 'icon.svg' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/svg+xml');
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; sandbox"
      );
    });

    it('rejects non-image/pdf extensions with 415', async () => {
      const res = await request(app).get('/api/files/raw').query({ cwd: dir, path: 'notes.txt' });

      expect(res.status).toBe(415);
      expect(res.body.code).toBe('UNSUPPORTED_TYPE');
    });

    it('returns 404 for a missing file', async () => {
      const res = await request(app).get('/api/files/raw').query({ cwd: dir, path: 'gone.png' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('rejects a path that escapes the working directory with 403', async () => {
      // First call validates cwd (pass through); second validates the target and
      // rejects, mirroring a `..` traversal escape.
      vi.mocked(validateBoundary)
        .mockImplementationOnce(async (p: string) => p)
        .mockImplementationOnce(async () => {
          throw new BoundaryError(
            'Access denied: path outside directory boundary',
            'OUTSIDE_BOUNDARY'
          );
        });

      const res = await request(app)
        .get('/api/files/raw')
        .query({ cwd: dir, path: '../../etc/passwd.png' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('rejects a missing path query with 400', async () => {
      const res = await request(app).get('/api/files/raw').query({ cwd: dir });

      expect(res.status).toBe(400);
    });

    it.each([
      ['song.mp3', 'audio/mpeg'],
      ['part.3mf', 'model/3mf'],
      ['clip.mp4', 'video/mp4'],
    ])('serves %s as %s with Accept-Ranges', async (name, type) => {
      const res = await request(app)
        .get('/api/files/raw')
        .query({ cwd: dir, path: name })
        .buffer(true);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe(type);
      expect(res.headers['accept-ranges']).toBe('bytes');
    });

    it('advertises Accept-Ranges and serves the full body when no Range header is sent', async () => {
      const res = await request(app)
        .get('/api/files/raw')
        .query({ cwd: dir, path: 'clip.mp4' })
        .buffer(true);

      expect(res.status).toBe(200);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(Number(res.headers['content-length'])).toBe(mp4Bytes.length);
    });

    it('serves a 206 partial response with the correct slice for a Range request', async () => {
      const res = await request(app)
        .get('/api/files/raw')
        .query({ cwd: dir, path: 'clip.mp4' })
        .set('Range', 'bytes=4-9')
        .buffer(true);

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 4-9/${mp4Bytes.length}`);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(Number(res.headers['content-length'])).toBe(6);
      expect(res.body.toString()).toBe('456789');
    });

    it('serves an open-ended suffix Range (last N bytes) as 206', async () => {
      const res = await request(app)
        .get('/api/files/raw')
        .query({ cwd: dir, path: 'clip.mp4' })
        .set('Range', 'bytes=-5')
        .buffer(true);

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 15-19/${mp4Bytes.length}`);
      expect(res.body.toString()).toBe('FGHIJ');
    });

    it('returns 416 with a Content-Range header for an unsatisfiable Range', async () => {
      const res = await request(app)
        .get('/api/files/raw')
        .query({ cwd: dir, path: 'clip.mp4' })
        .set('Range', `bytes=${mp4Bytes.length}-`);

      expect(res.status).toBe(416);
      expect(res.headers['content-range']).toBe(`bytes */${mp4Bytes.length}`);
      expect(res.body.code).toBe('RANGE_NOT_SATISFIABLE');
    });

    it('ignores a malformed Range header and serves the full body (200)', async () => {
      const res = await request(app)
        .get('/api/files/raw')
        .query({ cwd: dir, path: 'clip.mp4' })
        .set('Range', 'rows=1-2')
        .buffer(true);

      expect(res.status).toBe(200);
      expect(Number(res.headers['content-length'])).toBe(mp4Bytes.length);
    });

    it('still rejects an unknown extension with 415 even with a Range header', async () => {
      const res = await request(app)
        .get('/api/files/raw')
        .query({ cwd: dir, path: 'notes.txt' })
        .set('Range', 'bytes=0-1');

      expect(res.status).toBe(415);
      expect(res.body.code).toBe('UNSUPPORTED_TYPE');
    });
  });
});
