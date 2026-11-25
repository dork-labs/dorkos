/**
 * `/api/rooms`: creating, listing, reading and updating a room.
 */
import { describe, it, expect } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { createRoomSubsystem, getRoomService } from '../../../services/rooms/index.js';
import {
  ANA_PATH,
  BO_PATH,
  agentToken,
  anaIn,
  createChannel,
  testServer,
  useRoomsApp,
} from './rooms.fixtures.js';

const db = useRoomsApp();

describe('/api/rooms', () => {
  describe('POST /', () => {
    it('M-01: creates a channel and returns it with its roster', async () => {
      const res = await request(testServer)
        .post('/api/rooms')
        .send({ kind: 'channel', title: 'Backend', topic: 'the API' });

      expect(res.status).toBe(201);
      expect(res.body.slug).toBe('backend');
      expect(res.body.topic).toBe('the API');
      expect(res.body.members).toHaveLength(1);
    });

    it('rejects a body with neither a title nor a slug', async () => {
      const res = await request(testServer).post('/api/rooms').send({ kind: 'channel' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    });

    it('seeds a direct message with several agents in one call', async () => {
      const res = await request(testServer)
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
      const first = await request(testServer)
        .post('/api/rooms')
        .send({ kind: 'dm', title: 'Ana and Bo', agentPaths: [ANA_PATH, BO_PATH] });
      const again = await request(testServer)
        .post('/api/rooms')
        .send({ kind: 'dm', title: 'Ana and Bo again', agentPaths: [BO_PATH, ANA_PATH] });

      // 201 said a room was created; 200 says one was already there. The bodies
      // are identical, so the status is the only thing that can carry it.
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      // `created` decides the status and then stops existing: the response is
      // exactly RoomWithRosterSchema, which is what the OpenAPI doc promises.
      expect(first.body).not.toHaveProperty('created');
      expect(again.body).toEqual({ ...first.body, title: again.body.title });
      expect(
        (await request(testServer).get('/api/rooms').query({ kind: 'dm' })).body.rooms
      ).toHaveLength(1);
    });

    it('still opens a separate conversation for a subset of a group', async () => {
      const group = await request(testServer)
        .post('/api/rooms')
        .send({ kind: 'dm', title: 'Ana and Bo', agentPaths: [ANA_PATH, BO_PATH] });
      const alone = await request(testServer)
        .post('/api/rooms')
        .send({ kind: 'dm', title: 'Ana', agentPaths: [ANA_PATH] });

      expect(alone.status).toBe(201);
      expect(alone.body.id).not.toBe(group.body.id);
      expect(
        (await request(testServer).get('/api/rooms').query({ kind: 'dm' })).body.rooms
      ).toHaveLength(2);
    });

    it('409s a duplicate live channel slug', async () => {
      await request(testServer)
        .post('/api/rooms')
        .send({ kind: 'channel', slug: 'general', title: 'G' });
      const res = await request(testServer)
        .post('/api/rooms')
        .send({ kind: 'channel', slug: 'general', title: 'G' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('slug_taken');
    });
  });

  describe('GET /', () => {
    it('lists rooms with the caller unread count', async () => {
      const room = await createChannel();
      await request(testServer).post(`/api/rooms/${room.id}/entries`).send({ text: 'hello' });

      const res = await request(testServer).get('/api/rooms');
      expect(res.status).toBe(200);
      expect(res.body.rooms).toHaveLength(1);
      expect(res.body.rooms[0].unreadCount).toBe(1);
      // Present, not absent: a client reading `warnings` must never have to tell
      // "no community degraded" apart from "this server does not report it".
      expect(res.body.warnings).toEqual([]);
    });

    it('filters by kind', async () => {
      await createChannel();
      await request(testServer).post('/api/rooms').send({ kind: 'dm', title: 'Ana' });

      const res = await request(testServer).get('/api/rooms').query({ kind: 'dm' });
      expect(res.body.rooms.map((r: { kind: string }) => r.kind)).toEqual(['dm']);
    });

    it('hides archived rooms unless asked', async () => {
      const room = await createChannel();
      await request(testServer).patch(`/api/rooms/${room.id}`).send({ archived: true });

      expect((await request(testServer).get('/api/rooms')).body.rooms).toHaveLength(0);
      const withArchived = await request(testServer)
        .get('/api/rooms')
        .query({ includeArchived: 'true' });
      expect(withArchived.body.rooms).toHaveLength(1);
    });

    it('serves exactly what the room service answers, now that the route asks the community registry too', async () => {
      // The parity gate for DOR-1204: this machine's rooms come back byte for
      // byte through `listRoomsAcrossCommunities`. Three rooms of two kinds with
      // different activity, so ordering and the DM-only `participants` field
      // both vary and a reshape cannot hide behind a single row.
      const first = await createChannel('Backend');
      await request(testServer)
        .post('/api/rooms')
        .send({ kind: 'dm', title: 'Ana', agentPaths: [ANA_PATH] });
      const last = await createChannel('Design');
      await request(testServer).post(`/api/rooms/${first.id}/entries`).send({ text: 'hello' });
      await request(testServer).post(`/api/rooms/${last.id}/entries`).send({ text: 'hi' });

      const viewer = (await request(testServer).get(`/api/rooms/${first.id}`)).body.viewerAuthorId;
      const direct = getRoomService().listRooms(viewer, {});

      const res = await request(testServer).get('/api/rooms');
      expect(res.status).toBe(200);
      expect(res.body.rooms).toEqual(JSON.parse(JSON.stringify(direct)));
    });

    it('says which listed rooms are bridged and which are not (sidebar-simplification D2)', async () => {
      // `bridge` is the only field that tells a hand-made DM from one a bridged
      // private chat projects; a bridged PRIVATE chat carries no other marker.
      const service = getRoomService();
      const bridged = service.createBridgedRoom({
        adapterId: 'tg-main',
        chatId: '950',
        bindingId: 'binding-950',
        chatType: 'private',
        channelType: null,
        title: 'Miguel',
        agentPath: ANA_PATH,
        operatorAuthorId: service.authorRegistry.localHuman().id,
      });
      const plain = await createChannel();

      const res = await request(testServer).get('/api/rooms');
      const byId = new Map<string, { bridge?: unknown }>(
        res.body.rooms.map((room: { id: string }) => [room.id, room])
      );
      expect(byId.get(bridged.id)?.bridge).toBeTruthy();
      expect(byId.get(plain.id)?.bridge).toBeNull();
    });
  });

  describe('GET /:id', () => {
    it('returns one room with its roster, and who the server resolved the caller as', async () => {
      // Nothing else on the wire says who the reader is (spec `invites` §4.5).
      const room = await createChannel();
      const res = await request(testServer).get(`/api/rooms/${room.id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(room.id);
      expect(res.body.members.map((m: { authorId: string }) => m.authorId)).toContain(
        res.body.viewerAuthorId
      );
    });

    it('404s an unknown room', async () => {
      const res = await request(testServer).get('/api/rooms/nope');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('room_not_found');
    });

    it('answers an agent with its own author id and tells it it is not the owner', async () => {
      // The one gate in a room that is not a membership (spec `canvas-agent-seat` §8).
      const room = await createChannel();
      const token = await anaIn(db(), room.id);

      const asHuman = await request(testServer).get(`/api/rooms/${room.id}`);
      const asAgent = await request(testServer)
        .get(`/api/rooms/${room.id}`)
        .set('X-DorkOS-Agent', token);

      expect(asAgent.body.viewerAuthorId).not.toBe(asHuman.body.viewerAuthorId);
      expect(asHuman.body.viewerIsOperator).toBe(true);
      expect(asAgent.body.viewerIsOperator).toBe(false);
      expect(asHuman.body.viewerCan).toEqual({ setUpFiles: true });
      // A member agent may set up its room's files too (DOR-3468).
      expect(asAgent.body.viewerCan).toEqual({ setUpFiles: true });

      await request(testServer).patch(`/api/rooms/${room.id}`).send({ archived: true });
      const archived = await request(testServer).get(`/api/rooms/${room.id}`);
      expect(archived.body.viewerCan).toEqual({ setUpFiles: false });
    });
  });

  describe('PATCH /:id — deliverNotices (chats-as-channels spec §6.2)', () => {
    it.each([
      ['a bridged group', '900', true, true],
      ['a bridged dm', '901', false, false],
    ])('sets the override on %s and it sticks', async (_case, chatId, group, value) => {
      const service = getRoomService();
      const room = service.createBridgedRoom({
        adapterId: 'tg-main',
        chatId,
        bindingId: `binding-${chatId}`,
        chatType: group ? 'group' : 'private',
        channelType: group ? 'group' : null,
        title: group ? 'Team' : 'Miguel',
        agentPath: ANA_PATH,
        operatorAuthorId: service.authorRegistry.localHuman().id,
      });
      const res = await request(testServer)
        .patch(`/api/rooms/${room.id}`)
        .send({ deliverNotices: value });
      expect(res.status).toBe(200);

      const { bridges } = createRoomSubsystem({ db: db() });
      expect(bridges.findBridgeByRoom(room.id)?.deliverNotices).toBe(value);
    });

    it('refuses NOT_A_BRIDGED_ROOM (409) on a plain channel, and leaves other fields patchable', async () => {
      const room = await createChannel();
      const res = await request(testServer)
        .patch(`/api/rooms/${room.id}`)
        .send({ deliverNotices: true });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('conflict');

      const topic = await request(testServer)
        .patch(`/api/rooms/${room.id}`)
        .send({ topic: 'hello' });
      expect(topic.status).toBe(200);
      expect(topic.body.topic).toBe('hello');
    });
  });

  describe("PATCH /:id — this room's own automatic-reply limits (DOR-1429)", () => {
    it('stores the four overrides and hands them straight back', async () => {
      const room = await createChannel();
      const unset = await request(testServer).get(`/api/rooms/${room.id}`);
      expect(unset.body).toMatchObject({
        turnLimitsEnabled: null,
        maxAgentDepth: null,
        maxTurnsPerAgentPerCascade: null,
        maxAutoTurnsPerHour: null,
      });

      const overrides = {
        turnLimitsEnabled: false,
        maxAgentDepth: 4,
        maxTurnsPerAgentPerCascade: 2,
        maxAutoTurnsPerHour: 12,
      };
      const res = await request(testServer).patch(`/api/rooms/${room.id}`).send(overrides);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject(overrides);
      // And on the read path, so a client can draw what is set.
      expect((await request(testServer).get(`/api/rooms/${room.id}`)).body.maxAgentDepth).toBe(4);

      // An absent field is "do not touch".
      const unrelated = await request(testServer)
        .patch(`/api/rooms/${room.id}`)
        .send({ topic: 'unrelated' });
      expect(unrelated.body.maxAgentDepth).toBe(4);
    });

    it.each([
      ['maxAgentDepth', 4],
      // `null` is not the same as false: it goes back to inheriting.
      ['turnLimitsEnabled', false],
    ])('clears %s with an explicit null', async (field, value) => {
      const room = await createChannel();
      await request(testServer)
        .patch(`/api/rooms/${room.id}`)
        .send({ [field]: value });
      const cleared = await request(testServer)
        .patch(`/api/rooms/${room.id}`)
        .send({ [field]: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body[field]).toBeNull();
    });

    it('refuses an agent with OPERATOR_ONLY, setting or clearing, and writes nothing', async () => {
      // An agent that can raise its own reply allowance has no allowance.
      // `room-limit-overrides.test.ts` measures a human who is not the owner.
      const room = await createChannel();
      await request(testServer).patch(`/api/rooms/${room.id}`).send({ maxAgentDepth: 4 });
      const token = await anaIn(db(), room.id);

      for (const maxAgentDepth of [99, null]) {
        const res = await request(testServer)
          .patch(`/api/rooms/${room.id}`)
          .set('X-DorkOS-Agent', token)
          .send({ maxAgentDepth });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('operator_only');
      }
      expect((await request(testServer).get(`/api/rooms/${room.id}`)).body.maxAgentDepth).toBe(4);
    });

    it('names the limit fields in the refusal, where an ordinary field gets the general one', async () => {
      // The whole route is operator-only since DOR-608 (`rooms-update-gate.test.ts`
      // owns that); this pins the SENTENCE the panel shows the reader.
      const room = await createChannel();
      const token = await anaIn(db(), room.id);

      const [limit, topic] = await Promise.all([
        request(testServer)
          .patch(`/api/rooms/${room.id}`)
          .set('X-DorkOS-Agent', token)
          .send({ maxAgentDepth: 99 }),
        request(testServer)
          .patch(`/api/rooms/${room.id}`)
          .set('X-DorkOS-Agent', token)
          .send({ topic: 'what we are working on' }),
      ]);

      expect(limit.body.detail).toBe(
        'Only you can change how much a room may spend on automatic replies'
      );
      expect(topic.body.detail).toBe(
        'Only you can change what a room is called, what it is about, or whether it is put away'
      );
    });

    it('answers 404, not 403, when an agent aims a limit patch at a room it cannot see', async () => {
      // Visibility is judged first, so an agent learns exactly what reading the
      // room would tell it and no more.
      const room = await createChannel();
      const token = await agentToken(db(), BO_PATH, 'Bo');
      const res = await request(testServer)
        .patch(`/api/rooms/${room.id}`)
        .set('X-DorkOS-Agent', token)
        .send({ maxAgentDepth: 99 });
      expect(res.status).toBe(404);
    });

    it.each([
      // 100 is the shared ceiling; 101 is one past it.
      { maxAgentDepth: 101 },
      // The per-agent counter's floor is 1: zero would mean "never answer".
      { maxTurnsPerAgentPerCascade: 0 },
      { maxAutoTurnsPerHour: 10_001 },
      { maxAgentDepth: 2.5 },
    ])('refuses %o, outside the bounds the config schema uses', async (body) => {
      const room = await createChannel();
      expect((await request(testServer).patch(`/api/rooms/${room.id}`).send(body)).status).toBe(
        400
      );
    });
  });

  describe('the retired PUT /:id/read-cursor', () => {
    it('is gone, and the generic route does its job', async () => {
      // Read state has exactly one write path (team-room-home §D4), so the
      // room-shaped URL must be absent rather than quietly still working.
      const room = await createChannel();
      await request(testServer).post(`/api/rooms/${room.id}/entries`).send({ text: 'hello' });

      const gone = await request(testServer)
        .put(`/api/rooms/${room.id}/read-cursor`)
        .send({ lastReadSeq: 1 });
      expect(gone.status).toBe(404);

      const res = await request(testServer)
        .put(`/api/read-cursors/room/${room.id}`)
        .send({ lastReadSeq: 1 });
      expect(res.status).toBe(200);
      expect(res.body.lastReadSeq).toBe(1);

      const list = await request(testServer).get('/api/rooms');
      expect(list.body.rooms[0].unreadCount).toBe(0);
    });
  });
});
