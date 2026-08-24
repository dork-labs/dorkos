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
import type { SessionActivity } from '@dorkos/shared/session-stream';
import { deriveSessionActivity } from '../../session/index.js';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import type { LateRoomReply, RoomTurnRequest, RoomTurnResult } from '../room-trigger.js';
import {
  agentLookupFor,
  createRoomHarness,
  settleUntil,
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
  /**
   * Say what this agent's live turn is doing, exactly as the real runner does.
   *
   * The tool NAME and INPUT go in, not a reading: the derivation is the
   * session's own {@link deriveSessionActivity}, so these tests read the
   * basename rule, the first-line rule and the 40-character truncation rather
   * than a value the test seeded. Breaking that function is what makes them red.
   *
   * @param authorId - Whose turn is doing something.
   * @param toolName - The tool it just started.
   * @param input - That tool's JSON input, when it has one.
   */
  doing(authorId: string, toolName: string, input?: string): void;
  /** Say this agent's turn is no longer doing anything nameable. */
  stoppedDoing(authorId: string): void;
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
 * **Held turns queue per agent rather than overwrite.** A map keyed by author
 * silently dropped a second hold, which is exactly the shape a test about
 * double-triggering must be able to SEE rather than lose: the dispatcher now
 * refuses a second turn for an agent already working in a room, and a runner
 * that could not represent two would agree with a broken one. Landing takes the
 * OLDEST outstanding hold, which is the order a room finishes them in.
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
  /** Each live turn's activity callback, by the agent running it. */
  const reporters = new Map<string, (activity: SessionActivity | null) => void>();
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
    interrupted: [],
    interrupt: () => Promise.resolve(false),
    land(authorId, reply) {
      takeHeld(authorId, 'land').land(reply);
    },
    fail(authorId, err) {
      takeHeld(authorId, 'fail').fail(err);
    },
    holdsFor(authorId) {
      return held.get(authorId)?.length ?? 0;
    },
    doing(authorId, toolName, input) {
      const report = reporters.get(authorId);
      if (!report) throw new Error(`no turn is running for ${authorId}, so it cannot be doing`);
      report(deriveSessionActivity(toolName, input) ?? null);
    },
    stoppedDoing(authorId) {
      const report = reporters.get(authorId);
      if (!report) throw new Error(`no turn is running for ${authorId}, so it cannot stop`);
      report(null);
    },
    release(authorId) {
      const open = gates.get(authorId);
      if (!open) throw new Error(`no turn is waiting to be released for ${authorId}`);
      open();
    },
    run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      reporters.set(request.authorId, request.onActivity);
      turns.push({
        roomId: request.room.id,
        authorId: request.authorId,
        agentPath: request.agentPath,
        sessionId: request.sessionId,
        prompt: request.entry.body.text,
        roomContext: request.roomContext,
        attachmentProjection: request.attachmentProjection,
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
   * means the SECOND message of a scenario reaches the agent whose turn is still
   * being held. A scenario about one held turn then measures a refusal it never
   * asked about. Naming each target makes who runs a property of the message
   * rather than of a window.
   *
   * Pass `'seeded'` to leave the channel's own default in place. One test WANTS
   * that re-trigger, because refusing it is the fix for DOR-752 — and pinning
   * `mention-only` everywhere is exactly what hid the double turn for so long.
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
      // That is judgment, not a fault, so the room adds nothing — and the claim
      // is released all the same, which is what lets Bo's question through.
      runner.land(ana, { text: null, waitedMs: 30 * 60_000 });
      await settleUntil(() => turnsBy(ana).length === 2, 'the held question to become a turn');
      expect(turnsBy(ana)[1].prompt).toBe('no idea — what do you think, @ana?');
      expect(postsBy(ana)).toHaveLength(0);
      expect(notices()).toHaveLength(0);
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
      expect(waiting[0].heldBehind).toEqual({ roomId: elsewhere.id, othersWaiting: false });
      expect(waiting[0].entryId).toBe(first.id);
      // No title, no topic, no text — an id and a boolean, and nothing else that
      // could describe a conversation this reader may not be in.
      expect(Object.keys(waiting[0].heldBehind!).sort()).toEqual(['othersWaiting', 'roomId']);

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
