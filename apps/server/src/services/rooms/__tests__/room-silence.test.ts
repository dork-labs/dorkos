/**
 * Every way an agent can end up saying nothing, and what the room says about it.
 *
 * DOR-621. Three paths used to return the same `null` an agent returns when it
 * simply has nothing to say — a busy session, a failed turn, and a turn that
 * outran the room's patience — so the room reported none of them, and an agent
 * that was merely occupied was indistinguishable from a broken one.
 *
 * Driven through the real service and the real dispatcher, like the cascade
 * tests: only the runner stands in, because the alternative is a model call.
 *
 * **Why no scenario here has one agent answering while another goes quiet.**
 * Two agents addressed by one message are triggered in roster order, and a
 * roster seeded in a single millisecond ties on `joinedAt` and breaks on a
 * random ULID — so which of them runs first flips between runs. When the
 * answering one runs first, its reply re-enters the cascade and the quiet one is
 * refused by the ancestry rule instead, which is correct and is a different
 * notice. A test built on that shape passes about half the time and teaches the
 * next reader nothing, so every scenario below is one the ordering cannot move.
 */
import { describe, it, expect } from 'vitest';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

/** Ana and Bo both answer everything, so a silence is never ambiguity. */
const bothAgents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
});

describe('a room says why an agent did not answer', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let runner: ScriptedTurnRunner;
  let room: RoomWithRoster;
  let ana: string;
  let bo: string;
  let human: string;

  /**
   * Wire a room around `scripted`, with every agent in `agentPaths` set to
   * answer always.
   *
   * @param scripted - The runner standing in for the turn machinery.
   * @param agentPaths - Who is in the room. One agent by default.
   */
  function open(scripted: ScriptedTurnRunner, agentPaths = ['/agents/ana']): void {
    ({ service, authors, runner, human } = createRoomHarness({
      agents: bothAgents,
      runner: scripted,
    }));
    room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths },
      human
    );
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    bo = authors.resolveAgent('/agents/bo', 'Bo').id;
    // A channel seeds `mention-only`; these agents answer everything, which is
    // the setting that makes a missing answer unambiguous.
    service.updateMembership(room.id, human, ana, 'always');
    if (agentPaths.includes('/agents/bo')) {
      service.updateMembership(room.id, human, bo, 'always');
    }
  }

  /** Post as the human and wait for every turn it set off, late answers included. */
  async function seedAndSettle(text = 'is the build green?'): Promise<RoomEntry> {
    const seed = service.post(room.id, { authorId: human, text });
    await service.triggersIdle();
    return seed;
  }

  /** Every entry in the room, oldest first. */
  function log(): RoomEntry[] {
    return service.listEntries(room.id, human, { limit: 200 });
  }

  /** Just the notices — the room speaking in its own voice. */
  function notices(): RoomEntry[] {
    return log().filter((entry) => entry.kind === 'notice');
  }

  /** The notices about one agent. */
  function noticesAbout(authorId: string): RoomEntry[] {
    return notices().filter((entry) => entry.body.subjectAuthorId === authorId);
  }

  /** Posts by one author. */
  function postsBy(authorId: string): RoomEntry[] {
    return log().filter((entry) => entry.kind === 'post' && entry.authorId === authorId);
  }

  describe('when its session is busy', () => {
    it('says so, in the room own voice, naming the agent', async () => {
      open(outcomeRunner(() => ({ text: null, unanswered: 'busy' })));
      await seedAndSettle();

      expect(notices()).toHaveLength(1);
      expect(notices()[0].body.notice).toBe('agent_busy');
      expect(notices()[0].body.subjectAuthorId).toBe(ana);
      expect(notices()[0].authorId).toBe(authors.system().id);
      expect(notices()[0].body.text).toContain('Ana');
      expect(notices()[0].body.text).not.toMatch(/error|Error|lock|undefined|null/);
      expect(postsBy(ana)).toHaveLength(0);
    });

    it('names the right agent when two of them are busy at once', async () => {
      // The bug this shape exists for: an assertion that only asks whether SOME
      // notice landed is satisfied by a notice about somebody else.
      open(
        outcomeRunner(() => ({ text: null, unanswered: 'busy' })),
        ['/agents/ana', '/agents/bo']
      );
      await seedAndSettle();

      expect(notices()).toHaveLength(2);
      expect(noticesAbout(ana)).toHaveLength(1);
      expect(noticesAbout(bo)).toHaveLength(1);
      expect(noticesAbout(ana)[0].body.text).toContain('Ana');
      expect(noticesAbout(ana)[0].body.text).not.toContain('Bo');
      expect(noticesAbout(bo)[0].body.text).toContain('Bo');
    });

    it('says it once per cascade, however many turns it skipped', async () => {
      // A second message inside the SAME cascade — the shape an agent's own
      // mid-turn post makes — triggers the busy agent a second time. One line,
      // not two: a room that answers one question with a pile of apologies is
      // worse than one that goes quiet.
      open(outcomeRunner(() => ({ text: null, unanswered: 'busy' })));
      const seed = await seedAndSettle();

      service.post(room.id, {
        authorId: human,
        text: 'still there?',
        trigger: { root: seed.cascadeRoot, depth: seed.cascadeDepth },
      });
      await service.triggersIdle();

      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(2);
      expect(noticesAbout(ana)).toHaveLength(1);
      expect(notices()).toHaveLength(1);
    });
  });

  describe('when its turn fails', () => {
    it('says so after the turn ends in an error', async () => {
      open(outcomeRunner(() => ({ text: null, unanswered: 'failed' })));
      await seedAndSettle();

      expect(notices()).toHaveLength(1);
      expect(notices()[0].body.notice).toBe('turn_failed');
      expect(notices()[0].body.subjectAuthorId).toBe(ana);
      expect(notices()[0].body.text).toContain('Ana');
      // The room log is no place for a stack trace: the detail belongs on the
      // agent's own session stream, and the notice points there.
      expect(notices()[0].body.text).not.toMatch(/Error:|stack|undefined/);
    });

    it('says so when the turn throws before it produces anything', async () => {
      open(outcomeRunner(() => ({ throws: new Error('runtime is down') })));
      await seedAndSettle();

      expect(notices()).toHaveLength(1);
      expect(notices()[0].body.notice).toBe('turn_failed');
      expect(notices()[0].body.subjectAuthorId).toBe(ana);
      expect(notices()[0].body.text).not.toContain('runtime is down');
    });
  });

  describe('when the message came from an agent posting outside a turn', () => {
    it('stays silent, on purpose, and this test is the reason why', async () => {
      // This silence is NOT a gap, and it looks exactly like one: DOR-621
      // nearly closed it while closing the three that ARE gaps.
      //
      // `deriveCascade` stamps an un-provenanced agent post AT the ceiling, so
      // every room-mate is refused on depth, at every configured
      // `maxAgentDepth`, on every such post. A notice here would be written once
      // per post per room-mate and could not be damped: the
      // `(room, cascade, author)` key never repeats, because each of these posts
      // is its own cascade root. The measured shape was five posts times every
      // room-mate. Closing it needs a damping key that repeats — keyed on the
      // room and the quiet agent, re-armed the way the budget notice re-arms —
      // which is a design, not a one-liner. The full reasoning sits beside the
      // branch in `room-trigger.ts`.
      //
      // The mentioned post is in this list deliberately: a mention does not
      // change the arithmetic, so it does not change the answer either.
      open(
        outcomeRunner(() => ({ text: 'on it' })),
        ['/agents/ana', '/agents/bo']
      );
      for (const text of ['deploying now', 'deploy is green', 'hey @bo take a look']) {
        service.post(room.id, { authorId: ana, text });
      }
      await service.triggersIdle();

      expect(runner.turns).toHaveLength(0);
      expect(notices()).toHaveLength(0);
    });
  });

  describe('when an agent simply has nothing to say', () => {
    it('says nothing about it', async () => {
      // Judgment, not a fault. An agent staying out of a conversation it has
      // nothing to add to must never be reported as broken.
      open(outcomeRunner(() => ({ text: null })));
      await seedAndSettle();

      expect(notices()).toHaveLength(0);
      expect(log().filter((entry) => entry.kind === 'post')).toHaveLength(1);
    });
  });

  describe('when the answer outruns the room wait', () => {
    it('posts it when it lands, saying how long it took', async () => {
      open(
        outcomeRunner(() => ({
          text: null,
          late: Promise.resolve({ text: 'green', waitedMs: 12 * 60_000 }),
        }))
      );
      await seedAndSettle();

      expect(postsBy(ana)).toHaveLength(1);
      expect(postsBy(ana)[0].body.text).toBe(
        'This answers a message from 12 minutes ago.\n\ngreen'
      );
      expect(notices()).toHaveLength(0);
    });

    it('says the turn failed when the late answer never arrives', async () => {
      open(
        outcomeRunner(() => ({
          text: null,
          late: Promise.resolve({ text: null, waitedMs: 60 * 60_000, unanswered: 'failed' }),
        }))
      );
      await seedAndSettle();

      expect(notices()).toHaveLength(1);
      expect(notices()[0].body.notice).toBe('turn_failed');
      expect(notices()[0].body.subjectAuthorId).toBe(ana);
      expect(postsBy(ana)).toHaveLength(0);
    });

    it('is not reported settled while a late answer is still coming', async () => {
      // The room stops WAITING at the deadline; the turn does not stop. If
      // `idle()` forgot the late answer, a caller would read the room as
      // finished while an answer was still on its way to it.
      let land: (reply: { text: string; waitedMs: number }) => void = () => undefined;
      const late = new Promise<{ text: string; waitedMs: number }>((resolve) => {
        land = resolve;
      });
      open(outcomeRunner(() => ({ text: null, late })));

      service.post(room.id, { authorId: human, text: 'is the build green?' });
      const settled = service.triggersIdle();
      let done = false;
      void settled.then(() => {
        done = true;
      });
      // Two macrotask hops: long enough for every turn that CAN settle to have
      // settled, so a still-pending `idle()` is the late answer and nothing else.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(done).toBe(false);

      land({ text: 'green', waitedMs: 60_000 });
      await settled;
      expect(postsBy(ana)).toHaveLength(1);
    });
  });
});
