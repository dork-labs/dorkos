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
 * The second half of this file pins what the ROOM says while that is going on.
 * Presence is the claim map made visible: a `progress` signal at the claim,
 * another at the wait deadline, one more when the turn ends, and a re-statement
 * every ten seconds in between so a client that connects mid-turn is not left
 * looking at a room that seems idle. Two properties there are worth more than
 * the rest, and both are asserted on the ORDER of the room's own stream rather
 * than on a mock: an indicator never drops before the entry that explains it,
 * and an indicator's age is measured from when the work started, not from when
 * the last event was sent.
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
import type {
  RoomEntry,
  RoomEvent,
  RoomSignalEvent,
  RoomWithRoster,
} from '@dorkos/shared/room-schemas';
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
  /** Never ran: another writer held the session, so the room says so instead. */
  | 'busy'
  /** Blows up before it can produce anything — the runtime-is-down path. */
  | 'throws'
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
        case 'busy':
          // What `room-turn-runner.ts` returns when the session lock refuses: no
          // turn ran, and the room owes the person a line about it.
          return Promise.resolve({ sessionId, text: null, unanswered: 'busy' });
        case 'throws':
          // The runner REJECTING, which is a different terminal from a turn that
          // returns `unanswered`: it lands in `runOne`'s `catch` rather than in
          // `deliver`, and is the only terminal that reaches the release without
          // passing through `deliver` at all.
          return Promise.reject(new Error('the runtime went away'));
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
   * Everything the room fanned out, in the order its readers received it.
   *
   * Recorded at the broadcaster — the one seam every entry and every signal
   * passes through — and still delivered, so this observes the real stream
   * rather than replacing it. Order is the whole point: "the answer lands, then
   * the indicator goes" is a claim about this list and about nothing else.
   */
  let published: Array<{ roomId: string; event: RoomEvent }> = [];

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
    published = [];
    const broadcaster = service.stream;
    const deliver = broadcaster.publish.bind(broadcaster);
    vi.spyOn(broadcaster, 'publish').mockImplementation((roomId, event) => {
      published.push({ roomId, event });
      deliver(roomId, event);
    });
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

  /** This room's stream, entries and signals interleaved, in order. */
  function roomStream(): RoomEvent[] {
    return published.filter((sent) => sent.roomId === room.id).map((sent) => sent.event);
  }

  /** Every presence signal about one agent, in the order it was sent. */
  function presenceFor(authorId: string): RoomSignalEvent[] {
    return roomStream()
      .filter((event): event is RoomSignalEvent => event.type === 'signal')
      .filter((event) => event.authorId === authorId);
  }

  /** Just the lifecycle, which is what most of these assertions are about. */
  function statesFor(authorId: string): Array<string | undefined> {
    return presenceFor(authorId).map((event) => event.state);
  }

  /**
   * Where one agent's release sits in the room's stream.
   *
   * @param authorId - Whose indicator released.
   */
  function releaseIndex(authorId: string): number {
    return roomStream().findIndex(
      (event) => event.type === 'signal' && event.authorId === authorId && event.state === 'done'
    );
  }

  /**
   * Where the durable entry that explains a release sits in the same stream.
   *
   * @param matches - Which entry is being looked for.
   */
  function entryIndex(matches: (entry: RoomEntry) => boolean): number {
    return roomStream().findIndex((event) => event.type === 'entry' && matches(event.entry));
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
      // **Presence does the opposite, and this is the only place both are
      // visible at once.** The roster block is prose for a model, where "Ana,
      // Ana" is noise; the signal stream carries an INDICATOR per claim, keyed
      // `(author, entryId)`, because the client has to be able to clear one of
      // Ana's two indicators when that turn ends without clearing the other. A
      // per-author collapse here would make the second claim's `done`
      // indistinguishable from the first's, and the live turn's indicator would
      // die at the client's TTL while the work was still running.
      //
      // The clock is pinned (`settleUntil` still needs a real `setTimeout`) so
      // "oldest wins" is checkable. Two claims a millisecond apart would let a
      // newest-wins bug pass. `setInterval` is faked alongside it so the
      // republish tick can be driven from here.
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
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

        const asked = service.post(room.id, {
          authorId: human,
          text: '@ana can you check the deploy?',
        });
        await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana past the wait deadline');
        expect(runner.holdsFor(ana)).toBe(1);

        // Five minutes on, well inside Ana's ten-minute window.
        vi.setSystemTime(new Date('2026-07-30T04:05:00.000Z'));
        const later = service.post(room.id, { authorId: human, text: '@bo what do you think?' });
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

        // The stream, meanwhile, is still carrying BOTH of Ana's claims: one tick
        // re-states each of them separately, under the entry it is answering and
        // from the time that claim was taken. Collapsing them to one event per
        // author is what this pins against.
        const before = presenceFor(ana).length;
        vi.advanceTimersByTime(10_000);
        const tick = presenceFor(ana).slice(before);
        expect(tick.map((event) => event.entryId)).toEqual([asked.id, later.id]);
        expect(tick.map((event) => event.state)).toEqual(['working_late', 'working_late']);
        expect(tick.map((event) => event.since)).toEqual([
          '2026-07-30T04:00:00.000Z',
          '2026-07-30T04:05:00.000Z',
        ]);

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

    it('releases with nothing on the log when the agent chose to say nothing', async () => {
      // The one indicator-then-nothing this design ACCEPTS (spec §4.3), pinned
      // here as a choice so that closing it is a decision somebody makes rather
      // than a test nobody wrote. A turn that runs and decides there is nothing
      // worth adding is exercising judgment; forcing a durable "had nothing to
      // say" entry on every ambient turn would be the over-participation this
      // whole programme exists to prevent.
      open(drivenRunner({ plan: () => 'answer', say: () => null }));

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await service.triggersIdle();

      expect(statesFor(ana)).toEqual(['working', 'done']);
      // The question is the entire log, and the entire durable half of the
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

    it('shows an indicator for every attempt, while saying once that the agent was busy', async () => {
      // Two busy refusals for the same agent, with no successful turn between
      // them. The notice is damped on `(room, agent)` until that agent answers
      // again — four messages to a busy agent must not put four apologies in the
      // room — but the INDICATOR is not damped, because each attempt really did
      // take a claim and really did release it.
      //
      // So the second release's durable explanation is the notice already
      // standing on the log. That is the release invariant read exactly as
      // written (spec §4.1 path (a)): an indicator may disappear into a fresh
      // notice OR one already standing, and never into nothing.
      open(drivenRunner({ plan: () => 'busy' }));

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await service.triggersIdle();
      service.post(room.id, { authorId: human, text: '@ana any luck?' });
      await service.triggersIdle();

      expect(turnsBy(ana)).toHaveLength(2);
      expect(statesFor(ana)).toEqual(['working', 'done', 'working', 'done']);
      expect(noticesAbout(ana)).toHaveLength(1);

      // The first release resolves into its own fresh notice; the second writes
      // no notice at all, and the standing one is still there to explain it.
      const stream = roomStream();
      const releases = stream.flatMap((event, at) =>
        event.type === 'signal' && event.state === 'done' ? [at] : []
      );
      const notice = entryIndex((entry) => entry.kind === 'notice');
      expect(releases).toHaveLength(2);
      expect(releases[0]).toBe(notice + 1);
      expect(
        stream
          .slice(releases[0], releases[1])
          .filter((e) => e.type === 'entry' && e.entry.kind === 'notice')
      ).toEqual([]);
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
