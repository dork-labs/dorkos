/**
 * Reactions on room entries, driven through the REAL service, the REAL store
 * and the REAL trigger dispatcher.
 *
 * The dispatcher is not incidental here — it is half of what is under test. The
 * headline claim of `specs/room-messaging-design` §2.5 is that a reaction is
 * COSTLESS: no turn, no trigger, no entry, no notice, no cascade, no bump in the
 * activity order. Every one of those is a claim about the machinery that would
 * otherwise fire, so the machinery has to be present and un-stubbed for a green
 * result to mean anything. Only the runner stands in, because the alternative is
 * a model call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { Db } from '@dorkos/db';
import type { RoomEntry, RoomEvent, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { REACTION_FREQUENTS_DEFAULT } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../../author-registry.js';
import type { ReactionStore } from '../reaction-store.js';
import { RoomError } from '../../room-errors.js';
import type { RoomService } from '../../room-service.js';
import type { RoomStore } from '../../room-store.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type ScriptedTurnRunner,
} from '../../__tests__/room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
});

describe('reactions', () => {
  let db: Db;
  let service: RoomService;
  let store: RoomStore;
  let reactions: ReactionStore;
  let authors: AuthorRegistry;
  let runner: ScriptedTurnRunner;
  let room: RoomWithRoster;
  let human: string;
  let ana: string;
  /** Everything the room fanned out, recorded at the one seam it all passes. */
  let published: RoomEvent[] = [];

  beforeEach(() => {
    ({ db, service, store, reactions, authors, runner, human } = createRoomHarness({
      agents,
      // Silent by default: most of these tests are about a reaction causing
      // nothing, and an agent that answers every post would fill the log with
      // entries nobody here is measuring.
      runner: scriptedRunner(() => null),
    }));
    room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;

    published = [];
    const broadcaster = service.stream;
    const deliver = broadcaster.publish.bind(broadcaster);
    vi.spyOn(broadcaster, 'publish').mockImplementation((roomId, event) => {
      if (roomId === room.id) published.push(event);
      deliver(roomId, event);
    });
  });

  /** Ana says something, and the entry she wrote comes back. */
  function anaSaid(text = 'Deployed to staging — the migration ran clean.'): RoomEntry {
    return service.post(room.id, { authorId: ana, text });
  }

  /** The reaction frames this room has fanned out, in order. */
  function reactionEvents(): Array<Extract<RoomEvent, { type: 'reaction' }>> {
    return published.filter((event) => event.type === 'reaction');
  }

  describe('the toggle', () => {
    it('adds a reaction, then takes the same one back', () => {
      const entry = anaSaid();

      expect(service.toggleReaction(room.id, entry.id, human, '👍').reacted).toBe(true);
      expect(reactions.listForEntry(room.id, entry.id)).toEqual([
        { emoji: '👍', authorIds: [human], firstAt: expect.any(String) },
      ]);

      expect(service.toggleReaction(room.id, entry.id, human, '👍').reacted).toBe(false);
      expect(
        reactions.listForEntry(room.id, entry.id),
        'the pill IS the toggle — a second click removes it'
      ).toEqual([]);
    });

    it('keeps a second emoji from the same person beside the first', () => {
      const entry = anaSaid();
      // Driven, because these two land in the same millisecond otherwise — one
      // click on a quick row does exactly that — and a same-millisecond pair
      // orders by the emoji itself, which is deterministic but not the rule this
      // test is about.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-07-30T09:00:00.000Z'));
        service.toggleReaction(room.id, entry.id, human, '👍');
        vi.setSystemTime(new Date('2026-07-30T09:00:01.000Z'));
        service.toggleReaction(room.id, entry.id, human, '🎉');
      } finally {
        vi.useRealTimers();
      }

      expect(reactions.listForEntry(room.id, entry.id).map((pill) => pill.emoji)).toEqual([
        '👍',
        '🎉',
      ]);
    });

    it('lands on a named state instead of flipping, when the caller names one', () => {
      const entry = anaSaid();

      expect(service.toggleReaction(room.id, entry.id, human, '👍', true).reacted).toBe(true);
      expect(
        service.toggleReaction(room.id, entry.id, human, '👍', true).reacted,
        'asking for ON twice leaves it ON — that is the whole point of naming it'
      ).toBe(true);
      expect(service.reactionsFor(room.id, entry.id).map((pill) => pill.emoji)).toEqual(['👍']);

      expect(service.toggleReaction(room.id, entry.id, human, '👍', false).reacted).toBe(false);
      expect(
        service.toggleReaction(room.id, entry.id, human, '👍', false).reacted,
        'and asking for OFF twice leaves it OFF'
      ).toBe(false);
      expect(service.reactionsFor(room.id, entry.id)).toEqual([]);
    });

    it('does not restamp a reaction that is already on, so the pill keeps its place', () => {
      const priya = authors.human('priya').id;
      service.addMember(room.id, human, { authorId: priya });
      const entry = anaSaid();

      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-07-30T09:00:00.000Z'));
        service.toggleReaction(room.id, entry.id, human, '👀', true);
        vi.setSystemTime(new Date('2026-07-30T09:00:01.000Z'));
        service.toggleReaction(room.id, entry.id, priya, '👍', true);
        // A retry of the first one. If it deleted and re-inserted, 👀 would take
        // a fresh timestamp and jump to the end of the row under the reader.
        vi.setSystemTime(new Date('2026-07-30T09:00:02.000Z'));
        service.toggleReaction(room.id, entry.id, human, '👀', true);
      } finally {
        vi.useRealTimers();
      }

      const pills = service.reactionsFor(room.id, entry.id);
      expect(pills.map((pill) => pill.emoji)).toEqual(['👀', '👍']);
      expect(pills[0].firstAt).toBe('2026-07-30T09:00:00.000Z');
    });

    it('orders two emoji from one person in the same millisecond by the emoji itself', () => {
      const entry = anaSaid();
      vi.useFakeTimers();
      try {
        // 🎉 (U+1F389) sorts before 👍 (U+1F44D), whichever order they were sent
        // in — the point is that the answer is total, not that it is insertion
        // order, because at this resolution there is no insertion order to know.
        vi.setSystemTime(new Date('2026-07-30T09:00:00.000Z'));
        service.toggleReaction(room.id, entry.id, human, '👍');
        service.toggleReaction(room.id, entry.id, human, '🎉');
      } finally {
        vi.useRealTimers();
      }

      expect(reactions.listForEntry(room.id, entry.id).map((pill) => pill.emoji)).toEqual([
        '🎉',
        '👍',
      ]);
    });

    it('gathers two people onto one pill, in the order they reacted', () => {
      const priya = authors.human('priya').id;
      service.addMember(room.id, human, { authorId: priya });
      const entry = anaSaid();

      // The clock is driven, because it is the ordering rule under test. Left to
      // the real one both reactions land in the same millisecond, the author-id
      // tiebreak decides, and the assertion would pass or fail on which author
      // row happened to be minted first — a lottery, not a check.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-07-30T09:00:00.000Z'));
        service.toggleReaction(room.id, entry.id, priya, '👍');
        vi.setSystemTime(new Date('2026-07-30T09:00:01.000Z'));
        service.toggleReaction(room.id, entry.id, human, '👍');
      } finally {
        vi.useRealTimers();
      }

      expect(reactions.listForEntry(room.id, entry.id)).toEqual([
        {
          emoji: '👍',
          authorIds: [priya, human],
          firstAt: '2026-07-30T09:00:00.000Z',
        },
      ]);
    });

    it('orders pills by when each one first appeared, never by how many joined it', () => {
      const priya = authors.human('priya').id;
      service.addMember(room.id, human, { authorId: priya });
      const entry = anaSaid();

      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-07-30T09:00:00.000Z'));
        service.toggleReaction(room.id, entry.id, human, '👀');
        vi.setSystemTime(new Date('2026-07-30T09:00:01.000Z'));
        service.toggleReaction(room.id, entry.id, human, '👍');
        vi.setSystemTime(new Date('2026-07-30T09:00:02.000Z'));
        service.toggleReaction(room.id, entry.id, priya, '👍');
      } finally {
        vi.useRealTimers();
      }

      // 👍 has two reactors and 👀 has one, and 👀 still comes first: a pill that
      // jumped left as people joined it would move under the reader's cursor.
      expect(reactions.listForEntry(room.id, entry.id).map((pill) => pill.emoji)).toEqual([
        '👀',
        '👍',
      ]);
    });

    it('breaks a same-millisecond tie on author id, so the order is never the planner’s', () => {
      const priya = authors.human('priya').id;
      service.addMember(room.id, human, { authorId: priya });
      const entry = anaSaid();

      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-07-30T09:00:00.000Z'));
        service.toggleReaction(room.id, entry.id, priya, '👍');
        service.toggleReaction(room.id, entry.id, human, '👍');
      } finally {
        vi.useRealTimers();
      }

      expect(reactions.listForEntry(room.id, entry.id)[0].authorIds).toEqual([priya, human].sort());
    });

    it('takes back only the reacting person, leaving everybody else on the pill', () => {
      const priya = authors.human('priya').id;
      service.addMember(room.id, human, { authorId: priya });
      const entry = anaSaid();
      service.toggleReaction(room.id, entry.id, priya, '👍');
      service.toggleReaction(room.id, entry.id, human, '👍');

      service.toggleReaction(room.id, entry.id, human, '👍');

      expect(reactions.listForEntry(room.id, entry.id)).toEqual([
        { emoji: '👍', authorIds: [priya], firstAt: expect.any(String) },
      ]);
    });
  });

  describe('costless — what a reaction does NOT do (§2.5)', () => {
    it('runs no turn, writes no entry, and does not move the room', async () => {
      // Ana answers everything, so a trigger of any kind would be visible.
      ({ db, service, store, reactions, authors, runner, human } = createRoomHarness({
        agents,
        runner: scriptedRunner(() => 'on it'),
      }));
      room = service.createRoom(
        { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
        human
      );
      ana = authors.resolveAgent('/agents/ana', 'Ana').id;
      const entry = service.post(room.id, { authorId: ana, text: 'Deployed to staging.' });
      await service.triggersIdle();

      const turnsBefore = runner.turns.length;
      const seqBefore = service.maxSeq(room.id);
      const activityBefore = store.getRoom(room.id)?.lastActivityAt;

      service.toggleReaction(room.id, entry.id, human, '👍');
      await service.triggersIdle();

      expect(runner.turns.length, 'a reaction takes no turn').toBe(turnsBefore);
      expect(service.maxSeq(room.id), 'a reaction writes no entry and no notice').toBe(seqBefore);
      expect(
        store.getRoom(room.id)?.lastActivityAt,
        'being thanked must not push a quiet room up a sidebar sorted by recency'
      ).toBe(activityBefore);
    });

    it('spends none of the room budget', async () => {
      ({ service, authors, runner, human } = createRoomHarness({
        agents,
        runner: scriptedRunner(() => null),
        // One automatic turn in the whole hour: if a reaction spent it, the post
        // afterwards would be refused and never reach the runner.
        maxAutomaticTurnsPerRoomPerHour: 1,
      }));
      room = service.createRoom(
        { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
        human
      );
      ana = authors.resolveAgent('/agents/ana', 'Ana').id;
      const entry = service.post(room.id, { authorId: ana, text: 'Deployed.' });

      service.toggleReaction(room.id, entry.id, human, '👍');
      service.toggleReaction(room.id, entry.id, human, '🎉');
      service.toggleReaction(room.id, entry.id, human, '❤️');
      service.post(room.id, { authorId: human, text: '@ana how long did it take?' });
      await service.triggersIdle();

      expect(runner.turns, 'three reactions did not eat the hour’s one turn').toHaveLength(1);
    });
  });

  describe('who may react', () => {
    it('lets an agent in the room react, bounded rather than banned', () => {
      // The reversal of etiquette E16b (ADR 260814-195522). The BOUND that
      // replaced the ban is `room-tool-hand.test.ts`'s; this pins that the door
      // is open at all, because it used to be a `PEOPLE_ONLY` refusal here.
      const entry = service.post(room.id, { authorId: human, text: 'shipping today' });

      expect(service.toggleReaction(room.id, entry.id, ana, '👍').reacted).toBe(true);
      expect(service.reactionsFor(room.id, entry.id)).toEqual([
        { emoji: '👍', authorIds: [ana], firstAt: expect.any(String) },
      ]);
    });

    it('refuses a person who is not a member of the room', () => {
      const outsider = authors.human('outsider').id;
      const entry = anaSaid();

      expect(() => service.toggleReaction(room.id, entry.id, outsider, '👍')).toThrow(
        expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
      );
    });

    it('refuses the owner in a room they can see but have not joined', () => {
      // The owner sees every room; seeing one is not being in it, and `post`
      // draws the same line.
      const { service: solo, authors: soloAuthors, human: owner } = createRoomHarness({ agents });
      const priya = soloAuthors.human('priya').id;
      const theirs = solo.createRoom(
        { kind: 'channel', title: 'Theirs', members: [], agentPaths: [] },
        priya
      );
      const entry = solo.post(theirs.id, { authorId: priya, text: 'mine' });

      expect(() => solo.toggleReaction(theirs.id, entry.id, owner, '👍')).toThrow(
        expect.objectContaining({ code: 'MEMBER_NOT_FOUND' })
      );
    });

    it('refuses an archived room', () => {
      const entry = anaSaid();
      service.updateRoom(room.id, human, { archived: true });

      expect(() => service.toggleReaction(room.id, entry.id, human, '👍')).toThrow(
        expect.objectContaining({ code: 'ROOM_ARCHIVED' })
      );
    });

    it('refuses an entry that is not in this room', () => {
      const elsewhere = service.createRoom(
        { kind: 'channel', title: 'Other', members: [], agentPaths: [] },
        human
      );
      const theirs = service.post(elsewhere.id, { authorId: human, text: 'over here' });

      expect(() => service.toggleReaction(room.id, theirs.id, human, '👍')).toThrow(
        expect.objectContaining({ code: 'ENTRY_NOT_FOUND' })
      );
    });
  });

  describe('the stream', () => {
    it('fans out the entry’s WHOLE current set, never a delta', () => {
      const priya = authors.human('priya').id;
      service.addMember(room.id, human, { authorId: priya });
      const entry = anaSaid();
      published = [];

      service.toggleReaction(room.id, entry.id, human, '👍');
      service.toggleReaction(room.id, entry.id, priya, '👍');
      service.toggleReaction(room.id, entry.id, priya, '🎉');

      const frames = reactionEvents();
      expect(frames).toHaveLength(3);
      expect(frames.every((frame) => frame.entryId === entry.id)).toBe(true);
      // Each frame is the state after it, so a reader that missed the first two
      // and caught the third is correct again.
      expect(frames[0].reactions.map((pill) => [pill.emoji, pill.authorIds])).toEqual([
        ['👍', [human]],
      ]);
      expect(frames[2].reactions.map((pill) => [pill.emoji, pill.authorIds])).toEqual([
        ['👍', [human, priya]],
        ['🎉', [priya]],
      ]);
    });

    it('fans out an empty set when the last pill is taken back', () => {
      const entry = anaSaid();
      service.toggleReaction(room.id, entry.id, human, '👍');
      published = [];

      service.toggleReaction(room.id, entry.id, human, '👍');

      expect(reactionEvents().at(-1)?.reactions).toEqual([]);
    });

    it('carries no seq, so it can never move a reader’s resume cursor', () => {
      const entry = anaSaid();
      published = [];
      service.toggleReaction(room.id, entry.id, human, '👍');

      expect(reactionEvents().at(-1)).not.toHaveProperty('seq');
    });

    it('gives a freshly committed entry an empty reaction set rather than none', () => {
      published = [];
      anaSaid();

      const entryFrame = published.find((event) => event.type === 'entry');
      expect(entryFrame?.type === 'entry' && entryFrame.entry.reactions).toEqual([]);
    });
  });

  describe('reading entries back', () => {
    it('attaches reactions to a listed page', () => {
      const first = anaSaid('one');
      anaSaid('two');
      service.toggleReaction(room.id, first.id, human, '👍');

      const page = service.listEntries(room.id, human, { limit: 50 });
      const byText = new Map(page.map((entry) => [entry.body.text, entry.reactions]));
      expect(byText.get('one')?.map((pill) => pill.emoji)).toEqual(['👍']);
      expect(byText.get('two'), 'an entry with no reactions carries [], not undefined').toEqual([]);
    });

    it('reads a whole page of reactions in ONE query, not one per entry', () => {
      const entries = [anaSaid('a'), anaSaid('b'), anaSaid('c'), anaSaid('d')];
      for (const entry of entries) service.toggleReaction(room.id, entry.id, human, '👍');

      const statements = selectsDuring(db, () => {
        service.listEntries(room.id, human, { limit: 50 });
      });
      const reactionReads = statements.filter((sql) => /from "room_entry_reactions"/i.test(sql));
      expect(
        reactionReads,
        'four entries must cost one reaction query — see countThreadRepliesFor for the precedent'
      ).toHaveLength(1);
    });

    it('attaches reactions to the hydration snapshot', () => {
      const entry = anaSaid();
      service.toggleReaction(room.id, entry.id, human, '🎉');

      const snapshot = service.snapshot(room.id, human, 100);
      expect(snapshot.entries.at(-1)?.reactions?.map((pill) => pill.emoji)).toEqual(['🎉']);
    });

    it('attaches reactions to a resume replay', () => {
      const entry = anaSaid();
      service.toggleReaction(room.id, entry.id, human, '🎉');

      expect(service.entriesAfter(room.id, entry.seq - 1)[0].reactions).toHaveLength(1);
    });
  });

  describe('the resume resync', () => {
    it('reports what each entry currently holds', () => {
      const first = anaSaid('one');
      anaSaid('two');
      const third = anaSaid('three');
      service.toggleReaction(room.id, first.id, human, '👍');
      service.toggleReaction(room.id, third.id, human, '🎉');

      const resync = service.reactionResync(room.id, 100);
      const byEntry = new Map(resync.map((event) => [event.entryId, event.reactions]));
      expect(resync.every((event) => event.type === 'reaction')).toBe(true);
      expect(byEntry.get(first.id)?.map((pill) => pill.emoji)).toEqual(['👍']);
      expect(byEntry.get(third.id)?.map((pill) => pill.emoji)).toEqual(['🎉']);
    });

    it('covers a REMOVAL, which is the case a "only what has pills" resync loses', () => {
      // The scenario, end to end: a person reacts, a reader disconnects holding
      // that pill, the person takes it back, the reader resumes. Nothing replays
      // the entry — it is below the cursor and unchanged — so the ONLY thing that
      // can correct the reader is this resync, and an entry with no reactions is
      // exactly the shape it has to be able to say. Reporting only entries that
      // still have pills leaves the reader showing a 👍 the server denies.
      const entry = anaSaid('Deployed.');
      service.toggleReaction(room.id, entry.id, human, '👍');
      const whatTheReaderHolds = service.reactionsFor(room.id, entry.id);
      expect(whatTheReaderHolds.map((pill) => pill.emoji)).toEqual(['👍']);

      service.toggleReaction(room.id, entry.id, human, '👍');

      const resync = service.reactionResync(room.id, 100);
      const forEntry = resync.find((event) => event.entryId === entry.id);
      expect(forEntry, 'the resync has to mention the entry at all').toBeDefined();
      expect(forEntry?.reactions, 'and say it is empty now').toEqual([]);
      expect(forEntry?.reactions).toEqual(service.reactionsFor(room.id, entry.id));
    });

    it('reports every entry in the window, pills or not — it is state, not a diff', () => {
      const first = anaSaid('one');
      const second = anaSaid('two');
      service.toggleReaction(room.id, first.id, human, '👍');

      const resync = service.reactionResync(room.id, 100);
      expect(resync.map((event) => event.entryId).sort()).toEqual([first.id, second.id].sort());
      expect(resync.find((event) => event.entryId === second.id)?.reactions).toEqual([]);
    });

    it('covers an entry BELOW a resume cursor, which is the whole reason it exists', () => {
      const old = anaSaid('the old one');
      const recent = anaSaid('the new one');
      // The reader holds up to `recent`, then goes away; the reaction lands on
      // the older message, which nothing in the replay would ever re-send.
      service.toggleReaction(room.id, old.id, human, '👍');

      expect(service.entriesAfter(room.id, recent.seq), 'the replay is empty').toEqual([]);
      const resync = service.reactionResync(room.id, 100);
      expect(
        resync.find((event) => event.entryId === old.id)?.reactions.map((pill) => pill.emoji),
        'the pill the replay could never have delivered'
      ).toEqual(['👍']);
    });
  });

  describe('the quick row', () => {
    it('is the shipped defaults before anybody has reacted to anything', () => {
      expect(reactions.frequents(human)).toEqual([...REACTION_FREQUENTS_DEFAULT]);
    });

    it('puts what you have used first and pads the rest from the defaults', () => {
      const entry = anaSaid();
      service.toggleReaction(room.id, entry.id, human, '👀');

      expect(reactions.frequents(human)).toEqual(['👀', '👍', '❤️']);
    });

    it('never repeats an emoji that is already both used and a default', () => {
      const entry = anaSaid();
      service.toggleReaction(room.id, entry.id, human, '❤️');

      expect(reactions.frequents(human)).toEqual(['❤️', '👍', '🎉']);
    });

    it('orders by how often you have used each one', () => {
      const entries = [anaSaid('a'), anaSaid('b'), anaSaid('c'), anaSaid('d')];
      // 🔥 three times, 🐢 twice, 🙈 once.
      for (const entry of entries.slice(0, 3))
        service.toggleReaction(room.id, entry.id, human, '🔥');
      for (const entry of entries.slice(0, 2))
        service.toggleReaction(room.id, entry.id, human, '🐢');
      service.toggleReaction(room.id, entries[0].id, human, '🙈');

      expect(reactions.frequents(human)).toEqual(['🔥', '🐢', '🙈']);
    });

    it('is one person’s and not another’s', () => {
      const priya = authors.human('priya').id;
      service.addMember(room.id, human, { authorId: priya });
      const entry = anaSaid();
      service.toggleReaction(room.id, entry.id, priya, '🔥');

      expect(reactions.frequents(priya)[0]).toBe('🔥');
      expect(reactions.frequents(human)).toEqual([...REACTION_FREQUENTS_DEFAULT]);
    });

    it('un-counts an emoji when the reaction is taken back', () => {
      const entry = anaSaid();
      service.toggleReaction(room.id, entry.id, human, '🔥');
      expect(reactions.frequents(human)[0]).toBe('🔥');

      service.toggleReaction(room.id, entry.id, human, '🔥');
      expect(reactions.frequents(human)).toEqual([...REACTION_FREQUENTS_DEFAULT]);
    });

    it('rides the room a reader is handed, so a capsule never draws an empty row', () => {
      const entry = anaSaid();
      service.toggleReaction(room.id, entry.id, human, '🔥');

      expect(service.getRoom(room.id, human)?.reactionFrequents).toEqual(['🔥', '👍', '❤️']);
      expect(service.snapshot(room.id, human, 100).room.reactionFrequents).toEqual([
        '🔥',
        '👍',
        '❤️',
      ]);
    });

    it('comes back recomputed on the toggle that changed it', () => {
      const entry = anaSaid();
      expect(service.toggleReaction(room.id, entry.id, human, '🔥').frequents).toEqual([
        '🔥',
        '👍',
        '❤️',
      ]);
    });
  });

  it('exposes the typed refusal every route maps to a status code', () => {
    anaSaid();
    try {
      service.toggleReaction(room.id, 'entry_that_is_not_here', human, '👍');
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(RoomError);
    }
  });
});

/**
 * Every SELECT the body issued, as SQL text.
 *
 * Reaches through drizzle to the `better-sqlite3` handle and wraps `prepare`,
 * the same seam `engagement.test.ts` uses to pin a query plan. Restored
 * afterwards, so one test cannot leak the wrapper into another.
 *
 * @param db - The test database.
 * @param body - What to run while listening.
 */
function selectsDuring(db: Db, body: () => void): string[] {
  const client = (db as unknown as { $client: Database.Database }).$client;
  const prepare = client.prepare.bind(client);
  const seen: string[] = [];
  client.prepare = ((source: string) => {
    if (/^\s*select/i.test(source)) seen.push(source);
    return prepare(source);
  }) as typeof client.prepare;
  try {
    body();
  } finally {
    client.prepare = prepare;
  }
  return seen;
}
