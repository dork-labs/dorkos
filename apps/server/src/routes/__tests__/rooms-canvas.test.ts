/**
 * The eight canvas routes, driven through the REAL app mount (specs
 * `room-canvas` §4 and `canvas-agent-seat` §8).
 *
 * What only a route test can reach: the membership gate as the identity
 * middleware really resolves it, the status a refusal becomes, and the fact that
 * the canvas router is mounted at all — a router nobody registered type-checks
 * perfectly and 404s on every path.
 *
 * The claim worth being exact about is the gate: **a room the caller may not see
 * and a room that does not exist answer identically**, so holding a room id is
 * never a way to learn whether it names anything. That is the same rule
 * `GET /:id/events` keeps, and it is asserted here rather than assumed from the
 * shared helper.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request, { type Test } from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  // The review's containment, named here because the module under test imports
  // it. No case in this file reaches them: the people gate runs before the
  // review is asked for anything, and a room with no files of its own is
  // refused before a path is resolved. The symlink rule they carry is pinned
  // where it can be planted, in `canvas/__tests__/canvas-diff-review.test.ts`.
  resolveCanonicalPath: vi.fn(async (p: string) => p),
  isContained: vi.fn(() => true),
  BoundaryError: class BoundaryError extends Error {},
}));

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(),
    get: vi.fn(),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    has: vi.fn(() => true),
    listRuntimes: vi.fn(() => []),
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
import type { RoomEvent } from '@dorkos/shared/room-schemas';
import { createRoomSubsystem, getRoomService, setRoomService } from '../../services/rooms/index.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';

const app = createApp();
finalizeApp(app);

const ANA_PATH = '/agents/ana';

/** Register an agent so the room can resolve it by directory. */
function registerAgent(db: Db, name: string, projectPath: string): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: `ULID_${name.toUpperCase()}`,
      name,
      displayName: name[0].toUpperCase() + name.slice(1),
      runtime: 'claude-code',
      projectPath,
      behaviorJson: '{"responseMode":"silent"}',
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

const testServer = listeningServer(app);

/** A URL document — content with a natural identity, so opens dedupe. */
const urlContent = (url: string) => ({ type: 'url' as const, url });

/**
 * Start listening to a room's live stream, and answer with what it carried.
 *
 * The frames are the assertion for the viewing route: a refusal that still
 * published would be the whole defect with a red status code on top of it.
 *
 * @param roomId - The room to listen to.
 * @returns A function that stops listening and returns the frames.
 */
function collectRoomFrames(roomId: string): () => Promise<RoomEvent[]> {
  const abort = new AbortController();
  const seen: RoomEvent[] = [];
  const reading = (async () => {
    for await (const event of getRoomService().stream.subscribe(roomId, abort.signal)) {
      seen.push(event);
    }
  })();
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    abort.abort();
    await reading;
    return seen;
  };
}

describe('the room canvas routes', () => {
  let db: Db;
  let roomId: string;

  beforeEach(async () => {
    db = createTestDb();
    registerAgent(db, 'ana', ANA_PATH);
    const subsystem = createRoomSubsystem({ db });
    setRoomService(subsystem.service);
    const created = await request(testServer)
      .post('/api/rooms')
      .send({ kind: 'channel', title: 'Backend', agentPaths: [ANA_PATH] });
    roomId = created.body.id;
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  /** Put a document on the table as the person at the keyboard. */
  const open = (url: string, pinned?: boolean) =>
    request(testServer)
      .post(`/api/rooms/${roomId}/canvas`)
      .send({ content: urlContent(url), ...(pinned !== undefined ? { pinned } : {}) });

  it('opens a document and lists it back', async () => {
    const created = await open('https://example.test/a');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      roomId,
      contentType: 'url',
      pinned: false,
      scope: `room:${roomId}`,
    });

    const listed = await request(testServer).get(`/api/rooms/${roomId}/canvas`);
    expect(listed.status).toBe(200);
    expect(listed.body.documents).toHaveLength(1);
    expect(listed.body.documents[0].id).toBe(created.body.id);
  });

  it('reads one document back by id, content included', async () => {
    const created = await open('https://example.test/a');
    const read = await request(testServer).get(`/api/rooms/${roomId}/canvas/${created.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body.content).toEqual({ type: 'url', url: 'https://example.test/a' });
  });

  it('refreshes the document that is already there rather than adding a second', async () => {
    const first = await open('https://example.test/a');
    const second = await open('https://example.test/a');
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.rev).toBeGreaterThan(first.body.rev);
    const listed = await request(testServer).get(`/api/rooms/${roomId}/canvas`);
    expect(listed.body.documents).toHaveLength(1);
  });

  it('changes content, pin and order independently', async () => {
    const created = await open('https://example.test/a');
    const patched = await request(testServer)
      .patch(`/api/rooms/${roomId}/canvas/${created.body.id}`)
      .send({ content: urlContent('https://example.test/b'), pinned: true, activate: true });
    expect(patched.status).toBe(200);
    expect(patched.body.content.url).toBe('https://example.test/b');
    expect(patched.body.pinned).toBe(true);
  });

  it('closes a document, and says nothing more about it', async () => {
    const created = await open('https://example.test/a');
    const closed = await request(testServer).delete(
      `/api/rooms/${roomId}/canvas/${created.body.id}`
    );
    expect(closed.status).toBe(204);
    const read = await request(testServer).get(`/api/rooms/${roomId}/canvas/${created.body.id}`);
    expect(read.status).toBe(404);
    expect(read.body.code).toBe('CANVAS_DOCUMENT_NOT_FOUND');
  });

  it('takes and releases the edit lock', async () => {
    const created = await open('https://example.test/a');
    const held = await request(testServer)
      .post(`/api/rooms/${roomId}/canvas/${created.body.id}/editing`)
      .send({ editing: true });
    expect(held.status).toBe(200);
    expect(held.body.editingBy).not.toBeNull();
    expect(typeof held.body.expiresAt).toBe('string');

    const released = await request(testServer)
      .post(`/api/rooms/${roomId}/canvas/${created.body.id}/editing`)
      .send({ editing: false });
    expect(released.body).toEqual({ editingBy: null, expiresAt: null });
  });

  describe('the gate', () => {
    /**
     * Ask as an agent this machine knows and the room does not.
     *
     * A REAL non-member caller rather than a header the server ignores: the
     * whole point is that `resolveCaller` happily names this caller — that is
     * its job — and the gate is what has to refuse them.
     */
    async function seedOutsider(): Promise<string> {
      const now = new Date().toISOString();
      db.insert(agents)
        .values({
          id: 'ULID_MALLORY',
          name: 'mallory',
          displayName: 'Mallory',
          runtime: 'claude-code',
          projectPath: '/agents/mallory',
          behaviorJson: '{"responseMode":"silent"}',
          registeredAt: now,
          updatedAt: now,
        })
        .run();
      const identity = initAgentIdentityService(db);
      return identity.mint({ agentPath: '/agents/mallory', displayName: 'Mallory' });
    }

    it('refuses a real NON-MEMBER on every route, before it reads anything', async () => {
      const created = await open('https://example.test/private');
      const token = await seedOutsider();
      const asOutsider = (req: Test) => req.set('X-DorkOS-Agent', token);

      const listed = await asOutsider(request(testServer).get(`/api/rooms/${roomId}/canvas`));
      const read = await asOutsider(
        request(testServer).get(`/api/rooms/${roomId}/canvas/${created.body.id}`)
      );
      // The route the gap was found on: a body that asks for nothing used to
      // fall through every branch and answer 200 with the document.
      const patched = await asOutsider(
        request(testServer).patch(`/api/rooms/${roomId}/canvas/${created.body.id}`).send({})
      );
      const deleted = await asOutsider(
        request(testServer).delete(`/api/rooms/${roomId}/canvas/${created.body.id}`)
      );
      const editing = await asOutsider(
        request(testServer)
          .post(`/api/rooms/${roomId}/canvas/${created.body.id}/editing`)
          .send({ editing: true })
      );
      const opened = await asOutsider(
        request(testServer)
          .post(`/api/rooms/${roomId}/canvas`)
          .send({ content: urlContent('https://example.test/theirs') })
      );

      for (const [name, res] of Object.entries({
        listed,
        read,
        patched,
        deleted,
        editing,
        opened,
      })) {
        expect(res.status, `${name} answered a stranger`).toBe(404);
        expect(JSON.stringify(res.body), `${name} leaked the document`).not.toContain(
          'example.test/private'
        );
      }
      // …and nothing they sent landed.
      const listedAsMember = await request(testServer).get(`/api/rooms/${roomId}/canvas`);
      expect(listedAsMember.body.documents).toHaveLength(1);
    });

    it('refuses a MEMBER agent on the viewing route, and paints nothing', async () => {
      // **The hole this closes.** Every spawned agent has an identity token in
      // its environment, so a member agent could POST here and put its own face
      // on any tab with no turn and no claim behind it — and, holding no room
      // stream, nothing would ever take it off again. An agent's face means a
      // turn really read that document, and the server puts it there from
      // `read_canvas`, never from a route (etiquette E16a).
      const created = await open('https://example.test/a');
      const identity = initAgentIdentityService(db);
      const token = await identity.mint({ agentPath: ANA_PATH, displayName: 'Ana' });

      const frames = collectRoomFrames(roomId);
      const res = await request(testServer)
        .post(`/api/rooms/${roomId}/canvas/viewing`)
        .set('X-DorkOS-Agent', token)
        .send({ documentId: created.body.id });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PEOPLE_ONLY');
      // A refusal that still published would be the whole bug with a red status
      // code on it, so the frames are the assertion rather than the status.
      expect(await frames()).toEqual([]);
    });

    it('refuses a MEMBER agent the review of somebody else’s working copy', async () => {
      // **The hole this closes, measured over HTTP by the reviewer.** A member
      // agent holding only the token every spawned agent carries read another
      // member's private copy and overwrote it — 200, the file changed, that
      // member's checkout left dirty, which is the state their own merge then
      // refuses. Both sibling writes (`PUT /:id/files/content`,
      // `POST /:id/canvas/viewing`) refused the SAME token; this did not.
      const created = await open('https://example.test/a');
      const identity = initAgentIdentityService(db);
      const token = await identity.mint({ agentPath: ANA_PATH, displayName: 'Ana' });

      const read = await request(testServer)
        .get(`/api/rooms/${roomId}/canvas/${created.body.id}/diff`)
        .set('X-DorkOS-Agent', token);
      const wrote = await request(testServer)
        .put(`/api/rooms/${roomId}/canvas/${created.body.id}/diff`)
        .set('X-DorkOS-Agent', token)
        .send({ content: 'AGENT WAS HERE\n', expectedHash: 'whatever' });

      for (const [name, res] of Object.entries({ read, wrote })) {
        expect(res.status, `${name} let an agent at a colleague’s copy`).toBe(403);
        expect(res.body.code).toBe('PEOPLE_ONLY');
      }
    });

    it('lets a PERSON past that gate, and refuses for the review’s own reason', async () => {
      // The discriminating half: the person is NOT refused `PEOPLE_ONLY`. What
      // they reach instead is the review's own refusal — this document is a web
      // page rather than a diff — which is the proof they got past the gate
      // rather than that the gate is missing.
      //
      // It also pins that the "not a review" branch FIRES. It used to be dead:
      // the route's seam pre-filtered non-`diff` documents to `null`, so a
      // markdown document answered as a missing one.
      const created = await open('https://example.test/a');

      const read = await request(testServer).get(
        `/api/rooms/${roomId}/canvas/${created.body.id}/diff`
      );

      expect(read.status).not.toBe(403);
      expect(read.body.code).toBe('CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM');
      expect(read.body.error).toContain('not a review');
    });

    it('refuses a real NON-MEMBER the review as if the room did not exist', async () => {
      const created = await open('https://example.test/private');
      const token = await seedOutsider();

      const read = await request(testServer)
        .get(`/api/rooms/${roomId}/canvas/${created.body.id}/diff`)
        .set('X-DorkOS-Agent', token);

      // 404, never 403: membership is checked first, so a stranger cannot tell
      // a room it may not see from one that is not there.
      expect(read.status).toBe(404);
      expect(read.body.code).toBe('ROOM_NOT_FOUND');
    });

    it('lets the PERSON say where they are looking', async () => {
      const created = await open('https://example.test/a');
      const frames = collectRoomFrames(roomId);

      const res = await request(testServer)
        .post(`/api/rooms/${roomId}/canvas/viewing`)
        .send({ documentId: created.body.id });

      expect(res.status).toBe(204);
      expect(await frames()).toMatchObject([
        { type: 'signal', signal: 'presence', documentId: created.body.id },
      ]);
    });

    it('answers a room that does not exist exactly as it answers one you cannot see', async () => {
      // Both 404 with the same code, so an id tells a caller nothing. Asserted
      // on the ROUTE rather than on the helper, because that is where a future
      // handler could accidentally distinguish them.
      const missing = await request(testServer).get('/api/rooms/no-such-room/canvas');
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('ROOM_NOT_FOUND');
    });

    it('404s a document id from another room', async () => {
      const other = await request(testServer)
        .post('/api/rooms')
        .send({ kind: 'channel', title: 'Other', agentPaths: [] });
      const theirs = await request(testServer)
        .post(`/api/rooms/${other.body.id}/canvas`)
        .send({ content: urlContent('https://example.test/theirs') });

      const read = await request(testServer).get(`/api/rooms/${roomId}/canvas/${theirs.body.id}`);
      expect(read.status).toBe(404);
    });
  });

  describe('an archived room', () => {
    beforeEach(async () => {
      await open('https://example.test/before');
      await request(testServer).patch(`/api/rooms/${roomId}`).send({ archived: true });
    });

    it('answers every READ', async () => {
      const listed = await request(testServer).get(`/api/rooms/${roomId}/canvas`);
      expect(listed.status).toBe(200);
      expect(listed.body.documents).toHaveLength(1);
    });

    it('refuses a PATCH that asks for NOTHING, rather than answering 200', async () => {
      // `{}` reaches no branch in the handler, so before the gate moved it fell
      // straight through to the response with the document it had fetched.
      const documentId = (await request(testServer).get(`/api/rooms/${roomId}/canvas`)).body
        .documents[0].id;
      const res = await request(testServer)
        .patch(`/api/rooms/${roomId}/canvas/${documentId}`)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ROOM_ARCHIVED');
      expect(JSON.stringify(res.body)).not.toContain('example.test/before');
    });

    it('refuses every WRITE with 409', async () => {
      const documentId = (await request(testServer).get(`/api/rooms/${roomId}/canvas`)).body
        .documents[0].id;
      const opened = await open('https://example.test/after');
      const patched = await request(testServer)
        .patch(`/api/rooms/${roomId}/canvas/${documentId}`)
        .send({ pinned: true });
      const deleted = await request(testServer).delete(`/api/rooms/${roomId}/canvas/${documentId}`);
      const editing = await request(testServer)
        .post(`/api/rooms/${roomId}/canvas/${documentId}/editing`)
        .send({ editing: true });

      for (const res of [opened, patched, deleted, editing]) {
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ROOM_ARCHIVED');
      }
      // And nothing was written on the way to being refused.
      const listed = await request(testServer).get(`/api/rooms/${roomId}/canvas`);
      expect(listed.body.documents).toHaveLength(1);
    });
  });

  describe('validation', () => {
    it('refuses a body with no content', async () => {
      const res = await request(testServer).post(`/api/rooms/${roomId}/canvas`).send({});
      expect(res.status).toBe(400);
    });

    it('refuses content that is not one of the canvas shapes', async () => {
      const res = await request(testServer)
        .post(`/api/rooms/${roomId}/canvas`)
        .send({ content: { type: 'not-a-thing' } });
      expect(res.status).toBe(400);
    });

    it('refuses an `editing` that is not a boolean', async () => {
      const created = await open('https://example.test/a');
      const res = await request(testServer)
        .post(`/api/rooms/${roomId}/canvas/${created.body.id}/editing`)
        .send({ editing: 'yes' });
      expect(res.status).toBe(400);
    });
  });

  it('is registered in the OpenAPI document under every one of its seven paths', async () => {
    // A route that ships undocumented is a route the published API does not
    // have. Read off the live registry rather than the committed JSON, so this
    // fails on the edit that forgot the registration rather than on the export.
    const { generateOpenAPISpec } = await import('../../services/core/openapi-registry.js');
    const spec = generateOpenAPISpec();
    const paths = Object.keys(spec.paths ?? {});
    expect(paths).toContain('/api/rooms/{id}/canvas');
    expect(paths).toContain('/api/rooms/{id}/canvas/{documentId}');
    expect(paths).toContain('/api/rooms/{id}/canvas/{documentId}/editing');
    expect(paths).toContain('/api/rooms/{id}/canvas/viewing');
    const document = spec.paths?.['/api/rooms/{id}/canvas/{documentId}'];
    expect(Object.keys(document ?? {}).sort()).toEqual(['delete', 'get', 'patch']);
  });
});
