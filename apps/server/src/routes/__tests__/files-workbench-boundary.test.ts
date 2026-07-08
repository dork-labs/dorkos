import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Unlike files-workbench.test.ts, this suite uses the REAL boundary module and
// REAL on-disk symlinks so that `..` / symlink-parent escapes are exercised end
// to end. These are the tests that catch the symlinked-parent write-escape
// (C1): a not-yet-existing target under `cwd/link -> /outside` string-contains
// `cwd` but resolves outside it. Only tunnel/config are stubbed (they are
// unrelated to path safety and would otherwise touch real state at app boot).
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

const app = createApp();

describe('Workbench file routes — real boundary + symlink escapes', () => {
  let root: string; // the global boundary
  let cwd: string; // the session working dir (inside root)
  let outside: string; // a sibling dir inside the boundary but OUTSIDE cwd

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dork-real-')));
    await initBoundary(root);
    cwd = path.join(root, 'project');
    outside = path.join(root, 'outside');
    await fs.mkdir(cwd);
    await fs.mkdir(outside);
    // A symlink inside cwd that points at a directory outside cwd.
    await fs.symlink(outside, path.join(cwd, 'link'), 'dir');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('POST create through a symlinked parent cannot escape cwd (403)', async () => {
    const res = await request(app)
      .post('/api/files')
      .send({ cwd, path: 'link/pwned.txt', type: 'file', content: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    // The write did NOT land outside cwd.
    await expect(fs.access(path.join(outside, 'pwned.txt'))).rejects.toThrow();
  });

  it('POST rename with a target through a symlinked parent cannot escape cwd (403)', async () => {
    await fs.writeFile(path.join(cwd, 'src.txt'), 'x\n');
    const res = await request(app)
      .post('/api/files/rename')
      .send({ cwd, from: 'src.txt', to: 'link/pwned.txt' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    await expect(fs.access(path.join(outside, 'pwned.txt'))).rejects.toThrow();
    // Source is untouched.
    expect(await fs.readFile(path.join(cwd, 'src.txt'), 'utf8')).toBe('x\n');
  });

  it('GET content through a symlinked parent cannot read outside cwd (403)', async () => {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret\n');
    const res = await request(app)
      .get('/api/files/content')
      .query({ cwd, path: 'link/secret.txt' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });

  it('DELETE through a symlinked parent cannot remove outside cwd (403)', async () => {
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep\n');
    const res = await request(app).delete('/api/files').query({ cwd, path: 'link/keep.txt' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    // The outside file survives.
    expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it('GET tree does not recurse THROUGH a symlinked directory (no metadata disclosure)', async () => {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret\n');
    const res = await request(app).get('/api/files/tree').query({ cwd, depth: '3' });
    expect(res.status).toBe(200);
    const paths = res.body.entries.map((e: { path: string }) => e.path);
    // The symlink itself is listed at the top level...
    expect(paths).toContain('link');
    // ...but its (outside) contents are never walked.
    expect(paths).not.toContain('link/secret.txt');
    const link = res.body.entries.find((e: { name: string }) => e.name === 'link');
    expect(link.isSymlink).toBe(true);
  });

  it('GET tree with a ../ path param is rejected (403)', async () => {
    const res = await request(app).get('/api/files/tree').query({ cwd, path: '../outside' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });

  it('rejects a null-byte path with 400', async () => {
    // Build the query by hand — a literal %00 in the path that Express decodes to
    // a NUL byte, which validateBoundary must reject.
    const qs = `cwd=${encodeURIComponent(cwd)}&path=a%00b.txt`;
    const res = await request(app).get(`/api/files/content?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NULL_BYTE');
  });

  it('allows a legitimate create inside cwd (control: boundary is not over-eager)', async () => {
    const res = await request(app)
      .post('/api/files')
      .send({ cwd, path: 'nested/ok.txt', type: 'file', content: 'fine' });
    expect(res.status).toBe(201);
    expect(await fs.readFile(path.join(cwd, 'nested', 'ok.txt'), 'utf8')).toBe('fine');
  });
});
