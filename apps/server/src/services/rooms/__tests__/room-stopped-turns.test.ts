/**
 * A turn that has stopped, and the three ways a room can be honest about it.
 *
 * All three come out of the 2026-07-31 incident (DOR-784), where agents named in
 * a room were silent for between twenty and forty-one minutes and the room said
 * nothing at all:
 *
 * 1. **Waiting on a person.** Each turn had stopped on a tool-approval prompt
 *    that only that agent's own session showed. The room had no way to say so,
 *    and ten minutes later every prompt auto-denied.
 * 2. **Busy in a different room.** One agent is one working directory, and
 *    nothing stopped it running turns for three rooms at once in that one
 *    checkout — the `(room, agent)` claim key cannot see across rooms.
 * 3. **Stopped on purpose.** There was no way to stop a room at all, so the only
 *    remedy anyone had was to type "stop", which agents answer like any other
 *    message.
 *
 * Driven through the real service and the real dispatcher, like the other room
 * suites: only the runner stands in, because the alternative is a model call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { eventFanOut } from '../../core/event-fan-out.js';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import {
  agentLookupFor,
  createRoomHarness,
  gatedRunner,
  settleUntil,
  type GatedRunner,
} from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
  '/agents/cy': { name: 'cy', displayName: 'Cy', responseMode: 'always' },
});

/** Ana's author id inside one wired harness. */
function anaIn(wired: ReturnType<typeof createRoomHarness>): string {
  return wired.authors.resolveAgent('/agents/ana', 'Ana').id;
}

describe('a room says when a turn has stopped', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let runner: GatedRunner;
  let room: RoomWithRoster;
  let human: string;
  let ana: string;
  /** Every `room_presence` count the global fan-out carried, in order. */
  let counts: Array<{ roomId: string; working: number }> = [];
  let unsubscribe = (): void => {};

  /** Every entry in a room, oldest first. */
  function log(roomId = room.id): RoomEntry[] {
    return service.listEntries(roomId, human, { limit: 200 });
  }

  /** Just the notices — the room speaking in its own voice. */
  function notices(roomId = room.id): RoomEntry[] {
    return log(roomId).filter((entry) => entry.kind === 'notice');
  }

  /** Just what the AGENTS said — what a halt has to leave empty. */
  function agentPosts(roomId = room.id): RoomEntry[] {
    return log(roomId).filter((entry) => entry.kind === 'post' && entry.authorId !== human);
  }

  beforeEach(() => {
    // **The answering runtime is this file's default, because it is the one the
    // product has.** A fake that hands back nothing when interrupted models a
    // runtime that obeys, and every halt assertion written against it passes
    // whether or not the room does its own half of the job (DOR-1232).
    runner = gatedRunner({ interruptedTurnStillAnswers: true });
    ({ service, authors, human } = createRoomHarness({ agents, runner }));
    room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    // `mention-only`, so a second message in a scenario cannot re-trigger an
    // agent whose first turn is still held and turn a one-claim test into two.
    service.updateMembership(room.id, human, ana, 'mention-only');
    counts = [];
    unsubscribe = eventFanOut.subscribe((name, data) => {
      if (name === 'room_presence') counts.push(data as { roomId: string; working: number });
    });
  });

  afterEach(() => {
    unsubscribe();
  });

  describe('waiting for a person', () => {
    /** Trigger Ana and wait until her turn is actually being held. */
    async function triggerAna(text = '@ana can you check the build?'): Promise<void> {
      service.post(room.id, { authorId: human, text });
      await settleUntil(() => runner.holdsFor(ana) > 0, 'Ana to be mid-turn');
    }

    it('says so, in the room own voice, while the turn is still running', async () => {
      // The incident itself. Nothing about this state is an OUTCOME — the turn
      // has not ended and will not until a person acts — so a room that could
      // only report outcomes reported nothing for forty-one minutes.
      await triggerAna();
      runner.waitOnPerson(ana, { kind: 'approval', toolName: 'Bash' });

      expect(notices()).toHaveLength(1);
      expect(notices()[0].body.notice).toBe('awaiting_approval');
      expect(notices()[0].body.subjectAuthorId).toBe(ana);
      expect(notices()[0].authorId).toBe(authors.system().id);
      expect(notices()[0].body.text).toBe(
        "Ana is waiting for you to approve something before it can carry on. Open Ana's session to answer — it gives up if nobody does."
      );
      // The tool's name is for the log, never the room: an approval's arguments
      // are file paths and commands, and a shared room is not where they go.
      expect(notices()[0].body.text).not.toContain('Bash');
      // And the agent is still working, so the room still says so.
      expect(service.listRooms(human, {})[0].working).toBe(1);
    });

    it('says it once for one turn, however many times that turn stops', async () => {
      // A turn that asks for three approvals in a row is one wait from the
      // reader's side; three lines about it would be the over-participation
      // every other notice in this domain is damped against.
      await triggerAna();
      runner.waitOnPerson(ana, { kind: 'approval', toolName: 'Bash' });
      runner.waitOnPerson(ana, { kind: 'approval', toolName: 'Write' });
      runner.waitOnPerson(ana, { kind: 'question' });

      expect(notices()).toHaveLength(1);
    });

    it('says it again for the NEXT turn that stops', async () => {
      // The other half, and the half that makes the damping safe: the key is
      // scoped to the turn, so it cannot leave a later wait unmentioned. Two
      // agents in the incident hit two approvals each in separate turns; a
      // memory that outlived the turn would have reported one of them.
      await triggerAna();
      runner.waitOnPerson(ana, { kind: 'approval' });
      runner.release(ana);
      await service.triggersIdle();

      await triggerAna('@ana and the tests?');
      runner.waitOnPerson(ana, { kind: 'approval' });

      expect(notices().filter((entry) => entry.body.notice === 'awaiting_approval')).toHaveLength(
        2
      );
    });
  });

  describe('busy in another room', () => {
    let second: RoomWithRoster;

    beforeEach(() => {
      second = service.createRoom(
        { kind: 'channel', title: 'Frontend', members: [], agentPaths: ['/agents/ana'] },
        human
      );
      service.updateMembership(second.id, human, ana, 'mention-only');
    });

    it('refuses a second turn in the same checkout, and says where it is', async () => {
      // One agent is one working directory. The `(room, agent)` claim key bounds
      // one transcript and cannot see across rooms, so an agent in three rooms
      // ran three turns in one tree — three processes editing the same files.
      service.post(room.id, { authorId: human, text: '@ana check the build' });
      await settleUntil(() => runner.holdsFor(ana) > 0, 'Ana to be mid-turn in the first room');

      service.post(second.id, { authorId: human, text: '@ana and the styles?' });
      await settleUntil(() => notices(second.id).length > 0, 'the second room to say something');

      // No second turn started, whatever the second room asked.
      expect(runner.turns).toHaveLength(1);
      expect(notices(second.id)).toHaveLength(1);
      expect(notices(second.id)[0].body.notice).toBe('agent_busy');
      expect(notices(second.id)[0].body.text).toBe(
        "Ana is working in another conversation right now, so it didn't pick this up. Send it again in a few minutes."
      );
      // Never which conversation: the reader of this room may not be in that one.
      expect(notices(second.id)[0].body.text).not.toContain('Backend');
    });

    it('says nothing for a second message in the room it is working in, and answers it next', async () => {
      // The counter-assertion, and the reason the two questions are asked in
      // this order. "It is busy somewhere you cannot see" is a refusal, because
      // nothing this room does will finish that turn. A message for an agent
      // working HERE is not refused at all since RP8: it is held, and it becomes
      // that agent's next turn the moment the claim goes (room-participation
      // spec §10.4). Saying "it didn't pick this one up" about a message it is
      // about to pick up would be the room lying to be reassuring.
      service.post(room.id, { authorId: human, text: '@ana check the build' });
      await settleUntil(() => runner.holdsFor(ana) > 0, 'Ana to be mid-turn');

      service.post(room.id, { authorId: human, text: '@ana still there?' });
      runner.release(ana);
      await settleUntil(() => runner.turns.length === 2, 'the held question to become a turn');

      expect(runner.turns[1].prompt).toBe('@ana still there?');
      expect(notices()).toHaveLength(0);
      runner.release(ana);
      await service.triggersIdle();
    });

    it('lets the turn run once the other room is finished with it', async () => {
      // The refusal is a refusal, never a queue (ADR 260726-170125) — but it is
      // also not a lockout: the moment the claim goes, the next message runs.
      service.post(room.id, { authorId: human, text: '@ana check the build' });
      await settleUntil(() => runner.holdsFor(ana) > 0, 'Ana to be mid-turn');
      runner.release(ana);
      await service.triggersIdle();

      service.post(second.id, { authorId: human, text: '@ana and the styles?' });
      await settleUntil(() => runner.turns.length === 2, 'the second room to get its turn');
      expect(runner.turns[1].roomId).toBe(second.id);
    });
  });

  describe('stopping a room', () => {
    it('interrupts every turn running in it and says so once', async () => {
      // A third agent, working in a DIFFERENT room, is what makes "in it" an
      // assertion rather than a description: a halt scoped to the process
      // instead of the room would stop that one too, and the count alone would
      // not notice.
      const other = service.createRoom(
        { kind: 'channel', title: 'Frontend', members: [], agentPaths: ['/agents/cy'] },
        human
      );
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;
      const cy = authors.resolveAgent('/agents/cy', 'Cy').id;
      service.addMember(room.id, human, { authorId: bo });
      service.updateMembership(room.id, human, bo, 'mention-only');
      service.updateMembership(other.id, human, cy, 'mention-only');

      service.post(other.id, { authorId: human, text: '@cy have a look' });
      service.post(room.id, { authorId: human, text: '@ana @bo take a look' });
      await settleUntil(() => runner.turns.length === 3, 'all three agents to be mid-turn');

      const stopped = await service.haltRoom(room.id, human);

      expect(stopped).toBe(2);
      expect(runner.interrupted.map((call) => call.agentPath).sort()).toEqual([
        '/agents/ana',
        '/agents/bo',
      ]);
      // **Two agents stopped, two answers thrown away, one line.** The runner
      // here is the answering one, so both interrupted turns came back with
      // their text — the count of notices alone would pass with both of those
      // posted underneath it.
      expect(agentPosts()).toHaveLength(0);
      // One line for the whole room, not one per agent.
      const halted = notices().filter((entry) => entry.body.notice === 'halted');
      expect(halted).toHaveLength(1);
      expect(halted[0].body.text).toBe(
        'Everything here was stopped. 2 agents were working and have been interrupted; send a message to start again.'
      );
      // The indicators go with the claims, and only this room's claims went.
      const rooms = service.listRooms(human, {});
      expect(rooms.find((r) => r.id === room.id)?.working).toBe(0);
      expect(rooms.find((r) => r.id === other.id)?.working).toBe(1);
      // The fan-out agrees with the map. This does NOT prove the release went
      // through the seam — with a runtime that stops promptly, `runOne`'s own
      // `finally` releases the claim a moment later and publishes the same
      // zero, so a halt that deleted from the map would still end up here. The
      // test that proves it is the stubborn-runtime one below, where no turn
      // ever settles and the halt's release is the only one there is.
      expect(counts.filter((count) => count.roomId === room.id).at(-1)).toEqual({
        roomId: room.id,
        working: 0,
      });
      expect(notices(other.id)).toHaveLength(0);
      runner.release(cy);
      await service.triggersIdle();
    });

    it('drops the indicator even when the runtime does not come back', async () => {
      // **Why the halt releases its own claims instead of leaving it to the
      // turns.** Ordinarily an interrupt ends the turn and `runOne` releases in
      // its `finally`, so both paths agree and neither is load-bearing. A
      // runtime that hangs is where they part: nothing ever settles that turn,
      // so nothing ever releases its claim, and the room would show an agent
      // working — republished every ten seconds, forever — for work that was
      // stopped minutes ago.
      //
      // It also has to go through `releaseClaim`, not the map. `done` is
      // published there and nowhere else, so a halt that deleted the entry
      // would leave the map right and every watching client wrong.
      const stubborn = gatedRunner({ interruptEndsTurn: false });
      const wired = createRoomHarness({ agents, runner: stubborn });
      const stuckRoom = wired.service.createRoom(
        { kind: 'channel', title: 'Stuck', members: [], agentPaths: ['/agents/ana'] },
        wired.human
      );
      const seen: Array<{ roomId: string; working: number }> = [];
      // Whether the room's own explanation was already on the log at the instant
      // the indicator dropped. Sampled inside the subscriber because the
      // ordering is what is being measured, and it is unobservable afterwards —
      // both facts are true once the dust settles, whichever order they landed
      // in.
      let noticeWasAlreadyThere: boolean | null = null;
      const stop = eventFanOut.subscribe((name, data) => {
        if (name !== 'room_presence') return;
        const count = data as { roomId: string; working: number };
        seen.push(count);
        if (
          count.roomId === stuckRoom.id &&
          count.working === 0 &&
          noticeWasAlreadyThere === null
        ) {
          noticeWasAlreadyThere = wired.service
            .listEntries(stuckRoom.id, wired.human, { limit: 50 })
            .some((entry) => entry.body.notice === 'halted');
        }
      });
      try {
        wired.service.post(stuckRoom.id, { authorId: wired.human, text: '@ana go' });
        await settleUntil(() => stubborn.holdsFor(anaIn(wired)) > 0, 'Ana to be mid-turn');

        await wired.service.haltRoom(stuckRoom.id, wired.human);

        expect(stubborn.interrupted).toHaveLength(1);
        expect(wired.service.listRooms(wired.human, {})[0].working).toBe(0);
        expect(seen.filter((count) => count.roomId === stuckRoom.id).at(-1)).toEqual({
          roomId: stuckRoom.id,
          working: 0,
        });
        // **And the notice came FIRST.** Releasing a claim publishes `done`, so
        // a halt that stopped the turns before saying so would drop every
        // working indicator in the room a beat ahead of the line explaining
        // why — a room going silent for no visible reason, which is the exact
        // shape the durable-sibling invariant exists to prevent
        // (`.claude/rules/room-conduct.md`). Nothing else pins the ORDER: move
        // the write below the release loop and every other assertion in this
        // file stays green.
        expect(noticeWasAlreadyThere).toBe(true);
      } finally {
        stop();
        stubborn.release(anaIn(wired));
        await wired.service.triggersIdle();
      }
    });

    /**
     * Wire a room of its own, get one agent mid-turn in it, and hand back the
     * handles these scenarios read.
     *
     * A fresh harness per scenario, rather than the suite's, because each one
     * needs its OWN runner: what a turn does when it is interrupted is the
     * variable under test, and it is fixed when the runner is built.
     *
     * @param runner - The runtime this room runs on.
     * @param opts.perRoomBudget - The room's hourly ceiling, when the scenario
     *   is about spending; the harness default otherwise.
     */
    async function roomMidTurn(
      runner: GatedRunner,
      opts: { perRoomBudget?: number } = {}
    ): Promise<{
      wired: ReturnType<typeof createRoomHarness>;
      roomId: string;
      agent: string;
      entries: () => RoomEntry[];
      /** Everything the AGENT posted — the thing a halt must leave empty. */
      answers: () => RoomEntry[];
      /** Ask the agent something and wait until it is really mid-turn. */
      ask: (text: string) => Promise<void>;
    }> {
      const wired = createRoomHarness({
        agents,
        runner,
        ...(opts.perRoomBudget !== undefined && {
          maxAutomaticTurnsPerRoomPerHour: opts.perRoomBudget,
        }),
      });
      const made = wired.service.createRoom(
        { kind: 'channel', title: 'Stop', members: [], agentPaths: ['/agents/ana'] },
        wired.human
      );
      const agent = anaIn(wired);
      const entries = (): RoomEntry[] =>
        wired.service.listEntries(made.id, wired.human, { limit: 200 });
      const ask = async (text: string): Promise<void> => {
        wired.service.post(made.id, { authorId: wired.human, text });
        await settleUntil(() => runner.holdsFor(agent) > 0, `Ana to be mid-turn for "${text}"`);
      };
      await ask('@ana write me a slow, careful poem about lakes');
      return {
        wired,
        roomId: made.id,
        agent,
        entries,
        answers: () => entries().filter((e) => e.kind === 'post' && e.authorId === agent),
        ask,
      };
    }

    it('throws away the answer of a turn that kept talking after it was stopped', async () => {
      // **The bug, exactly as it was measured** (DOR-1232, the live rooms
      // self-test of 2026-08-15): the room wrote its one `halted` notice and the
      // stopped turn's complete, well-formed answer landed two seconds later. An
      // interrupt is delivered, not obeyed — so the room cannot rely on the
      // runtime to make Stop mean anything, and has to decline the answer
      // itself. The runtime here is the stubborn one, whose turn is still
      // running when the halt returns and then closes normally, which is the
      // shape that used to post.
      const stubborn = gatedRunner({ interruptEndsTurn: false });
      const room = await roomMidTurn(stubborn);

      expect(await room.wired.service.haltRoom(room.roomId, room.wired.human)).toBe(1);
      expect(stubborn.interrupted).toHaveLength(1);
      // The turn the halt did not manage to stop, finishing the ordinary way.
      stubborn.release(room.agent);
      await room.wired.service.triggersIdle();

      expect(room.answers()).toHaveLength(0);
      // And the room said nothing ELSE either. A `turn_failed` line under the
      // halt would be the room apologising for doing what it was told.
      const notices = room.entries().filter((entry) => entry.kind === 'notice');
      expect(notices).toHaveLength(1);
      expect(notices[0].body.notice).toBe('halted');
      // The claim went with the halt and stayed gone.
      expect(room.wired.service.listRooms(room.wired.human, {})[0].working).toBe(0);
    });

    it('throws it away when the answer lands in the same instant as the halt', async () => {
      // The tightest version of the same race: the interrupt IS what closes the
      // stream, and the stream still carries the answer the model had finished
      // producing. Nothing about the ordering of the halt's own steps can help
      // here — the mark has to be set before the halt does anything that could
      // let a turn settle, which is why this scenario is separate from the one
      // above rather than a second assertion in it.
      const racing = gatedRunner({ interruptedTurnStillAnswers: true });
      const room = await roomMidTurn(racing);

      expect(await room.wired.service.haltRoom(room.roomId, room.wired.human)).toBe(1);
      await room.wired.service.triggersIdle();

      expect(room.answers()).toHaveLength(0);
      expect(room.entries().filter((entry) => entry.body.notice === 'halted')).toHaveLength(1);
      expect(room.wired.service.listRooms(room.wired.human, {})[0].working).toBe(0);
    });

    it('throws away an answer the room was already waiting LATE for', async () => {
      // **The other delivery path, and it had no halt coverage at all.** A turn
      // that outruns `rooms.replyWaitMinutes` stops being delivered by the frame
      // that started it: the room keeps the claim, flips it to `working_late`,
      // and hands the answer to `deliverLate` whenever it lands — which for the
      // shipped ceiling can be an hour later. Stop pressed anywhere in that hour
      // has to reach it, and the mark is the only thing that can, because
      // `runOne` returned long ago.
      const late = gatedRunner({ answersLate: true, interruptEndsTurn: false });
      const room = await roomMidTurn(late);

      // The room is showing this agent as working LATE — the state the late
      // delivery path is defined by, and the one the halt has to survive.
      expect(room.wired.service.listRooms(room.wired.human, {})[0].working).toBe(1);
      expect(await room.wired.service.haltRoom(room.roomId, room.wired.human)).toBe(1);
      // Long afterwards, the runtime finally comes back with the whole answer.
      late.release(room.agent);
      await room.wired.service.triggersIdle();

      expect(room.answers()).toHaveLength(0);
      expect(room.entries().filter((entry) => entry.kind === 'notice')).toHaveLength(1);
      expect(room.entries().filter((entry) => entry.body.notice === 'halted')).toHaveLength(1);
      expect(room.wired.service.listRooms(room.wired.human, {})[0].working).toBe(0);
    });

    it('does not let a stopped turn release the claim of the turn that replaced it', async () => {
      // **A claim key is `(room, agent)`; a turn is a DISPATCH — and a halt is
      // the one thing that pulls them apart.** Stop drops the claim, the person
      // types again, the next turn claims the same key, and then the stopped
      // turn's runtime finally returns and its `finally` releases whatever it
      // finds there. Unguarded, that is somebody else's live turn: the room
      // shows nobody working while an agent is mid-answer, the one-turn-per-
      // `(room, agent)` ceiling is gone, and the message after that starts a
      // SECOND concurrent turn in the same working tree — the contention DOR-500
      // measured. Reproduced on `main` before this guard existed.
      const stubborn = gatedRunner({ interruptEndsTurn: false });
      const room = await roomMidTurn(stubborn);
      await room.wired.service.haltRoom(room.roomId, room.wired.human);

      // The follow-up, which claims the same key while the stopped turn is still
      // out there. Waited for by TURN COUNT rather than by "somebody is mid-turn"
      // — the stopped turn is still being held, so the latter is already true and
      // would wait for nothing.
      room.wired.service.post(room.roomId, {
        authorId: room.wired.human,
        text: '@ana never mind — just the summary, please',
      });
      await settleUntil(() => stubborn.turns.length === 2, 'the follow-up to become a turn');
      expect(stubborn.holdsFor(room.agent)).toBe(2);

      // NOW the stopped turn comes back. `release` lands the OLDEST held turn,
      // which is the halted one.
      stubborn.release(room.agent);
      await settleUntil(
        () => stubborn.holdsFor(room.agent) === 1,
        'the stopped turn to finish and leave the live one holding'
      );

      // The live turn still holds its claim, and the room still says so.
      expect(room.wired.service.listRooms(room.wired.human, {})[0].working).toBe(1);
      // And it is still the only turn. A third message is HELD behind it (RP8
      // parks a message for an agent working here) rather than starting a second
      // one beside it — which is the ceiling itself, observable: with the claim
      // stolen, this message would find the agent idle and run concurrently.
      room.wired.service.post(room.roomId, {
        authorId: room.wired.human,
        text: '@ana one more thing',
      });
      await settleUntil(
        () => room.entries().some((entry) => entry.body.text === '@ana one more thing'),
        'the third message to land'
      );
      expect(stubborn.turns).toHaveLength(2);
      expect(stubborn.holdsFor(room.agent)).toBe(1);

      // The live turn's own terminal releases normally — it answers, and the
      // parked message becomes its own turn rather than being lost.
      stubborn.release(room.agent);
      await settleUntil(
        () => stubborn.turns.length === 3,
        'the parked message to run once the claim was free'
      );
      expect(room.answers()).toHaveLength(1);
      stubborn.release(room.agent);
      await room.wired.service.triggersIdle();
      expect(room.wired.service.listRooms(room.wired.human, {})[0].working).toBe(0);
      expect(room.answers()).toHaveLength(2);
    });

    it('drops every claim even when the database refuses to say where the work runs', async () => {
      // **A recovery path that can itself fail.** The session lookup is a
      // database read inside the release loop; a `SQLITE_BUSY` escaping there
      // would abandon the loop with every remaining claim marked and none of
      // them released — a room showing agents working for the life of the
      // process, each refused every message after by the `(room, agent)`
      // ceiling. Two agents, so "abandons the loop" is distinguishable from
      // "fails on the one".
      const stubborn = gatedRunner({ interruptEndsTurn: false });
      const wired = createRoomHarness({ agents, runner: stubborn });
      const stuck = wired.service.createRoom(
        {
          kind: 'channel',
          title: 'Locked',
          members: [],
          agentPaths: ['/agents/ana', '/agents/bo'],
        },
        wired.human
      );
      const anaId = anaIn(wired);
      const boId = wired.authors.resolveAgent('/agents/bo', 'Bo').id;
      for (const authorId of [anaId, boId]) {
        wired.service.updateMembership(stuck.id, wired.human, authorId, 'mention-only');
      }
      wired.service.post(stuck.id, { authorId: wired.human, text: '@ana @bo go' });
      await settleUntil(() => stubborn.turns.length === 2, 'both agents to be mid-turn');
      vi.spyOn(wired.store, 'getRoomSession').mockImplementation(() => {
        throw new Error('SQLITE_BUSY: database is locked');
      });

      try {
        // It answers rather than throwing at the person who pressed Stop, and
        // the count is the claims it dropped.
        expect(await wired.service.haltRoom(stuck.id, wired.human)).toBe(2);
        expect(wired.service.listRooms(wired.human, {})[0].working).toBe(0);
        // Nothing was interrupted, because nothing could say where to send it —
        // and both claims went anyway, which is the whole point.
        expect(stubborn.interrupted).toHaveLength(0);
      } finally {
        vi.restoreAllMocks();
        stubborn.release(anaId);
        stubborn.release(boId);
        await wired.service.triggersIdle();
      }
    });

    it('leaves the room able to answer the very next message', async () => {
      // Stop stops this turn, not the conversation. The claim is released, the
      // gathered messages are dropped, and the next thing somebody says runs a
      // normal turn that posts a normal answer — which is also the only
      // end-to-end proof that discarding the halted answer did not wedge
      // anything the next turn needs.
      const racing = gatedRunner({ interruptedTurnStillAnswers: true });
      const room = await roomMidTurn(racing);
      await room.wired.service.haltRoom(room.roomId, room.wired.human);
      await room.wired.service.triggersIdle();

      await room.ask('@ana never mind — what is 2 + 2?');
      racing.release(room.agent);
      await room.wired.service.triggersIdle();

      expect(racing.turns).toHaveLength(2);
      expect(room.answers()).toHaveLength(1);
      expect(room.answers()[0].body.text).toBe('on it');
    });

    it('charges a halted turn exactly once — no refund, and no second charge', async () => {
      // A turn that ran a model and was then stopped has SPENT: the work
      // happened, and `tryReserve` has no counterpart by design. Two mistakes
      // would make this red, which is what makes it worth asserting: refunding
      // the halted turn would let the third message run, and charging its
      // discarded answer a second time would refuse the second.
      const racing = gatedRunner({ interruptedTurnStillAnswers: true });
      const room = await roomMidTurn(racing, { perRoomBudget: 2 });

      await room.wired.service.haltRoom(room.roomId, room.wired.human);
      await room.wired.service.triggersIdle();

      // The second of two, so it must still be affordable.
      await room.ask('@ana try again, please');
      racing.release(room.agent);
      await room.wired.service.triggersIdle();
      expect(racing.turns).toHaveLength(2);

      // The third is not, so the room says so rather than running it.
      room.wired.service.post(room.roomId, {
        authorId: room.wired.human,
        text: '@ana and once more',
      });
      await settleUntil(
        () => room.entries().some((entry) => entry.body.notice === 'budget_reached'),
        'the room to say it is out of automatic turns'
      );
      expect(racing.turns).toHaveLength(2);
    });

    it('does not repeat itself when a quiet room is stopped twice', async () => {
      // Pressing Stop again in a room where nothing has happened since is the
      // same question asked twice, and answering it twice would put the thing
      // that reports over-participation into it.
      await service.haltRoom(room.id, human);
      await service.haltRoom(room.id, human);

      expect(notices().filter((entry) => entry.body.notice === 'halted')).toHaveLength(1);
    });

    it('says so again once something has actually happened since', async () => {
      // Recovery IS the re-arm, exactly as it is for the budget: a claim being
      // taken is precisely something happening, so the next halt is news.
      await service.haltRoom(room.id, human);
      service.post(room.id, { authorId: human, text: '@ana try again' });
      await settleUntil(() => runner.holdsFor(ana) > 0, 'Ana to take a turn');

      await service.haltRoom(room.id, human);

      expect(notices().filter((entry) => entry.body.notice === 'halted')).toHaveLength(2);
    });

    it('says so even when nothing was running', async () => {
      // Pressing stop in a quiet room is a question, and silence is not an
      // answer to it.
      expect(await service.haltRoom(room.id, human)).toBe(0);
      expect(notices()).toHaveLength(1);
      expect(notices()[0].body.text).toBe(
        'Everything here was stopped. Nothing was running at the time.'
      );
    });

    it('runs a normal turn for a message whose text is "stop"', async () => {
      // **The guard on the rule, and the rule is the whole design.** In the
      // Hermes loop incident an operator typed "you are in a loop, stop" and the
      // bot answered it like any other turn. The fix is not to teach the model
      // to notice the word — it is to make stopping a control action that never
      // touches the model. So this test exists to fail loudly if anybody ever
      // makes the room read message text for it (room-participation spec §10.4).
      service.post(room.id, { authorId: human, text: '@ana stop' });
      await settleUntil(() => runner.holdsFor(ana) > 0, 'Ana to take the turn anyway');

      expect(runner.turns).toHaveLength(1);
      expect(runner.turns[0].prompt).toBe('@ana stop');
      expect(runner.interrupted).toHaveLength(0);
      expect(notices()).toHaveLength(0);
      runner.release(ana);
      await service.triggersIdle();
    });

    it('refuses an agent that tries to stop its room-mates', async () => {
      // An agent electing itself referee over the room is the arbitration this
      // domain has declined twice.
      await expect(service.haltRoom(room.id, ana)).rejects.toMatchObject({ code: 'PEOPLE_ONLY' });
      expect(notices()).toHaveLength(0);
    });

    it('refuses a room it cannot resolve, in the same shape everything else does', async () => {
      // A room that does not exist and a room the caller may not see are
      // deliberately indistinguishable, here as everywhere else in this domain.
      await expect(service.haltRoom('no-such-room', human)).rejects.toMatchObject({
        code: 'ROOM_NOT_FOUND',
      });
    });
  });
});
