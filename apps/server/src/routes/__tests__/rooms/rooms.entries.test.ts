/**
 * `/api/rooms`: posting, reading, threading and stopping a room's messages.
 */
import { describe, it, expect } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import {
  ANA_PATH,
  BO_PATH,
  agentToken,
  createChannel,
  testServer,
  useRoomsApp,
} from './rooms.fixtures.js';

const db = useRoomsApp();

/** Post a top-level message and answer with its entry id. */
async function post(roomId: string, text: string): Promise<string> {
  const res = await request(testServer).post(`/api/rooms/${roomId}/entries`).send({ text });
  return res.body.entryId as string;
}

/** Reply in a thread. */
function reply(roomId: string, rootEntryId: string, text?: string) {
  return request(testServer)
    .post(`/api/rooms/${roomId}/threads`)
    .send(text === undefined ? { rootEntryId } : { rootEntryId, text });
}

describe('/api/rooms entries', () => {
  describe('POST /:id/entries', () => {
    it('accepts with 202 and returns the entry identity, not the entry', async () => {
      const room = await createChannel();
      const res = await request(testServer)
        .post(`/api/rooms/${room.id}/entries`)
        .send({ text: 'hello' });

      // Trigger-only: delivery is the SSE stream's job, so the body carries
      // identity plus who the message reached (DOR-786). This room has no
      // agents, so both lists are empty, and empty is an ANSWER.
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        accepted: true,
        entryId: expect.any(String),
        seq: 1,
        triggered: [],
        skipped: [],
      });
    });

    it('rejects an empty message', async () => {
      const room = await createChannel();
      const res = await request(testServer)
        .post(`/api/rooms/${room.id}/entries`)
        .send({ text: '' });
      expect(res.status).toBe(400);
    });

    it('409s a post into an archived room', async () => {
      const room = await createChannel();
      await request(testServer).patch(`/api/rooms/${room.id}`).send({ archived: true });

      const res = await request(testServer)
        .post(`/api/rooms/${room.id}/entries`)
        .send({ text: 'hi' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('room_archived');
    });

    it('does not let the body choose an author', async () => {
      const room = await createChannel();
      await request(testServer)
        .post(`/api/rooms/${room.id}/entries`)
        .send({ text: 'hi', authorId: 'somebody-else' });

      const entries = await request(testServer).get(`/api/rooms/${room.id}/entries`);
      const roster = await request(testServer).get(`/api/rooms/${room.id}`);
      expect(entries.body.entries[0].authorId).toBe(roster.body.members[0].authorId);
    });
  });

  describe('GET /:id/entries', () => {
    /** A room with `count` posts in it, written through the real route. */
    async function roomOf(count: number): Promise<string> {
      const room = await createChannel();
      for (let i = 1; i <= count; i++) await post(room.id, `line ${i}`);
      return room.id;
    }

    /** The seqs one page carries. */
    function seqs(body: { entries: { seq: number }[] }): number[] {
      return body.entries.map((entry) => entry.seq);
    }

    it('rejects an out-of-range limit rather than clamping it silently', async () => {
      const room = await createChannel();
      const res = await request(testServer)
        .get(`/api/rooms/${room.id}/entries`)
        .query({ limit: 5000 });
      expect(res.status).toBe(400);
    });

    // The cursor a reader scrolls back on (DOR-1734).
    describe('?before= — reading past the page the room opened on', () => {
      it('tiles the room exactly: consecutive pages meet, with no gap and no repeat', async () => {
        // A cursor inclusive at either end would repeat a line here, and one
        // that stepped by the wrong amount would lose one.
        const roomId = await roomOf(12);

        const collected: number[] = [];
        let cursor: number | undefined;
        for (let read = 0; read < 10; read++) {
          const res = await request(testServer)
            .get(`/api/rooms/${roomId}/entries`)
            .query(cursor === undefined ? { limit: 5 } : { before: cursor, limit: 5 });
          expect(res.status).toBe(200);
          const page = seqs(res.body);
          if (page.length === 0) break;
          collected.unshift(...page);
          cursor = page[0];
        }

        expect(collected).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      });

      it('answers an empty page below the oldest entry, rather than the same page again', async () => {
        const roomId = await roomOf(3);

        const res = await request(testServer)
          .get(`/api/rooms/${roomId}/entries`)
          .query({ before: 1, limit: 5 });

        expect(res.status).toBe(200);
        expect(res.body.entries).toEqual([]);
        expect(res.body.threadRoots).toEqual([]);
      });

      it('resolves the roots of the page it is asked for, not of the newest one', async () => {
        // `threadRoots` is per PAGE (DOR-690): the page under test is in the
        // middle of the room, and its root is one no trailing page would name.
        const roomId = (await createChannel()).id;
        const root = await post(roomId, 'why is the build slow?');
        for (let i = 0; i < 4; i++) await reply(roomId, root, `answer ${i}`);
        for (let i = 0; i < 4; i++) await post(roomId, `later ${i}`);

        const trailing = await request(testServer)
          .get(`/api/rooms/${roomId}/entries`)
          .query({ limit: 4 });
        expect(trailing.body.threadRoots).toEqual([]);

        const older = await request(testServer)
          .get(`/api/rooms/${roomId}/entries`)
          .query({ before: seqs(trailing.body)[0], limit: 4 });
        expect(older.body.entries).toHaveLength(4);
        expect((older.body.threadRoots as { id: string }[]).map((held) => held.id)).toEqual([root]);
      });

      it.each([
        ['a word', 'oldest'],
        ['a negative seq', '-5'],
        ['zero, which is below every seq a room allocates', '0'],
        ['a fraction, which is not a position in a log', '1.5'],
      ])('refuses %s rather than reading something else', async (_case, before) => {
        // Coerced silently, `NaN` and `0` both read as "no filter" and would
        // answer the NEWEST page to a request for the oldest.
        const roomId = await roomOf(3);
        const res = await request(testServer).get(`/api/rooms/${roomId}/entries`).query({ before });
        expect(res.status).toBe(400);
      });
    });

    /**
     * The page boundary a busy thread crosses (DOR-690). Sized past the default
     * page on purpose: a root and sixty replies, so the fifty entries the
     * default page returns are ALL replies and the root is nowhere in them.
     */
    it('answers a buried root once, with the room-wide reply count and its reactions', async () => {
      const room = await createChannel();
      const rootEntryId = await post(room.id, 'why is the build slow?');
      for (let i = 0; i < 60; i++) {
        expect((await reply(room.id, rootEntryId, `answer ${i}`)).status).toBe(202);
      }
      await request(testServer)
        .post(`/api/rooms/${room.id}/entries/${rootEntryId}/reactions`)
        .send({ emoji: '🎉' });

      const res = await request(testServer).get(`/api/rooms/${room.id}/entries`);
      const entries = res.body.entries as { id: string; seq: number }[];
      const roots = res.body.threadRoots as {
        id: string;
        seq: number;
        threadReplyCount: number;
        reactions: { emoji: string }[];
      }[];

      // The premise, asserted rather than assumed.
      expect(entries).toHaveLength(50);
      expect(entries.map((entry) => entry.id)).not.toContain(rootEntryId);
      // Exactly one root, deduped across fifty replies, older than the page.
      expect(roots.map((root) => root.id)).toEqual([rootEntryId]);
      expect(roots[0].seq).toBeLessThan(entries[0].seq);
      // Sixty, the ROOM's count, beside a page that carries fifty of them.
      expect(roots[0].threadReplyCount).toBe(60);
      // A root arriving through the second read still renders its pills.
      expect(roots[0].reactions.map((pill) => pill.emoji)).toEqual(['🎉']);
    });

    it('says nothing extra when the page holds every root it points at', async () => {
      // The absent count is the instruction "count what you have", and the
      // self-contained page costs no extra rows on the wire.
      const room = await createChannel();
      const root = await post(room.id, 'why is the build slow?');
      await reply(room.id, root, 'the cache is cold');

      const res = await request(testServer).get(`/api/rooms/${room.id}/entries`);
      const entries = res.body.entries as { threadReplyCount?: number }[];
      expect(entries).toHaveLength(2);
      expect(entries.every((entry) => entry.threadReplyCount === undefined)).toBe(true);
      expect(res.body.threadRoots).toEqual([]);
    });
  });

  describe('POST /:id/threads', () => {
    it('accepts a reply and writes it into this room, not a new one', async () => {
      const room = await createChannel();
      const root = await post(room.id, 'why is the build slow?');

      const res = await reply(room.id, root, 'the cache is cold');
      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(true);

      const entries = await request(testServer).get(`/api/rooms/${room.id}/entries?limit=50`);
      const written = entries.body.entries.find(
        (e: { id: string }) => e.id === res.body.entryId
      ) as { parentEntryId: string; threadRootEntryId: string };
      expect(written.parentEntryId).toBe(root);
      expect(written.threadRootEntryId).toBe(root);

      const rooms = await request(testServer).get('/api/rooms');
      expect(rooms.body.rooms.map((r: { id: string }) => r.id)).toEqual([room.id]);
    });

    it('400s a reply whose root is itself a reply, or that has no text', async () => {
      const room = await createChannel();
      const root = await post(room.id, 'why is the build slow?');
      const first = await reply(room.id, root, 'the cache is cold');

      const nested = await reply(room.id, first.body.entryId, 'deeper');
      expect(nested.status).toBe(400);
      expect(nested.body.code).toBe('invalid_request');

      expect((await reply(room.id, root)).status).toBe(400);
    });

    it('404s a reply to an entry this room does not hold', async () => {
      const room = await createChannel();
      const res = await reply(room.id, 'no-such-entry', 'orphan');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('409s a reply into an archived room', async () => {
      // A thread answers to every rule an ordinary post does.
      const room = await createChannel();
      const root = await post(room.id, 'why is the build slow?');
      await request(testServer).patch(`/api/rooms/${room.id}`).send({ archived: true });

      const res = await reply(room.id, root, 'too late');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('room_archived');
    });
  });

  describe('GET /threads', () => {
    it('answers with the caller’s threads across rooms, newest first', async () => {
      const backend = await createChannel('Backend');
      const design = await createChannel('Design');
      const older = await post(backend.id, 'older question');
      await reply(backend.id, older, 'on it');
      const newer = await post(design.id, 'newer question');
      await reply(design.id, newer, 'on it');

      const res = await request(testServer).get('/api/rooms/threads');
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
      const res = await request(testServer).get('/api/rooms/threads');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ threads: [] });
    });

    it('400s a limit outside the allowed range', async () => {
      const res = await request(testServer).get('/api/rooms/threads').query({ limit: 5000 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    });
  });

  describe('POST /:id/halt', () => {
    it('answers with how many turns it stopped, and writes the room a notice', async () => {
      const room = await createChannel();

      // No body: Express 5 leaves `req.body` undefined on an empty POST.
      const res = await request(testServer).post(`/api/rooms/${room.id}/halt`);

      // Nothing was running, and that is a real answer rather than a failure.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stopped: 0 });
      const entries = await request(testServer).get(`/api/rooms/${room.id}/entries`);
      expect(entries.body.entries.at(-1).body.notice).toBe('halted');
    });

    it('404s a room that is not there', async () => {
      const res = await request(testServer).post('/api/rooms/no-such-room/halt');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('room_not_found');
    });
  });

  describe('POST /:id/halt/:authorId', () => {
    /** A channel holding Ana, with her author id and the operator's. */
    async function channelWithAna(title: string): Promise<{ id: string; ana: string; me: string }> {
      const room = await createChannel(title);
      await request(testServer).post(`/api/rooms/${room.id}/members`).send({ agentPath: ANA_PATH });
      const roster = (await request(testServer).get(`/api/rooms/${room.id}`)).body
        .members as Array<{ authorId: string; author: { kind: string; displayName: string } }>;
      return {
        id: room.id,
        ana: roster.find((member) => member.author.displayName === 'Ana')!.authorId,
        me: roster.find((member) => member.author.kind === 'human')!.authorId,
      };
    }

    /** Every `halted` notice stored in a room. */
    async function haltedIn(roomId: string): Promise<Array<{ body: Record<string, string> }>> {
      const entries = (await request(testServer).get(`/api/rooms/${roomId}/entries`)).body
        .entries as Array<{ body: Record<string, string> }>;
      return entries.filter((entry) => entry.body.notice === 'halted');
    }

    it('answers whether a turn was stopped, and names the agent in the room', async () => {
      const room = await channelWithAna('Stop one');

      const res = await request(testServer).post(`/api/rooms/${room.id}/halt/${room.ana}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stopped: 0 });
      const halted = await haltedIn(room.id);
      expect(halted).toHaveLength(1);
      // The subject tells a per-agent stop from a room-wide one on the wire.
      expect(halted[0].body.subjectAuthorId).toBe(room.ana);
      expect(halted[0].body.text).toContain('Ana was not working here at the time');
    });

    it('refuses an agent trying to stop a room-mate, and the room stays silent', async () => {
      const room = await channelWithAna('Agents do not stop agents');
      const token = await agentToken(db(), ANA_PATH, 'Ana');

      const res = await request(testServer)
        .post(`/api/rooms/${room.id}/halt/${room.ana}`)
        .set('X-DorkOS-Agent', token);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('person_only');
      expect(await haltedIn(room.id)).toHaveLength(0);
    });

    it('answers a room the caller cannot see exactly as it answers one that is not there', async () => {
      // The room gate runs BEFORE the roster check, so a caller who cannot see
      // the room learns nothing about who is on it.
      const room = await channelWithAna('Not yours');
      const token = await agentToken(db(), BO_PATH, 'Bo');

      const unseen = await request(testServer)
        .post(`/api/rooms/${room.id}/halt/${room.ana}`)
        .set('X-DorkOS-Agent', token);
      const missing = await request(testServer)
        .post(`/api/rooms/no-such-room/halt/${room.ana}`)
        .set('X-DorkOS-Agent', token);

      expect(unseen.status).toBe(404);
      expect(unseen.body.code).toBe('room_not_found');
      expect(unseen.body).toEqual(missing.body);
    });

    it('404s an author that is not an agent on this roster', async () => {
      const room = await channelWithAna('No such member');

      const stranger = await request(testServer).post(`/api/rooms/${room.id}/halt/01NOSUCHAUTHOR`);
      expect(stranger.status).toBe(404);
      expect(stranger.body.code).toBe('not_found');

      // A PERSON on the roster is refused by the same code.
      const person = await request(testServer).post(`/api/rooms/${room.id}/halt/${room.me}`);
      expect(person.status).toBe(404);
      expect(person.body.code).toBe('not_found');
      expect(await haltedIn(room.id)).toHaveLength(0);
    });

    it.each([
      ['the whole room', (room: { id: string; ana: string }) => `/api/rooms/${room.id}/halt`],
      [
        'one agent',
        (room: { id: string; ana: string }) => `/api/rooms/${room.id}/halt/${room.ana}`,
      ],
    ])('still stops %s in an archived room', async (_case, target) => {
      // Archiving stops a room GAINING messages; a turn already running is
      // still running, and refusing here would shut the only way to stop it.
      const room = await channelWithAna('Archived');
      await request(testServer).patch(`/api/rooms/${room.id}`).send({ archived: true });

      const res = await request(testServer).post(target(room));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stopped: 0 });
    });
  });
});
