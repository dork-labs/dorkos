/**
 * @vitest-environment node
 *
 * `GET /api/documents/index` (DOR-2982): the docs in one space while the Docs
 * experiment is on, the `/api` 404 while it is off, and the files routes'
 * directory boundary on `cwd`. The space is a real temporary folder.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const config = vi.hoisted(() => ({ docs: undefined as { enabled: boolean } | undefined }));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'docs' ? config.docs : undefined) },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { ApiEnv } from '../../http/api-chain.js';
import { initBoundary } from '../../lib/boundary.js';
import { resetDocIndexCacheForTests } from '../../services/docs/links/doc-index.js';
import { createDocLinkRoutes, type DocLinkRouteDeps } from '../docs-links.js';

let base: string;
let space: string;

/** The routes mounted where the app mounts them. */
function app(deps?: DocLinkRouteDeps): Hono<ApiEnv> {
  return new Hono<ApiEnv>().route('/api/documents', createDocLinkRoutes(deps));
}

/** `GET /api/documents/index` for one working directory. */
function getIndex(target: Hono<ApiEnv>, cwd: string | null): Promise<Response> {
  const query = cwd === null ? '' : `?cwd=${encodeURIComponent(cwd)}`;
  return Promise.resolve(target.request(`/api/documents/index${query}`));
}

beforeEach(async () => {
  resetDocIndexCacheForTests();
  config.docs = { enabled: true };
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'docs-links-route-')));
  space = path.join(base, 'space');
  mkdirSync(path.join(space, 'notes'), { recursive: true });
  writeFileSync(path.join(space, 'README.md'), '# Welcome\n');
  writeFileSync(path.join(space, 'notes', 'plan.md'), '---\ntitle: Launch plan\n---\n');
  await initBoundary(space);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('GET /api/documents/index', () => {
  it('lists the space’s docs while Docs is on', async () => {
    const res = await getIndex(app(), space);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await expect(res.json()).resolves.toEqual({
      docs: [
        { path: 'README.md', title: 'Welcome', slug: 'readme' },
        { path: 'notes/plan.md', title: 'Launch plan', slug: 'plan' },
      ],
      truncated: false,
    });
  });

  it('answers the /api 404 while Docs is off, read on every request', async () => {
    const live = app();
    config.docs = { enabled: false };
    const off = await getIndex(live, space);
    expect(off.status).toBe(404);
    await expect(off.json()).resolves.toEqual({ error: 'Not found', code: 'API_NOT_FOUND' });

    config.docs = undefined;
    expect((await getIndex(live, space)).status).toBe(404);

    config.docs = { enabled: true };
    expect((await getIndex(live, space)).status).toBe(200);
  });

  it('never reads the disk while Docs is off', async () => {
    const index = vi.fn();
    const res = await getIndex(app({ enabled: () => false, index }), space);
    expect(res.status).toBe(404);
    expect(index).not.toHaveBeenCalled();
  });

  it('refuses a request with no cwd', async () => {
    const res = await getIndex(app(), null);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'Invalid query' });
  });

  it('refuses a cwd that is relative or not an existing folder', async () => {
    for (const cwd of ['space', path.join(space, 'missing'), path.join(space, 'README.md')]) {
      const res = await getIndex(app(), cwd);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_DOC_SPACE' });
    }
  });

  it('refuses a cwd outside the directory boundary', async () => {
    const res = await getIndex(app(), base);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'Access denied: path outside directory boundary',
      code: 'OUTSIDE_BOUNDARY',
    });
  });

  it('answers 500 in plain words when the listing fails', async () => {
    const index = vi.fn().mockRejectedValue(new Error('disk gone'));
    const res = await getIndex(app({ enabled: () => true, index }), space);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'Couldn’t list the docs here.',
      code: 'DOC_INDEX_FAILED',
    });
  });

  it('gates only its own paths, so another /api/documents group still answers', async () => {
    const shared = app({ enabled: () => false, index: vi.fn() });
    shared.get('/api/documents/other', (c) => c.text('other group'));
    const res = await shared.request('/api/documents/other');
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('other group');
  });
});
