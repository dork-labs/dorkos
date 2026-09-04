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
import { describe, it, expect, vi } from 'vitest';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import { RoomTurnRuntimeGoneError } from '../room-turn-port.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  scriptedRunner,
  settleUntil,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

/**
 * The ceiling these tests measure against, pinned to a literal rather than read
 * from config, for the same reason `cascade-guard.test.ts` pins it: a test that
 * read the value the code reads could only prove the two agree.
 */
const MAX_AGENT_DEPTH = 3;

/** The agents these rooms are built from. Ana alone unless a test says more. */
const bothAgents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
  '/agents/cy': { name: 'cy', displayName: 'Cy', responseMode: 'always' },
  '/agents/di': { name: 'di', displayName: 'Di', responseMode: 'always' },
});

describe('a room says why an agent did not answer', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let store: RoomStore;
  let runner: ScriptedTurnRunner;
  let room: RoomWithRoster;
  let ana: string;
  let bo: string;
  let cy: string;
  let di: string;
  let human: string;
  /** Who each agent hands off to, for the chain that reaches the ceiling. */
  let nextInChain: Record<string, string>;

  /**
   * Wire a room around `scripted`, with every agent in `agentPaths` set to
   * answer always.
   *
   * @param scripted - The runner standing in for the turn machinery.
   * @param agentPaths - Who is in the room. One agent by default.
   */
  function open(scripted: ScriptedTurnRunner, agentPaths = ['/agents/ana']): void {
    ({ service, authors, store, runner, human } = createRoomHarness({
      agents: bothAgents,
      runner: scripted,
    }));
    room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths },
      human
    );
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    bo = authors.resolveAgent('/agents/bo', 'Bo').id;
    cy = authors.resolveAgent('/agents/cy', 'Cy').id;
    di = authors.resolveAgent('/agents/di', 'Di').id;
    nextInChain = { [ana]: 'bo', [bo]: 'cy', [cy]: 'di' };
    // A channel seeds `engaged`; these agents answer everything, which is the
    // setting that makes a missing answer unambiguous.
    for (const [path, authorId] of [
      ['/agents/ana', ana],
      ['/agents/bo', bo],
      ['/agents/cy', cy],
      ['/agents/di', di],
    ] as const) {
      if (agentPaths.includes(path)) service.updateMembership(room.id, human, authorId, 'always');
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
      // The room has no claim of its own to describe here — another writer holds
      // Ana's session, most often the person typing into her directly — so it
      // says what it knows and does not invent what she is doing instead.
      expect(notices()[0].body.text).toBe(
        "Ana was busy in its own session, so it didn't answer here. It will read your message the next time it picks up work in this room."
      );
      // **Past tense, and no resend.** The message is a committed room entry
      // sitting behind Ana's read cursor, so the next turn she takes here reads
      // it whatever triggers that turn — asking the person to type it a second
      // time was asking them to do work the machine already did.
      expect(notices()[0].body.text).not.toContain('again');
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

    it('answers every message that asked it, however busy it stays', async () => {
      // **This assertion was reversed, deliberately, and the reversal is the
      // fix.** It used to expect ONE line for three messages, on the reasoning
      // that three apologies are over-participation. What that shipped was
      // worse: damping on `(room, agent, reason)` has no clock and clears only
      // when the agent actually takes a turn, so "say it once" meant "say it
      // once, ever". A person asked "@X are you there?" into a room that had
      // reported X busy some time earlier and got total silence — twice — which
      // from inside the room is indistinguishable from a product that dropped
      // the message (DOR-781).
      //
      // A direct question deserves a direct answer, every time it is asked. This
      // cannot become a flood: the bound is per ADDRESSED message and the sender
      // is the one addressing, so somebody gets back exactly as many lines as
      // they wrote messages naming Ana. Nothing an agent does inflates it.
      //
      // What stays damped is everything nobody directed at her — the test below.
      //
      // **Asked one at a time, and since RP8 that is the whole point of the
      // shape.** The room now gathers a burst into ONE turn, so three questions
      // typed in the same instant are one question as far as the model is
      // concerned and earn one line between them — which is the collect
      // mechanism working, not damping. The rule this test is about is the other
      // one: a person who asks, waits, and asks again is answered every time.
      open(outcomeRunner(() => ({ text: null, unanswered: 'busy' })));
      for (const text of ['@ana is the build green?', '@ana still there?', '@ana hello?']) {
        service.post(room.id, { authorId: human, text });
        await service.triggersIdle();
      }

      // Every one of them reached the runner, and every one of them came back
      // busy — the runner's own refusal, before any model ran.
      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(3);
      expect(noticesAbout(ana)).toHaveLength(3);
      expect(notices()).toHaveLength(3);
      expect(noticesAbout(ana).map((entry) => entry.body.notice)).toEqual([
        'agent_busy',
        'agent_busy',
        'agent_busy',
      ]);
    });

    it('gathers a burst of direct questions into one turn, and one line', async () => {
      // The other side of the test above, and the reason it had to change
      // (room-participation spec §10.4). Three messages typed at once are one
      // moment, and answering each of them separately is the "several rushed
      // replies" RP8 exists to stop. One turn ran, so there is one thing to
      // report about, so there is one line.
      open(outcomeRunner(() => ({ text: null, unanswered: 'busy' })));
      for (const text of ['@ana is the build green?', '@ana still there?', '@ana hello?']) {
        service.post(room.id, { authorId: human, text });
      }
      await service.triggersIdle();

      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(1);
      // The LAST message is what the turn answers as its own content; the two
      // before it ride it as gathered messages the same reply owes an answer
      // to, so none of the three is lost.
      expect(runner.turns[0].prompt).toBe('@ana hello?');
      expect(runner.turns[0].roomContext.gathered?.map((entry) => entry.text)).toEqual([
        '@ana is the build green?',
        '@ana still there?',
      ]);
      expect(noticesAbout(ana)).toHaveLength(1);
    });

    it('says it once for ordinary chatter that never asked it anything', async () => {
      // The narrowness that keeps the rule above from becoming the flood it was
      // meant to prevent.
      //
      // `engaged` is the channel default and `always` is set here, so an agent
      // is triggered by EVERY message for the length of its window — not just
      // the ones naming it. An exemption keyed on "a person wrote this" rather
      // than "a person asked THIS agent" therefore fires on ordinary
      // conversation: three unrelated messages while Ana ran late produced three
      // apologies about an agent nobody had addressed.
      //
      // Nobody is owed a repeat for a message they never aimed at her.
      // One at a time, so the collect window is not what is doing the work here
      // — three turns really do run, and only one of them earns a line.
      open(outcomeRunner(() => ({ text: null, unanswered: 'busy' })));
      for (const text of ['is the build green?', 'still there?', 'hello?']) {
        service.post(room.id, { authorId: human, text });
        await service.triggersIdle();
      }

      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(3);
      expect(noticesAbout(ana)).toHaveLength(1);
      expect(notices()).toHaveLength(1);
    });

    it('answers every message in a direct message, where naming is implicit', async () => {
      // A DM has one agent on the other side, so every message a person sends
      // there is addressed to it — nobody types `@ana` into their own DM with
      // Ana. Requiring a literal mention would make the one room where every
      // message is a direct question the one room that never answers a repeat.
      open(outcomeRunner(() => ({ text: null, unanswered: 'busy' })));
      const dm = service.createRoom(
        { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
        human
      );
      for (const text of ['is the build green?', 'still there?']) {
        service.post(dm.id, { authorId: human, text });
        // One at a time: a burst is one turn since RP8, and this test is about
        // repeats over time rather than about messages typed in one breath.
        await service.triggersIdle();
      }

      const dmNotices = service
        .listEntries(dm.id, human, { limit: 50 })
        .filter((entry) => entry.kind === 'notice');
      expect(dmNotices).toHaveLength(2);
      expect(dmNotices.every((entry) => entry.body.notice === 'agent_busy')).toBe(true);
    });

    it('says it once when a cascade keeps re-triggering the same busy agent, and logs both', async () => {
      // The other half, and the reason the damping key exists at all. Bo and Cy
      // each answer the person by handing the question to Ana, whose own session
      // is held by another writer — so two agent-authored entries refuse against
      // the same busy agent, in traffic nobody typed. That is exactly what E17 is
      // about, and it gets one line.
      //
      // **Ana's OWN SESSION is what is busy here, and that is now the only busy
      // that refuses.** Neither room ceiling refuses any more: a message for an
      // agent mid-turn in this room is held (RP8), and since
      // `room-hold-when-busy` a message for one mid-turn in ANOTHER room is held
      // too. What cannot be held is a session a stranger is holding — usually
      // the person typing into that agent directly — because nothing publishes an
      // event when a foreign session lock releases, so there is no seam to hang a
      // resume on (DOR-1242). That refusal stands, and it is the one this damping
      // key is now about.
      //
      // Everyone is `mention-only` so that who runs is a property of the
      // message rather than of an engagement window, and so that Bo's and Cy's
      // replies cannot trigger each other into a different notice entirely. The
      // two rounds are separated by a settle rather than sent in one breath,
      // because a burst is one turn since RP8 and this test needs two refusals.
      //
      // The log half is the incident's other lesson. Forty-one minutes of a room
      // going quiet left three lines in the whole server log, and the decisions
      // that mattered most — the refusals a damping key swallowed — left none:
      // from outside, a damped refusal and a trigger that never happened are the
      // same absence. A damped notice is still a decision the room MADE.
      //
      // And the LEVEL follows the visibility. A refusal the person saw is
      // `info` — the room already told them. A refusal that was damped is
      // `warn`, because this line is then the only place it exists, and filing
      // it beside the ones they saw makes it invisible a second time.
      const reported = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      const warned = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      open(
        outcomeRunner((request) =>
          request.authorId === ana ? { text: null, unanswered: 'busy' } : { text: 'over to @ana' }
        ),
        ['/agents/ana', '/agents/bo', '/agents/cy']
      );
      for (const agent of [ana, bo, cy]) {
        service.updateMembership(room.id, human, agent, 'mention-only');
      }

      service.post(room.id, { authorId: human, text: '@bo can you chase it?' });
      await settleUntil(() => postsBy(bo).length === 1, 'Bo answered, naming Ana');
      await service.triggersIdle();
      service.post(room.id, { authorId: human, text: '@cy can you chase it?' });
      await settleUntil(() => postsBy(cy).length === 1, 'Cy answered, naming Ana');
      await service.triggersIdle();

      // Two agent-authored triggers, one line. Ana ran both times and refused
      // both times — the refusal is real either way; only the telling is damped.
      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(2);
      expect(noticesAbout(ana)).toHaveLength(1);
      expect(noticesAbout(ana)[0].body.notice).toBe('agent_busy');

      // Two refusals happened. One was written into the room; both are on the
      // log, and the one that was swallowed says so — louder, not quieter.
      const refusalsOf = (spy: typeof reported): Array<{ reason: string; visibility: string }> =>
        spy.mock.calls
          .filter(([message]) => message === '[rooms] an agent did not answer')
          .map(([, context]) => context as { reason: string; visibility: string });

      const shown = refusalsOf(reported);
      const damped = refusalsOf(warned);
      expect(shown).toHaveLength(1);
      expect(shown[0]).toMatchObject({ reason: 'agent_busy', visibility: 'shown' });
      expect(damped).toHaveLength(1);
      expect(damped[0]).toMatchObject({ reason: 'agent_busy', visibility: 'damped' });
      reported.mockRestore();
      warned.mockRestore();
    });

    it('says it again once the agent has answered and gone quiet a second time', async () => {
      // Damped is not muted. Recovery re-arms it, the way the budget notice
      // re-arms when the room can spend again: a block that ended and started
      // over is news, and an agent that goes quiet for good after one line is
      // exactly the state a notice exists to prevent.
      let busy = true;
      open(outcomeRunner(() => (busy ? { text: null, unanswered: 'busy' } : { text: 'on it' })));

      await seedAndSettle('first message');
      expect(noticesAbout(ana)).toHaveLength(1);

      busy = false;
      await seedAndSettle('second message');
      expect(postsBy(ana)).toHaveLength(1);
      expect(noticesAbout(ana)).toHaveLength(1);

      busy = true;
      await seedAndSettle('third message');
      expect(noticesAbout(ana)).toHaveLength(2);
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

    it('says so every time, because an error is news each time it happens', async () => {
      // `turn_failed` is not damped, and never was meant to be
      // (room-participation spec §5.2). It shared the busy path's memory anyway,
      // so the second crash in a row was swallowed: a room whose agent was
      // failing on every message reported it once and then went quiet, which
      // reads as the agent having recovered.
      //
      // A busy line can be a repeat of a state that has not changed. A turn that
      // crashed is an event that just happened, and there is no such thing as a
      // repeat of one.
      //
      // Both of Ana's turns are triggered by BO, not by the person — deliberately
      // the damped side of the busy rule, so this measures "a failure is never
      // damped" rather than borrowing the "a person is never damped" exemption
      // that sits beside it.
      open(
        outcomeRunner((request) =>
          request.authorId === ana ? { text: null, unanswered: 'failed' } : { text: 'over to @ana' }
        ),
        ['/agents/ana', '/agents/bo']
      );
      for (const agent of [ana, bo]) {
        service.updateMembership(room.id, human, agent, 'mention-only');
      }

      await seedAndSettle('@bo is the build green?');
      await seedAndSettle('@bo and the migration?');

      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(2);
      expect(noticesAbout(ana).map((entry) => entry.body.notice)).toEqual([
        'turn_failed',
        'turn_failed',
      ]);
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

  describe('when the program it runs on is not running here', () => {
    // **DOR-1720.** A room keeps one session per `(room, agent)` and a session
    // never changes hands (ADR-0255, DOR-764), so a runtime switched off after
    // the conversation started refuses every turn from then on. The refusal is
    // right; what was wrong is that it arrived as a bare `Error` and came out as
    // `turn_failed` — the reader was told an agent was broken, sent to a session
    // no turn had ever opened, and told nothing about either recovery. The
    // recovery was folklore, and the room was dead with no way out from inside.

    it('names the program and both ways back, instead of apologising for a broken agent', async () => {
      open(
        outcomeRunner(() => ({
          throws: new RoomTurnRuntimeGoneError('codex', 'room-session-on-codex'),
        }))
      );
      await seedAndSettle();

      expect(notices()).toHaveLength(1);
      const [notice] = notices();
      expect(notice.body.notice).toBe('runtime_gone');
      expect(notice.body.subjectAuthorId).toBe(ana);
      // The program, named the way a person meets it everywhere else in the
      // product — never the `codex` slug the binding is stored as.
      expect(notice.body.text).toContain('Codex');
      expect(notice.body.text).not.toContain('codex');
      // Both recoveries, because they are not the same recovery: one keeps this
      // conversation, the other starts a fresh one on what the agent runs now.
      expect(notice.body.text).toContain('Turn Codex back on');
      expect(notice.body.text).toContain('remove Ana from this conversation and add it back');
      // And never the pointer that made the old line misleading: no turn ever
      // started, so there is nothing on that session to go and read.
      expect(notice.body.text).not.toContain('session');
      expect(notice.body.text).not.toMatch(/Error:|stack|undefined/);
    });

    it('still says the turn failed for every other throw', async () => {
      // The discrimination, from the other side. A runner that throws for any
      // ordinary reason keeps `turn_failed` and its pointer at the session —
      // that line is right for a turn that broke, and only wrong for the one
      // refusal that never started a turn at all.
      open(outcomeRunner(() => ({ throws: new Error('runtime is down') })));
      await seedAndSettle();

      expect(notices()[0].body.notice).toBe('turn_failed');
    });

    it('says it once while the state lasts, not once per message', async () => {
      // Damped like `agent_gone`, and unlike `turn_failed`. A crash is an event
      // and each one is news; this is a STATE that holds until somebody acts, so
      // repeating it per message would be a fresh apology every time for a fact
      // that has not changed — and the state's own line is already on the log,
      // above, where the person can still read it.
      open(
        outcomeRunner(() => ({
          throws: new RoomTurnRuntimeGoneError('codex', 'room-session-on-codex'),
        }))
      );
      await seedAndSettle();
      await seedAndSettle('and the migration?');

      expect(runner.turns).toHaveLength(2);
      expect(noticesAbout(ana).map((entry) => entry.body.notice)).toEqual(['runtime_gone']);
    });
  });

  describe('when its session cannot be bound', () => {
    // DOR-1206: this was the last silent trigger drop. `bindRoomSession` can
    // throw under database contention (`claimTargets`'s own comment says so),
    // and until now the target was simply dropped — a log line and nothing in
    // the room, so a dropped trigger and a broken agent looked identical from
    // inside it.

    /**
     * Make every bind for this harness throw until `shouldFail` is switched
     * off, restoring the real write once it is — the same "flip a flag"
     * shape `open`'s busy scenarios use, but at the STORE rather than the
     * runner: a bind failure happens before a turn is ever asked for, so
     * `outcomeRunner` has nothing to stand in for here.
     */
    function failBinding(): { shouldFail: boolean } {
      const real = store.bindRoomSession.bind(store);
      const state = { shouldFail: true };
      vi.spyOn(store, 'bindRoomSession').mockImplementation(
        (roomId, authorId, sessionId, createdAt) => {
          if (state.shouldFail) throw new Error('SQLITE_BUSY: database is locked');
          return real(roomId, authorId, sessionId, createdAt);
        }
      );
      return state;
    }

    it('says so, in the room own voice, and never asks the agent to run', async () => {
      open(scriptedRunner());
      failBinding();

      await seedAndSettle();

      // (a) the target was dropped without crashing the post that triggered
      // it — `seedAndSettle` awaits `triggersIdle()`, so an uncaught throw out
      // of `claimTargets` would already have failed this test.
      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(0);
      expect(postsBy(ana)).toHaveLength(0);
      // (b) the damped notice entry lands, in plain words with nothing about
      // the database contention that actually caused it.
      expect(notices()).toHaveLength(1);
      expect(notices()[0].body.notice).toBe('agent_unavailable');
      expect(notices()[0].body.subjectAuthorId).toBe(ana);
      expect(notices()[0].authorId).toBe(authors.system().id);
      expect(notices()[0].body.text).toBe(
        "Ana couldn't be made ready to answer here just now. Send another message to try again."
      );
      expect(notices()[0].body.text).not.toMatch(/SQLITE_BUSY|Error|stack|undefined|null/);
    });

    it('drops only the target whose bind failed, and binds/claims/answers the other normally', async () => {
      // Pins the two-pass invariant this catch reaches into: `claimTargets`
      // binds every affordable target in its own loop, each wrapped in its
      // own try/catch, PRECISELY so one target's contention cannot take the
      // others down with it (see the comment above the `bound` array). A
      // shared try around the whole loop would have made Bo collateral damage
      // for a fault that was never his.
      open(scriptedRunner(), ['/agents/ana', '/agents/bo']);
      const real = store.bindRoomSession.bind(store);
      vi.spyOn(store, 'bindRoomSession').mockImplementation(
        (roomId, authorId, sessionId, createdAt) => {
          if (authorId === ana) throw new Error('SQLITE_BUSY: database is locked');
          return real(roomId, authorId, sessionId, createdAt);
        }
      );

      await seedAndSettle();

      // Bo is untouched by Ana's contention: bound, claimed, and answered
      // exactly once.
      expect(runner.turns.filter((turn) => turn.authorId === bo)).toHaveLength(1);
      expect(postsBy(bo)).toHaveLength(1);
      // Ana never ran — her bind failed before a claim was ever taken.
      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(0);
      expect(postsBy(ana)).toHaveLength(0);
      // Exactly one notice, naming Ana and nobody else.
      expect(notices()).toHaveLength(1);
      expect(notices()[0].body.notice).toBe('agent_unavailable');
      expect(notices()[0].body.subjectAuthorId).toBe(ana);
    });

    it('says it once for ordinary chatter that keeps failing to bind', async () => {
      // (c) the second (and third) mention in the same cascade does not
      // duplicate the notice — the same damping `agent_busy` gets, because the
      // one reachable cause here is contention that a retry routinely clears.
      open(scriptedRunner());
      failBinding();

      for (const text of ['is the build green?', 'still there?', 'hello?']) {
        service.post(room.id, { authorId: human, text });
      }
      await service.triggersIdle();

      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(0);
      expect(noticesAbout(ana)).toHaveLength(1);
      expect(notices()).toHaveLength(1);
    });

    it('answers every message that asked it directly, however it keeps failing to bind', async () => {
      // The other half of the damping rule: a direct question is never
      // swallowed, however persistent the contention is.
      open(scriptedRunner());
      failBinding();

      for (const text of ['@ana is the build green?', '@ana still there?', '@ana hello?']) {
        service.post(room.id, { authorId: human, text });
        // One at a time: three messages typed in one breath are one turn since
        // RP8, so they are one bind attempt and one line. The rule under test is
        // about asking again after waiting.
        await service.triggersIdle();
      }

      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(0);
      expect(noticesAbout(ana)).toHaveLength(3);
      expect(noticesAbout(ana).map((entry) => entry.body.notice)).toEqual([
        'agent_unavailable',
        'agent_unavailable',
        'agent_unavailable',
      ]);
    });

    it('says it again once binding recovers and then fails a second time', async () => {
      // Recovery re-arms the key, the way it does for `agent_busy`: a block
      // that ended and started over is news.
      open(scriptedRunner());
      const state = failBinding();

      await seedAndSettle('first message');
      expect(noticesAbout(ana)).toHaveLength(1);
      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(0);

      state.shouldFail = false;
      await seedAndSettle('second message');
      expect(postsBy(ana)).toHaveLength(1);
      expect(noticesAbout(ana)).toHaveLength(1);

      state.shouldFail = true;
      await seedAndSettle('third message');
      expect(noticesAbout(ana)).toHaveLength(2);
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

    it('still speaks when a long chain hits the reply ceiling', async () => {
      // The other half of the narrowness claim, and the one nothing covered:
      // a DEPTH refusal inside a real chain. The two-agent cascade never
      // reaches it, because ancestry fires first — so a change that announced
      // only ancestry refusals left the ceiling silent with every test green.
      //
      // Four agents, each naming the next, against a ceiling of three: the
      // fourth hop is refused on depth alone, by a chain that really ran.
      open(
        outcomeRunner((request) => ({
          text: `over to @${nextInChain[request.authorId] ?? 'nobody'}`,
        })),
        ['/agents/ana', '/agents/bo', '/agents/cy', '/agents/di']
      );
      for (const agent of [ana, bo, cy, di]) {
        service.updateMembership(room.id, human, agent, 'mention-only');
      }
      await seedAndSettle('over to @ana');

      // Three turns ran and the fourth was refused, below no ancestry rule:
      // every agent in this chain is distinct, so depth is the only rule left.
      expect(runner.turns.map((turn) => turn.authorId)).toEqual([ana, bo, cy]);
      expect(Math.max(...log().map((entry) => entry.cascadeDepth))).toBe(MAX_AGENT_DEPTH);
      expect(noticesAbout(di)).toHaveLength(1);
      expect(noticesAbout(di)[0].body.notice).toBe('cascade_stopped');
    });

    it('still speaks when a real exchange is refused, which is the narrow part', async () => {
      // The counter-assertion. Without it, the test above is satisfied by a
      // room that never says anything at all, and a later change that silenced
      // the cascade notice too would keep it green.
      //
      // A→B→A with the shipped ceiling: the human asks Ana, Ana asks Bo, and
      // Bo's answer would trigger Ana a second time. Ana is already in this
      // cascade, so the ancestry rule refuses her — and it refuses her BELOW
      // the depth ceiling, which is the point of having an ancestry rule at
      // all. That refusal is a real exchange stopping, so the room says so.
      open(
        outcomeRunner((request) =>
          request.authorId === ana ? { text: 'asking @bo now' } : { text: 'confirmed' }
        ),
        ['/agents/ana', '/agents/bo']
      );
      // Only Ana answers unprompted; Bo answers when Ana names him.
      service.updateMembership(room.id, human, bo, 'mention-only');
      await seedAndSettle('who can confirm the build?');

      const refused = noticesAbout(ana);
      expect(refused).toHaveLength(1);
      expect(refused[0].body.notice).toBe('cascade_stopped');
      // The hop that was refused sat at depth 3 against a ceiling of 3, so the
      // depth rule permitted it and ancestry is what stopped it.
      const deepest = Math.max(...log().map((entry) => entry.cascadeDepth));
      expect(deepest).toBe(2);
      expect(deepest + 1).toBeLessThanOrEqual(MAX_AGENT_DEPTH);
      expect(runner.turns.map((turn) => turn.authorId)).toEqual([ana, bo]);
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
        'This answers the message from 12 minutes ago: "is the build green?"\n\ngreen'
      );
      expect(notices()).toHaveLength(0);
    });

    it('re-addresses nobody from the question it quotes, however many names it held', async () => {
      // The late answer used to re-address the whole question it was answering.
      //
      // Its prefix quotes that question, and the quote kept the `@` sigils — so
      // the handles were resolved again at write time and everyone the person
      // originally named was addressed by the ANSWER to them, minutes later. One
      // observed entry mentioned the agent that wrote it, from nothing but the
      // quote in its own prefix.
      //
      // The fix is at the source: the quote carries the words and not the
      // addresses. Nothing about the POST is special — see the test below, which
      // is the half that says so.
      let land: (reply: { text: string; waitedMs: number }) => void = () => undefined;
      const late = new Promise<{ text: string; waitedMs: number }>((resolve) => {
        land = resolve;
      });
      open(
        outcomeRunner((request) =>
          request.authorId === ana ? { text: null, late } : { text: 'nothing from me' }
        ),
        ['/agents/ana', '/agents/bo', '/agents/cy']
      );
      for (const agent of [ana, bo, cy]) {
        service.updateMembership(room.id, human, agent, 'mention-only');
      }

      const asked = service.post(room.id, {
        authorId: human,
        text: '@ana @bo @cy is the build green?',
      });
      await settleUntil(
        () => postsBy(bo).length === 1 && postsBy(cy).length === 1,
        'Bo and Cy answered while Ana ran on'
      );
      // Everyone the person named was addressed exactly once, which is correct
      // and is the baseline the assertions below are measured against.
      expect(asked.mentions).toEqual([ana, bo, cy]);

      land({ text: 'all green', waitedMs: 12 * 60_000 });
      await service.triggersIdle();

      const answer = postsBy(ana)[0];
      // The quote is still there — it is what tells the reader which message
      // this belongs to — and it still carries the words, minus the addresses.
      expect(answer.body.text).toBe(
        'This answers the message from 12 minutes ago: "ana bo cy is the build green?"\n\nall green'
      );
      // Ana said nothing that addresses anybody, so the entry addresses nobody.
      // Ana least of all: an agent cannot be re-triggered by a quote of the
      // question it was asked, which is exactly the self-mention in the incident.
      expect(answer.mentions).toEqual([]);
      // And nobody ran a second turn off it.
      expect(runner.turns.filter((turn) => turn.authorId === bo)).toHaveLength(1);
      expect(runner.turns.filter((turn) => turn.authorId === cy)).toHaveLength(1);
      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(1);
      expect(notices()).toEqual([]);
    });

    it('still reaches whoever the late answer names in its own words', async () => {
      // The counter-assertion, and a decision worth stating: a late answer is
      // posted like any other and addresses people like any other.
      //
      // It was briefly written with its dispatch suppressed, on the theory that a
      // reply to an already-dispatched question must not open a second hop. That
      // over-corrected. The spam it was aimed at came from the QUOTE, which the
      // test above closes at the source; what suppression ALSO dropped was the
      // agent's own words. An agent that comes back after ten minutes with "@bo
      // can you deploy it?" is handing work over, and silently reaching nobody
      // with it is the one thing this file is not allowed to do — a dropped
      // trigger is indistinguishable from a broken agent.
      //
      // Bo is deliberately not in the original question: he never entered this
      // cascade, so the ancestry rule has no reason to refuse him and what is
      // measured is the addressing, not the guard.
      let land: (reply: { text: string; waitedMs: number }) => void = () => undefined;
      const late = new Promise<{ text: string; waitedMs: number }>((resolve) => {
        land = resolve;
      });
      open(
        outcomeRunner((request) =>
          request.authorId === ana ? { text: null, late } : { text: 'nothing from me' }
        ),
        ['/agents/ana', '/agents/bo', '/agents/cy']
      );
      for (const agent of [ana, bo, cy]) {
        service.updateMembership(room.id, human, agent, 'mention-only');
      }

      service.post(room.id, { authorId: human, text: '@ana @cy is the build green?' });
      await settleUntil(() => postsBy(cy).length === 1, 'Cy answered while Ana ran on');
      expect(runner.turns.filter((turn) => turn.authorId === bo)).toHaveLength(0);

      land({ text: 'all green — @bo can you deploy it?', waitedMs: 12 * 60_000 });
      await service.triggersIdle();

      const answer = postsBy(ana)[0];
      // Bo, and only Bo: the quote named Ana and Cy, and neither is here.
      expect(answer.mentions).toEqual([bo]);
      // And he was actually asked, which is the part a person in the room would
      // notice going missing.
      expect(runner.turns.filter((turn) => turn.authorId === bo)).toHaveLength(1);
      expect(runner.turns.filter((turn) => turn.authorId === cy)).toHaveLength(1);
      expect(notices()).toEqual([]);
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
