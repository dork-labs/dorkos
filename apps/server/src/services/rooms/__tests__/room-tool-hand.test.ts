/**
 * The service half of the room tool hand (room-participation spec §10.2, §10.3,
 * and the E16b reversal recorded in ADR 260814-...).
 *
 * Everything here is driven through the REAL service, store, author registry and
 * trigger dispatcher — only the turn runner stands in, because the alternative is
 * a model call. That matters most for two claims: that a tool post inherits the
 * live cascade rather than minting a fresh one, and that an agent which has
 * already spoken deliberately does not also get its narration posted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  scriptedRunner,
  settleUntil,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
});

describe('the room tool hand', () => {
  let service: RoomService;
  let store: RoomStore;
  let authors: AuthorRegistry;
  let runner: ScriptedTurnRunner;
  let channel: RoomWithRoster;
  let human: string;
  let ana: string;
  let bo: string;
  /** Sweep the message index, so what has been posted is findable. */
  let index: () => Promise<void>;

  /** Wire a harness whose runner answers with `reply`, and open a channel in it. */
  function harness(runnerOverride?: ScriptedTurnRunner): void {
    ({
      service,
      store,
      authors,
      runner,
      human,
      indexMessages: index,
    } = createRoomHarness({
      agents,
      runner: runnerOverride ?? scriptedRunner(() => null),
    }));
    channel = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      human
    );
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    bo = authors.resolveAgent('/agents/bo', 'Bo').id;
  }

  beforeEach(() => {
    harness();
  });

  // ── RP6: post_to_room ───────────────────────────────────────────────────

  describe('postFromTool', () => {
    it('writes a post through the guarded path, addressing whoever it names', () => {
      const entry = service.postFromTool(channel.id, {
        authorId: ana,
        text: 'the migration is running, @bo',
      });

      expect(entry.body.text).toBe('the migration is running, @bo');
      expect(entry.mentions).toEqual([bo]);
      expect(store.listEntries(channel.id, { limit: 10 }).at(-1)?.id).toBe(entry.id);
    });

    it('refuses in a direct message — there the reply IS the message (§2.6)', () => {
      const dm = service.createRoom(
        { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
        human
      );

      expect(() => service.postFromTool(dm.id, { authorId: ana, text: 'hello' })).toThrow(
        expect.objectContaining({ code: 'TOOL_POST_NOT_IN_DM' })
      );
      expect(store.listEntries(dm.id, { limit: 10 })).toEqual([]);
    });

    it('refuses a room the agent is not a member of, the way a missing room refuses', () => {
      const private_ = service.createRoom(
        { kind: 'channel', title: 'Private', members: [], agentPaths: ['/agents/bo'] },
        human
      );

      expect(() => service.postFromTool(private_.id, { authorId: ana, text: 'hi' })).toThrow(
        expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
      );
      expect(() => service.postFromTool('room_nope', { authorId: ana, text: 'hi' })).toThrow(
        expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
      );
    });

    it('lands a thread reply under the entry it names', () => {
      const root = service.post(channel.id, { authorId: human, text: 'ship it?' });

      const reply = service.postFromTool(channel.id, {
        authorId: ana,
        text: 'not yet',
        replyTo: root.id,
      });

      expect(reply.threadRootEntryId).toBe(root.id);
    });

    it('inherits the live cascade mid-turn instead of minting a fresh one', async () => {
      // Ana answers by posting through the tool from inside her own turn, which
      // is the shape `activeTurnFor` exists for.
      let posted: RoomEntry | undefined;
      harness(
        outcomeRunner((request) => {
          posted = service.postFromTool(request.room.id, {
            authorId: request.authorId,
            text: 'looking',
          });
          return { text: null };
        })
      );

      const asked = service.post(channel.id, { authorId: human, text: '@ana status?' });
      await settleUntil(() => posted !== undefined, 'Ana posted through the tool');

      expect(posted?.cascadeRoot).toBe(asked.cascadeRoot);
      expect(posted?.cascadeDepth).toBe(1);
    });

    it('is pre-spent at the ceiling when the agent has no turn running', () => {
      const entry = service.postFromTool(channel.id, { authorId: ana, text: 'heads up' });

      // `deriveCascade` stamps an un-provenanced agent post at the ceiling under
      // its own root, so nothing downstream of it is triggered.
      expect(entry.cascadeRoot).toBe(entry.id);
      expect(entry.cascadeDepth).toBe(3);
    });

    it('suppresses the turn narration when the agent already spoke deliberately', async () => {
      harness(
        outcomeRunner((request) => {
          service.postFromTool(request.room.id, {
            authorId: request.authorId,
            text: 'deployed — logs look clean',
          });
          return { text: 'I posted the deploy note into the channel.' };
        })
      );

      service.post(channel.id, { authorId: human, text: '@ana deploy please' });
      await service.triggersIdle();

      const said = store
        .listEntries(channel.id, { limit: 20 })
        .filter((entry) => entry.authorId === ana)
        .map((entry) => entry.body.text);
      expect(said).toEqual(['deployed — logs look clean']);
    });

    it('still posts the turn narration when the agent used no tool', async () => {
      harness(scriptedRunner(() => 'on it'));

      service.post(channel.id, { authorId: human, text: '@ana deploy please' });
      await service.triggersIdle();

      const said = store
        .listEntries(channel.id, { limit: 20 })
        .filter((entry) => entry.authorId === ana)
        .map((entry) => entry.body.text);
      expect(said).toEqual(['on it']);
    });
  });

  // ── RP7: history ────────────────────────────────────────────────────────

  describe('readHistory', () => {
    it('returns the room newest-first, capped by the caller"s limit', () => {
      for (const text of ['one', 'two', 'three']) {
        service.post(channel.id, { authorId: human, text });
      }

      const page = service.readHistory(channel.id, ana, { limit: 2 });

      expect(page.map((entry) => entry.body.text)).toEqual(['three', 'two']);
    });

    it('clamps a limit above the cap rather than refusing it', () => {
      for (let n = 0; n < 5; n += 1) {
        service.post(channel.id, { authorId: human, text: `line ${n}` });
      }

      expect(() => service.readHistory(channel.id, ana, { limit: 10_000 })).not.toThrow();
      expect(service.readHistory(channel.id, ana, { limit: 10_000 }).length).toBeLessThanOrEqual(
        200
      );
    });

    it('cannot read below the seq the agent joined at', () => {
      const late = service.createRoom(
        { kind: 'channel', title: 'Late', members: [], agentPaths: [] },
        human
      );
      const before = service.post(late.id, { authorId: human, text: 'said before ana arrived' });
      service.addMember(late.id, human, { agentPath: '/agents/ana' });
      const after = service.post(late.id, { authorId: human, text: 'said after ana arrived' });

      const seen = service.readHistory(late.id, ana, { limit: 50 }).map((entry) => entry.id);

      expect(seen).toContain(after.id);
      expect(seen).not.toContain(before.id);
    });

    it('answers a room it is not in exactly as it answers a room that does not exist', () => {
      const private_ = service.createRoom(
        { kind: 'channel', title: 'Private', members: [], agentPaths: ['/agents/bo'] },
        human
      );

      const outsider = (): unknown => service.readHistory(private_.id, ana, { limit: 5 });
      const missing = (): unknown => service.readHistory('room_nope', ana, { limit: 5 });

      expect(outsider).toThrow(expect.objectContaining({ code: 'ROOM_NOT_FOUND' }));
      expect(missing).toThrow(expect.objectContaining({ code: 'ROOM_NOT_FOUND' }));
    });

    it('refuses the owner in a room they can see but have not joined', () => {
      // The one caller `requireVisibleRoom` does NOT already refuse: the owner
      // sees every room on the install, and seeing a room is not being in it.
      // Reading a room's log is a membership, and the answer is the same
      // `ROOM_NOT_FOUND` a stranger gets, because a room id is not a capability.
      const { service: solo, authors: soloAuthors, human: owner } = createRoomHarness({ agents });
      const priya = soloAuthors.human('priya').id;
      const theirs = solo.createRoom(
        { kind: 'channel', title: 'Theirs', members: [], agentPaths: [] },
        priya
      );
      solo.post(theirs.id, { authorId: priya, text: 'mine' });

      expect(() => solo.readHistory(theirs.id, owner, { limit: 5 })).toThrow(
        expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
      );
    });

    it('narrows to one thread when asked', () => {
      const root = service.post(channel.id, { authorId: human, text: 'thread opener' });
      service.post(channel.id, { authorId: human, text: 'in the thread', replyTo: root.id });
      service.post(channel.id, { authorId: human, text: 'top level again' });

      const thread = service.readHistory(channel.id, ana, {
        limit: 50,
        threadRootEntryId: root.id,
      });

      expect(thread.map((entry) => entry.body.text)).toEqual(['in the thread']);
    });
  });

  describe('searchHistory', () => {
    it('matches word stems through the shipped index, best first', async () => {
      service.post(channel.id, { authorId: human, text: 'the migration is DOGGED by locks' });
      service.post(channel.id, { authorId: human, text: 'nothing to do with animals' });
      await index();

      const hits = service.searchHistory(channel.id, ana, { query: 'dogs', limit: 10 });

      expect(hits.map((entry) => entry.body.text)).toEqual(['the migration is DOGGED by locks']);
    });

    it('cannot find anything said before the agent joined', async () => {
      const late = service.createRoom(
        { kind: 'channel', title: 'Late', members: [], agentPaths: [] },
        human
      );
      service.post(late.id, { authorId: human, text: 'kubernetes rollout notes' });
      service.addMember(late.id, human, { agentPath: '/agents/ana' });
      service.post(late.id, { authorId: human, text: 'kubernetes rollout finished' });
      await index();

      const hits = service.searchHistory(late.id, ana, { query: 'kubernetes', limit: 10 });

      expect(hits.map((entry) => entry.body.text)).toEqual(['kubernetes rollout finished']);
    });

    it('answers a room it is not in exactly as it answers a room that does not exist', async () => {
      const private_ = service.createRoom(
        { kind: 'channel', title: 'Private', members: [], agentPaths: ['/agents/bo'] },
        human
      );
      service.post(private_.id, { authorId: human, text: 'secret kubernetes plan' });
      await index();

      expect(() =>
        service.searchHistory(private_.id, ana, { query: 'kubernetes', limit: 5 })
      ).toThrow(expect.objectContaining({ code: 'ROOM_NOT_FOUND' }));
      expect(() =>
        service.searchHistory('room_nope', ana, { query: 'kubernetes', limit: 5 })
      ).toThrow(expect.objectContaining({ code: 'ROOM_NOT_FOUND' }));
    });

    it('narrows to one thread when asked', async () => {
      const root = service.post(channel.id, { authorId: human, text: 'deploy plan' });
      service.post(channel.id, {
        authorId: human,
        text: 'deploy blocked on migration',
        replyTo: root.id,
      });
      service.post(channel.id, { authorId: human, text: 'deploy done at the top level' });
      await index();

      const hits = service.searchHistory(channel.id, ana, {
        query: 'deploy',
        limit: 10,
        threadRootEntryId: root.id,
      });

      expect(hits.map((entry) => entry.body.text)).toEqual(['deploy blocked on migration']);
    });

    it('clamps a limit above the cap rather than refusing it', async () => {
      service.post(channel.id, { authorId: human, text: 'kubernetes' });
      await index();

      expect(
        service.searchHistory(channel.id, ana, { query: 'kubernetes', limit: 10_000 }).length
      ).toBeLessThanOrEqual(200);
    });

    it('finds nothing for a query with no word in it, rather than throwing', async () => {
      service.post(channel.id, { authorId: human, text: 'kubernetes' });
      await index();

      expect(service.searchHistory(channel.id, ana, { query: '"" NEAR(', limit: 5 })).toEqual([]);
    });
  });

  // ── The reaction reversal ───────────────────────────────────────────────

  describe('agents may react', () => {
    it('lets an agent put an emoji on a message', () => {
      const entry = service.post(channel.id, { authorId: human, text: 'shipping today' });

      expect(service.toggleReaction(channel.id, entry.id, ana, '👍').reacted).toBe(true);
      expect(service.reactionsFor(channel.id, entry.id)).toEqual([
        { emoji: '👍', authorIds: [ana], firstAt: expect.any(String) },
      ]);
    });

    it('writes no entry, spends no turn and triggers nobody', async () => {
      const entry = service.post(channel.id, { authorId: human, text: 'shipping today' });
      const before = store.listEntries(channel.id, { limit: 50 }).length;
      runner.turns.length = 0;

      service.toggleReaction(channel.id, entry.id, ana, '🎉');
      await service.triggersIdle();

      expect(store.listEntries(channel.id, { limit: 50 })).toHaveLength(before);
      expect(runner.turns).toEqual([]);
    });

    it('stops an agent after its hourly ceiling in this room, and says so', () => {
      const entries = Array.from({ length: 40 }, (_, n) =>
        service.post(channel.id, { authorId: human, text: `line ${n}` })
      );

      let landed = 0;
      let refusal: unknown;
      for (const entry of entries) {
        try {
          service.toggleReaction(channel.id, entry.id, ana, '👍');
          landed += 1;
        } catch (err) {
          refusal = err;
          break;
        }
      }

      expect(landed).toBe(20);
      expect(refusal).toMatchObject({ code: 'REACTION_RATE_LIMITED' });
    });

    it('bounds each agent in each room separately, and never bounds a person', () => {
      const entries = Array.from({ length: 25 }, (_, n) =>
        service.post(channel.id, { authorId: human, text: `line ${n}` })
      );
      for (const entry of entries.slice(0, 20)) {
        service.toggleReaction(channel.id, entry.id, ana, '👍');
      }

      // Ana is spent here; Bo is not, and neither is the person.
      expect(() => service.toggleReaction(channel.id, entries[20]!.id, ana, '🎉')).toThrow(
        expect.objectContaining({ code: 'REACTION_RATE_LIMITED' })
      );
      expect(service.toggleReaction(channel.id, entries[20]!.id, bo, '👍').reacted).toBe(true);
      expect(service.toggleReaction(channel.id, entries[20]!.id, human, '👍').reacted).toBe(true);
    });

    it('still refuses an agent that is not a member of the room', () => {
      const private_ = service.createRoom(
        { kind: 'channel', title: 'Private', members: [], agentPaths: ['/agents/bo'] },
        human
      );
      const entry = service.post(private_.id, { authorId: human, text: 'private' });

      expect(() => service.toggleReaction(private_.id, entry.id, ana, '👍')).toThrow(
        expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
      );
    });
  });
});
