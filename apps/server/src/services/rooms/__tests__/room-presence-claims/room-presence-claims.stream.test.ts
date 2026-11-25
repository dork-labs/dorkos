/**
 * How long a claim lives: the room says on its stream who is working, and when they stop.
 * The suite's full rationale is on `room-presence-claims.fixtures.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { settleUntil } from '../room-test-harness.js';

import {
  ana,
  bo,
  drivenRunner,
  entryIndex,
  human,
  log,
  noticesAbout,
  open,
  postsBy,
  presenceFor,
  releaseIndex,
  room,
  roomStream,
  runner,
  service,
  statesFor,
  turnsBy,
} from './room-presence-claims.fixtures.js';

describe('a claim lives until its turn is done', () => {
  describe('and the room says so on its stream', () => {
    it('says who is working, from the moment the claim is taken', async () => {
      // The claim already existed and was shown to nobody but other agents. This
      // is the publish that closes that: one signal, per claimed target, naming
      // the agent, the question it is answering, and when it started.
      //
      // The clock is pinned so `since` is checkable against a literal —
      // `expect.any(String)` would pass on an indicator with no age at all.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-07-30T04:00:00.000Z'));
        // Gated, so the turn is still running when the assertions read the
        // stream: a turn that answered would have released before they looked.
        open(drivenRunner({ plan: () => 'gated' }));

        const asked = service.post(room.id, {
          authorId: human,
          text: '@ana can you check the deploy?',
        });
        await settleUntil(() => turnsBy(ana).length === 1, 'Ana handed a turn');

        expect(presenceFor(ana)).toHaveLength(1);
        const working = presenceFor(ana)[0];
        // `progress`, from the relay's shared vocabulary. Never `typing`: agents
        // do not type, they work (room-presence spec §1).
        expect(working.signal).toBe('progress');
        expect(working.state).toBe('working');
        expect(working.entryId).toBe(asked.id);
        expect(working.since).toBe('2026-07-30T04:00:00.000Z');

        // The question is on the stream before the indicator that names it, so a
        // client is never told about work on an entry it has not been sent.
        expect(entryIndex((entry) => entry.id === asked.id)).toBeLessThan(
          roomStream().indexOf(working)
        );
        // And nobody else is claimed to be doing anything.
        expect(presenceFor(bo)).toEqual([]);

        runner.release(ana);
        await service.triggersIdle();
      } finally {
        vi.useRealTimers();
      }
    });

    it('lets the indicator go only once the answer is on the log', async () => {
      // The ordering rule, on the ordinary path: `done` is published after
      // `writer.post` returns, so the reply is already on the stream when the
      // line under the composer disappears. Reversed, a person watches the
      // indicator vanish and then waits for an answer they think was lost.
      open(drivenRunner({ plan: () => 'answer' }));

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await service.triggersIdle();

      expect(statesFor(ana)).toEqual(['working', 'done']);
      expect(postsBy(ana)).toHaveLength(1);
      expect(releaseIndex(ana)).toBe(
        entryIndex((entry) => entry.kind === 'post' && entry.authorId === ana) + 1
      );
    });

    it('lets the indicator go only once the notice that explains it is on the log', async () => {
      // A busy refusal never gets past the session lock, so the person's whole
      // experience of it is: an indicator appeared, and it resolved into a line
      // saying the agent did not pick this up. Indicator and explanation, in that
      // order, never indicator and mystery.
      open(drivenRunner({ plan: () => 'busy' }));

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await service.triggersIdle();

      expect(statesFor(ana)).toEqual(['working', 'done']);
      expect(noticesAbout(ana)).toHaveLength(1);
      expect(noticesAbout(ana)[0].body.notice).toBe('agent_busy');
      expect(releaseIndex(ana)).toBe(entryIndex((entry) => entry.kind === 'notice') + 1);
    });

    it('lets the indicator go only once a turn that blew up has been reported', async () => {
      // The fourth terminal, and the only one that never reaches `deliver`: the
      // runner rejects, `runOne`'s `catch` reports the failure, and the release
      // happens in the `finally` after it. Same ordering rule as every other
      // path, on the path most likely to be rewritten by someone adding error
      // handling later.
      open(drivenRunner({ plan: () => 'throws' }));

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await service.triggersIdle();

      expect(statesFor(ana)).toEqual(['working', 'done']);
      expect(noticesAbout(ana)).toHaveLength(1);
      expect(noticesAbout(ana)[0].body.notice).toBe('turn_failed');
      expect(releaseIndex(ana)).toBe(entryIndex((entry) => entry.kind === 'notice') + 1);
    });

    it('releases with nothing on the log when nobody asked and the agent chose to say nothing', async () => {
      // The one indicator-then-nothing this design ACCEPTS (spec §4.3), pinned
      // here as a choice so that closing it is a decision somebody makes rather
      // than a test nobody wrote. A turn that runs and decides there is nothing
      // worth adding is exercising judgment; forcing a durable "had nothing to
      // say" entry on every ambient turn would be the over-participation this
      // whole programme exists to prevent.
      //
      // **Ambient, deliberately.** The obligation attaches to being ASKED, never
      // to running a turn (spec §D6), so a message that named Ana would earn one
      // `agent_declined` line and this would no longer be an
      // indicator-then-nothing at all. Nobody is named here.
      open(drivenRunner({ plan: () => 'answer', say: () => null }), 'always');

      service.post(room.id, { authorId: human, text: 'the deploy is stuck' });
      await service.triggersIdle();

      expect(statesFor(ana)).toEqual(['working', 'done']);
      // The message is the entire log, and the entire durable half of the
      // stream: nothing was written between the indicator appearing and going.
      expect(log()).toHaveLength(1);
      expect(roomStream().filter((event) => event.type === 'entry')).toHaveLength(1);
    });

    it('says a turn is taking longer than usual once, and releases when it lands', async () => {
      // The deadline is a state change, not a notice: the room already tells the
      // person how long the answer took when it finally posts, and a durable line
      // at every deadline would be a second message about every slow turn.
      open(drivenRunner({ plan: (request) => (request.authorId === ana ? 'hold' : 'answer') }));

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline');

      expect(statesFor(ana)).toEqual(['working', 'working_late']);

      runner.land(ana, { text: 'green', waitedMs: 12 * 60_000 });
      await service.triggersIdle();

      expect(statesFor(ana)).toEqual(['working', 'working_late', 'done']);
      // Same ordering rule as the fast path, on the path where it matters most:
      // the late answer has been waited on for minutes.
      expect(releaseIndex(ana)).toBe(
        entryIndex((entry) => entry.kind === 'post' && entry.authorId === ana) + 1
      );
    });

    it('releases after the failure notice when a late delivery never lands', async () => {
      // The other way a late turn settles. It used to leave a `logger.warn` and
      // nothing else; now it leaves the same damped `turn_failed` notice every
      // other failure leaves, and the indicator goes after that notice.
      open(drivenRunner({ plan: (request) => (request.authorId === ana ? 'hold' : 'answer') }));

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline');

      runner.fail(ana, new Error('the session stream went away'));
      await service.triggersIdle();

      expect(statesFor(ana)).toEqual(['working', 'working_late', 'done']);
      expect(noticesAbout(ana)[0].body.notice).toBe('turn_failed');
      expect(releaseIndex(ana)).toBe(entryIndex((entry) => entry.kind === 'notice') + 1);
    });

    it('shows an indicator for every attempt, and answers the person on every one', async () => {
      // Two busy refusals for the same agent, both from somebody typing into the
      // room, with no successful turn between them. Neither the indicator nor
      // the line is damped here: each attempt really did take a claim and
      // release it, and each message really did go nowhere.
      //
      // Damping a person's second message is what DOR-781 reversed — see
      // `room-silence.test.ts`. What stays damped is agent traffic, which is
      // where the apologies actually multiplied.
      //
      // So each indicator resolves into ITS OWN fresh notice: the release
      // invariant (spec §4.1 path (a)) read one attempt at a time.
      open(drivenRunner({ plan: () => 'busy' }));

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await service.triggersIdle();
      service.post(room.id, { authorId: human, text: '@ana any luck?' });
      await service.triggersIdle();

      expect(turnsBy(ana)).toHaveLength(2);
      expect(statesFor(ana)).toEqual(['working', 'done', 'working', 'done']);
      expect(noticesAbout(ana)).toHaveLength(2);

      const stream = roomStream();
      const releases = stream.flatMap((event, at) =>
        event.type === 'signal' && event.state === 'done' ? [at] : []
      );
      const written = stream.flatMap((event, at) =>
        event.type === 'entry' && event.entry.kind === 'notice' ? [at] : []
      );
      expect(releases).toHaveLength(2);
      expect(written).toHaveLength(2);
      // Each release sits immediately after the notice that explains it, never
      // before — on both attempts.
      expect(releases).toEqual([written[0] + 1, written[1] + 1]);
    });

    it('keeps re-stating every live claim, dated from when each one started', async () => {
      // Signals never replay, so without this loop a client that opens a room in
      // the middle of a turn sees a room that looks idle — for up to an hour, on
      // the shipped ceiling. Re-stating live claims on an interval means presence
      // heals itself within one tick of any connect, reconnect or recovery, with
      // nothing persisted and nothing to strand if the process dies.
      //
      // Only the interval is faked: `settleUntil` still needs a real `setTimeout`
      // to hop the macrotask queue. Faking `Date` alongside it is what makes the
      // `since` assertions below discriminate — ten seconds pass on the clock,
      // and every re-statement still carries the time the work began.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      try {
        vi.setSystemTime(new Date('2026-07-30T04:00:00.000Z'));
        open(drivenRunner({ plan: (request) => (request.authorId === ana ? 'hold' : 'gated') }));

        service.post(room.id, { authorId: human, text: '@ana @bo can you check the deploy?' });
        await settleUntil(
          () => runner.holdsFor(ana) === 1 && turnsBy(bo).length === 1,
          'Ana past the wait deadline, with Bo still working'
        );
        expect(statesFor(ana)).toEqual(['working', 'working_late']);
        expect(statesFor(bo)).toEqual(['working']);
        // One loop for the whole dispatcher, not one per claim.
        expect(vi.getTimerCount()).toBe(1);

        vi.advanceTimersByTime(10_000);

        // Both claims re-stated, each in the state it is actually in.
        expect(statesFor(ana)).toEqual(['working', 'working_late', 'working_late']);
        expect(statesFor(bo)).toEqual(['working', 'working']);
        // And dated from when the work started, not from when the event was
        // sent. A `since` that meant "now" would reset every indicator's age
        // every ten seconds, and this is what catches it.
        expect(presenceFor(ana).map((event) => event.since)).toEqual([
          '2026-07-30T04:00:00.000Z',
          '2026-07-30T04:00:00.000Z',
          '2026-07-30T04:00:00.000Z',
        ]);
        expect(presenceFor(bo).map((event) => event.since)).toEqual([
          '2026-07-30T04:00:00.000Z',
          '2026-07-30T04:00:00.000Z',
        ]);

        runner.release(bo);
        runner.land(ana, { text: 'green', waitedMs: 12 * 60_000 });
        await service.triggersIdle();

        expect(statesFor(ana).at(-1)).toBe('done');
        expect(statesFor(bo).at(-1)).toBe('done');
        // The map is empty, so the loop is gone: an idle room runs no timer.
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
