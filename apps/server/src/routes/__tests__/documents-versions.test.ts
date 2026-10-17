/**
 * `/api/documents/versions` (DOR-2984): the `/api` 404 while Docs are off,
 * a doc's saved versions newest first, and a restore that puts one back and
 * keeps what it replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// The chain reads config (login off) and the session gate (a person at this computer).
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn(() => undefined),
    set: vi.fn(),
    onChange: vi.fn(() => () => undefined),
  },
}));
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createDocumentVersionRoutes } from '../documents-versions.js';
import type { DocCollabService } from '../../services/docs/collab/index.js';
import {
  makeService,
  makeSpace,
  type TestSpace,
} from '../../services/docs/collab/__tests__/collab-harness.js';

const target = swappableServer();
let space: TestSpace;
let service: DocCollabService;
let enabled: boolean;

beforeEach(async () => {
  enabled = true;
  space = await makeSpace();
  ({ service } = makeService(space));
});

afterEach(async () => {
  await service.stop();
  space.cleanup();
});

function app() {
  return target.mount(
    honoGroupListener({
      path: '/api/documents/versions',
      routes: createDocumentVersionRoutes({ enabled: () => enabled, service: () => service }),
    })
  );
}

describe('/api/documents/versions', () => {
  it('answers the /api 404 while Docs are off', async () => {
    enabled = false;
    const res = await request(app())
      .get('/api/documents/versions')
      .query({ cwd: space.space, path: 'a.md' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('API_NOT_FOUND');
    const restore = await request(app())
      .post('/api/documents/versions/restore')
      .send({ cwd: space.space, path: 'a.md', versionId: 'x' });
    expect(restore.status).toBe(404);
  });

  it('lists a doc’s versions and restores one, keeping what it replaced', async () => {
    const rel = space.write('plan.md', 'Mine.\n');
    await service.write({ cwd: space.space, path: rel }, 'The agent’s.\n', {
      writer: { kind: 'agent', name: 'Ada' },
    });

    const listed = await request(app())
      .get('/api/documents/versions')
      .query({ cwd: space.space, path: rel });
    expect(listed.status).toBe(200);
    expect(listed.body.versions).toHaveLength(1);
    expect(listed.body.versions[0].changedBy).toEqual({ kind: 'agent', name: 'Ada' });

    const restored = await request(app())
      .post('/api/documents/versions/restore')
      .send({ cwd: space.space, path: rel, versionId: listed.body.versions[0].id });
    expect(restored.status).toBe(200);
    expect(restored.body).toEqual({ ok: true, live: false });
    expect(readFileSync(path.join(space.space, rel), 'utf8')).toBe('Mine.\n');

    const after = await request(app())
      .get('/api/documents/versions')
      .query({ cwd: space.space, path: rel });
    expect(after.body.versions).toHaveLength(2);
    expect(after.body.versions[0].changedBy).toEqual({ kind: 'person' });
  });

  it('keeps unsaved edits as a version that can be put back', async () => {
    const rel = space.write('draft.md', 'On disk.\n');
    const kept = await request(app())
      .post('/api/documents/versions')
      .send({ cwd: space.space, path: rel, markdown: 'Typed offline.\n' });
    expect(kept.status).toBe(200);
    expect(kept.body.version).toMatchObject({
      reason: 'unsaved-edits',
      changedBy: { kind: 'person' },
    });

    await request(app())
      .post('/api/documents/versions/restore')
      .send({ cwd: space.space, path: rel, versionId: kept.body.version.id });
    expect(readFileSync(path.join(space.space, rel), 'utf8')).toBe('Typed offline.\n');
  });

  it('refuses what the files routes refuse', async () => {
    space.write('notes.txt', 'x\n');
    const notMarkdown = await request(app())
      .get('/api/documents/versions')
      .query({ cwd: space.space, path: 'notes.txt' });
    expect(notMarkdown.status).toBe(415);
    const outside = await request(app())
      .get('/api/documents/versions')
      .query({ cwd: space.dorkHome, path: 'x.md' });
    expect(outside.status).toBe(403);
    const missingVersion = await request(app())
      .post('/api/documents/versions/restore')
      .send({
        cwd: space.space,
        path: space.write('a.md', 'a\n'),
        versionId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      });
    expect(missingVersion.status).toBe(404);
  });
});
