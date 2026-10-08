import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionLocations } from '@dorkos/db';
import { initBoundary } from '../../lib/boundary.js';
import { createSessionLocationsRouter, MAX_SESSION_LOCATIONS } from '../session-locations.js';

vi.mock('../extensions-person-bar.js', () => ({
  refuseIfNotAPerson: (req: express.Request, res: express.Response) => {
    if (req.headers['x-dorkos-agent']) {
      res.status(403).json({ error: 'Person required' });
      return true;
    }
    return false;
  },
}));
vi.mock('../../services/core/auth/index.js', () => ({ readOwnerAccount: () => null }));

let root: string;
let db: ReturnType<typeof createTestDb>;
const listener = swappableServer();
function app(owner = 'owner-a') {
  const result = express();
  result.use(express.json(), (_req, res, next) => {
    res.locals.user = { userId: owner, credential: 'cookie' };
    next();
  });
  result.use('/api/session-locations', createSessionLocationsRouter(db));
  return listener.mount(result);
}
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'session-locations-'));
  mkdirSync(path.join(root, 'folder'));
  db = createTestDb();
  await initBoundary(root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('opaque session locations', () => {
  it('reuses a canonical folder and survives rebuilding the router', async () => {
    const cwd = path.join(root, 'folder');
    const created = await request(app()).post('/api/session-locations').send({ cwd }).expect(201);
    expect(created.body.id).toMatch(/^[\da-f-]{36}$/);
    expect(JSON.stringify(created.body)).not.toContain(root);
    const again = await request(app())
      .post('/api/session-locations')
      .send({ cwd: path.join(root, 'folder', '..', 'folder') })
      .expect(200);
    expect(again.body).toEqual(created.body);
    await request(app())
      .get(`/api/session-locations/${created.body.id}`)
      .expect(200, { cwd: realpathSync(cwd) });
    expect(db.select().from(sessionLocations).all()).toHaveLength(1);
  });
  it("does not expose another caller's folder", async () => {
    const created = await request(app())
      .post('/api/session-locations')
      .send({ cwd: root })
      .expect(201);
    await request(app('owner-b')).get(`/api/session-locations/${created.body.id}`).expect(404);
    await request(app())
      .get('/api/session-locations/00000000-0000-4000-8000-000000000000')
      .expect(404);
  });
  it('checks traversal on creation and boundary changes on resolution', async () => {
    await request(app())
      .post('/api/session-locations')
      .send({ cwd: path.join(root, '..') })
      .expect(403);
    const created = await request(app())
      .post('/api/session-locations')
      .send({ cwd: root })
      .expect(201);
    await initBoundary(path.join(root, 'folder'));
    await request(app()).get(`/api/session-locations/${created.body.id}`).expect(403);
  });
  it('allows system-agent folders outside the project boundary without allowing data siblings', async () => {
    const project = path.join(root, 'folder');
    const dorkHome = path.join(root, 'data');
    const agent = path.join(dorkHome, 'agents', 'dorkbot');
    const secrets = path.join(dorkHome, 'extension-secrets');
    mkdirSync(agent, { recursive: true });
    mkdirSync(secrets);
    vi.stubEnv('DORK_HOME', dorkHome);
    await initBoundary(project);
    const created = await request(app())
      .post('/api/session-locations')
      .send({ cwd: agent })
      .expect(201);
    await request(app())
      .get(`/api/session-locations/${created.body.id}`)
      .expect(200, { cwd: realpathSync(agent) });
    for (const cwd of [dorkHome, secrets]) {
      await request(app()).post('/api/session-locations').send({ cwd }).expect(403);
      const id = randomUUID();
      db.insert(sessionLocations)
        .values({ id, ownerId: 'owner-a', cwd, createdAt: '2026-10-06T00:00:00Z' })
        .run();
      await request(app()).get(`/api/session-locations/${id}`).expect(403);
    }
  });
  it('refuses escaping agent symlinks on creation and revalidates saved references on read', async () => {
    const dorkHome = path.join(root, 'data');
    const agents = path.join(dorkHome, 'agents');
    const secrets = path.join(dorkHome, 'extension-secrets');
    mkdirSync(agents, { recursive: true });
    mkdirSync(secrets);
    vi.stubEnv('DORK_HOME', dorkHome);
    await initBoundary(path.join(root, 'folder'));
    const escape = path.join(agents, 'escape');
    symlinkSync(secrets, escape);
    await request(app()).post('/api/session-locations').send({ cwd: escape }).expect(403);
    const agent = path.join(agents, 'dorkbot');
    mkdirSync(agent);
    const created = await request(app())
      .post('/api/session-locations')
      .send({ cwd: agent })
      .expect(201);
    rmSync(agent, { recursive: true });
    symlinkSync(secrets, agent);
    await request(app()).get(`/api/session-locations/${created.body.id}`).expect(403);
    unlinkSync(agent);
  });
  it('caps new folders without invalidating or refusing saved folders', async () => {
    db.insert(sessionLocations)
      .values(
        Array.from({ length: MAX_SESSION_LOCATIONS }, (_, index) => ({
          id: `existing-${index}`,
          ownerId: 'owner-a',
          cwd: index === 0 ? realpathSync(root) : `/saved/${index}`,
          createdAt: '2026-10-06T00:00:00Z',
        }))
      )
      .run();
    await request(app())
      .post('/api/session-locations')
      .send({ cwd: path.join(root, 'folder') })
      .expect(409);
    await request(app())
      .post('/api/session-locations')
      .send({ cwd: root })
      .expect(200, { id: 'existing-0' });
    expect(db.select().from(sessionLocations).all()).toHaveLength(MAX_SESSION_LOCATIONS);
  });
  it('refuses cross-site and agent callers before registering a folder', async () => {
    await request(app())
      .post('/api/session-locations')
      .set('sec-fetch-site', 'cross-site')
      .send({ cwd: root })
      .expect(403);
    await request(app())
      .post('/api/session-locations')
      .set('x-dorkos-agent', 'agent')
      .send({ cwd: root })
      .expect(403);
    expect(db.select().from(sessionLocations).all()).toHaveLength(0);
  });
});
