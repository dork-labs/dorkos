/**
 * `/api/rooms`: who is in a room, what they are called, and what a caller
 * outside a room can see of it.
 */
import { describe, it, expect } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { initPermissionGate } from '../../../services/core/capabilities/index.js';
import {
  ANA_PATH,
  BO_PATH,
  agentToken,
  createChannel,
  testServer,
  useRoomsApp,
} from './rooms.fixtures.js';

const db = useRoomsApp();

/** The operator's own author id, off a room they created. */
function operatorOf(room: { id: string }): string {
  return (room as unknown as { members: { authorId: string }[] }).members[0].authorId;
}

/** Add Ana to a room as the person and answer with her author id. */
async function addAna(roomId: string): Promise<string> {
  const added = await request(testServer)
    .post(`/api/rooms/${roomId}/members`)
    .send({ agentPath: ANA_PATH });
  expect(added.status).toBe(201);
  return added.body.authorId as string;
}

/** How many members a room's roster holds, read as the person. */
async function rosterSize(roomId: string): Promise<number> {
  return (await request(testServer).get(`/api/rooms/${roomId}`)).body.members.length;
}

describe('/api/rooms members', () => {
  describe('PATCH /authors/:authorId/handle', () => {
    it('sets a handle, normalized on the server, and gives it back on the author it reaches', async () => {
      const authorId = operatorOf(await createChannel('Handles'));

      const res = await request(testServer)
        .patch(`/api/rooms/authors/${authorId}/handle`)
        .send({ handle: '  Dorian  ' });

      expect(res.status).toBe(200);
      expect(res.body.handle).toBe('dorian');
      expect(res.body.id).toBe(authorId);
    });

    it('400s a spelling the grammar rejects, naming the rule', async () => {
      const authorId = operatorOf(await createChannel('Handles'));

      const res = await request(testServer)
        .patch(`/api/rooms/authors/${authorId}/handle`)
        .send({ handle: 'not a handle' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_handle');
      expect(res.body.detail).toMatch(/lowercase letters, numbers, dots/);
    });

    it('409s a handle live on another author, and one reserved to somebody else', async () => {
      const room = await createChannel('Taken');
      const me = operatorOf(room);
      const anaId = await addAna(room.id);

      const live = await request(testServer)
        .patch(`/api/rooms/authors/${me}/handle`)
        .send({ handle: 'ana' });
      expect(live.status).toBe(409);
      expect(live.body.code).toBe('handle_taken');

      // Ana releases `ana`. It stays hers, forever.
      await request(testServer)
        .patch(`/api/rooms/authors/${anaId}/handle`)
        .send({ handle: 'ana-pm' });
      const reserved = await request(testServer)
        .patch(`/api/rooms/authors/${me}/handle`)
        .send({ handle: 'ana' });
      expect(reserved.status).toBe(409);
      expect(reserved.body.code).toBe('handle_reserved');
    });

    it('refuses an AGENT presenting its own identity — handle changes are human-only', async () => {
      // S6: an agent that could rename itself in a loop would grow the
      // tombstone table forever, so there is no automated path at all.
      const me = operatorOf(await createChannel('Agents'));
      const token = await agentToken(db(), ANA_PATH, 'Ana');

      const res = await request(testServer)
        .patch(`/api/rooms/authors/${me}/handle`)
        .set('X-DorkOS-Agent', token)
        .send({ handle: 'stolen' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('operator_only');
    });

    it('404s an author that does not exist', async () => {
      const res = await request(testServer)
        .patch('/api/rooms/authors/01NOSUCHAUTHOR/handle')
        .send({ handle: 'nobody' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });
  });

  describe('members', () => {
    it('adds an agent by its directory, seeds a channel to engaged, and never puts the directory on the wire', async () => {
      const room = await createChannel();
      const res = await request(testServer)
        .post(`/api/rooms/${room.id}/members`)
        .send({ agentPath: ANA_PATH });

      expect(res.status).toBe(201);
      expect(res.body.responseMode).toBe('engaged');
      expect(res.body.author.displayName).toBe('Ana');
      expect(JSON.stringify(res.body)).not.toContain(ANA_PATH);
    });

    it('404s an agent path nothing is registered at', async () => {
      const room = await createChannel();
      const res = await request(testServer)
        .post(`/api/rooms/${room.id}/members`)
        .send({ agentPath: '/agents/ghost' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('changes a response mode, and refuses one outside the shared enum', async () => {
      const room = await createChannel();
      const anaId = await addAna(room.id);
      const target = `/api/rooms/${room.id}/members/${anaId}`;

      const res = await request(testServer).patch(target).send({ responseMode: 'always' });
      expect(res.status).toBe(200);
      expect(res.body.responseMode).toBe('always');

      expect(
        (await request(testServer).patch(target).send({ responseMode: 'sometimes' })).status
      ).toBe(400);
    });
  });

  describe('membership scoping', () => {
    /**
     * A real identity token for an agent on NO room's roster, so the requests
     * travel the path a rogue agent would: the header resolves (identity is
     * attribution, not authorization) and the room layer is the only thing
     * standing between it and somebody else's conversation.
     */
    function outsiderToken(): Promise<string> {
      return agentToken(db(), '/agents/outsider', 'Outsider');
    }

    it('does not list a room the caller is not a member of', async () => {
      await createChannel('Private');
      const res = await request(testServer)
        .get('/api/rooms')
        .set('X-DorkOS-Agent', await outsiderToken());
      expect(res.status).toBe(200);
      expect(res.body.rooms).toEqual([]);
    });

    it('404s GET /:id for a non-member exactly as for an unknown room', async () => {
      const room = await createChannel();
      const res = await request(testServer)
        .get(`/api/rooms/${room.id}`)
        .set('X-DorkOS-Agent', await outsiderToken());
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('room_not_found');
    });

    it('404s the history of a room the caller is not in', async () => {
      const room = await createChannel();
      await request(testServer).post(`/api/rooms/${room.id}/entries`).send({ text: 'private' });

      const res = await request(testServer)
        .get(`/api/rooms/${room.id}/entries`)
        .set('X-DorkOS-Agent', await outsiderToken());
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('private');
    });

    it('refuses a post into a room the caller is not in', async () => {
      const room = await createChannel();
      const res = await request(testServer)
        .post(`/api/rooms/${room.id}/entries`)
        .set('X-DorkOS-Agent', await outsiderToken())
        .send({ text: 'let me in' });
      expect(res.status).toBe(404);
    });

    it('stops an outsider adding itself to a room', async () => {
      const room = await createChannel();
      const res = await request(testServer)
        .post(`/api/rooms/${room.id}/members`)
        .set('X-DorkOS-Agent', await outsiderToken())
        .send({ agentPath: '/agents/outsider' });
      expect(res.status).toBe(404);
      expect(await rosterSize(room.id)).toBe(1);
    });

    it('lets the same agent read once it has actually been added', async () => {
      const room = await createChannel();
      const token = await agentToken(db(), ANA_PATH, 'Ana');

      const before = await request(testServer)
        .get(`/api/rooms/${room.id}`)
        .set('X-DorkOS-Agent', token);
      expect(before.status).toBe(404);

      await addAna(room.id);

      const after = await request(testServer)
        .get(`/api/rooms/${room.id}`)
        .set('X-DorkOS-Agent', token);
      expect(after.status).toBe(200);
      const listed = await request(testServer).get('/api/rooms').set('X-DorkOS-Agent', token);
      expect(listed.body.rooms.map((r: { id: string }) => r.id)).toEqual([room.id]);
    });

    /**
     * The roster routes are the OPERATOR's surface, and an agent identity buys
     * nothing on them (DOR-1611 review). Widening `RoomService.addMember` and
     * `removeMember` for the room-management verbs once widened these two
     * routes with them, which a direct `curl` could use to step around the Rooms
     * permission. The rows use a MEMBER agent deliberately: an outsider is
     * refused one step earlier, so it could never detect a relapse.
     */
    describe('the roster routes are operator-only, whatever the Rooms permission says', () => {
      /** Ana, put on the roster by the person, holding a valid token. */
      async function memberAgent(roomId: string): Promise<{ token: string; authorId: string }> {
        const authorId = await addAna(roomId);
        return { token: await agentToken(db(), ANA_PATH, 'Ana'), authorId };
      }

      it('refuses a member agent adding somebody', async () => {
        const room = await createChannel();
        const { token } = await memberAgent(room.id);

        const res = await request(testServer)
          .post(`/api/rooms/${room.id}/members`)
          .set('X-DorkOS-Agent', token)
          .send({ agentPath: BO_PATH });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('operator_only');
        expect(res.body.detail).toBe('Only you can change who is in a room');
        expect(await rosterSize(room.id)).toBe(2);
      });

      it('refuses a member agent removing somebody, even itself', async () => {
        const room = await createChannel();
        const { token, authorId } = await memberAgent(room.id);

        // Ana removing HERSELF, the shape the capability's `leave_room` may do.
        const res = await request(testServer)
          .delete(`/api/rooms/${room.id}/members/${authorId}`)
          .set('X-DorkOS-Agent', token);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('operator_only');
        expect(res.body.detail).toBe('Only you can change who is in a room');
        expect(await rosterSize(room.id)).toBe(2);
      });

      it('refuses the same agent even when its Rooms permission is Allowed', async () => {
        // The discriminating row: the permission unlocks the VERBS, not the
        // HTTP surface. Without it the two above would pass on a build where it
        // did unlock the routes.
        initPermissionGate({
          readConfig: () => ({ preset: 'full', defaults: { areas: {}, actions: {} } }),
          readAgentPermissions: async () => ({ areas: { rooms: 'allowed' } }),
        });
        const room = await createChannel();
        const { token, authorId } = await memberAgent(room.id);

        const added = await request(testServer)
          .post(`/api/rooms/${room.id}/members`)
          .set('X-DorkOS-Agent', token)
          .send({ agentPath: BO_PATH });
        const removed = await request(testServer)
          .delete(`/api/rooms/${room.id}/members/${authorId}`)
          .set('X-DorkOS-Agent', token);

        expect(added.status).toBe(403);
        expect(added.body.code).toBe('operator_only');
        expect(removed.status).toBe(403);
        expect(removed.body.code).toBe('operator_only');
        expect(await rosterSize(room.id)).toBe(2);
      });

      it('still lets the operator add and remove, and 404s a second removal', async () => {
        const room = await createChannel();
        const anaId = await addAna(room.id);
        expect(await rosterSize(room.id)).toBe(2);

        const removed = await request(testServer).delete(`/api/rooms/${room.id}/members/${anaId}`);
        expect(removed.status).toBe(204);
        expect(await rosterSize(room.id)).toBe(1);

        const again = await request(testServer).delete(`/api/rooms/${room.id}/members/${anaId}`);
        expect(again.status).toBe(404);
      });
    });
  });
});
