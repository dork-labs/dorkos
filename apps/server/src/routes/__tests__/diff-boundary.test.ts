import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Like files-workbench-boundary.test.ts, this suite uses the REAL boundary module
// and REAL on-disk symlinks so the diff routes' `..` / symlink-parent escapes are
// exercised end to end — the mandatory boundary-escape coverage for every new
// path route (the workbench review caught a real symlinked-parent hole here).
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
import { initBoundary } from '../../lib/boundary.js';
import { editBaselineStore } from '../../services/diff/index.js';

const app = createApp();
const SESSION = 'sess-diff-1';

describe('Diff routes — real boundary + symlink escapes', () => {
  let root: string; // the global boundary
  let cwd: string; // the session working dir (inside root)
  let outside: string; // a sibling dir inside the boundary but OUTSIDE cwd

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dork-diff-')));
    await initBoundary(root);
    cwd = path.join(root, 'project');
    outside = path.join(root, 'outside');
    await fs.mkdir(cwd);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(cwd, 'link'), 'dir');
  });
  afterEach(async () => {
    editBaselineStore.clearSession(SESSION);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('GET /baseline through a symlinked parent cannot read outside cwd (403)', async () => {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret\n');
    const res = await request(app)
      .get('/api/diff/baseline')
      .query({ cwd, path: 'link/secret.txt', sessionId: SESSION });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });

  it('GET /baseline with a ../ path is rejected (403)', async () => {
    const res = await request(app)
      .get('/api/diff/baseline')
      .query({ cwd, path: '../outside/secret.txt', sessionId: SESSION });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });

  it('GET /baseline rejects a null-byte path (400)', async () => {
    const qs = `cwd=${encodeURIComponent(cwd)}&path=a%00b.ts&sessionId=${SESSION}`;
    const res = await request(app).get(`/api/diff/baseline?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NULL_BYTE');
  });

  it('POST /baseline/advance through a symlinked parent cannot escape cwd (403)', async () => {
    const res = await request(app)
      .post('/api/diff/baseline/advance')
      .send({ cwd, path: 'link/secret.txt', sessionId: SESSION });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });

  it('GET /pending rejects a cwd outside the boundary (403)', async () => {
    const res = await request(app)
      .get('/api/diff/pending')
      .query({ cwd: '/etc', sessionId: SESSION });
    expect(res.status).toBe(403);
  });

  it('GET /baseline returns 400 for a directory target (never a 500)', async () => {
    await fs.mkdir(path.join(cwd, 'subdir'));
    const res = await request(app)
      .get('/api/diff/baseline')
      .query({ cwd, path: 'subdir', sessionId: SESSION });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_A_FILE');
  });

  it('GET /baseline returns 415 for a binary file', async () => {
    await fs.writeFile(path.join(cwd, 'logo.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const res = await request(app)
      .get('/api/diff/baseline')
      .query({ cwd, path: 'logo.bin', sessionId: SESSION });
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('BINARY_FILE');
  });

  it('GET /baseline resolves an empty base for an untracked, unsnapshotted file (control)', async () => {
    await fs.writeFile(path.join(cwd, 'note.txt'), 'hello\nworld\n');
    const res = await request(app)
      .get('/api/diff/baseline')
      .query({ cwd, path: 'note.txt', sessionId: SESSION });
    expect(res.status).toBe(200);
    expect(res.body.baseline).toBe('');
    expect(res.body.current).toBe('hello\nworld\n');
    expect(res.body.capturedFrom).toBe('empty');
  });

  it('GET /baseline uses a captured snapshot as the base (control: happy path)', async () => {
    await fs.writeFile(path.join(cwd, 'app.ts'), 'const a = 1;\n');
    await editBaselineStore.captureFromDisk(SESSION, path.join(cwd, 'app.ts'));
    await fs.writeFile(path.join(cwd, 'app.ts'), 'const a = 2;\n');
    const res = await request(app)
      .get('/api/diff/baseline')
      .query({ cwd, path: 'app.ts', sessionId: SESSION });
    expect(res.status).toBe(200);
    expect(res.body.baseline).toBe('const a = 1;\n');
    expect(res.body.current).toBe('const a = 2;\n');
    expect(res.body.capturedFrom).toBe('pre-tool');
  });
  // --- Chunk B: baseline image bytes + whole-file revert -------------------

  const PNG_V1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const PNG_V2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);

  it('GET /baseline/raw through a symlinked parent cannot read outside cwd (403)', async () => {
    await fs.writeFile(path.join(outside, 'secret.png'), PNG_V1);
    const res = await request(app)
      .get('/api/diff/baseline/raw')
      .query({ cwd, path: 'link/secret.png', sessionId: SESSION });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });

  it('GET /baseline/raw with a ../ path is rejected (403)', async () => {
    const res = await request(app)
      .get('/api/diff/baseline/raw')
      .query({ cwd, path: '../outside/secret.png', sessionId: SESSION });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });

  it('GET /baseline/raw rejects a null-byte path (400)', async () => {
    const qs = `cwd=${encodeURIComponent(cwd)}&path=a%00b.png&sessionId=${SESSION}`;
    const res = await request(app).get(`/api/diff/baseline/raw?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NULL_BYTE');
  });

  it('GET /baseline/raw serves ONLY media types (415 for .ts)', async () => {
    await fs.writeFile(path.join(cwd, 'app.ts'), 'code\n');
    await editBaselineStore.captureFromDisk(SESSION, path.join(cwd, 'app.ts'));
    const res = await request(app)
      .get('/api/diff/baseline/raw')
      .query({ cwd, path: 'app.ts', sessionId: SESSION });
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_TYPE');
  });

  it('GET /baseline/raw is 404 when no baseline exists', async () => {
    await fs.writeFile(path.join(cwd, 'logo.png'), PNG_V2);
    const res = await request(app)
      .get('/api/diff/baseline/raw')
      .query({ cwd, path: 'logo.png', sessionId: SESSION });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NO_BASELINE');
  });

  it('GET /baseline/raw streams the snapshot bytes with the files/raw security posture', async () => {
    const file = path.join(cwd, 'logo.png');
    await fs.writeFile(file, PNG_V1);
    await editBaselineStore.captureFromDisk(SESSION, file);
    await fs.writeFile(file, PNG_V2);

    const res = await request(app)
      .get('/api/diff/baseline/raw')
      .query({ cwd, path: 'logo.png', sessionId: SESSION })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe('inline');
    expect((res.body as Buffer).equals(PNG_V1)).toBe(true);
  });

  it('GET /baseline/raw serves SVGs under the script-neutering CSP sandbox', async () => {
    const file = path.join(cwd, 'icon.svg');
    await fs.writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await editBaselineStore.captureFromDisk(SESSION, file);
    const res = await request(app)
      .get('/api/diff/baseline/raw')
      .query({ cwd, path: 'icon.svg', sessionId: SESSION });
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('POST /revert through a symlinked parent cannot write outside cwd (403)', async () => {
    await fs.writeFile(path.join(outside, 'victim.png'), PNG_V2);
    const res = await request(app)
      .post('/api/diff/revert')
      .send({ cwd, path: 'link/victim.png', sessionId: SESSION });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    // The outside file is untouched.
    expect((await fs.readFile(path.join(outside, 'victim.png'))).equals(PNG_V2)).toBe(true);
  });

  it('POST /revert restores the snapshot bytes to disk (control: happy path)', async () => {
    const file = path.join(cwd, 'logo.png');
    await fs.writeFile(file, PNG_V1);
    await editBaselineStore.captureFromDisk(SESSION, file);
    await fs.writeFile(file, PNG_V2);

    const res = await request(app)
      .post('/api/diff/revert')
      .send({ cwd, path: 'logo.png', sessionId: SESSION });
    expect(res.status).toBe(200);
    expect((await fs.readFile(file)).equals(PNG_V1)).toBe(true);
  });

  it('POST /revert is 404 when nothing is restorable (never deletes)', async () => {
    const file = path.join(cwd, 'new.png');
    await fs.writeFile(file, PNG_V2);
    const res = await request(app)
      .post('/api/diff/revert')
      .send({ cwd, path: 'new.png', sessionId: SESSION });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NO_BASELINE');
    expect((await fs.readFile(file)).equals(PNG_V2)).toBe(true);
  });
});
