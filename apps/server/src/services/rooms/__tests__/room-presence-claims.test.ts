/**
 * How long a claim lives, and what the room believes while it is alive.
 *
 * A claim is the only live record that an agent is working. It used to die when
 * `runner.run()` resolved — which for a slow turn is the moment the room stops
 * WAITING, not the moment the turn ends. On the shipped settings that left up to
 * fifty minutes (ceiling 60 − wait 10) in which an agent was demonstrably
 * mid-turn and read as idle to everything that asks: the cascade guard's
 * in-flight union, every room-mate's `room_context.working`, and — once the
 * presence signal lands on top of this — the person waiting for the answer.
 *
 * So the rule these tests pin is one sentence: **a claim lives until its turn
 * reaches a terminal**, and every way a turn can reach one releases it.
 *
 * Everything below runs through the real service and the real dispatcher, like
 * the cascade tests; only the runner stands in, because the alternative is a
 * model call. What this file's runner adds over `outcomeRunner` is control of
 * TIME: a turn can be held past the deadline and landed when the test says so,
 * and a turn can be gated so that the order of two turns is a fact rather than a
 * coin flip. That second one is not decoration — roster order breaks a
 * `joinedAt` tie on a random ULID, so a test that depends on which of two agents
 * answers first passes about half the time (`room-silence.test.ts` says the same
 * at more length).
 *
 * Spec: `specs/room-presence/02-specification.md` §3.1, §4.1.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import type { LateRoomReply, RoomTurnRequest, RoomTurnResult } from '../room-trigger.js';
import {
  agentLookupFor,
  createRoomHarness,
  type RecordedTurn,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

/** The agents these rooms are built from. */
const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
  '/agents/cy': { name: 'cy', displayName: 'Cy', responseMode: 'always' },
});

/** What one turn does when the dispatcher asks for it. */
type TurnPlan =
  /** Outruns the room's wait: returns `{ text: null, late }` and keeps running. */
  | 'hold'
  /** Answers straight away. */
  | 'answer'
  /** Answers only once the test releases it, which fixes the order of two turns. */
  | 'gated';

/** A scripted runner whose turns the test finishes by hand. */
interface DrivenRunner extends ScriptedTurnRunner {
  /** Land the oldest held turn's answer, the way a late turn closing does. */
  land(authorId: string, reply: LateRoomReply): void;
  /** Blow up the oldest held turn's delivery — the infrastructure-failure path. */
  fail(authorId: string, err: Error): void;
  /** Let a gated turn answer now. */
  release(authorId: string): void;
  /** How many of this agent's turns are still being held. */
  holdsFor(authorId: string): number;
}

/** One held turn, waiting for the test to finish it one way or the other. */
interface HeldTurn {
  land(reply: LateRoomReply): void;
  fail(err: Error): void;
}

/**
 * Build the runner these tests drive.
 *
 * Every hand-off throws when there is nothing to hand off to. A `land` that
 * silently did nothing because the turn was never held would leave a test
 * asserting about a room that never moved, which is the failure mode a test
 * helper must not have.
 *
 * **Held turns queue per agent rather than overwrite.** One agent really can
 * have two turns running in one room at once — `engaged` produces it whenever a
 * held-late agent is re-triggered inside its window — so a map keyed by author
 * silently dropped the first hold, and with it the ability to see the very
 * duplicate `workingIn` had to learn to collapse. Landing takes the OLDEST
 * outstanding hold, which is the order a room finishes them in.
 *
 * @param opts.plan - What each turn does, by request.
 * @param opts.say - What an answering turn says. `'on it'` by default.
 */
function drivenRunner(opts: {
  plan(request: RoomTurnRequest): TurnPlan;
  say?(request: RoomTurnRequest): string | null;
}): DrivenRunner {
  const turns: RecordedTurn[] = [];
  const held = new Map<string, HeldTurn[]>();
  const gates = new Map<string, () => void>();
  const say = opts.say ?? ((): string => 'on it');
  /**
   * Take this agent's oldest outstanding hold.
   *
   * @param authorId - Whose turn is being finished.
   * @param verb - What the caller was trying to do, for the error.
   */
  function takeHeld(authorId: string, verb: string): HeldTurn {
    const turn = held.get(authorId)?.shift();
    if (!turn) throw new Error(`no turn is being held for ${authorId}, so it cannot ${verb}`);
    return turn;
  }
  return {
    turns,
    land(authorId, reply) {
      takeHeld(authorId, 'land').land(reply);
    },
    fail(authorId, err) {
      takeHeld(authorId, 'fail').fail(err);
    },
    holdsFor(authorId) {
      return held.get(authorId)?.length ?? 0;
    },
    release(authorId) {
      const open = gates.get(authorId);
      if (!open) throw new Error(`no turn is waiting to be released for ${authorId}`);
      open();
    },
    run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      turns.push({
        roomId: request.room.id,
        authorId: request.authorId,
        agentPath: request.agentPath,
        sessionId: request.sessionId,
        prompt: request.entry.body.text,
        roomContext: request.roomContext,
      });
      // Bound at claim time, so this is never actually null in a triggered turn.
      const sessionId = request.sessionId ?? `session-${request.authorId}`;
      switch (opts.plan(request)) {
        case 'hold': {
          const late = new Promise<LateRoomReply>((resolve, reject) => {
            const queue = held.get(request.authorId) ?? [];
            queue.push({ land: resolve, fail: reject });
            held.set(request.authorId, queue);
          });
          // Exactly what `room-turn-runner.ts` returns at the wait deadline: the
          // room has no answer yet, and one is still coming.
          return Promise.resolve({ sessionId, text: null, late });
        }
        case 'gated':
          return new Promise<RoomTurnResult>((resolve) => {
            gates.set(request.authorId, () => resolve({ sessionId, text: say(request) }));
          });
        default:
          return Promise.resolve({ sessionId, text: say(request) });
      }
    },
  };
}

/** How many macrotask hops a room gets to reach a state before the test gives up. */
const SETTLE_HOPS = 500;

/**
 * Wait until the room has reached the state this step is about.
 *
 * `triggersIdle()` is the right wait when every turn will settle, and the wrong
 * one whenever a turn is being held: it never resolves until the test lands
 * that turn. So these steps need a different wait, and the obvious one — hop the
 * macrotask queue a fixed number of times — is how a suite acquires a test that
 * usually passes. Two hops were enough on an idle machine and not enough inside
 * a full run, where several hundred test files share one event loop; the
 * scenarios then measured a room that had not finished moving.
 *
 * Waiting on the CONDITION removes the guess in both directions: it returns as
 * soon as the room is ready, and it fails with the state it wanted rather than
 * with a confusing assertion three lines later.
 *
 * Absence is never the condition. "Ana was not triggered again" is proved by
 * waiting for the thing that happens INSTEAD — the refusal notice, or the reply
 * that carried it — which is on the log by the time the dispatch that decided it
 * returns.
 *
 * @param reached - The state being waited for.
 * @param described - What that state is, for the failure message.
 */
async function settleUntil(reached: () => boolean, described: string): Promise<void> {
  for (let hop = 0; hop < SETTLE_HOPS; hop += 1) {
    if (reached()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`the room never reached: ${described}`);
}

describe('a claim lives until its turn is done', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let runner: DrivenRunner;
  let room: RoomWithRoster;
  let ana: string;
  let bo: string;
  let cy: string;
  let human: string;

  /**
   * Wire a channel holding Ana, Bo and Cy around `driven`, every one of them
   * answering only when named.
   *
   * `mention-only` is set explicitly by default, and the reason is the thing
   * these tests are about. A channel now seeds `engaged` (`room-roster.ts`), so
   * an agent stays answerable for ten minutes after being addressed — which
   * means the SECOND message of a scenario re-triggers the agent whose turn is
   * still being held, in a fresh cascade the guard has no reason to refuse. A
   * scenario about ONE held turn then measures two. Naming each target makes who
   * runs a property of the message rather than of a window.
   *
   * Pass `'seeded'` to leave the channel's own default in place — that path has
   * its own test, because pinning `mention-only` everywhere is exactly what hid
   * the duplicate `workingIn` reported.
   *
   * @param driven - The runner standing in for the turn machinery.
   * @param responseMode - What every agent's membership is set to, or `'seeded'`
   *   to keep whatever opening a channel gives them.
   */
  function open(
    driven: DrivenRunner,
    responseMode: ResponseMode | 'seeded' = 'mention-only'
  ): void {
    ({ service, authors, human } = createRoomHarness({ agents, runner: driven }));
    runner = driven;
    room = service.createRoom(
      {
        kind: 'channel',
        title: 'Backend',
        members: [],
        agentPaths: ['/agents/ana', '/agents/bo', '/agents/cy'],
      },
      human
    );
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    bo = authors.resolveAgent('/agents/bo', 'Bo').id;
    cy = authors.resolveAgent('/agents/cy', 'Cy').id;
    if (responseMode === 'seeded') return;
    for (const authorId of [ana, bo, cy]) {
      service.updateMembership(room.id, human, authorId, responseMode);
    }
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

  /** The turns one agent was asked to run. */
  function turnsBy(authorId: string): RecordedTurn[] {
    return runner.turns.filter((turn) => turn.authorId === authorId);
  }

  /**
   * Who the agent running `turn` was told is already working in this room.
   *
   * This is the observable the whole lifetime fix is about: `room_context.working`
   * is derived from the live claim map at the moment a turn is handed its
   * context, so a claim that has been dropped early is a colleague this list
   * cannot mention.
   *
   * @param turn - The recorded turn whose context is being read.
   */
  function workingSeenBy(turn: RecordedTurn | undefined): string[] {
    return (turn?.roomContext.working ?? []).map((claim) => claim.displayName);
  }

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

    it('names an agent once, however many turns it has in flight here', async () => {
      // The shipped default, and the shape every other test here hides by
      // pinning `mention-only`. A channel seeds `engaged`: Ana is addressed, her
      // turn outruns the wait, and the next message re-triggers her because she
      // is still inside her window. That is two live claims for one agent, in
      // two different cascades — legitimate, and both really are running.
      //
      // `workingIn` walked the claim map, so it reported Ana twice, and the
      // roster block an agent reads rendered "Working right now: Ana, Ana". The
      // count collapses; the OLDEST claim wins, because elapsed time has to
      // measure how long Ana has been working and not how long ago she was last
      // interrupted.
      //
      // The clock is pinned (Date only — `settleUntil` still needs real timers) so
      // "oldest wins" is checkable. Two claims a millisecond apart would let a
      // newest-wins bug pass.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-07-30T04:00:00.000Z'));
        open(
          drivenRunner({
            plan: (request) => (request.authorId === ana ? 'hold' : 'answer'),
            // Nobody posts anything: this test is about the claim map, and a
            // reply would start a cascade that has nothing to do with it.
            say: () => null,
          }),
          'seeded'
        );

        service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
        await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline');
        expect(runner.holdsFor(ana)).toBe(1);

        // Five minutes on, well inside Ana's ten-minute window.
        vi.setSystemTime(new Date('2026-07-30T04:05:00.000Z'));
        service.post(room.id, { authorId: human, text: '@bo what do you think?' });
        await settleUntil(
          () => runner.holdsFor(ana) === 2 && turnsBy(bo).length === 1,
          'Ana re-triggered on her engagement, and Bo handed a turn'
        );

        // Ana was re-triggered on her engagement, so she has two turns running.
        expect(runner.holdsFor(ana)).toBe(2);
        expect(turnsBy(ana)).toHaveLength(2);
        // And Bo is told about her once, from when she started.
        expect(workingSeenBy(turnsBy(bo)[0])).toEqual(['Ana']);
        expect(turnsBy(bo)[0].roomContext.working[0].since).toBe('2026-07-30T04:00:00.000Z');

        runner.land(ana, { text: null, waitedMs: 12 * 60_000 });
        runner.land(ana, { text: null, waitedMs: 7 * 60_000 });
        await service.triggersIdle();
        // Both turns ended with nothing to say, so the room stayed quiet: the
        // two questions are the whole log.
        expect(log()).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('lets go the moment the late answer lands', async () => {
      open(drivenRunner({ plan: (request) => (request.authorId === ana ? 'hold' : 'answer') }));

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline');

      runner.land(ana, { text: 'green', waitedMs: 12 * 60_000 });
      await service.triggersIdle();

      // The answer is on the log, saying how long it took.
      expect(postsBy(ana)).toHaveLength(1);
      expect(postsBy(ana)[0].body.text).toContain('This answers the message from 12 minutes ago');

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

  describe('and the guard reads the same claim', () => {
    it('refuses a re-trigger of an agent whose late turn is still running', async () => {
      // This refusal is NEW, and it is accepted deliberately (spec §3.1).
      //
      // A late turn that ends up saying nothing never lands a durable stamp in
      // the ancestry table, so before this change a re-trigger of that agent in
      // the same cascade bought a SECOND model call on the very session the
      // first turn was still holding — the busy collision, one layer up. Now the
      // held claim is in the guard's in-flight union and the second trigger is
      // refused. Ana genuinely has a turn in flight on this room's session for
      // this cascade; starting another one is the thing to avoid.
      //
      // The refusal's copy is the known rough edge: `cascade_stopped` says the
      // back-and-forth "hit its automatic-reply limit" when the real cause is a
      // turn still running, and it will land beside a live working indicator
      // once the presence line ships. Both statements are true (no NEW turn
      // starts; the OLD one has not finished), but the words point at the wrong
      // reason — revisit them if dogfooding shows people read it as a
      // contradiction.
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
      // Bo's reply, and the refusal it drew, land in the same dispatch — so the
      // notice being on the log means the decision about Ana has been made.
      await settleUntil(() => noticesAbout(ana).length === 1, 'Ana refused, once');

      // Bo named Ana, and Ana was not asked to run a second turn.
      expect(postsBy(bo)).toHaveLength(1);
      expect(turnsBy(ana)).toHaveLength(1);
      expect(noticesAbout(ana)).toHaveLength(1);
      expect(noticesAbout(ana)[0].body.notice).toBe('cascade_stopped');

      // The refusal did not disturb the claim: Ana is still working, and the
      // next agent to be handed a context is still told so.
      service.post(room.id, { authorId: human, text: '@cy are you free?' });
      await settleUntil(() => turnsBy(cy).length === 1, 'Cy handed a turn');
      expect(workingSeenBy(turnsBy(cy)[0])).toEqual(['Ana']);

      // Ana's turn ends the way this scenario is named for: with nothing to say.
      // That is judgment, not a fault, so the room adds nothing — and the claim
      // is released all the same.
      runner.land(ana, { text: null, waitedMs: 30 * 60_000 });
      await service.triggersIdle();
      expect(postsBy(ana)).toHaveLength(0);
      expect(notices()).toHaveLength(1);
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
