/**
 * A turn answers a moment, not a message (room-participation spec §10.4, RP8).
 *
 * Four mechanisms ship together here and this file pins all four:
 *
 * 1. **Collect, do not interrupt or drop.** A burst of people talking at once
 *    becomes ONE turn, gathered for `rooms.collectDebounceMs` and capped at
 *    `rooms.collectMaxEntries`. A message that arrives after the window starts
 *    the next turn instead of being folded into this one.
 * 2. **Mid-turn arrival steers.** A message for an agent that is already working
 *    here is held rather than refused, and — this is the half nothing else in
 *    the suite would catch — the claim's release RUNS it. Without that, a person
 *    who asked one more thing and stopped typing waited for a stranger to speak
 *    before their question was ever seen.
 * 3. **No in-flight peeking.** Agents never see each other's partial text. What
 *    they get is `room_context.working`, which is a name and a start time.
 * 4. **Halt is a transport verb.** It drops the gathered messages too, and it is
 *    never inferred from what somebody typed.
 *
 * Driven through the real service and the real dispatcher like the rest of the
 * rooms suite; only the runner stands in, because the alternative is a model
 * call. The collect window is pinned to a literal per test rather than read from
 * config, for the reason every other ceiling in this suite is: a test that read
 * the value the code reads could only prove the two agree.
 */
import { describe, it, expect } from 'vitest';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import type { RoomTurnRequest, RoomTurnResult } from '../room-trigger.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  settleUntil,
  type RecordedTurn,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
});

/** The window these tests measure against, pinned rather than read from config. */
const DEBOUNCE_MS = 500;

/** A runner whose turns only finish when the test says so. */
interface HeldRunner extends ScriptedTurnRunner {
  /** How many of this agent's turns are still open. */
  holdsFor(authorId: string): number;
  /** Let this agent's oldest open turn answer. */
  release(authorId: string): void;
}

/**
 * Build a runner that holds every turn open until the test releases it.
 *
 * Holding is what makes any of this observable: a turn that answered would take
 * and release its claim inside one `await`, and "a message arrived while the
 * agent was working" would be a state the test never got to look at.
 *
 * @param say - What a released turn answers. The default names nobody, which is
 *   what keeps most scenarios free of cascades they did not ask for; a scenario
 *   about one agent handing work to another overrides it.
 */
function heldRunner(say: (request: RoomTurnRequest) => string = () => 'on it'): HeldRunner {
  const turns: RecordedTurn[] = [];
  const interrupted: ScriptedTurnRunner['interrupted'] = [];
  const open = new Map<string, Array<() => void>>();
  const paths = new Map<string, string>();
  return {
    turns,
    interrupted,
    interrupt(request): Promise<void> {
      interrupted.push(request);
      // A real interrupt ENDS the turn: the runtime stops, the stream closes,
      // and the collector resolves with whatever there was. A fake that only
      // recorded the call would leave the dispatcher awaiting a turn nothing can
      // finish, which is not what a halt does.
      for (const [authorId, queued] of open) {
        if (paths.get(authorId) !== request.agentPath) continue;
        for (const gate of queued.splice(0)) gate();
      }
      return Promise.resolve();
    },
    run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      turns.push({
        roomId: request.room.id,
        authorId: request.authorId,
        agentPath: request.agentPath,
        sessionId: request.sessionId,
        prompt: request.prompt,
        roomContext: request.roomContext,
        attachmentProjection: request.attachmentProjection,
      });
      paths.set(request.authorId, request.agentPath);
      return new Promise<RoomTurnResult>((resolve) => {
        const queued = open.get(request.authorId) ?? [];
        queued.push(() =>
          resolve({ sessionId: request.sessionId ?? 'session-1', text: say(request) })
        );
        open.set(request.authorId, queued);
      });
    },
    holdsFor(authorId) {
      return open.get(authorId)?.length ?? 0;
    },
    release(authorId) {
      const gate = open.get(authorId)?.shift();
      if (!gate) throw new Error(`no held turn for ${authorId}`);
      gate();
    },
  };
}

describe('a room gathers a burst into one turn', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let runner: ScriptedTurnRunner;
  let room: RoomWithRoster;
  let ana: string;
  let human: string;

  /**
   * Wire a channel around `scripted`, with a collect window of `debounceMs`.
   *
   * @param scripted - The runner standing in for the turn machinery.
   * @param collect - The window and cap this scenario is about.
   * @param agentPaths - Who is in the room. Ana alone by default.
   */
  function open(
    scripted: ScriptedTurnRunner,
    collect: { debounceMs: number; maxEntries: number },
    agentPaths = ['/agents/ana']
  ): void {
    ({ service, authors, runner, human } = createRoomHarness({
      agents,
      runner: scripted,
      collect,
    }));
    room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths },
      human
    );
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    // Named explicitly throughout, so who runs is a property of the message
    // rather than of an engagement window.
    for (const [path, name] of [
      ['/agents/ana', 'Ana'],
      ['/agents/bo', 'Bo'],
    ] as const) {
      if (!agentPaths.includes(path)) continue;
      service.updateMembership(room.id, human, authors.resolveAgent(path, name).id, 'mention-only');
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

  /** Posts by one author. */
  function postsBy(authorId: string): RoomEntry[] {
    return log().filter((entry) => entry.kind === 'post' && entry.authorId === authorId);
  }

  describe('collect, do not interrupt or drop', () => {
    it('turns three posts inside the window into one turn carrying the other two', async () => {
      // **The gaps are the measurement, not a guess**, which is the one place a
      // sleep belongs in this suite. Three posts fired in the same tick would
      // gather under ANY window length, zero included — a sweep is a macrotask
      // whatever it is waiting for — so a test written that way could not tell a
      // working window from an absent one. Real time has to pass between them,
      // and the window is a second wide so the margin is not a race.
      open(scriptedRunner(), { debounceMs: 1_000, maxEntries: 20 });
      const typingPause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

      service.post(room.id, { authorId: human, text: '@ana the build is red' });
      await typingPause();
      service.post(room.id, { authorId: human, text: '@ana it is the migration step' });
      await typingPause();
      service.post(room.id, { authorId: human, text: '@ana can you look?' });
      await service.triggersIdle();

      expect(runner.turns).toHaveLength(1);
      // The newest message is what the turn answers; the two before it ride its
      // ambient window, so all three are in front of the model exactly once.
      expect(runner.turns[0].prompt).toBe('@ana can you look?');
      expect(runner.turns[0].roomContext.pending.map((entry) => entry.text)).toEqual([
        '@ana the build is red',
        '@ana it is the migration step',
      ]);
      // One answer, not three.
      expect(log().filter((entry) => entry.kind === 'post' && entry.authorId === ana)).toHaveLength(
        1
      );
    });

    it('starts a second turn for a post that lands after the window closed', async () => {
      open(scriptedRunner(), { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      service.post(room.id, { authorId: human, text: '@ana the build is red' });
      await service.triggersIdle();
      service.post(room.id, { authorId: human, text: '@ana and now the cache' });
      await service.triggersIdle();

      expect(runner.turns.map((turn) => turn.prompt)).toEqual([
        '@ana the build is red',
        '@ana and now the cache',
      ]);
    });

    it('answers at the cap instead of waiting out the window', async () => {
      // A room that never goes quiet still gets replies: the cap is what stops
      // the gathering window from being a way to never answer. Messages past it
      // start the next turn rather than being dropped.
      open(scriptedRunner(), { debounceMs: 60_000, maxEntries: 3 });

      for (const text of ['one', 'two', 'three', 'four']) {
        service.post(room.id, { authorId: human, text: `@ana ${text}` });
      }
      // A minute-long window, so nothing here can be the timer expiring — the
      // cap is the only thing that can produce a turn.
      await settleUntil(() => runner.turns.length === 1, 'the cap to close the first window');

      expect(runner.turns[0].prompt).toBe('@ana three');
      expect(runner.turns[0].roomContext.pending.map((entry) => entry.text)).toEqual([
        '@ana one',
        '@ana two',
      ]);
      // And the fourth is not lost: it is sitting in the next window, which this
      // test deliberately never waits out.
      expect(runner.turns).toHaveLength(1);
    });

    it('covers one message per answer at a cap of one', async () => {
      // The documented floor of `collectMaxEntries`, and the boundary the cap
      // check has to run on CREATION to honour: at one, the FIRST message
      // already fills the batch. Checked only when a collection grew, this
      // setting quietly meant two messages per turn — the opposite of what it
      // says — because the batch had to be joined before it was measured.
      //
      // Both messages land in the same tick and the window is a minute wide, so
      // nothing here can be the timer closing anything: the cap is the only
      // thing that can produce a turn, and it has to produce two.
      open(scriptedRunner(), { debounceMs: 60_000, maxEntries: 1 });

      service.post(room.id, { authorId: human, text: '@ana one' });
      service.post(room.id, { authorId: human, text: '@ana two' });
      await settleUntil(() => runner.turns.length === 2, 'one turn per message');

      expect(runner.turns.map((turn) => turn.prompt)).toEqual(['@ana one', '@ana two']);
      // Each answer covers its own message and gathers nothing behind it.
      expect(runner.turns.every((turn) => turn.roomContext.pending.length === 0)).toBe(true);
    });

    it('settles, and loses nothing, when a burst at the cap parks more than one batch', async () => {
      // At a cap of one, three messages in a tick close three batches at once.
      // The first claims and the other two both park — onto the SAME
      // `(room, agent)` key. Parking that overwrote instead of merging dropped
      // the middle batch and the pending turn it was owed, so the room never
      // settled and one message was never anybody's trigger.
      //
      // `triggersIdle()` resolving at all is half of what this measures.
      open(scriptedRunner(), { debounceMs: 60_000, maxEntries: 1 });

      for (const text of ['one', 'two', 'three']) {
        service.post(room.id, { authorId: human, text: `@ana ${text}` });
      }
      await service.triggersIdle();

      // Two turns: the cap says an answer covers one message, and a parked batch
      // that outgrows it keeps the newest.
      expect(runner.turns.map((turn) => turn.prompt)).toEqual(['@ana one', '@ana three']);
      // And the message the cap dropped from the batch is not lost — it is
      // still unread, so it rides the very next turn's window.
      expect(runner.turns[1].roomContext.pending.map((entry) => entry.text)).toEqual(['@ana two']);
    });

    it('gathers per agent, so one burst is one turn each and neither waits for the other', async () => {
      // No arbitration (I1): two agents addressed by the same burst both answer,
      // and the collect window never orders one against the other.
      open(scriptedRunner(), { debounceMs: DEBOUNCE_MS, maxEntries: 20 }, [
        '/agents/ana',
        '/agents/bo',
      ]);
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;

      service.post(room.id, { authorId: human, text: '@ana @bo the build is red' });
      service.post(room.id, { authorId: human, text: '@ana @bo can you both look?' });
      await service.triggersIdle();

      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(1);
      expect(runner.turns.filter((turn) => turn.authorId === bo)).toHaveLength(1);
    });

    it('charges the room for the gathered turn once, not once per message', async () => {
      // The half of this that shows up on a bill. Three messages, one turn, one
      // reservation — a room that charged per message would let two people
      // talking at once burn an hour's automatic turns on one answer.
      open(scriptedRunner(), { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      for (const text of ['one', 'two', 'three']) {
        service.post(room.id, { authorId: human, text: `@ana ${text}` });
      }
      await service.triggersIdle();
      const afterBurst = runner.turns[0].roomContext.budget.automaticRepliesLeftInThisRoomThisHour;

      service.post(room.id, { authorId: human, text: '@ana four' });
      await service.triggersIdle();

      expect(runner.turns).toHaveLength(2);
      expect(runner.turns[1].roomContext.budget.automaticRepliesLeftInThisRoomThisHour).toBe(
        afterBurst - 1
      );
    });

    it('advances the read cursor over the whole gathered window, so nothing repeats', async () => {
      open(scriptedRunner(), { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      for (const text of ['one', 'two', 'three']) {
        service.post(room.id, { authorId: human, text: `@ana ${text}` });
      }
      await service.triggersIdle();
      service.post(room.id, { authorId: human, text: '@ana four' });
      await service.triggersIdle();

      // The second turn's window starts where the first one's claim left the
      // cursor: past all three of the messages it gathered.
      expect(runner.turns[1].roomContext.pending.map((entry) => entry.text)).not.toContain(
        '@ana one'
      );
      expect(runner.turns[1].roomContext.pending.map((entry) => entry.text)).not.toContain(
        '@ana two'
      );
    });

    it('gathers the chatter an engaged agent hears, and still reports its window', async () => {
      // The engaged window is evaluated PER MESSAGE, before anything is
      // gathered, and the turn carries the reading from the message it answers.
      // Gathering must not lose that: an agent told its window is `null` by the
      // very burst that kept it engaged would have no way to tell being spoken
      // to from overhearing.
      open(scriptedRunner(), { debounceMs: DEBOUNCE_MS, maxEntries: 20 });
      // `engaged` is what a channel seeds, and what these tests otherwise
      // override away from; this is the one scenario about it.
      service.updateMembership(room.id, human, ana, 'engaged');

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await service.triggersIdle();

      // Nobody is named now: these reach Ana only because she is inside her
      // window, and they reach her as ONE turn.
      service.post(room.id, { authorId: human, text: 'the logs are in the ticket' });
      service.post(room.id, { authorId: human, text: 'what do you think?' });
      await service.triggersIdle();

      const ambient = runner.turns.at(-1);
      expect(runner.turns).toHaveLength(2);
      expect(ambient?.prompt).toBe('what do you think?');
      expect(ambient?.roomContext.pending.map((entry) => entry.text)).toEqual([
        'the logs are in the ticket',
      ]);
      expect(ambient?.roomContext.addressing.responseMode).toBe('engaged');
      expect(ambient?.roomContext.addressing.engagedUntil).not.toBeNull();
      // And it knows this particular message did not name it, which is the other
      // half of "am I being spoken to".
      expect(ambient?.roomContext.addressing.addressedNow).toBe(false);
    });

    it('gathers inside a thread without reaching for the rest of the channel', async () => {
      // DOR-1207's scope, unchanged by RP8: a thread turn reads its thread. The
      // gathering is per `(room, agent)`, so a burst inside one thread must not
      // be answered with the channel's own messages in `pending`.
      open(scriptedRunner(), { debounceMs: DEBOUNCE_MS, maxEntries: 20 });
      const root = service.post(room.id, { authorId: human, text: 'the release checklist' });
      await service.triggersIdle();

      service.post(room.id, {
        authorId: human,
        text: '@ana step two looks wrong',
        replyTo: root.id,
      });
      service.post(room.id, {
        authorId: human,
        text: '@ana and step four',
        replyTo: root.id,
      });
      await service.triggersIdle();

      const threadTurn = runner.turns.at(-1);
      expect(threadTurn?.prompt).toBe('@ana and step four');
      expect(threadTurn?.roomContext.thread?.rootEntryId).toBe(root.id);
      expect(threadTurn?.roomContext.pending.map((entry) => entry.text)).toEqual([
        '@ana step two looks wrong',
      ]);
    });
  });

  describe('the guard judges the batch one message at a time', () => {
    it('still answers a parked question when an agent reply joins the batch behind it', async () => {
      // **The defect this exists for.** A person asks Ana something directly
      // while she is mid-turn, so it is parked. Bo then answers the room and
      // names Ana, and that reply joins the same batch. Judged as a batch — one
      // verdict, taken from the newest entry — Bo's reply is vetoed by the
      // ancestry rule and the WHOLE batch went with it: the person's question
      // was discarded, no turn ran for it, and the room said nothing about it.
      //
      // A person's message mints its own cascade root at depth 0, which every
      // rule here allows. That carve-out is the whole point of `deriveCascade`,
      // and aggregating the verdict is exactly how it gets lost.
      const held = heldRunner((request) =>
        request.authorId === ana ? 'looking' : 'no idea — @ana ran that one'
      );
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 }, ['/agents/ana', '/agents/bo']);
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;

      // **The ordering is the whole scenario, so it is spelled out.** Bo's reply
      // is ALLOWED when it is collected — Ana has not spoken in that exchange
      // yet, because her turn is still running — and REFUSED when the batch
      // finally runs, because by then that very turn has posted and the
      // ancestry rule can see it. That gap between the two verdicts is exactly
      // what re-asking the guard exists for, and it is what made a batch-level
      // verdict swallow the person's question.
      service.post(room.id, { authorId: human, text: '@ana @bo what broke the build?' });
      await settleUntil(
        () => held.holdsFor(ana) === 1 && held.holdsFor(bo) === 1,
        'both agents mid-turn'
      );

      // The person asks Ana something else. Parked behind her claim, on its own
      // fresh root at depth 0.
      service.post(room.id, { authorId: human, text: '@ana can you also check the cache?' });

      // Bo answers, naming Ana. Ana has still said nothing in that exchange, so
      // the guard lets this into her batch — on top of the person's question.
      held.release(bo);
      await settleUntil(() => postsBy(bo).length === 1, 'Bo answered, naming Ana');

      // Ana's running turn now posts into that same exchange, and only then does
      // her claim release and the batch run.
      held.release(ana);
      await settleUntil(
        () => runner.turns.filter((turn) => turn.authorId === ana).length === 2,
        'the parked question to become a turn of its own'
      );

      // The person's question ran, on its own fresh root, at depth 0 — not Bo's
      // reply, which is the entry the guard actually refused.
      const steered = runner.turns.filter((turn) => turn.authorId === ana)[1];
      expect(steered.prompt).toBe('@ana can you also check the cache?');
      const asked = log().find((entry) => entry.body.text === '@ana can you also check the cache?');
      expect(asked?.cascadeRoot).toBe(asked?.id);
      expect(asked?.cascadeDepth).toBe(0);

      // Bo's refused reply is not consumed by that turn: it sits above the
      // trigger, so it is still unread and still the next turn's to read.
      expect(steered.roomContext.pending.map((entry) => entry.text)).not.toContain(
        'no idea — @ana ran that one'
      );

      // And the refusal was said out loud, once.
      const refusals = notices().filter((entry) => entry.body.notice === 'cascade_stopped');
      expect(refusals).toHaveLength(1);
      expect(refusals[0].body.subjectAuthorId).toBe(ana);
      held.release(ana);
      await service.triggersIdle();
    });

    it('refuses the whole batch, visibly, only when every message in it is refused', async () => {
      // The other side of the rule. Nothing in this batch is a person's fresh
      // question — both entries are agent replies inside an exchange Ana has
      // already spoken in — so there is nothing left to answer and the batch is
      // refused. That refusal is on the log (I3): a batch is not a way to make a
      // refusal quiet.
      const held = heldRunner((request) =>
        request.authorId === ana ? 'looking' : 'no idea — @ana ran that one'
      );
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 }, ['/agents/ana', '/agents/bo']);
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;

      service.post(room.id, { authorId: human, text: '@ana @bo what broke the build?' });
      await settleUntil(
        () => held.holdsFor(ana) === 1 && held.holdsFor(bo) === 1,
        'both agents mid-turn'
      );

      // Same ordering as the scenario above, with nothing else in the batch:
      // Bo's reply is collected while it is still allowed, and refused when the
      // batch runs because Ana's own turn has posted into that exchange by then.
      held.release(bo);
      await settleUntil(() => postsBy(bo).length === 1, 'Bo answered, naming Ana');
      held.release(ana);
      await service.triggersIdle();

      // No second turn for Ana — and the room said why.
      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(1);
      const refusals = notices().filter((entry) => entry.body.notice === 'cascade_stopped');
      expect(refusals).toHaveLength(1);
      expect(refusals[0].body.subjectAuthorId).toBe(ana);
      expect(refusals[0].body.text).toContain('automatic-reply limit');
    });
  });

  describe('a message that lands mid-turn steers rather than restarting', () => {
    it('does not cancel the running turn, and runs the held message when the claim goes', async () => {
      const held = heldRunner();
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => held.holdsFor(ana) === 1, 'Ana mid-turn');

      service.post(room.id, { authorId: human, text: '@ana and the migration?' });
      // The running turn was never interrupted, and no second turn was started
      // beside it.
      expect(held.interrupted).toEqual([]);
      expect(held.holdsFor(ana)).toBe(1);
      expect(runner.turns).toHaveLength(1);

      held.release(ana);
      await settleUntil(() => runner.turns.length === 2, 'the held message to become a turn');
      expect(runner.turns[1].prompt).toBe('@ana and the migration?');
      // Nothing was said about it: it was never refused, so there is nothing to
      // apologise for.
      expect(notices()).toHaveLength(0);
      held.release(ana);
      await service.triggersIdle();
    });

    it('marks the messages behind it as having arrived while the agent was working', async () => {
      const held = heldRunner();
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => held.holdsFor(ana) === 1, 'Ana mid-turn');

      service.post(room.id, { authorId: human, text: '@ana the logs are in the ticket' });
      service.post(room.id, { authorId: human, text: '@ana what do you think?' });
      held.release(ana);
      await settleUntil(() => runner.turns.length === 2, 'the held messages to become a turn');

      const steered = runner.turns[1];
      expect(steered.prompt).toBe('@ana what do you think?');
      expect(steered.roomContext.pending).toEqual([
        expect.objectContaining({
          text: '@ana the logs are in the ticket',
          arrivedDuringPrevTurn: true,
        }),
      ]);
      held.release(ana);
      await service.triggersIdle();
    });

    it('leaves an ordinary gathered message unmarked, so the signal means something', async () => {
      // The counter-assertion. A flag every line carries is a flag no model
      // reads: only the ones that really did land mid-turn are marked.
      open(scriptedRunner(), { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      service.post(room.id, { authorId: human, text: '@ana the build is red' });
      service.post(room.id, { authorId: human, text: '@ana can you look?' });
      await service.triggersIdle();

      expect(runner.turns[0].roomContext.pending[0].arrivedDuringPrevTurn).toBeUndefined();
    });

    it('never shows an agent a colleague partial text, only that it is working', async () => {
      // I1, and the reason there is no lock here. Ana is mid-turn and has said
      // nothing yet; Bo, addressed by a later message, is told she is working and
      // is told nothing about what she is writing.
      const held = heldRunner();
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 }, ['/agents/ana', '/agents/bo']);
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => held.holdsFor(ana) === 1, 'Ana mid-turn');
      service.post(room.id, { authorId: human, text: '@bo anything from you?' });
      await settleUntil(
        () => runner.turns.some((turn) => turn.authorId === bo),
        'Bo handed a turn of his own'
      );

      const boTurn = runner.turns.find((turn) => turn.authorId === bo);
      expect(boTurn?.roomContext.working.map((claim) => claim.displayName)).toEqual(['Ana']);
      // A name and a start, and no way to reach anything Ana has typed.
      expect(Object.keys(boTurn?.roomContext.working[0] ?? {}).sort()).toEqual([
        'displayName',
        'handle',
        'since',
      ]);
      // Nothing Ana is writing is in the log yet either.
      expect(log().filter((entry) => entry.authorId === ana)).toHaveLength(0);
      held.release(ana);
      held.release(bo);
      await service.triggersIdle();
    });
  });

  describe('halt', () => {
    it('drops the gathered messages as well as the running turns', async () => {
      const held = heldRunner();
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => held.holdsFor(ana) === 1, 'Ana mid-turn');
      // Held behind the claim — no window is counting for it at all — and it
      // would become Ana's next turn if the room were left alone.
      service.post(room.id, { authorId: human, text: '@ana and the migration?' });

      const stopped = await service.haltRoom(room.id, human);
      expect(stopped).toBe(1);
      expect(held.interrupted).toHaveLength(1);

      // The claim is gone, so nothing is holding the gathered message back — and
      // it still does not run, because the halt dropped it. `triggersIdle`
      // resolving at all is half the assertion: a dropped collection that kept
      // its accounting would never let the room settle.
      await service.triggersIdle();
      expect(runner.turns).toHaveLength(1);
      const halted = notices().filter((entry) => entry.body.notice === 'halted');
      expect(halted).toHaveLength(1);
    });

    it('drops the gathered messages BEFORE it releases any claim', async () => {
      // **The ordering, pinned with a runtime that takes its time stopping.**
      // Releasing a claim is what runs a held batch, so a halt that dropped the
      // buffers after the release loop would start those turns one macrotask
      // later — answering, seconds after Stop, exactly the messages the person
      // pressed it over.
      //
      // Two things make that reachable and neither is decoration. TWO agents,
      // so there is a second `await` inside the loop for the first agent's
      // resumed batch to fire during; and an `interrupt` that yields for real
      // rather than resolving on a microtask, because the resume rides a
      // `setTimeout(0)` and a loop that only awaits microtasks completes before
      // any macrotask runs — which would let a broken order pass.
      const held = heldRunner();
      const slow: HeldRunner = {
        ...held,
        async interrupt(request) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          await held.interrupt(request);
        },
      };
      open(slow, { debounceMs: DEBOUNCE_MS, maxEntries: 20 }, ['/agents/ana', '/agents/bo']);
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;

      service.post(room.id, { authorId: human, text: '@ana @bo can you both look?' });
      await settleUntil(
        () => held.holdsFor(ana) === 1 && held.holdsFor(bo) === 1,
        'both agents mid-turn'
      );
      // One held message apiece, so either agent's release could start a turn.
      service.post(room.id, { authorId: human, text: '@ana and the migration?' });
      service.post(room.id, { authorId: human, text: '@bo and the cache?' });

      const stopped = await service.haltRoom(room.id, human);
      expect(stopped).toBe(2);

      // **Asserted the instant the halt returns, before anything is awaited.**
      // A resumed batch fires DURING the halt's own interrupt await, so by the
      // time this line runs a wrong order has already started the turn — and
      // asserting after `triggersIdle()` would meet it as a hang rather than as
      // a countable third turn.
      expect(runner.turns).toHaveLength(2);
      expect(runner.turns.map((turn) => turn.prompt)).toEqual([
        '@ana @bo can you both look?',
        '@ana @bo can you both look?',
      ]);

      // And it stays two: nothing is waiting to start.
      await service.triggersIdle();
      expect(runner.turns).toHaveLength(2);
    });

    it('drops a window that has not closed yet, so nothing answers a stopped room', async () => {
      // A gathering window is work the room is about to do. Leaving it would
      // answer, half a second later, the very messages the person pressed Stop
      // over.
      open(scriptedRunner(), { debounceMs: 60_000, maxEntries: 20 });

      service.post(room.id, { authorId: human, text: '@ana the build is red' });
      const stopped = await service.haltRoom(room.id, human);

      expect(stopped).toBe(0);
      await service.triggersIdle();
      expect(runner.turns).toEqual([]);
    });

    it('runs a normal turn for a message whose text is exactly "stop"', async () => {
      // **This test is the guard on the rule**, not a description of a feature.
      // Halting is a control action — a button and a route — and nothing
      // anywhere pattern-matches a message for it. In the Hermes loop incident
      // of 26 May 2026 an operator typed "you are in a loop, stop" and the bot
      // answered it as one more conversational turn; inferring the verb from
      // text would be that same failure wearing the opposite clothes, because
      // the model would then be the thing deciding whether to obey.
      //
      // `room-stopped-turns.test.ts` pins the same rule from the other side.
      const held = heldRunner();
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => held.holdsFor(ana) === 1, 'Ana mid-turn');
      service.post(room.id, { authorId: human, text: 'stop' });
      service.post(room.id, { authorId: human, text: '@ana stop' });
      held.release(ana);
      await settleUntil(() => runner.turns.length === 2, 'the ordinary next turn');

      // Not interrupted, not halted, and no notice — just another message.
      expect(held.interrupted).toEqual([]);
      expect(notices()).toHaveLength(0);
      expect(runner.turns[1].prompt).toBe('@ana stop');
      held.release(ana);
      await service.triggersIdle();
    });
  });
});
