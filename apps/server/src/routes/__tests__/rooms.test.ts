/**
 * Route tests for `/api/rooms`, driven through the REAL app mount rather than a
 * bespoke mini-router, so the `app.use('/api/rooms', …)` wiring and the
 * middleware stack in front of it are covered too.
 *
 * `FakeAgentRuntime` stands in for the runtime registry here. The room routes
 * never resolve a runtime in R1 — nothing triggers a turn yet — so what this
 * proves is the other direction: the room surface stands up inside a fully
 * wired app without reaching for one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
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

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    getSessionSettings: vi.fn(async () => null),
    has: vi.fn(() => true),
    listRuntimes: vi.fn(() => [fakeRuntime]),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { createApp, finalizeApp } from '../../app.js';
import { createRoomSubsystem, setRoomService } from '../../services/rooms/index.js';

const app = createApp();
finalizeApp(app);

const ANA_PATH = '/agents/ana';

/** Register an agent so `POST /:id/members` can resolve it by directory. */
function registerAna(db: Db): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: 'ULID_ANA',
      name: 'ana',
      displayName: 'Ana',
      runtime: 'claude-code',
      projectPath: ANA_PATH,
      behaviorJson: '{"responseMode":"always"}',
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

/** Create a channel and return its body. */
async function createChannel(title = 'Backend'): Promise<Record<string, never> & { id: string }> {
  const res = await request(app).post('/api/rooms').send({ kind: 'channel', title });
  expect(res.status).toBe(201);
  return res.body;
}

describe('/api/rooms', () => {
  let db: Db;

  beforeEach(() => {
    fakeRuntime = new FakeAgentRuntime();
    vi.clearAllMocks();
    db = createTestDb();
    registerAna(db);
    setRoomService(createRoomSubsystem({ db }).service);
  });

  describe('POST /', () => {
    it('creates a channel and returns it with its roster', async () => {
      const res = await request(app)
        .post('/api/rooms')
        .send({ kind: 'channel', title: 'Backend', topic: 'the API' });

      expect(res.status).toBe(201);
      expect(res.body.slug).toBe('backend');
      expect(res.body.topic).toBe('the API');
      expect(res.body.members).toHaveLength(1);
    });

    it('rejects a body with neither a title nor a slug', async () => {
      const res = await request(app).post('/api/rooms').send({ kind: 'channel' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('409s a duplicate live channel slug', async () => {
      await request(app).post('/api/rooms').send({ kind: 'channel', slug: 'general', title: 'G' });
      const res = await request(app)
        .post('/api/rooms')
        .send({ kind: 'channel', slug: 'general', title: 'G' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SLUG_TAKEN');
    });
  });

  describe('GET /', () => {
    it('lists rooms with the caller unread count', async () => {
      const room = await createChannel();
      await request(app).post(`/api/rooms/${room.id}/entries`).send({ text: 'hello' });

      const res = await request(app).get('/api/rooms');
      expect(res.status).toBe(200);
      expect(res.body.rooms).toHaveLength(1);
      expect(res.body.rooms[0].unreadCount).toBe(1);
    });

    it('filters by kind', async () => {
      await createChannel();
      await request(app).post('/api/rooms').send({ kind: 'dm', title: 'Ana' });

      const res = await request(app).get('/api/rooms').query({ kind: 'dm' });
      expect(res.body.rooms.map((r: { kind: string }) => r.kind)).toEqual(['dm']);
    });

    it('hides archived rooms unless asked', async () => {
      const room = await createChannel();
      await request(app).patch(`/api/rooms/${room.id}`).send({ archived: true });

      expect((await request(app).get('/api/rooms')).body.rooms).toHaveLength(0);
      const withArchived = await request(app).get('/api/rooms').query({ includeArchived: 'true' });
      expect(withArchived.body.rooms).toHaveLength(1);
    });
  });

  describe('GET /:id', () => {
    it('returns one room with its roster', async () => {
      const room = await createChannel();
      const res = await request(app).get(`/api/rooms/${room.id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(room.id);
    });

    it('404s an unknown room', async () => {
      const res = await request(app).get('/api/rooms/nope');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ROOM_NOT_FOUND');
    });
  });

  describe('POST /:id/entries', () => {
    it('accepts with 202 and returns the entry identity, not the entry', async () => {
      const room = await createChannel();
      const res = await request(app).post(`/api/rooms/${room.id}/entries`).send({ text: 'hello' });

      // Trigger-only, mirroring POST /api/sessions/:id/messages: delivery is
      // the SSE stream's job, so the body carries identity and nothing else.
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: true, entryId: expect.any(String), seq: 1 });
      expect(res.body.entry).toBeUndefined();
    });

    it('rejects an empty message', async () => {
      const room = await createChannel();
      const res = await request(app).post(`/api/rooms/${room.id}/entries`).send({ text: '' });
      expect(res.status).toBe(400);
    });

    it('409s a post into an archived room', async () => {
      const room = await createChannel();
      await request(app).patch(`/api/rooms/${room.id}`).send({ archived: true });

      const res = await request(app).post(`/api/rooms/${room.id}/entries`).send({ text: 'hi' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ROOM_ARCHIVED');
    });

    it('does not let the body choose an author', async () => {
      const room = await createChannel();
      await request(app)
        .post(`/api/rooms/${room.id}/entries`)
        .send({ text: 'hi', authorId: 'somebody-else' });

      const entries = await request(app).get(`/api/rooms/${room.id}/entries`);
      const roster = await request(app).get(`/api/rooms/${room.id}`);
      expect(entries.body.entries[0].authorId).toBe(roster.body.members[0].authorId);
    });
  });

  describe('GET /:id/entries', () => {
    it('pages backwards from a seq', async () => {
      const room = await createChannel();
      for (const text of ['one', 'two', 'three']) {
        await request(app).post(`/api/rooms/${room.id}/entries`).send({ text });
      }

      const page = await request(app)
        .get(`/api/rooms/${room.id}/entries`)
        .query({ before: 3, limit: 2 });
      expect(page.body.entries.map((e: { seq: number }) => e.seq)).toEqual([1, 2]);
    });

    it('rejects an out-of-range limit rather than clamping it silently', async () => {
      const room = await createChannel();
      const res = await request(app).get(`/api/rooms/${room.id}/entries`).query({ limit: 5000 });
      expect(res.status).toBe(400);
    });
  });

  describe('members', () => {
    it('adds an agent by its directory and seeds a channel to mention-only', async () => {
      const room = await createChannel();
      const res = await request(app)
        .post(`/api/rooms/${room.id}/members`)
        .send({ agentPath: ANA_PATH });

      expect(res.status).toBe(201);
      expect(res.body.responseMode).toBe('mention-only');
      expect(res.body.author.displayName).toBe('Ana');
    });

    it('never puts the agent directory on the wire', async () => {
      const room = await createChannel();
      const res = await request(app)
        .post(`/api/rooms/${room.id}/members`)
        .send({ agentPath: ANA_PATH });
      expect(JSON.stringify(res.body)).not.toContain(ANA_PATH);
    });

    it('404s an agent path nothing is registered at', async () => {
      const room = await createChannel();
      const res = await request(app)
        .post(`/api/rooms/${room.id}/members`)
        .send({ agentPath: '/agents/ghost' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('AGENT_NOT_FOUND');
    });

    it('changes a response mode', async () => {
      const room = await createChannel();
      const added = await request(app)
        .post(`/api/rooms/${room.id}/members`)
        .send({ agentPath: ANA_PATH });

      const res = await request(app)
        .patch(`/api/rooms/${room.id}/members/${added.body.authorId}`)
        .send({ responseMode: 'always' });

      expect(res.status).toBe(200);
      expect(res.body.responseMode).toBe('always');
    });

    it('rejects a response mode outside the shared enum', async () => {
      const room = await createChannel();
      const added = await request(app)
        .post(`/api/rooms/${room.id}/members`)
        .send({ agentPath: ANA_PATH });

      const res = await request(app)
        .patch(`/api/rooms/${room.id}/members/${added.body.authorId}`)
        .send({ responseMode: 'sometimes' });
      expect(res.status).toBe(400);
    });

    it('removes a member with 204', async () => {
      const room = await createChannel();
      const added = await request(app)
        .post(`/api/rooms/${room.id}/members`)
        .send({ agentPath: ANA_PATH });

      const res = await request(app).delete(`/api/rooms/${room.id}/members/${added.body.authorId}`);
      expect(res.status).toBe(204);

      const again = await request(app).delete(
        `/api/rooms/${room.id}/members/${added.body.authorId}`
      );
      expect(again.status).toBe(404);
    });
  });

  describe('PUT /:id/read-cursor', () => {
    it('advances the caller cursor and clears the unread count', async () => {
      const room = await createChannel();
      await request(app).post(`/api/rooms/${room.id}/entries`).send({ text: 'hello' });

      const res = await request(app)
        .put(`/api/rooms/${room.id}/read-cursor`)
        .send({ lastReadSeq: 1 });
      expect(res.status).toBe(200);
      expect(res.body.lastReadSeq).toBe(1);

      const list = await request(app).get('/api/rooms');
      expect(list.body.rooms[0].unreadCount).toBe(0);
    });
  });

  describe('POST /:id/threads', () => {
    it('opens a thread off an entry', async () => {
      const room = await createChannel();
      const posted = await request(app)
        .post(`/api/rooms/${room.id}/entries`)
        .send({ text: 'why is the build slow?' });

      const res = await request(app)
        .post(`/api/rooms/${room.id}/threads`)
        .send({ rootEntryId: posted.body.entryId });

      expect(res.status).toBe(201);
      expect(res.body.kind).toBe('thread');
      expect(res.body.parentId).toBe(room.id);
    });

    it('400s a thread off a thread', async () => {
      const room = await createChannel();
      const posted = await request(app)
        .post(`/api/rooms/${room.id}/entries`)
        .send({ text: 'why is the build slow?' });
      const thread = await request(app)
        .post(`/api/rooms/${room.id}/threads`)
        .send({ rootEntryId: posted.body.entryId });
      const inThread = await request(app)
        .post(`/api/rooms/${thread.body.id}/entries`)
        .send({ text: 'follow-up' });

      const res = await request(app)
        .post(`/api/rooms/${thread.body.id}/threads`)
        .send({ rootEntryId: inThread.body.entryId });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NESTED_THREAD');
    });
  });
});
