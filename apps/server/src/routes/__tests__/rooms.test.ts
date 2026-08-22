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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { createRoomSubsystem, getRoomService, setRoomService } from '../../services/rooms/index.js';
import { setReadCursorService } from '../../services/core/read-cursor-service.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';

const app = createApp();
finalizeApp(app);

const ANA_PATH = '/agents/ana';
const BO_PATH = '/agents/bo';

/** Register an agent so a room can resolve it by directory. */
function registerAgent(db: Db, name: string, projectPath: string): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: `ULID_${name.toUpperCase()}`,
      name,
      displayName: name[0].toUpperCase() + name.slice(1),
      runtime: 'claude-code',
      projectPath,
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
    resetAgentIdentityService();
    db = createTestDb();
    registerAgent(db, 'ana', ANA_PATH);
    registerAgent(db, 'bo', BO_PATH);
    // Both halves of one subsystem: the rooms service and the read-cursor
    // service it writes a person's place into. Built together so the room list
    // and `/api/read-cursors` provably read the same table.
    const rooms = createRoomSubsystem({ db });
    setRoomService(rooms.service);
    setReadCursorService(rooms.readCursors);
  });

  afterEach(() => {
    resetAgentIdentityService();
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

    it('seeds a direct message with several agents in one call', async () => {
      const res = await request(app)
        .post('/api/rooms')
        .send({ kind: 'dm', title: 'Ana and Bo', agentPaths: [ANA_PATH, BO_PATH] });

      expect(res.status).toBe(201);
      // Both agents plus the operator, and every one of them resolved.
      expect(
        res.body.members
          .map((m: { author: { displayName: string } }) => m.author.displayName)
          .sort()
      ).toEqual(['Ana', 'Bo', 'You']);
    });

    it('answers a repeated direct message with the room that already holds those people', async () => {
      const first = await request(app)
        .post('/api/rooms')
        .send({ kind: 'dm', title: 'Ana and Bo', agentPaths: [ANA_PATH, BO_PATH] });
      const again = await request(app)
        .post('/api/rooms')
        .send({ kind: 'dm', title: 'Ana and Bo again', agentPaths: [BO_PATH, ANA_PATH] });

      // 201 said a room was created; 200 says one was already there. The bodies
      // are identical, so the status is the only thing that can carry it.
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      expect((await request(app).get('/api/rooms').query({ kind: 'dm' })).body.rooms).toHaveLength(
        1
      );
    });

    it('serializes the same body on both paths, with no bookkeeping field on the wire', async () => {
      const created = await request(app)
        .post('/api/rooms')
        .send({ kind: 'dm', title: 'Ana', agentPaths: [ANA_PATH] });
      const matched = await request(app)
        .post('/api/rooms')
        .send({ kind: 'dm', title: 'Ana', agentPaths: [ANA_PATH] });

      // `created` decides the status and then stops existing: the response is
      // exactly RoomWithRosterSchema, which is what the OpenAPI doc promises.
      expect(created.body).not.toHaveProperty('created');
      expect(matched.body).not.toHaveProperty('created');
      expect(matched.body).toEqual(created.body);
    });

    it('answers 201 for a channel every time, since only a DM dedupes', async () => {
      const first = await request(app).post('/api/rooms').send({ kind: 'channel', title: 'One' });
      const second = await request(app).post('/api/rooms').send({ kind: 'channel', title: 'Two' });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
    });

    it('still opens a separate conversation for a subset of a group', async () => {
      const group = await request(app)
        .post('/api/rooms')
        .send({ kind: 'dm', title: 'Ana and Bo', agentPaths: [ANA_PATH, BO_PATH] });
      const alone = await request(app)
        .post('/api/rooms')
        .send({ kind: 'dm', title: 'Ana', agentPaths: [ANA_PATH] });

      expect(alone.status).toBe(201);
      expect(alone.body.id).not.toBe(group.body.id);
      expect((await request(app).get('/api/rooms').query({ kind: 'dm' })).body.rooms).toHaveLength(
        2
      );
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

    it('serves exactly what the room service answers, now that the route asks the community registry too', async () => {
      // The parity gate for DOR-1204. `GET /api/rooms` goes through
      // `listRoomsAcrossCommunities`, which consults the community registry —
      // and this machine's rooms must come back byte for byte regardless: same
      // rooms, same order, every field. Three rooms of two kinds with different
      // activity, so ordering and the DM-only `participants` field both vary
      // and a reshape cannot hide behind a single row.
      const first = await createChannel('Backend');
      await request(app)
        .post('/api/rooms')
        .send({ kind: 'dm', title: 'Ana', agentPaths: [ANA_PATH] });
      const last = await createChannel('Design');
      await request(app).post(`/api/rooms/${first.id}/entries`).send({ text: 'hello' });
      await request(app).post(`/api/rooms/${last.id}/entries`).send({ text: 'hi' });

      // Whoever the server resolved this request as — the same author the route
      // lists for, read off a room rather than assumed.
      const viewer = (await request(app).get(`/api/rooms/${first.id}`)).body.viewerAuthorId;
      const direct = getRoomService().listRooms(viewer, {});

      const res = await request(app).get('/api/rooms');
      expect(res.status).toBe(200);
      expect(res.body.rooms).toEqual(JSON.parse(JSON.stringify(direct)));
    });

    it('carries an empty warnings list while this machine is the only community', async () => {
      // Present, not absent: a client reading `warnings` must never have to tell
      // "no community degraded" apart from "this server does not report it".
      await createChannel();
      const res = await request(app).get('/api/rooms');
      expect(res.body.warnings).toEqual([]);
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

    it('tells the caller which author the server resolved them as', async () => {
      // Nothing else on the wire says. Without it a client can only guess by
      // author kind, which stops being the reader the moment two people share
      // a room (spec `invites` §4.5).
      const room = await createChannel();
      const res = await request(app).get(`/api/rooms/${room.id}`);
      const me = res.body.viewerAuthorId;
      expect(me).toEqual(expect.any(String));
      expect(res.body.members.map((m: { authorId: string }) => m.authorId)).toContain(me);
    });

    it('answers an agent with the agent own author id, not the human one', async () => {
      const room = await createChannel();
      const identity = initAgentIdentityService(db);
      const token = await identity.mint({ agentPath: ANA_PATH, displayName: 'Ana' });
      await request(app).post(`/api/rooms/${room.id}/members`).send({ agentPath: ANA_PATH });

      const asHuman = await request(app).get(`/api/rooms/${room.id}`);
      const asAgent = await request(app).get(`/api/rooms/${room.id}`).set('X-DorkOS-Agent', token);

      expect(asAgent.body.viewerAuthorId).not.toBe(asHuman.body.viewerAuthorId);
    });
  });

  describe('PATCH /:id — deliverNotices (chats-as-channels spec §6.2)', () => {
    /** Seed a bridged room directly through the service, as the local caller. */
    function bridgeRoom(chatId: string, group = false) {
      const service = getRoomService();
      const operatorAuthorId = service.authorRegistry.localHuman().id;
      return service.createBridgedRoom({
        adapterId: 'tg-main',
        chatId,
        bindingId: `binding-${chatId}`,
        chatType: group ? 'group' : 'private',
        channelType: group ? 'group' : null,
        title: group ? 'Team' : 'Miguel',
        agentPath: ANA_PATH,
        operatorAuthorId,
      });
    }

    it('flips the override on a bridged room and it sticks', async () => {
      const room = bridgeRoom('900', true);
      const res = await request(app).patch(`/api/rooms/${room.id}`).send({ deliverNotices: true });
      expect(res.status).toBe(200);

      const { bridges } = createRoomSubsystem({ db });
      expect(bridges.findBridgeByRoom(room.id)?.deliverNotices).toBe(true);
    });

    it('flips it off on a bridged dm and it sticks', async () => {
      const room = bridgeRoom('901');
      const res = await request(app).patch(`/api/rooms/${room.id}`).send({ deliverNotices: false });
      expect(res.status).toBe(200);

      const { bridges } = createRoomSubsystem({ db });
      expect(bridges.findBridgeByRoom(room.id)?.deliverNotices).toBe(false);
    });

    it('refuses NOT_A_BRIDGED_ROOM (409) on a plain channel', async () => {
      const room = await createChannel();
      const res = await request(app).patch(`/api/rooms/${room.id}`).send({ deliverNotices: true });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NOT_A_BRIDGED_ROOM');
    });

    it('leaves a title/topic patch on an unbridged room unaffected when deliverNotices is absent', async () => {
      const room = await createChannel();
      const res = await request(app).patch(`/api/rooms/${room.id}`).send({ topic: 'hello' });
      expect(res.status).toBe(200);
      expect(res.body.topic).toBe('hello');
    });
  });

  describe('GET / — bridge on every listed room (sidebar-simplification D2)', () => {
    it('says which listed rooms are bridged and which are not', async () => {
      // The cockpit tells a direct message somebody made by hand from one a
      // bridged private chat projects, and `bridge` is the only field that says
      // which. It used to be left off the list entirely, so `null` there meant
      // "not carried" and the rule was unanswerable over the wire.
      const service = getRoomService();
      const operatorAuthorId = service.authorRegistry.localHuman().id;
      const bridged = service.createBridgedRoom({
        adapterId: 'tg-main',
        chatId: '950',
        bindingId: 'binding-950',
        chatType: 'private',
        channelType: null,
        title: 'Miguel',
        agentPath: ANA_PATH,
        operatorAuthorId,
      });
      const plain = await createChannel();

      const res = await request(app).get('/api/rooms');
      expect(res.status).toBe(200);
      const byId = new Map<string, { bridge?: unknown }>(
        res.body.rooms.map((room: { id: string }) => [room.id, room])
      );
      // A bridged PRIVATE chat carries no `platformTitle` and no visibility —
      // both are group-only facts — so what says "this room is bridged" over the
      // wire is the object being there at all.
      expect(byId.get(bridged.id)?.bridge).not.toBeNull();
      expect(byId.get(bridged.id)?.bridge).toBeDefined();
      expect(byId.get(plain.id)?.bridge).toBeNull();
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

  describe('PATCH /authors/:authorId/handle', () => {
    /** The author ids on a room body, in roster order. */
    function memberIds(room: { id: string }): string[] {
      return (room as unknown as { members: { authorId: string }[] }).members.map(
        (member) => member.authorId
      );
    }

    /** The operator's own author id, off a room they created. */
    async function operatorAuthorId(): Promise<string> {
      const room = await createChannel('Handles');
      return memberIds(room)[0];
    }

    it('sets a handle, and gives it back on the author it reaches', async () => {
      const authorId = await operatorAuthorId();

      const res = await request(app)
        .patch(`/api/rooms/authors/${authorId}/handle`)
        .send({ handle: '  Dorian  ' });

      expect(res.status).toBe(200);
      // Normalized on the server, so a client that skipped its own check cannot
      // store something the grammar forbids.
      expect(res.body.handle).toBe('dorian');
      expect(res.body.id).toBe(authorId);
    });

    it('400s a spelling the grammar rejects', async () => {
      const authorId = await operatorAuthorId();

      const res = await request(app)
        .patch(`/api/rooms/authors/${authorId}/handle`)
        .send({ handle: 'not a handle' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_HANDLE');
      // The message names the rule that was missed rather than saying "invalid".
      expect(res.body.error).toMatch(/lowercase letters, numbers, dots/);
    });

    it('409s a handle live on another author', async () => {
      const room = await createChannel('Taken');
      const me = memberIds(room)[0];
      await request(app).post(`/api/rooms/${room.id}/members`).send({ agentPath: ANA_PATH });

      const res = await request(app)
        .patch(`/api/rooms/authors/${me}/handle`)
        .send({ handle: 'ana' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('HANDLE_TAKEN');
    });

    it('409s a handle reserved to somebody else', async () => {
      const room = await createChannel('Reserved');
      const me = memberIds(room)[0];
      await request(app).post(`/api/rooms/${room.id}/members`).send({ agentPath: ANA_PATH });
      const anaId = (await request(app).get(`/api/rooms/${room.id}`)).body.members.find(
        (m: { author: { displayName: string } }) => m.author.displayName === 'Ana'
      ).authorId as string;

      // Ana releases `ana`. It stays hers, forever.
      await request(app).patch(`/api/rooms/authors/${anaId}/handle`).send({ handle: 'ana-pm' });

      const res = await request(app)
        .patch(`/api/rooms/authors/${me}/handle`)
        .send({ handle: 'ana' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('HANDLE_RESERVED');
    });

    it('refuses an AGENT presenting its own identity — handle changes are human-only', async () => {
      // S6: rate limiting is the wrong instrument, so there is no automated path
      // at all. An agent that could rename itself in a loop would grow the
      // tombstone table forever; removing the mechanism beats throttling it.
      const room = await createChannel('Agents');
      const me = memberIds(room)[0];
      const identity = initAgentIdentityService(db);
      const token = await identity.mint({ agentPath: ANA_PATH, displayName: 'Ana' });

      const res = await request(app)
        .patch(`/api/rooms/authors/${me}/handle`)
        .set('X-DorkOS-Agent', token)
        .send({ handle: 'stolen' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OPERATOR_ONLY');
    });

    it('404s an author that does not exist', async () => {
      const res = await request(app)
        .patch('/api/rooms/authors/01NOSUCHAUTHOR/handle')
        .send({ handle: 'nobody' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('MEMBER_NOT_FOUND');
    });
  });

  describe('POST /:id/halt', () => {
    it('answers with how many turns it stopped, and writes the room a notice', async () => {
      const room = await createChannel();

      const res = await request(app).post(`/api/rooms/${room.id}/halt`);

      // Nothing was running, and that is a real answer rather than a failure —
      // pressing stop in a quiet room is a question, and the room answers it.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stopped: 0 });
      const entries = await request(app).get(`/api/rooms/${room.id}/entries`);
      expect(entries.body.entries.at(-1).body.notice).toBe('halted');
    });

    it('takes no body, because there is nothing to say', async () => {
      // Express 5 leaves `req.body` undefined on an empty POST, so a handler
      // that parsed one would refuse every honest caller.
      const room = await createChannel();
      expect((await request(app).post(`/api/rooms/${room.id}/halt`)).status).toBe(200);
    });

    it('404s a room that is not there', async () => {
      const res = await request(app).post('/api/rooms/no-such-room/halt');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ROOM_NOT_FOUND');
    });

    it('still works on an archived room', async () => {
      // The one write that an archived room does not refuse. Archiving stops a
      // room GAINING messages; a turn that was already running when it was
      // archived is still running, and refusing here would put the only way to
      // stop it behind a door that has just been shut.
      const room = await createChannel();
      await request(app).patch(`/api/rooms/${room.id}`).send({ archived: true });

      const res = await request(app).post(`/api/rooms/${room.id}/halt`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stopped: 0 });
    });
  });

  describe('POST /:id/halt/:authorId', () => {
    /**
     * A channel holding Ana, with her author id and the operator's.
     *
     * @param title - The room's title, so parallel cases cannot collide.
     */
    async function channelWithAna(
      title = 'Stop one'
    ): Promise<{ id: string; ana: string; me: string }> {
      const room = await createChannel(title);
      await request(app).post(`/api/rooms/${room.id}/members`).send({ agentPath: ANA_PATH });
      const roster = (await request(app).get(`/api/rooms/${room.id}`)).body.members as Array<{
        authorId: string;
        author: { kind: string; displayName: string };
      }>;
      return {
        id: room.id,
        ana: roster.find((member) => member.author.displayName === 'Ana')!.authorId,
        me: roster.find((member) => member.author.kind === 'human')!.authorId,
      };
    }

    /** Every `halted` notice stored in a room. */
    async function haltedIn(roomId: string): Promise<Array<{ body: Record<string, string> }>> {
      const entries = (await request(app).get(`/api/rooms/${roomId}/entries`)).body
        .entries as Array<{ body: Record<string, string> }>;
      return entries.filter((entry) => entry.body.notice === 'halted');
    }

    it('answers whether a turn was stopped, and names the agent in the room', async () => {
      const room = await channelWithAna();

      const res = await request(app).post(`/api/rooms/${room.id}/halt/${room.ana}`);

      // Nothing was running, and that is a real answer rather than a failure:
      // pressing Stop is a question, and the room answers it either way.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stopped: 0 });
      const halted = await haltedIn(room.id);
      expect(halted).toHaveLength(1);
      // The subject is what tells a per-agent stop from a room-wide one on the
      // wire — the code is the same `halted` either way.
      expect(halted[0].body.subjectAuthorId).toBe(room.ana);
      expect(halted[0].body.text).toContain('Ana was not working here at the time');
    });

    it('refuses an agent trying to stop a room-mate, and the room stays silent', async () => {
      // Scoping the verb makes it more tempting rather than less, so the gate is
      // asserted at the route rather than assumed from the service. A refusal
      // that still wrote a line would be a way to make a room say things.
      const room = await channelWithAna('Agents do not stop agents');
      const identity = initAgentIdentityService(db);
      const token = await identity.mint({ agentPath: ANA_PATH, displayName: 'Ana' });

      const res = await request(app)
        .post(`/api/rooms/${room.id}/halt/${room.ana}`)
        .set('X-DorkOS-Agent', token);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PEOPLE_ONLY');
      expect(await haltedIn(room.id)).toHaveLength(0);
    });

    it('answers a room the caller cannot see exactly as it answers one that is not there', async () => {
      // The room gate runs BEFORE the roster check, so a caller who cannot see
      // the room learns nothing about who is on it. Bo is an agent in no room at
      // all, so this room is invisible to it.
      const room = await channelWithAna('Not yours');
      const identity = initAgentIdentityService(db);
      const token = await identity.mint({ agentPath: BO_PATH, displayName: 'Bo' });

      const unseen = await request(app)
        .post(`/api/rooms/${room.id}/halt/${room.ana}`)
        .set('X-DorkOS-Agent', token);
      const missing = await request(app)
        .post(`/api/rooms/no-such-room/halt/${room.ana}`)
        .set('X-DorkOS-Agent', token);

      expect(unseen.status).toBe(404);
      expect(unseen.body.code).toBe('ROOM_NOT_FOUND');
      // Identical bodies: a room id must never be a way to enumerate a roster,
      // and a `PEOPLE_ONLY` here would say the caller had found a real room.
      expect(unseen.body).toEqual(missing.body);
    });

    it('404s an author that is not an agent on this roster', async () => {
      // Answering `{ stopped: 0 }` for a name that is not there would hide a
      // client bug behind a success.
      const room = await channelWithAna('No such member');

      const stranger = await request(app).post(`/api/rooms/${room.id}/halt/01NOSUCHAUTHOR`);
      expect(stranger.status).toBe(404);
      expect(stranger.body.code).toBe('MEMBER_NOT_FOUND');

      // A PERSON on the roster is refused by the same code, and the sentence is
      // literally true: there is no agent by that id here.
      const person = await request(app).post(`/api/rooms/${room.id}/halt/${room.me}`);
      expect(person.status).toBe(404);
      expect(person.body.code).toBe('MEMBER_NOT_FOUND');
      expect(await haltedIn(room.id)).toHaveLength(0);
    });

    it('still works on an archived room', async () => {
      // The carve-out the room-wide stop has, for the same reason: archiving
      // stops a room GAINING messages, and a turn that was already running when
      // it was archived is still running. Red if somebody adds an archive guard
      // here by symmetry with `post`.
      const room = await channelWithAna('Archived');
      await request(app).patch(`/api/rooms/${room.id}`).send({ archived: true });

      const res = await request(app).post(`/api/rooms/${room.id}/halt/${room.ana}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stopped: 0 });
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
    it('adds an agent by its directory and seeds a channel to engaged', async () => {
      const room = await createChannel();
      const res = await request(app)
        .post(`/api/rooms/${room.id}/members`)
        .send({ agentPath: ANA_PATH });

      expect(res.status).toBe(201);
      expect(res.body.responseMode).toBe('engaged');
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

  describe('the retired PUT /:id/read-cursor', () => {
    it('is gone, and the generic route does its job', async () => {
      // The migration's closing condition (team-room-home §D4): read state has
      // exactly one write path, so the room-shaped URL must be absent rather
      // than quietly still working. Asserting the 404 is what keeps a later
      // "restore the old endpoint for compatibility" honest — a second URL onto
      // one implementation is still a second thing to keep true.
      const room = await createChannel();
      await request(app).post(`/api/rooms/${room.id}/entries`).send({ text: 'hello' });

      const gone = await request(app)
        .put(`/api/rooms/${room.id}/read-cursor`)
        .send({ lastReadSeq: 1 });
      expect(gone.status).toBe(404);

      // And the room's unread count still clears, through the one route there
      // is — so the 404 above is a removal and not a regression.
      const res = await request(app)
        .put(`/api/read-cursors/room/${room.id}`)
        .send({ lastReadSeq: 1 });
      expect(res.status).toBe(200);
      expect(res.body.lastReadSeq).toBe(1);

      const list = await request(app).get('/api/rooms');
      expect(list.body.rooms[0].unreadCount).toBe(0);
    });
  });

  describe('POST /:id/threads', () => {
    it('accepts a reply and writes it into this room, not a new one', async () => {
      const room = await createChannel();
      const posted = await request(app)
        .post(`/api/rooms/${room.id}/entries`)
        .send({ text: 'why is the build slow?' });

      const res = await request(app)
        .post(`/api/rooms/${room.id}/threads`)
        .send({ rootEntryId: posted.body.entryId, text: 'the cache is cold' });

      // Trigger-only, exactly like `POST /:id/entries`: 202 and the identity,
      // while the entry itself reaches readers over the room stream.
      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(true);

      const entries = await request(app).get(`/api/rooms/${room.id}/entries?limit=50`);
      const reply = entries.body.entries.find((e: { id: string }) => e.id === res.body.entryId) as {
        parentEntryId: string;
        threadRootEntryId: string;
      };
      expect(reply.parentEntryId).toBe(posted.body.entryId);
      expect(reply.threadRootEntryId).toBe(posted.body.entryId);

      // And no room was minted. The room list is the channel and nothing else.
      const rooms = await request(app).get('/api/rooms');
      expect(rooms.body.rooms.map((r: { id: string }) => r.id)).toEqual([room.id]);
    });

    it('400s a reply whose root is itself a reply', async () => {
      const room = await createChannel();
      const posted = await request(app)
        .post(`/api/rooms/${room.id}/entries`)
        .send({ text: 'why is the build slow?' });
      const reply = await request(app)
        .post(`/api/rooms/${room.id}/threads`)
        .send({ rootEntryId: posted.body.entryId, text: 'the cache is cold' });

      const res = await request(app)
        .post(`/api/rooms/${room.id}/threads`)
        .send({ rootEntryId: reply.body.entryId, text: 'deeper' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NESTED_THREAD');
    });

    it('404s a reply to an entry this room does not hold', async () => {
      const room = await createChannel();
      const res = await request(app)
        .post(`/api/rooms/${room.id}/threads`)
        .send({ rootEntryId: 'no-such-entry', text: 'orphan' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ENTRY_NOT_FOUND');
    });

    it('409s a reply into an archived room', async () => {
      // New: `createThread` went through neither the archive check nor the
      // membership one. Routing a reply through `RoomService.post` means a
      // thread answers to every rule an ordinary post does, and the OpenAPI
      // registration says so.
      const room = await createChannel();
      const posted = await request(app)
        .post(`/api/rooms/${room.id}/entries`)
        .send({ text: 'why is the build slow?' });
      await request(app).patch(`/api/rooms/${room.id}`).send({ archived: true });

      const res = await request(app)
        .post(`/api/rooms/${room.id}/threads`)
        .send({ rootEntryId: posted.body.entryId, text: 'too late' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ROOM_ARCHIVED');
    });

    it('400s a reply with no text, because it writes a message', async () => {
      const room = await createChannel();
      const posted = await request(app)
        .post(`/api/rooms/${room.id}/entries`)
        .send({ text: 'why is the build slow?' });

      const res = await request(app)
        .post(`/api/rooms/${room.id}/threads`)
        .send({ rootEntryId: posted.body.entryId });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /threads', () => {
    /** Open a thread in `room` and answer with its root entry id. */
    async function startThread(roomId: string, text: string): Promise<string> {
      const root = await request(app).post(`/api/rooms/${roomId}/entries`).send({ text });
      await request(app)
        .post(`/api/rooms/${roomId}/threads`)
        .send({ rootEntryId: root.body.entryId, text: 'on it' });
      return root.body.entryId as string;
    }

    it('answers with the caller’s threads across rooms, newest first', async () => {
      const backend = await createChannel('Backend');
      const design = await createChannel('Design');
      const older = await startThread(backend.id, 'older question');
      const newer = await startThread(design.id, 'newer question');

      const res = await request(app).get('/api/rooms/threads');
      expect(res.status).toBe(200);
      expect(res.body.threads.map((t: { rootEntryId: string }) => t.rootEntryId)).toEqual([
        newer,
        older,
      ]);
      expect(res.body.threads[0]).toMatchObject({
        roomId: design.id,
        roomTitle: 'Design',
        rootPreview: 'newer question',
        replyCount: 1,
      });
    });

    it('is reached as a literal segment, not swallowed by GET /:id', async () => {
      // The ordering hazard this route is written around: `/:id` above it would
      // take `threads` for a room id and answer 404. A room-shaped 404 body here
      // is the failure mode, so the assertion is on the SHAPE of a 200.
      const res = await request(app).get('/api/rooms/threads');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ threads: [] });
      expect(res.body).not.toHaveProperty('members');
    });

    it('400s a limit outside the allowed range', async () => {
      const res = await request(app).get('/api/rooms/threads').query({ limit: 5000 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  describe('membership scoping', () => {
    /**
     * Mint a real identity token for an agent that is on NO room's roster, so
     * the requests below travel the same path a rogue agent would: the header
     * resolves (identity is attribution, not authorization) and the room layer
     * is the only thing standing between it and somebody else's conversation.
     */
    async function outsiderToken(): Promise<string> {
      const identity = initAgentIdentityService(db);
      return identity.mint({ agentPath: '/agents/outsider', displayName: 'Outsider' });
    }

    it('does not list a room the caller is not a member of', async () => {
      await createChannel('Private');
      const token = await outsiderToken();

      const res = await request(app).get('/api/rooms').set('X-DorkOS-Agent', token);
      expect(res.status).toBe(200);
      expect(res.body.rooms).toEqual([]);
    });

    it('404s GET /:id for a non-member rather than revealing the room', async () => {
      const room = await createChannel();
      const token = await outsiderToken();

      const res = await request(app).get(`/api/rooms/${room.id}`).set('X-DorkOS-Agent', token);
      expect(res.status).toBe(404);
      // Same code as a genuinely unknown id: probing cannot confirm existence.
      expect(res.body.code).toBe('ROOM_NOT_FOUND');
      const unknown = await request(app).get('/api/rooms/does-not-exist');
      expect(res.body.code).toBe(unknown.body.code);
    });

    it('404s the history of a room the caller is not in', async () => {
      const room = await createChannel();
      await request(app).post(`/api/rooms/${room.id}/entries`).send({ text: 'private' });
      const token = await outsiderToken();

      const res = await request(app)
        .get(`/api/rooms/${room.id}/entries`)
        .set('X-DorkOS-Agent', token);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('private');
    });

    it('refuses a post into a room the caller is not in', async () => {
      const room = await createChannel();
      const token = await outsiderToken();

      const res = await request(app)
        .post(`/api/rooms/${room.id}/entries`)
        .set('X-DorkOS-Agent', token)
        .send({ text: 'let me in' });
      expect(res.status).toBe(404);
    });

    it('stops an outsider adding itself to a room', async () => {
      const room = await createChannel();
      const token = await outsiderToken();

      const res = await request(app)
        .post(`/api/rooms/${room.id}/members`)
        .set('X-DorkOS-Agent', token)
        .send({ agentPath: '/agents/outsider' });
      expect(res.status).toBe(404);

      const roster = await request(app).get(`/api/rooms/${room.id}`);
      expect(roster.body.members).toHaveLength(1);
    });

    it('lets the same agent read once it has actually been added', async () => {
      const room = await createChannel();
      const identity = initAgentIdentityService(db);
      const token = await identity.mint({ agentPath: ANA_PATH, displayName: 'Ana' });

      const before = await request(app).get(`/api/rooms/${room.id}`).set('X-DorkOS-Agent', token);
      expect(before.status).toBe(404);

      // The human, who IS a member, adds her.
      await request(app).post(`/api/rooms/${room.id}/members`).send({ agentPath: ANA_PATH });

      const after = await request(app).get(`/api/rooms/${room.id}`).set('X-DorkOS-Agent', token);
      expect(after.status).toBe(200);
      expect(after.body.id).toBe(room.id);

      const listed = await request(app).get('/api/rooms').set('X-DorkOS-Agent', token);
      expect(listed.body.rooms.map((r: { id: string }) => r.id)).toEqual([room.id]);
    });
  });
});
