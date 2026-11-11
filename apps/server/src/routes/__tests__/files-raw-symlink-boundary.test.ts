import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
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
// The one non-path-safety stub: reveal's side effect is opening a desktop file
// manager, which a test must never do. Mocked so "did the boundary stop it?"
// can be asked as "was the launcher reached at all?".
vi.mock('../../lib/reveal-in-file-manager.js', () => ({
  revealInFileManager: vi.fn().mockResolvedValue(undefined),
}));

import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { composedListener } from '../../http/__tests__/composed-listener.js';
import { initBoundary } from '../../lib/boundary.js';

const admission = new MainRequestAdmission();
// Routed as the running server routes: the moved groups answer from Hono.
const testServer = listeningServer(composedListener(admission));

describe('DOR-3522 proof: media and content reads through a symlinked folder', () => {
  let root: string; // the global boundary (stands in for the home folder)
  let cwd: string; // the agent's folder
  let volume: string; // stands in for /Volumes/ext-ssd-1: outside the boundary entirely
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor3522-home-')));
    volume = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor3522-volume-')));
    await initBoundary(root);
    cwd = path.join(root, 'media-manager');
    await fs.mkdir(cwd);
    await fs.mkdir(path.join(volume, 'exports'));
    await fs.writeFile(path.join(volume, 'exports', 'clip.mp4'), Buffer.from('not really a video'));
    await fs.writeFile(path.join(volume, 'exports', 'notes.txt'), 'outside text\n');
    await fs.symlink(path.join(volume, 'exports'), path.join(cwd, 'library-exports'), 'dir');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(volume, { recursive: true, force: true });
  });
  it('GET /raw (video) through the link is 403 and serves no bytes', async () => {
    const res = await request(testServer)
      .get('/api/files/raw')
      .query({ cwd, path: 'library-exports/clip.mp4' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });
  it('GET /raw with the absolute target path is 403', async () => {
    const res = await request(testServer)
      .get('/api/files/raw')
      .query({ cwd, path: path.join(volume, 'exports', 'clip.mp4') });
    expect(res.status).toBe(403);
  });
  it('GET /content through the link is 403', async () => {
    const res = await request(testServer)
      .get('/api/files/content')
      .query({ cwd, path: 'library-exports/notes.txt' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });
  it('control: a real video inside the folder is served (200)', async () => {
    await fs.writeFile(path.join(cwd, 'own.mp4'), Buffer.from('mine'));
    const res = await request(testServer).get('/api/files/raw').query({ cwd, path: 'own.mp4' });
    expect(res.status).toBe(200);
  });
});
