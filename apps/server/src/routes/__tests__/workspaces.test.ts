/**
 * Route tests for /api/workspaces — thin handlers over the WorkspaceManager.
 * Locks the contract the browser test surfaced: a dirty refusal is a 200 with
 * `blocked: 'dirty'` in the body (so the client can escalate), NOT a 409 the
 * generic fetch layer would swallow into a opaque error.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtemp, rm, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import workspaceRoutes from '../workspaces.js';
import { setWorkspaceManager, setWorkspaceRoot } from '../../services/workspace/index.js';
import type { WorkspaceManager, Workspace } from '@dorkos/shared/workspace';

function mountWith(manager: Partial<WorkspaceManager>): Express {
  setWorkspaceManager(manager as WorkspaceManager);
  const app = express();
  app.use(express.json());
  app.use('/api/workspaces', workspaceRoutes);
  return app;
}

const sampleWorkspace: Workspace = {
  owner: null,
  id: 'w1',
  projectKey: 'core',
  key: 'DOR-84',
  path: '/root/core/DOR-84',
  source: '/repo',
  branch: 'dork/DOR-84',
  provider: 'worktree',
  status: 'ready',
  portBase: 4250,
  portBlockSize: 10,
  hostname: null,
  url: null,
  pinned: false,
  createdAt: '2026-06-16T00:00:00.000Z',
  lastUsedAt: '2026-06-16T00:00:00.000Z',
};

describe('workspaces routes', () => {
  it('GET / returns the workspace list', async () => {
    const app = mountWith({
      list: vi.fn().mockResolvedValue([{ ...sampleWorkspace, sessions: [] }]),
    });
    const res = await request(app).get('/api/workspaces');
    expect(res.status).toBe(200);
    expect(res.body.workspaces).toHaveLength(1);
  });

  it('GET /resolve maps a nested path to its workspace', async () => {
    const app = mountWith({ resolveByPath: vi.fn().mockResolvedValue(sampleWorkspace) });
    const res = await request(app)
      .get('/api/workspaces/resolve')
      .query({ path: '/root/core/DOR-84/x' });
    expect(res.status).toBe(200);
    expect(res.body.workspace.id).toBe('w1');
  });

  it('DELETE returns 200 + blocked:dirty for a dirty workspace (not 409)', async () => {
    const app = mountWith({
      remove: vi.fn().mockResolvedValue({
        removed: false,
        blocked: 'dirty',
        dirty: { dirty: true, uncommitted: [], untracked: ['scratch.txt'], unpushed: 0 },
      }),
    });
    const res = await request(app).delete('/api/workspaces/w1');
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(false);
    expect(res.body.blocked).toBe('dirty');
  });

  it('DELETE returns 404 when the workspace does not exist', async () => {
    const app = mountWith({ remove: vi.fn().mockResolvedValue({ removed: false }) });
    const res = await request(app).delete('/api/workspaces/missing');
    expect(res.status).toBe(404);
  });

  it('DELETE returns the result on a clean removal', async () => {
    const app = mountWith({ remove: vi.fn().mockResolvedValue({ removed: true }) });
    const res = await request(app).delete('/api/workspaces/w1');
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
  });
});

/**
 * The adoption scan (DOR-1056). Driven against a real temp root, because the
 * route's job is to hand back what is genuinely on disk — and because `/scan`
 * has to beat the `/:id` parameter route, which a mocked service could not show.
 */
describe('GET /api/workspaces/scan', () => {
  let base: string;
  let root: string;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'ws-scan-route-')));
    root = path.join(base, 'workspaces');
    const source = path.join(base, 'source');
    await mkdir(path.join(root, 'core'), { recursive: true });
    await mkdir(source, { recursive: true });

    execFileSync('git', ['init', '-b', 'main', '.'], { cwd: source, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: source, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: source, stdio: 'pipe' });
    await writeFile(path.join(source, 'README.md'), '# s\n');
    execFileSync('git', ['add', '.'], { cwd: source, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: source, stdio: 'pipe' });
    execFileSync('git', ['worktree', 'add', path.join(root, 'core', 'DOR-1056'), '-b', 'scan'], {
      cwd: source,
      stdio: 'pipe',
    });
  }, 60_000);

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('returns the checkouts found under the registered root', async () => {
    setWorkspaceRoot(root);
    const app = mountWith({});

    const res = await request(app).get('/api/workspaces/scan');

    expect(res.status).toBe(200);
    expect(res.body.root).toBe(root);
    expect(res.body.worktrees).toHaveLength(1);
    expect(res.body.worktrees[0]).toMatchObject({
      name: 'DOR-1056',
      project: 'core',
      branch: 'scan',
      readable: true,
    });
  });

  it('is not swallowed by the /:id route', async () => {
    setWorkspaceRoot(root);
    // `get` is what `/:id` would call. If `/scan` were declared after it, the
    // literal path would be read as an id and this spy would fire.
    const get = vi.fn().mockResolvedValue(null);
    const app = mountWith({ get });

    const res = await request(app).get('/api/workspaces/scan');

    expect(res.status).toBe(200);
    expect(get).not.toHaveBeenCalled();
  });
});
