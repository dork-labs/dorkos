/**
 * `GET /api/projects` and `GET /api/projects/resolve` (spec `flow-multiproject`
 * §6.1), over the real boundary check and real git repositories.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import {
  ProjectListResponseSchema,
  ProjectResolveResponseSchema,
} from '@dorkos/shared/project-schemas';

import { initBoundary } from '../../lib/boundary.js';
import projectRoutes from '../projects.js';
import { ProjectRegistry } from '../../services/projects/project-registry.js';

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

let base: string;
let inside: string;
let worktree: string;
let outside: string;
let worktreeOfOutside: string;
let fakeGitFile: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

const app = express();
app.use('/api/projects', projectRoutes);
const server = listeningServer(app);

beforeAll(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'projects-route-')));
  const home = path.join(base, 'home');
  inside = path.join(home, 'dev', 'dorkos');
  mkdirSync(inside, { recursive: true });
  git(inside, 'init', '-q', '-b', 'main');
  git(
    inside,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'i'
  );
  worktree = path.join(home, '.dork', 'workspaces', 'dorkos', 'dor-1');
  mkdirSync(path.dirname(worktree), { recursive: true });
  git(inside, 'worktree', 'add', '-q', '-b', 'dor-1', worktree);
  outside = path.join(base, 'elsewhere');
  mkdirSync(outside, { recursive: true });
  git(outside, 'init', '-q', '-b', 'main');
  git(
    outside,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'i'
  );
  // Two ways a folder INSIDE the boundary can belong to a repository OUTSIDE it:
  // a linked worktree of the outside repository...
  worktreeOfOutside = path.join(home, 'wt-of-outside');
  git(outside, 'worktree', 'add', '-q', '-b', 'escape', worktreeOfOutside);
  // ...and a `.git` FILE pointing at the outside repository's git dir.
  fakeGitFile = path.join(home, 'fake');
  mkdirSync(fakeGitFile, { recursive: true });
  writeFileSync(path.join(fakeGitFile, '.git'), `gitdir: ${path.join(outside, '.git')}\n`);
  await initBoundary(home);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('GET /api/projects/resolve', () => {
  it('maps a worktree to its main checkout', async () => {
    const res = await request(server).get('/api/projects/resolve').query({ cwd: worktree });
    expect(res.status).toBe(200);
    expect(ProjectResolveResponseSchema.parse(res.body)).toEqual({
      project: { root: inside, name: 'dorkos' },
    });
  });

  it('answers null for a folder in no repository', async () => {
    const plain = path.join(base, 'home', 'plain');
    mkdirSync(plain, { recursive: true });
    const res = await request(server).get('/api/projects/resolve').query({ cwd: plain });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ project: null });
  });

  it('refuses a folder outside the directory boundary with 403', async () => {
    const res = await request(server).get('/api/projects/resolve').query({ cwd: outside });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });

  it('refuses a missing cwd with 400', async () => {
    const res = await request(server).get('/api/projects/resolve');
    expect(res.status).toBe(400);
  });
});

describe('a folder inside the boundary whose repository is outside it (real git)', () => {
  it.each([
    ['a linked worktree of an outside repository', () => worktreeOfOutside],
    ['a .git file pointing at an outside repository', () => fakeGitFile],
  ])('refuses %s with 403, and never names the outside folder', async (_what, dir) => {
    const res = await request(server).get('/api/projects/resolve').query({ cwd: dir() });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    expect(JSON.stringify(res.body)).not.toContain(outside);
  });

  it.each([
    ['a linked worktree of an outside repository', () => worktreeOfOutside],
    ['a .git file pointing at an outside repository', () => fakeGitFile],
  ])('answers null to an extension for %s and records nothing', async (_what, dir) => {
    // The real registry, real boundary and real git.
    const registry = new ProjectRegistry();
    expect(await registry.report(dir(), 'flow')).toBeNull();
    expect(await registry.resolveWithin(dir(), 'flow')).toBe('outside');
    expect(registry.get(outside)).toBeUndefined();
    expect(await registry.listForExtension('flow')).toEqual([]);
  });
});

describe('GET /api/projects', () => {
  it('does not list a folder that was only looked up: a lookup never makes it seen', async () => {
    await request(server).get('/api/projects/resolve').query({ cwd: worktree });
    const res = await request(server).get('/api/projects');
    expect(res.status).toBe(200);
    expect(ProjectListResponseSchema.parse(res.body).projects).toEqual([]);
  });

  it('lists it once a real session folder is seen there', async () => {
    const { projectRegistry } = await import('../../services/projects/project-registry.js');
    await projectRegistry.resolve(worktree);
    const res = await request(server).get('/api/projects');
    const { projects } = ProjectListResponseSchema.parse(res.body);
    expect(projects).toEqual([
      expect.objectContaining({ root: inside, name: 'dorkos', originRepo: null }),
    ]);
  });
});
