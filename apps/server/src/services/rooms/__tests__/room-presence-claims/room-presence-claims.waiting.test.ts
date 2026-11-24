/**
 * How long a claim lives: a claim outlives the room’s wait, and the stream says what the turn is doing.
 * The suite's full rationale is on `room-presence-claims.fixtures.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SessionActivity } from '@dorkos/shared/session-stream';
import { settleUntil } from '../room-test-harness.js';

import {
  ana,
  bo,
  drivenRunner,
  human,
  notices,
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
  describe('while the room has stopped waiting', () => {
    it('still reports the agent as working, to everyone who asks', async () => {
      // The defect this pins: `runOne`'s `finally` deleted the claim the moment
      // `runner.run()` resolved, and for a slow turn that resolves at the WAIT
      // deadline. Ana kept working; the room stopped saying so.
      open(drivenRunner({ plan: (request) => (request.authorId === ana ? 'hold' : 'answer') }));

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline');
      expect(turnsBy(ana)).toHaveLength(1);

      // A second person's question, answered by a second agent, mid-window.
      service.post(room.id, { authorId: human, text: '@bo what do you think?' });
      await settleUntil(() => turnsBy(bo).length === 1, 'Bo handed a turn');

      expect(workingSeenBy(turnsBy(bo)[0])).toEqual(['Ana']);
      // And it says since WHEN, which is what an elapsed-time indicator renders
      // from. `expect.any(String)` would pass on `''` — an indicator with no age.
      expect(Date.parse(turnsBy(bo)[0].roomContext.working[0].since)).not.toBeNaN();

      runner.land(ana, { text: 'green', waitedMs: 12 * 60_000 });
      await service.triggersIdle();
      expect(postsBy(ana)).toHaveLength(1);
    });

    it('lets go the moment the late answer lands', async () => {
      open(drivenRunner({ plan: (request) => (request.authorId === ana ? 'hold' : 'answer') }));

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline');

      runner.land(ana, { text: 'green', waitedMs: 12 * 60_000 });
      await service.triggersIdle();

      // The answer is on the log, in the agent's own words. The room used to
      // prefix a late answer with how long it took, because the room was posting
      // it; a late turn posts through the tool now, carrying its own timestamp.
      expect(postsBy(ana)).toHaveLength(1);
      expect(postsBy(ana)[0].body.text).toBe('green');

      // And the room no longer claims Ana is on anything.
      service.post(room.id, { authorId: human, text: '@bo anything else?' });
      await service.triggersIdle();
      expect(workingSeenBy(turnsBy(bo)[0])).toEqual([]);
    });

    it('lets go when the late delivery fails, and says once that the turn failed', async () => {
      // Up to an hour of "Ana is working", then nothing at all: no answer, and
      // no line on the log to explain the silence. A `logger.warn` is not an
      // explanation — the person watching the room cannot read it.
      open(drivenRunner({ plan: (request) => (request.authorId === ana ? 'hold' : 'answer') }));

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline');

      runner.fail(ana, new Error('the session stream went away'));
      await service.triggersIdle();

      expect(notices()).toHaveLength(1);
      expect(notices()[0].body.notice).toBe('turn_failed');
      expect(notices()[0].body.subjectAuthorId).toBe(ana);
      expect(notices()[0].body.text).toContain('Ana');
      // The room log is no place for a stack trace; the detail stays on the
      // agent's own session stream, where the turn machinery already surfaces it.
      expect(notices()[0].body.text).not.toContain('the session stream went away');
      expect(notices()[0].body.text).not.toMatch(/Error:|stack|undefined/);
      expect(postsBy(ana)).toHaveLength(0);

      // The claim is gone too. A failure that released the notice but not the
      // claim would leave the room contradicting itself.
      service.post(room.id, { authorId: human, text: '@bo anything else?' });
      await service.triggersIdle();
      expect(workingSeenBy(turnsBy(bo)[0])).toEqual([]);
    });
  });

  describe('and says what the turn is doing', () => {
    /**
     * Put Ana mid-turn in the room, with the clock stopped and the two timers
     * this feature uses under the test's control.
     *
     * Real timers up to here: `settleUntil` hops the macrotask queue, and a
     * faked `setTimeout` would strand it. Everything after this line is
     * synchronous — `noteActivity` publishes straight into the broadcaster — so
     * the assertions read the stream without another hop.
     */
    async function anaWorking(): Promise<void> {
      open(drivenRunner({ plan: () => 'gated' }));
      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => turnsBy(ana).length === 1, 'Ana handed a turn');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(new Date('2026-07-30T04:00:00.000Z'));
    }

    /** The readings the room heard about one agent, in order, `undefined` for none. */
    function readingsFor(authorId: string): Array<SessionActivity | undefined> {
      return presenceFor(authorId).map((event) => event.activity);
    }

    it('names the tool a turn just started, derived the way the session pane derives it', async () => {
      await anaWorking();
      try {
        expect(readingsFor(ana)).toEqual([undefined]);

        runner.doing(ana, 'Read', '{"file_path":"/repo/notes/standup.md"}');

        // The basename, not the path — this is `deriveSessionActivity`'s answer
        // and not a value this test wrote, which is what makes it evidence that
        // the room and the session describe one tool call one way.
        expect(presenceFor(ana).at(-1)).toMatchObject({
          state: 'working',
          activity: { toolName: 'Read', target: 'standup.md' },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('holds a second tool inside the window, then publishes it on the trailing flush', async () => {
      await anaWorking();
      try {
        runner.doing(ana, 'Read', '{"file_path":"/repo/standup.md"}');
        expect(presenceFor(ana)).toHaveLength(2);

        vi.advanceTimersByTime(100);
        runner.doing(ana, 'Bash', '{"command":"pnpm test"}');
        // Throttled: a busy turn starts tools several times a second, and every
        // publish is a frame on every reader of this room.
        expect(presenceFor(ana)).toHaveLength(2);

        vi.advanceTimersByTime(2_000);

        // And the flush carries the SECOND tool. Without it the last tool of a
        // burst would wait for the ten-second republish, and the lane would name
        // something the agent finished nine seconds ago.
        expect(presenceFor(ana)).toHaveLength(3);
        expect(readingsFor(ana).at(-1)).toEqual({ toolName: 'Bash', target: 'pnpm test' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('says nothing at all when the reading has not changed', async () => {
      await anaWorking();
      try {
        runner.doing(ana, 'Read', '{"file_path":"/repo/standup.md"}');
        expect(presenceFor(ana)).toHaveLength(2);

        vi.advanceTimersByTime(5_000);
        runner.doing(ana, 'Read', '{"file_path":"/repo/standup.md"}');

        // The same tool on the same target is not a change. Republishing it
        // would restart nothing on screen and cost a frame.
        expect(presenceFor(ana)).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears immediately, without waiting out the throttle', async () => {
      await anaWorking();
      try {
        runner.doing(ana, 'Read', '{"file_path":"/repo/standup.md"}');
        vi.advanceTimersByTime(100);

        runner.stoppedDoing(ana);

        // A verb that outlives its turn is the one thing this must not do, so
        // the clear is never delayed — 100 ms into a 2 s window, and the frame
        // is already out with no reading on it.
        expect(presenceFor(ana)).toHaveLength(3);
        expect(presenceFor(ana).at(-1)).toMatchObject({ state: 'working' });
        expect(readingsFor(ana).at(-1)).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('spends no frame on a burst that ends where it started', async () => {
      // A → B → A inside one throttle window. The room is already showing A when
      // the flush fires, so publishing it again would repaint every reader of
      // this room to tell them nothing.
      await anaWorking();
      try {
        runner.doing(ana, 'Read', '{"file_path":"/repo/standup.md"}');
        expect(presenceFor(ana)).toHaveLength(2);

        vi.advanceTimersByTime(100);
        runner.doing(ana, 'Bash', '{"command":"pnpm test"}');
        vi.advanceTimersByTime(100);
        runner.doing(ana, 'Read', '{"file_path":"/repo/standup.md"}');

        vi.advanceTimersByTime(5_000);

        expect(presenceFor(ana)).toHaveLength(2);
        expect(readingsFor(ana).at(-1)).toEqual({ toolName: 'Read', target: 'standup.md' });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('carries the current reading on every ten-second re-statement', async () => {
      // The cold-connect hole: signals never replay, so a client that opens the
      // room mid-turn learns what is happening from a republish and from nothing
      // else. Only the interval is faked, as in the re-statement test above.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      try {
        vi.setSystemTime(new Date('2026-07-30T04:00:00.000Z'));
        open(drivenRunner({ plan: () => 'gated' }));
        service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
        await settleUntil(() => turnsBy(ana).length === 1, 'Ana handed a turn');
        runner.doing(ana, 'Grep', '{"pattern":"deriveLaneState"}');
        expect(readingsFor(ana).at(-1)).toEqual({ toolName: 'Grep', target: 'deriveLaneState' });

        vi.advanceTimersByTime(10_000);

        expect(presenceFor(ana)).toHaveLength(3);
        expect(readingsFor(ana).at(-1)).toEqual({ toolName: 'Grep', target: 'deriveLaneState' });
      } finally {
        vi.useRealTimers();
      }
      runner.release(ana);
      await service.triggersIdle();
    });

    it('publishes nothing more once the claim it was about is gone', async () => {
      await anaWorking();
      try {
        runner.doing(ana, 'Read', '{"file_path":"/repo/standup.md"}');
        vi.advanceTimersByTime(100);
        // Arms a trailing flush that is still pending when the claim goes.
        runner.doing(ana, 'Bash', '{"command":"pnpm test"}');
        expect(vi.getTimerCount()).toBe(1);

        // A halt is the release that settles without the macrotask hops the
        // other terminals need, and it goes through the same `releaseClaim` they
        // all do.
        await service.haltRoom(room.id, human);
        expect(statesFor(ana).at(-1)).toBe('done');
        // And the `done` says the turn is over rather than what it was doing:
        // a halt reaches the release without the runner ever having cleared, so
        // this is the only thing making the frame honest.
        expect(readingsFor(ana).at(-1)).toBeUndefined();
        const afterRelease = presenceFor(ana).length;

        vi.advanceTimersByTime(10_000);

        // A publish for work that is over — the one leak a per-claim timer can
        // cause, and the reason the release clears it.
        expect(presenceFor(ana)).toHaveLength(afterRelease);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('hears nothing from a halted turn that keeps calling tools', async () => {
      await anaWorking();
      try {
        await service.haltRoom(room.id, human);
        const afterHalt = presenceFor(ana).length;

        // The turn's own stream does not stop the instant Stop is pressed, so
        // its runner goes on reporting. With no claim under the key there is
        // nothing for those readings to be about.
        runner.doing(ana, 'Read', '{"file_path":"/repo/standup.md"}');
        vi.advanceTimersByTime(10_000);

        expect(presenceFor(ana)).toHaveLength(afterHalt);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
