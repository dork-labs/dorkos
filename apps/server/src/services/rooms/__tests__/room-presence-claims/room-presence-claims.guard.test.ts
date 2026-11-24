/**
 * How long a claim lives: the dispatch guard reads the same live claim the room shows.
 * The suite's full rationale is on `room-presence-claims.fixtures.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { settleUntil } from '../room-test-harness.js';

import {
  ana,
  bo,
  cy,
  drivenRunner,
  human,
  notices,
  noticesAbout,
  open,
  postsBy,
  presenceFor,
  room,
  runner,
  service,
  statesFor,
  turnsBy,
  workingSeenBy,
} from './room-presence-claims.fixtures.js';

describe('a claim lives until its turn is done', () => {
  describe('and the guard reads the same claim', () => {
    it('holds a re-trigger of an agent whose late turn is still running, and runs it after', async () => {
      // A late turn that ends up saying nothing never lands a durable stamp in
      // the ancestry table, so before the claim existed a re-trigger of that
      // agent in the same cascade bought a SECOND model call on the very session
      // the first turn was still holding — the busy collision, one layer up.
      //
      // The claim still stops that second turn starting beside the first. What
      // RP8 changed is what happens to the message instead: it used to be
      // refused with an "it didn't pick this up" line and then never answered,
      // and it is now held and run the moment the claim goes (spec §10.4). Bo
      // really did ask Ana something, and Ana really does answer it.
      //
      // Bo is gated so that Ana's turn is provably past the deadline before Bo's
      // reply re-enters the cascade. Ungated, the two turns race and this test
      // would agree with a broken dispatcher about half the time.
      open(
        drivenRunner({
          plan: (request) => {
            if (request.authorId === ana) return 'hold';
            return request.authorId === bo ? 'gated' : 'answer';
          },
          say: (request) =>
            request.authorId === bo ? 'no idea — what do you think, @ana?' : 'on it',
        })
      );

      service.post(room.id, { authorId: human, text: '@ana @bo what is going on with the build?' });
      await settleUntil(
        () => runner.holdsFor(ana) === 1 && turnsBy(bo).length === 1,
        'Ana past the wait deadline, with Bo waiting at his gate'
      );
      expect(turnsBy(ana)).toHaveLength(1);
      expect(turnsBy(bo)).toHaveLength(1);

      runner.release(bo);
      await settleUntil(() => postsBy(bo).length === 1, 'Bo answered, naming Ana');

      // Bo named Ana, and Ana was not asked to run a second turn beside the one
      // she is holding — nor was the room made to apologise for a message that
      // is about to be answered.
      expect(turnsBy(ana)).toHaveLength(1);
      expect(notices()).toHaveLength(0);

      // The held message did not disturb the claim: Ana is still working, and
      // the next agent to be handed a context is still told so.
      service.post(room.id, { authorId: human, text: '@cy are you free?' });
      await settleUntil(() => turnsBy(cy).length === 1, 'Cy handed a turn');
      expect(workingSeenBy(turnsBy(cy)[0])).toEqual(['Ana']);

      // Ana's turn ends the way this scenario is named for: with nothing to say.
      // That is judgment, not a fault, so nothing of Ana's is posted — and the
      // claim is released all the same, which is what lets Bo's question
      // through. The person DID ask her, though, so the room says once that she
      // read it and did not reply (spec §D6), which is the whole point of that
      // line: an unanswered question does not simply vanish.
      runner.land(ana, { text: null, waitedMs: 30 * 60_000 });
      await settleUntil(() => turnsBy(ana).length === 2, 'the held question to become a turn');
      expect(turnsBy(ana)[1].prompt).toBe('no idea — what do you think, @ana?');
      expect(postsBy(ana)).toHaveLength(0);
      expect(notices().map((entry) => entry.body.notice)).toEqual(['agent_declined']);
      runner.land(ana, { text: null, waitedMs: 0 });
      await service.triggersIdle();
    });

    it('never starts a second turn for an agent already working here, whatever cascade asks', async () => {
      // DOR-752, the shipped default. The guard's in-flight union is scoped to
      // ONE cascade, so an agent held past the wait deadline and re-triggered by
      // the NEXT message — a different cascade root, which is what every human
      // message mints — was allowed straight through. Ana then ran two turns at
      // once on the one session this room binds for her: two model calls, two
      // interleaved writers on one transcript, and a room that had never been
      // asked twice.
      //
      // `engaged` is the channel default, so this is the ordinary path for any
      // slow agent, not an edge. The rule is unchanged by RP8 — one turn per
      // agent per room, never two at once — and what RP8 changed is what becomes
      // of the second message: held, then run in order, rather than refused.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-07-30T04:00:00.000Z'));
        open(
          drivenRunner({ plan: (request) => (request.authorId === ana ? 'hold' : 'answer') }),
          'seeded'
        );

        service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
        await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline');

        // Five minutes on, well inside Ana's ten-minute engagement window. Nobody
        // is named, so Ana is the only member this can reach.
        vi.setSystemTime(new Date('2026-07-30T04:05:00.000Z'));
        service.post(room.id, { authorId: human, text: 'and the migration?' });
        // Absence is never the condition: Bo is asked next, and his turn running
        // proves the room has finished deciding what to do with Ana's second
        // message.
        service.post(room.id, { authorId: human, text: '@bo anything from you?' });
        await settleUntil(() => turnsBy(bo).length === 1, 'Bo handed a turn of his own');

        // One turn, one claim, and nothing said about it — the message is not
        // refused, so there is nothing to report yet.
        expect(turnsBy(ana)).toHaveLength(1);
        expect(runner.holdsFor(ana)).toBe(1);
        expect(notices()).toHaveLength(0);

        // The held message did not disturb the live claim: the indicator is
        // still up, dated from when the work actually started.
        expect(statesFor(ana)).toEqual(['working', 'working_late']);
        expect(presenceFor(ana).at(-1)?.since).toBe('2026-07-30T04:00:00.000Z');

        // The turn that IS running lands its answer, and only then does the
        // second message become Ana's second turn.
        runner.land(ana, { text: 'green', waitedMs: 12 * 60_000 });
        await settleUntil(() => turnsBy(ana).length === 2, 'the held message to become a turn');
        // Bo answered while Ana worked too, so his reply joins the same held
        // collection and — being the newest thing said — is what her turn is
        // asked about. The question she was asked first is right behind it,
        // marked as having landed while she was working.
        expect(turnsBy(ana)[1].prompt).toBe('on it');
        expect(turnsBy(ana)[1].roomContext.gathered).toContainEqual(
          expect.objectContaining({ text: 'and the migration?', arrivedDuringPrevTurn: true })
        );
        expect(postsBy(ana)).toHaveLength(1);
        runner.land(ana, { text: 'migrated', waitedMs: 0 });
        await service.triggersIdle();
        expect(statesFor(ana).at(-1)).toBe('done');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not re-arm its apologies at the deadline of a turn that answered nothing', async () => {
      // The wait deadline was clearing every damping key for the agent it was
      // about, and nothing on the outside could see it happen.
      //
      // `runOne` used to hand a late result to BOTH `deliverLate` and `deliver`.
      // A late result is `{ text: null, late, unanswered: undefined }`, which
      // `deliver` cannot tell from a turn that ran and chose to stay quiet — so
      // it ran its recovery branch, whose whole premise is "this agent just
      // answered, so whatever was blocking it is over". Nothing had answered.
      // The block was lifted at the moment the room GAVE UP waiting, for an
      // agent that was still working, and the next refusal wrote a second
      // apology on top of the standing one.
      //
      // Every existing scenario missed it because the clear lands BEFORE the
      // first busy line in each of them, where it has nothing to clear. This one
      // is ordered the other way round: a line first, then a deadline, then a
      // second refusal that must still be damped.
      //
      // **Both refusals come from the RUNNER**, and since RP8 that is the only
      // way to get two of them for one agent in one room. A message that lands
      // while the agent holds a claim here is no longer refused at all — it is
      // held and becomes the next turn — so the dispatcher-side busy line this
      // test used to use for its second refusal does not exist any more. The
      // runner's own `unanswered: 'busy'` is a different thing: no model ran,
      // and the room owes a line whether or not a claim was involved.
      let anaTurns = 0;
      open(
        drivenRunner({
          plan: (request) => {
            if (request.authorId !== ana) return 'answer';
            anaTurns += 1;
            return anaTurns === 1 ? 'busy' : 'hold';
          },
        }),
        // `engaged` is the channel default, and it is load-bearing here: the
        // second message names nobody, so it reaches Ana through her window —
        // which is what makes its refusal DAMPABLE. A message that named her
        // would be a direct question and is never damped.
        'seeded'
      );

      // One busy line, and the key that damps undirected traffic is now armed.
      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await service.triggersIdle();
      expect(noticesAbout(ana)).toHaveLength(1);
      expect(noticesAbout(ana)[0].body.notice).toBe('agent_busy');

      // Ana's next turn outruns the wait. The room stops waiting; she has still
      // answered nothing, so nothing about her has recovered.
      service.post(room.id, { authorId: human, text: 'and the migration?' });
      await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline');
      expect(turnsBy(ana)).toHaveLength(2);

      // That turn finally settles the way it started: refused by the runner,
      // with no model behind it. Still one line — two is the defect, the
      // deadline having quietly re-armed the key half an hour earlier.
      runner.land(ana, { text: null, unanswered: 'busy', waitedMs: 12 * 60_000 });
      await service.triggersIdle();
      expect(noticesAbout(ana)).toHaveLength(1);
      expect(postsBy(ana)).toHaveLength(0);
    });

    it('refuses nobody whose agent is working elsewhere, and answers them here', async () => {
      // **The refusal this pair of tests used to pin is gone** (spec
      // `room-hold-when-busy`). A message for an agent mid-turn in a room this
      // reader cannot see used to be dropped with a line asking the person to
      // send it again; it is now held, and the claim's release runs a turn for
      // it IN THE ROOM THAT ASKED. Seed for the red: put the old early return
      // back in `collectOne` and this room fills with notices and never answers.
      // Only Ana's FIRST turn outruns the wait; the one she takes here answers
      // straight away, so the assertion below is about the room and not about
      // the runner's queue.
      let anaTurns = 0;
      open(
        drivenRunner({
          plan: (request) => {
            if (request.authorId !== ana) return 'answer';
            anaTurns += 1;
            return anaTurns === 1 ? 'hold' : 'answer';
          },
        })
      );
      const elsewhere = service.createRoom(
        { kind: 'channel', title: 'Frontend', members: [], agentPaths: ['/agents/ana'] },
        human
      );
      service.updateMembership(elsewhere.id, human, ana, 'mention-only');

      service.post(elsewhere.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline elsewhere');

      // A person, asking twice, in a room whose agent is busy somewhere else.
      service.post(room.id, { authorId: human, text: '@ana are you there?' });
      service.post(room.id, { authorId: human, text: '@ana hello?' });
      for (let tick = 0; tick < 5; tick += 1) await new Promise((r) => setTimeout(r, 0));

      // Nothing was said, because nothing went wrong: both messages are waiting.
      expect(notices()).toEqual([]);
      expect(turnsBy(ana)).toHaveLength(1);

      // The blocking turn ends, and both waiting messages become ONE turn here —
      // gathered, the way a burst always is.
      runner.land(ana, { text: 'green', waitedMs: 12 * 60_000 });
      await settleUntil(() => postsBy(ana).length === 1, 'Ana to answer in the room that asked');
      await service.triggersIdle();
      expect(turnsBy(ana)).toHaveLength(2);
      expect(turnsBy(ana)[1].roomId).toBe(room.id);
      expect(notices()).toEqual([]);
    });

    it('says a message is waiting, names the room in the way, and resolves it into working', async () => {
      // The `held` indicator, end to end, on the room's own stream.
      //
      // Three properties, and each one is a defect somebody would otherwise
      // ship. It carries the room in the way as an ID and nothing else, because
      // the reader may not be in that room and the client resolves the name
      // against the rooms it can already see. Its `entryId` does not move while
      // the person keeps typing, because the indicator is keyed on it and a
      // moving id opens a second indicator nothing can clear. And the `done`
      // comes BEFORE the `working`, so the waiting line resolves INTO the
      // working one rather than sitting beside it.
      let anaTurns = 0;
      open(
        drivenRunner({
          plan: (request) => {
            if (request.authorId !== ana) return 'answer';
            anaTurns += 1;
            return anaTurns === 1 ? 'hold' : 'answer';
          },
        })
      );
      const elsewhere = service.createRoom(
        { kind: 'channel', title: 'Frontend', members: [], agentPaths: ['/agents/ana'] },
        human
      );
      service.updateMembership(elsewhere.id, human, ana, 'mention-only');

      service.post(elsewhere.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline elsewhere');

      const first = service.post(room.id, { authorId: human, text: '@ana are you there?' });
      await settleUntil(
        () => presenceFor(ana).some((event) => event.state === 'held'),
        'this room to say the message is waiting'
      );
      const waiting = presenceFor(ana).filter((event) => event.state === 'held');
      expect(waiting[0].heldBehind).toEqual({
        roomId: elsewhere.id,
        othersWaiting: false,
        severalInTheWay: false,
      });
      expect(waiting[0].entryId).toBe(first.id);
      // No title, no topic, no text — an id and two booleans, and nothing else that
      // could describe a conversation this reader may not be in.
      expect(Object.keys(waiting[0].heldBehind!).sort()).toEqual([
        'othersWaiting',
        'roomId',
        'severalInTheWay',
      ]);

      // Typing again does not open a second indicator.
      service.post(room.id, { authorId: human, text: '@ana hello?' });
      for (let tick = 0; tick < 5; tick += 1) await new Promise((r) => setTimeout(r, 0));
      expect(
        new Set(
          presenceFor(ana)
            .filter((e) => e.state === 'held')
            .map((e) => e.entryId)
        )
      ).toEqual(new Set([first.id]));

      runner.land(ana, { text: 'green', waitedMs: 12 * 60_000 });
      await settleUntil(() => turnsBy(ana).length === 2, 'the waiting question to become a turn');

      // `done` closes the waiting indicator before `working` opens the real one.
      const lifecycle = statesFor(ana);
      const cleared = lifecycle.indexOf('done');
      const started = lifecycle.indexOf('working');
      expect(lifecycle[0]).toBe('held');
      expect(cleared).toBeGreaterThan(-1);
      expect(started).toBeGreaterThan(cleared);

      await service.triggersIdle();
    });

    it('still says the turn failed after it has already said the agent was busy', async () => {
      // The trap the busy refusal opens, and the reason its damping key carries
      // the REASON. Ana is refused as busy while her real turn runs, so the room
      // says "was busy… send it again when Ana is free" — and then that turn
      // falls over. With one memory per `(room, agent)`, the busy line had
      // already armed it and the `turn_failed` line was swallowed: the room's
      // last word was an invitation to wait for an agent that had crashed.
      //
      // Both lines are true, both are news, and the person needs the second one
      // most. Seed for the red: collapse the two keys back into one.
      //
      // The busy line comes from the RUNNER — no model ran, another writer held
      // the session — because since RP8 that is the only busy refusal a room can
      // write about an agent it is about to run a turn for. The trap it opens is
      // unchanged: one memory per `(room, agent)` and the crash goes unreported.
      let anaTurns = 0;
      open(
        drivenRunner({
          plan: (request) => {
            if (request.authorId !== ana) return 'answer';
            anaTurns += 1;
            return anaTurns === 1 ? 'busy' : 'hold';
          },
        }),
        'seeded'
      );

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => noticesAbout(ana).length === 1, 'Ana refused as busy');
      expect(noticesAbout(ana)[0].body.notice).toBe('agent_busy');

      service.post(room.id, { authorId: human, text: 'and the migration?' });
      await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline');

      runner.fail(ana, new Error('the session stream went away'));
      await service.triggersIdle();

      expect(noticesAbout(ana).map((entry) => entry.body.notice)).toEqual([
        'agent_busy',
        'turn_failed',
      ]);
      // And the indicator is down: the room is not still claiming she is on it.
      expect(statesFor(ana).at(-1)).toBe('done');
    });

    it('spends the room budget once per turn, not once per message it gathered', async () => {
      // The reservation happens per TURN, and this is what says so
      // (room-participation spec §10.4). A room that charged per message would
      // let two people talking at once burn an hour's automatic turns on one
      // answer — and would then report a budget notice for a spend nobody got.
      //
      // Two messages land while Ana is mid-turn, so they are held together and
      // become ONE turn. The room's remaining budget is read off the turns Bo is
      // handed either side of that, which is the only place the count is
      // observable from outside.
      // `mention-only` throughout, so every turn below is one a message asked
      // for by name. Left on the channel's `engaged` seed, an agent's own reply
      // re-triggers its room-mates and the count moves for reasons that have
      // nothing to do with the collect window.
      open(drivenRunner({ plan: (request) => (request.authorId === ana ? 'hold' : 'answer') }));

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline');

      service.post(room.id, { authorId: human, text: '@ana and the migration?' });
      service.post(room.id, { authorId: human, text: '@ana and the cache?' });
      service.post(room.id, { authorId: human, text: '@bo can you take it?' });
      await settleUntil(() => turnsBy(bo).length === 1, 'Bo handed a turn');
      const whileHeld = turnsBy(bo)[0].roomContext.budget.automaticRepliesLeftInThisRoomThisHour;
      // `null` is the limits-off reading, and this harness counts (see the same
      // narrowing in `room-collect.test.ts`).
      if (whileHeld === null) throw new Error('the room reported no automatic-turn count');

      // Ana's turn lands, and the two held messages become her ONE next turn.
      runner.land(ana, { text: 'green', waitedMs: 12 * 60_000 });
      await settleUntil(() => turnsBy(ana).length === 2, 'the held messages to become one turn');
      expect(turnsBy(ana)[1].roomContext.gathered?.map((entry) => entry.text)).toContain(
        '@ana and the migration?'
      );

      // Bo again, to read the count back. Exactly two turns have been charged
      // since the last reading — Ana's gathered one and Bo's own — never three.
      service.post(room.id, { authorId: human, text: '@bo and now?' });
      await settleUntil(() => turnsBy(bo).length === 2, 'Bo handed a second turn');
      expect(turnsBy(bo)[1].roomContext.budget.automaticRepliesLeftInThisRoomThisHour).toBe(
        whileHeld - 2
      );

      runner.land(ana, { text: 'all good', waitedMs: 0 });
      await service.triggersIdle();
    });

    it('gives an agent posting during its own late window the cascade it is in', async () => {
      // The widening nobody asked for and everybody wants. `activeTurnFor` is
      // what an agent's DIRECT post (`POST /api/rooms/:id/entries`, which
      // carries no provenance) inherits, and it reads the same claim map.
      //
      // Before this change the claim was gone at the wait deadline, so a post
      // Ana made while still working was read as a post with no turn behind it
      // and stamped at the ceiling — and everything it addressed was then
      // refused on depth, silently, because a refusal against a synthesized
      // stamp deliberately says nothing. Ana asked Bo a question and Bo was
      // never told. Now the post carries the real cascade and Bo runs.
      //
      // This is spend-affecting in the honest direction: a turn runs that did
      // not run before, because a turn SHOULD have run. It stays bounded by the
      // same two rules — Bo is at depth 2 of a ceiling of 3, and Ana cannot
      // trigger herself.
      open(drivenRunner({ plan: (request) => (request.authorId === ana ? 'hold' : 'answer') }));

      const asked = service.post(room.id, {
        authorId: human,
        text: '@ana can you check the deploy?',
      });
      await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline');

      // Ana writes to the room herself, mid-turn, past the deadline.
      const aside = service.post(room.id, { authorId: ana, text: 'can you take a look @bo?' });
      await settleUntil(() => postsBy(bo).length === 1, 'Bo asked, and answering');

      // Bo was actually asked — the outcome first, because that is the part a
      // person in the room would notice going missing.
      expect(turnsBy(bo)).toHaveLength(1);
      expect(postsBy(bo)).toHaveLength(1);
      // And the mechanism behind it: her post joined the exchange it was made
      // inside, rather than starting a spent one of its own.
      expect(aside.cascadeRoot).toBe(asked.id);
      expect(aside.cascadeDepth).toBe(1);
      // Nothing was refused, so the room had nothing to report.
      expect(notices()).toEqual([]);

      // Bo's indicator names the entry Bo was actually asked by, which below the
      // top of a cascade is NOT the cascade root: `aside` triggered Bo, `asked`
      // began the exchange. Everywhere else in this file the two coincide,
      // because depth 0 is the only place they can, so publishing `cascadeRoot`
      // instead would look right in every other scenario — and here it would key
      // Bo's line to the question Ana was asked rather than the one Bo was.
      expect(aside.id).not.toBe(aside.cascadeRoot);
      expect(presenceFor(bo)[0].entryId).toBe(aside.id);

      runner.land(ana, { text: 'all green', waitedMs: 12 * 60_000 });
      await service.triggersIdle();
    });

    it('leaves a legitimate re-trigger alone once the late turn has landed', async () => {
      // The counter-assertion. Without it, the test above is satisfied by a
      // dispatcher that refuses everything, and "claims are held longer" could
      // quietly become "agents stop answering".
      //
      // Only Ana's FIRST turn is held: the second is the one being asked about,
      // and a test that held it too would prove nothing and never finish.
      let anaTurns = 0;
      open(
        drivenRunner({
          plan: (request) => {
            if (request.authorId !== ana) return 'answer';
            anaTurns += 1;
            return anaTurns === 1 ? 'hold' : 'answer';
          },
        })
      );

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline');
      runner.land(ana, { text: 'all green', waitedMs: 12 * 60_000 });
      await service.triggersIdle();

      // A fresh question, after the late answer landed. Nothing is holding Ana.
      service.post(room.id, { authorId: human, text: '@ana and the migration?' });
      await service.triggersIdle();

      expect(turnsBy(ana)).toHaveLength(2);
      expect(noticesAbout(ana)).toEqual([]);
    });
  });
});
