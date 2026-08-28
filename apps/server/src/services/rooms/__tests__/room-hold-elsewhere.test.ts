/**
 * A room never asks you to resend.
 *
 * One agent is one working directory, so a message addressed to an agent that is
 * already mid-turn somewhere else cannot start a second turn — the `agentPath`
 * ceiling has bounded that since DOR-500. What it used to do instead was drop the
 * message with a durable line: _"is working in another conversation right now, so
 * it didn't pick this up. Send it again in a few minutes."_ Three things were
 * wrong with that, in increasing order of seriousness: it asked a person to do
 * work the machine could do, over a message the room had already committed to its
 * log; the remedy it named was unfollowable, because a room shows no "free" state
 * for another room's agent; and it was the same mistake the session path had
 * already corrected (ADR 260811-184735, where a busy session's `409` became a
 * queue).
 *
 * So the ceiling stands and the outcome changed: the message is **held**, the
 * blocking claim's release runs a turn for it **in the room that asked**, and
 * while it waits the room says so on its live lane rather than on its log.
 *
 * Two invariants run through every case below and are worth naming once:
 *
 * - **The release seam, not the outcome, is what resumes a hold.** Every terminal
 *   a turn can reach goes through one `releaseClaim`, so a blocking turn that
 *   answers, says nothing, fails or is stopped all run the waiting message.
 * - **Nothing durable is written when a hold opens.** The promise lives on the
 *   ephemeral lane, which dies with the process that could keep it — so a restart
 *   cannot break a promise the room made. The one durable line left is the room
 *   giving UP on a wait, and it is past tense.
 *
 * Driven through the real service and the real dispatcher, like every other room
 * suite; only the runner stands in, because the alternative is a model call.
 *
 * Spec: `specs/room-hold-when-busy/02-specification.md`.
 */
import { describe, it, expect } from 'vitest';
import type { RoomEntry, RoomEvent, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import type { RoomTurnRequest, RoomTurnResult } from '../room-trigger.js';
import {
  agentLookupFor,
  createRoomHarness,
  settleUntil,
  type RecordedTurn,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
});

/** A runner whose turns finish only when the test says so. */
interface GatedRunner extends ScriptedTurnRunner {
  /** How many turns are being held for one agent right now. */
  holdsFor(authorId: string): number;
  /** Let one agent's oldest held turn answer. */
  release(authorId: string, text?: string | null): void;
  /** End one agent's oldest held turn in an error instead. */
  failOldest(authorId: string): void;
  /**
   * End one agent's oldest held turn as `busy` — the session-lock path, where a
   * stranger held the agent's session and no model ever ran.
   */
  failOldestAsBusy(authorId: string): void;
}

/**
 * Build a runner that holds every turn open until released.
 *
 * Holding is what makes a hold observable at all: a turn that answered would
 * take and release its claim inside one `await`, and the whole state under test
 * — another room's message waiting behind it — would never exist for long enough
 * to look at.
 */
function gatedRunner(): GatedRunner {
  const turns: RecordedTurn[] = [];
  const interrupted: ScriptedTurnRunner['interrupted'] = [];
  const held = new Map<string, Array<(result: RoomTurnResult | Error) => void>>();
  let minted = 0;
  /** The oldest held turn for one agent, or a failure naming what was wanted. */
  const oldest = (authorId: string, verb: string): ((r: RoomTurnResult | Error) => void) => {
    const queued = held.get(authorId);
    const turn = queued?.shift();
    if (!turn) throw new Error(`no turn is being held for ${authorId}, so it cannot ${verb}`);
    return turn;
  };
  return {
    turns,
    interrupted,
    interrupt(request): Promise<boolean> {
      interrupted.push(request);
      // A real interrupt ENDS the turn: the runtime stops and the stream closes.
      // A fake that only recorded the call would leave the dispatcher awaiting a
      // turn nothing can finish, which is not what a halt does.
      let stoppedSomething = false;
      for (const [authorId, queued] of held) {
        for (const settle of queued.splice(0)) settle({ sessionId: 'session-halted', text: null });
        held.delete(authorId);
        stoppedSomething = true;
      }
      return Promise.resolve(stoppedSomething);
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
      const sessionId = request.sessionId ?? `session-${(minted += 1)}`;
      return new Promise<RoomTurnResult>((resolve, reject) => {
        const queued = held.get(request.authorId) ?? [];
        queued.push((result) => {
          if (result instanceof Error) reject(result);
          else resolve({ ...result, sessionId });
        });
        held.set(request.authorId, queued);
      });
    },
    holdsFor(authorId): number {
      return held.get(authorId)?.length ?? 0;
    },
    release(authorId, text = 'on it'): void {
      oldest(authorId, 'answer')({ sessionId: '', text });
    },
    failOldest(authorId): void {
      oldest(authorId, 'fail')(new Error('the session stream went away'));
    },
    failOldestAsBusy(authorId): void {
      oldest(
        authorId,
        'report a busy session'
      )({
        sessionId: '',
        text: null,
        unanswered: 'busy',
      });
    },
  };
}

describe('a message for an agent working elsewhere', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let human: string;
  let ana: string;
  let runner: GatedRunner;
  /** Every event published anywhere, so a test can read another room's stream. */
  let published: Array<{ roomId: string; event: RoomEvent }>;

  /** Open a fresh install with `count` channels, all of them Ana's. */
  function open(count = 2, opts: { holdCeilingMs?: number } = {}): RoomWithRoster[] {
    runner = gatedRunner();
    const harness = createRoomHarness({
      agents,
      runner,
      ...(opts.holdCeilingMs === undefined ? {} : { holdCeilingMs: opts.holdCeilingMs }),
    });
    ({ service, authors, human } = harness);
    published = [];
    const broadcaster = service.stream;
    const deliver = broadcaster.publish.bind(broadcaster);
    broadcaster.publish = (roomId, event) => {
      published.push({ roomId, event });
      deliver(roomId, event);
    };
    const rooms: RoomWithRoster[] = [];
    for (let index = 0; index < count; index += 1) {
      const room = service.createRoom(
        {
          kind: 'channel',
          title: `Room ${index + 1}`,
          members: [],
          agentPaths: ['/agents/ana'],
        },
        human
      );
      // `mention-only` everywhere, so who runs is a property of the message
      // rather than of an engagement window nobody in the test set up.
      rooms.push(room);
    }
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    for (const room of rooms) service.updateMembership(room.id, human, ana, 'mention-only');
    return rooms;
  }

  /** Every entry in one room, oldest first. */
  function log(roomId: string): RoomEntry[] {
    return service.listEntries(roomId, human, { limit: 200 });
  }

  /** Just the notices — the room speaking in its own voice. */
  function notices(roomId: string): RoomEntry[] {
    return log(roomId).filter((entry) => entry.kind === 'notice');
  }

  /** Posts by one author in one room. */
  function postsBy(roomId: string, authorId: string): RoomEntry[] {
    return log(roomId).filter((entry) => entry.kind === 'post' && entry.authorId === authorId);
  }

  /** Every presence signal one room published about one agent, in order. */
  function signalsIn(roomId: string, authorId: string) {
    return published
      .filter((sent) => sent.roomId === roomId)
      .map((sent) => sent.event)
      .filter((event) => event.type === 'signal' && event.authorId === authorId)
      .map((event) => (event.type === 'signal' ? event : null))
      .filter((event) => event !== null);
  }

  /** Let several macrotasks pass, so a notice that WAS coming would have landed. */
  async function quiet(): Promise<void> {
    for (let tick = 0; tick < 6; tick += 1) await new Promise((r) => setTimeout(r, 0));
  }

  it('opens a collection and writes no notice', async () => {
    // Case 1. Red before this change: `collectOne` refused here and wrote
    // `agent_busy` with the line that asked for a resend.
    const [a, b] = open();
    service.post(a.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room A');

    service.post(b.id, { authorId: human, text: '@ana and the styles?' });
    await quiet();

    expect(notices(b.id)).toEqual([]);
    expect(runner.turns).toHaveLength(1);
    runner.release(ana);
    await settleUntil(() => runner.holdsFor(ana) === 1, 'the waiting message to become a turn');
    runner.release(ana);
    await service.triggersIdle();
  });

  it('runs the waiting message in the room that asked, and answers there', async () => {
    // Case 2. The whole promise, and the half that a scheduler would get wrong:
    // the turn belongs to the room that asked, not to the room that was busy.
    const [a, b] = open();
    service.post(a.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room A');
    service.post(b.id, { authorId: human, text: '@ana and the styles?' });
    await quiet();

    runner.release(ana, 'build is green');
    await settleUntil(() => runner.holdsFor(ana) === 1, 'the waiting message to become a turn');
    runner.release(ana, 'styles are fine');
    await settleUntil(() => postsBy(b.id, ana).length === 1, "Ana's answer to land in room B");

    expect(runner.turns[1]!.roomId).toBe(b.id);
    expect(runner.turns[1]!.prompt).toBe('@ana and the styles?');
    expect(postsBy(a.id, ana)).toHaveLength(1);
    await service.triggersIdle();
  });

  it('still runs it when the blocking turn ends in an error', async () => {
    // Case 3. The release seam, not the outcome. An agent whose turn fell over in
    // one room still owes an answer in another, and the room that asked must not
    // be punished for a failure it cannot see.
    const [a, b] = open();
    service.post(a.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room A');
    service.post(b.id, { authorId: human, text: '@ana and the styles?' });
    await quiet();

    runner.failOldest(ana);
    await settleUntil(() => runner.turns.length === 2, 'the waiting message to become a turn');

    expect(runner.turns[1]!.roomId).toBe(b.id);
    // The failure is reported where it happened, and only there.
    expect(notices(a.id).map((entry) => entry.body.notice)).toEqual(['turn_failed']);
    expect(notices(b.id)).toEqual([]);
    runner.release(ana);
    await service.triggersIdle();
  });

  it('runs two waiting rooms one at a time, oldest first', async () => {
    // Case 4. FIFO per agent, across rooms. The second room re-parks against the
    // claim the first just took rather than starting beside it — which is the
    // ceiling still doing its job, and is what makes this ordering rather than
    // scheduling.
    const [a, b, c] = open(3);
    service.post(a.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room A');
    service.post(b.id, { authorId: human, text: '@ana and the styles?' });
    await quiet();
    service.post(c!.id, { authorId: human, text: '@ana and the docs?' });
    await quiet();

    runner.release(ana);
    await settleUntil(() => runner.turns.length === 2, 'the older waiting room to run');
    expect(runner.turns[1]!.roomId).toBe(b.id);
    // One at a time: C is still waiting, not running beside B.
    expect(runner.holdsFor(ana)).toBe(1);

    runner.release(ana);
    await settleUntil(() => runner.turns.length === 3, 'the newer waiting room to run next');
    expect(runner.turns[2]!.roomId).toBe(c!.id);
    runner.release(ana);
    await service.triggersIdle();
    expect(notices(b.id)).toEqual([]);
    expect(notices(c!.id)).toEqual([]);
  });

  it('lets a person ask to be answered first, without passing anybody over for good', async () => {
    // Case 5. Promotion REORDERS: the blocking turn is untouched, the promoted
    // room goes first, and the room that was passed over is next rather than
    // last forever.
    const [a, b, c] = open(3);
    service.post(a.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room A');
    service.post(b.id, { authorId: human, text: '@ana and the styles?' });
    await quiet();
    service.post(c!.id, { authorId: human, text: '@ana and the docs?' });
    await quiet();

    expect(service.promoteHold(c!.id, ana, human)).toBe(true);
    // Nothing was interrupted to do it.
    expect(runner.interrupted).toEqual([]);
    expect(runner.turns).toHaveLength(1);

    runner.release(ana);
    await settleUntil(() => runner.turns.length === 2, 'the promoted room to run first');
    expect(runner.turns[1]!.roomId).toBe(c!.id);

    runner.release(ana);
    await settleUntil(() => runner.turns.length === 3, 'the passed-over room to run next');
    expect(runner.turns[2]!.roomId).toBe(b.id);
    runner.release(ana);
    await service.triggersIdle();
  });

  it('answers false when there is nothing waiting to promote', () => {
    // The stale-button case, which is a normal answer and not an error: the wait
    // ended between the control being drawn and being pressed.
    const [, b] = open();
    expect(service.promoteHold(b.id, ana, human)).toBe(false);
  });

  it('gives up after the late ceiling, and says so once, in the past tense', async () => {
    // Case 6. The bound exists to stop a chain — A blocks B, B blocks C — running
    // without end, and a lane that promised an answer for an hour has stopped
    // being a promise. `rooms.lateReplyCeilingMinutes` is reused rather than a new
    // setting invented: it already means "when the room stops listening".
    const [a, b] = open(2, { holdCeilingMs: 0 });
    service.post(a.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room A');
    service.post(b.id, { authorId: human, text: '@ana and the styles?' });
    await quiet();
    expect(notices(b.id)).toEqual([]);

    // The republish tick is what ages holds out; drive it rather than sleeping
    // ten seconds. It is private, so this reaches it the way the timer does.
    (service as unknown as { triggers: { republishPresence(): void } }).triggers[
      'republishPresence'
    ]();
    await quiet();

    const said = notices(b.id);
    expect(said).toHaveLength(1);
    expect(said[0]!.body.notice).toBe('agent_busy');
    expect(said[0]!.body.text).toBe(
      "Ana has been working in another conversation for a long time, so it hasn't got to your message yet. It will read it the next time it picks up work here."
    );
    // Past tense, and never a resend. The message is still behind Ana's cursor,
    // so the next turn here reads it whatever triggers that turn.
    expect(said[0]!.body.text).not.toContain('again');
    // And the indicator goes with it: a promise the room has given up on must
    // not be left standing on the lane.
    expect(signalsIn(b.id, ana).at(-1)?.state).toBe('done');
    runner.release(ana);
    await service.triggersIdle();
  });

  it('says it gave up even when the room already said the session was busy', async () => {
    // **The undirected path, which is the one that can go silent.** A refusal is
    // damped per `(room, agent, reason)` unless the message ASKED the agent by
    // name — and `busy` used to be one key covering two unrelated states: a
    // stranger holding the agent's own session, and this room giving up on a
    // wait. So for an `engaged` seat with no `@mention`, an earlier session-lock
    // line swallowed the expiry line, and the lane promised an answer and then
    // just cleared. That is an invisible refusal, which room-conduct forbids.
    //
    // **Seeded defect: key the damper on `reason` alone.** The second assertion
    // below goes red — one notice, the wrong one, and nothing saying the room
    // stopped waiting.
    const [a, b] = open(2, { holdCeilingMs: 0 });
    // Engaged, so a message that names nobody still reaches Ana — which is what
    // makes `asked` false and the damper live.
    service.updateMembership(b.id, human, ana, 'engaged');
    service.post(b.id, { authorId: human, text: '@ana are you about?' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room B');
    // That turn fails with the session held by somebody else, which writes the
    // `unknown` busy line and arms its key.
    runner.failOldestAsBusy(ana);
    await settleUntil(() => notices(b.id).length === 1, 'the session-busy line');
    expect(notices(b.id)[0]!.body.text).toContain('was busy in its own session');

    // Now Ana takes a turn somewhere else, and an UNDIRECTED message here waits
    // behind it until the room gives up.
    service.post(a.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room A');
    service.post(b.id, { authorId: human, text: 'anything on the styles?' });
    await quiet();
    (service as unknown as { triggers: { republishPresence(): void } }).triggers[
      'republishPresence'
    ]();
    await quiet();

    const said = notices(b.id);
    expect(said, 'the room gave up on a wait and said nothing about it').toHaveLength(2);
    expect(said[1]!.body.text).toContain(
      'has been working in another conversation for a long time'
    );
    runner.release(ana);
    await service.triggersIdle();
  });

  it('drops the wait when this room is halted, and runs it when the blocking room is', async () => {
    // Case 7. Both fall out of the existing ordering, and the second is the one
    // worth stating: the person stopped one conversation, not the other, and the
    // other one's question still deserves an answer.
    const [a, b] = open();
    service.post(a.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room A');
    service.post(b.id, { authorId: human, text: '@ana and the styles?' });
    await quiet();
    expect(signalsIn(b.id, ana).at(-1)?.state).toBe('held');

    await service.haltRoom(b.id, human);
    // The waiting message is dropped, its indicator released, and the room's own
    // `halted` line is the durable sibling.
    expect(signalsIn(b.id, ana).at(-1)?.state).toBe('done');
    expect(notices(b.id).map((entry) => entry.body.notice)).toEqual(['halted']);
    // Room A's turn is still running and is untouched by room B's Stop; letting
    // it finish is what proves the drop was permanent rather than deferred.
    runner.release(ana);
    await service.triggersIdle();
    expect(runner.turns).toHaveLength(1);

    // Now the other direction, from a fresh pair.
    const [c, d] = open();
    service.post(c.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room C');
    service.post(d.id, { authorId: human, text: '@ana and the styles?' });
    await quiet();

    await service.haltRoom(c.id, human);
    await settleUntil(() => runner.turns.length === 2, "room D's question to run after all");
    expect(runner.turns[1]!.roomId).toBe(d.id);
    runner.release(ana);
    await service.triggersIdle();
  });

  it('gives up on the wait when the agent is taken out of the room', async () => {
    // **The window this change opened.** A parked collection used to be bounded
    // by one collect debounce — half a second — so an agent removed mid-park was
    // a race nobody could lose. A cross-room hold lasts up to the late ceiling,
    // fifty minutes on the shipped defaults, which is plenty of time to take the
    // agent out of the room while the lane promises an answer.
    //
    // **Seeded defect: drop the `abandonHolds` call in `removeMember`.** The
    // indicator stays up, and when the blocking turn ends the agent runs a turn
    // in — and posts into — a room it is not in.
    const [a, b] = open();
    service.post(a.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room A');
    service.post(b.id, { authorId: human, text: '@ana and the styles?' });
    await quiet();
    expect(signalsIn(b.id, ana).at(-1)?.state).toBe('held');

    service.removeMember(b.id, human, ana);
    // The promise is withdrawn the moment it stops being keepable.
    expect(signalsIn(b.id, ana).at(-1)?.state).toBe('done');
    // And no line: the removal is operator-only, deliberate and already visible
    // on the roster, so a busy notice would explain a decision back to the
    // person who just made it — and would be false, because Ana is not busy.
    expect(notices(b.id)).toEqual([]);

    runner.release(ana);
    await service.triggersIdle();
    // No turn ran in the room it had left, and nothing was posted there.
    expect(runner.turns.filter((turn) => turn.roomId === b.id)).toEqual([]);
    expect(postsBy(b.id, ana)).toEqual([]);
  });

  it('gives up on the wait when the room is archived', async () => {
    // An archived room takes no new posts, so an answer could not be written
    // into it anyway — and a lane going on promising one is the room saying
    // something that has stopped being true. Only the TRANSITION drops it.
    const [a, b] = open();
    service.post(a.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room A');
    service.post(b.id, { authorId: human, text: '@ana and the styles?' });
    await quiet();
    expect(signalsIn(b.id, ana).at(-1)?.state).toBe('held');

    service.updateRoom(b.id, human, { archived: true });
    expect(signalsIn(b.id, ana).at(-1)?.state).toBe('done');

    runner.release(ana);
    await service.triggersIdle();
    expect(runner.turns.filter((turn) => turn.roomId === b.id)).toEqual([]);
  });

  it('does not tell the turn that a waiting message arrived while it was working', async () => {
    // Case 8. The flag split, and the only place it is visible. A message held
    // because the agent was working HERE really did arrive mid-turn, and the turn
    // is told so. One held because the agent was working ELSEWHERE did not: the
    // agent was not working here, and saying otherwise would be the room telling
    // the model something that did not happen.
    //
    // Two messages per room, because the mark rides the messages a turn GATHERED
    // behind its trigger — with one message there is nothing behind it to mark.
    const [a, b] = open();
    service.post(a.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room A');

    // Here: these really did land while Ana was working in this room.
    service.post(a.id, { authorId: human, text: '@ana and the tests?' });
    service.post(a.id, { authorId: human, text: '@ana and the linter?' });
    // Elsewhere: Ana is not working in room B at all.
    service.post(b.id, { authorId: human, text: '@ana one' });
    service.post(b.id, { authorId: human, text: '@ana two' });
    await quiet();

    runner.release(ana);
    await settleUntil(() => runner.turns.length === 2, 'the first waiting room to run');
    runner.release(ana);
    await settleUntil(() => runner.turns.length === 3, 'the second waiting room to run');

    const inA = runner.turns.slice(1).find((turn) => turn.roomId === a.id)!;
    const inB = runner.turns.slice(1).find((turn) => turn.roomId === b.id)!;
    expect(
      (inA.roomContext.gathered ?? []).some((entry) => entry.arrivedDuringPrevTurn === true),
      'a message that really did arrive mid-turn here says so'
    ).toBe(true);
    expect(
      (inB.roomContext.gathered ?? []).some((entry) => entry.arrivedDuringPrevTurn === true),
      'a message held behind ANOTHER room never claims to have arrived mid-turn here'
    ).toBe(false);
    // …and it IS gathered, so the turn still owes it an answer.
    expect(inB.roomContext.gathered ?? []).toHaveLength(1);
    runner.release(ana);
    await service.triggersIdle();
  });

  it('keeps every waiting line when the batch outgrows the cap, and only drops its marks', async () => {
    // Case 9. The cap bounds what one turn is asked to ANSWER, never what it
    // reads. A trimmed message is still in the room log, behind the agent's read
    // cursor, so the ambient window delivers it — it arrives as background rather
    // than as a question, which is the honest cost of a cap somebody set.
    runner = gatedRunner();
    const harness = createRoomHarness({
      agents,
      runner,
      collect: { debounceMs: 0, maxEntries: 2 },
    });
    ({ service, authors, human } = harness);
    published = [];
    const rooms = [1, 2].map((index) =>
      service.createRoom(
        { kind: 'channel', title: `Room ${index}`, members: [], agentPaths: ['/agents/ana'] },
        harness.human
      )
    );
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    for (const room of rooms) service.updateMembership(room.id, human, ana, 'mention-only');
    const a = rooms[0]!;
    const b = rooms[1]!;

    service.post(a.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room A');
    const first = service.post(b.id, { authorId: human, text: '@ana one' });
    await quiet();
    service.post(b.id, { authorId: human, text: '@ana two' });
    service.post(b.id, { authorId: human, text: '@ana three' });
    await quiet();

    runner.release(ana);
    await settleUntil(() => runner.turns.length === 2, "room B's batch to run");
    const inB = runner.turns[1]!;
    expect(
      (inB.roomContext.gathered ?? []).map((entry) => entry.id),
      'the cap dropped the oldest MARK: the turn is asked to answer two, not three'
    ).not.toContain(first.id);
    expect(
      inB.roomContext.pending.map((entry) => entry.id),
      'the trimmed line is still shown to the turn, as ambient background'
    ).toContain(first.id);
    runner.release(ana);
    await service.triggersIdle();
  });

  it('says which room is in the way, and whether anywhere else is waiting', async () => {
    // The wire, and the whole of the disclosure design. An id and a boolean —
    // no title, no topic, no text — because the reader may not be in that room,
    // and the client resolves the name against what it can already see.
    const [a, b, c] = open(3);
    service.post(a.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room A');

    service.post(b.id, { authorId: human, text: '@ana and the styles?' });
    await quiet();
    const alone = signalsIn(b.id, ana)
      .filter((event) => event.state === 'held')
      .at(-1)!;
    expect(alone.heldBehind).toEqual({ roomId: a.id, othersWaiting: false });

    // A second room starts waiting on the same agent, and now "answer here
    // first" would actually change something.
    service.post(c!.id, { authorId: human, text: '@ana and the docs?' });
    await quiet();
    const shared = signalsIn(c!.id, ana)
      .filter((event) => event.state === 'held')
      .at(-1)!;
    expect(shared.heldBehind).toEqual({ roomId: a.id, othersWaiting: true });

    // **And the FIRST room is told, without waiting for the republish tick.**
    // `othersWaiting` is a fact about the set of waits, not about any one of
    // them, so it went stale in room B the instant room C started waiting — and
    // it is the only thing that decides whether "Answer here first" is offered.
    // Seeded defect: drop the sibling restate, and B keeps saying
    // `othersWaiting: false` for up to ten seconds while the control it gates is
    // exactly what a person now wants.
    expect(
      signalsIn(b.id, ana)
        .filter((event) => event.state === 'held')
        .at(-1)!.heldBehind,
      'the first waiting room was not told that somewhere else is waiting too'
    ).toEqual({ roomId: a.id, othersWaiting: true });

    runner.release(ana);
    await settleUntil(() => runner.turns.length === 2, 'a waiting room to run');
    runner.release(ana);
    await settleUntil(() => runner.turns.length === 3, 'the other waiting room to run');
    runner.release(ana);
    await service.triggersIdle();
  });

  it('points every waiting room at the turn that is in the way NOW', async () => {
    // The re-point. A room whose wait was re-armed by one claim's release and
    // then found ANOTHER claim in the way has to name the new room: a lane still
    // naming the conversation that finished is a lane telling the reader to go
    // and look at something that is over.
    const [a, b, c] = open(3);
    service.post(a.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room A');
    service.post(b.id, { authorId: human, text: '@ana and the styles?' });
    await quiet();
    service.post(c!.id, { authorId: human, text: '@ana and the docs?' });
    await quiet();

    runner.release(ana);
    await settleUntil(() => runner.turns.length === 2, "room B's question to run");

    const behind = signalsIn(c!.id, ana)
      .filter((event) => event.state === 'held')
      .at(-1)!;
    expect(behind.heldBehind?.roomId, 'the room in the way is B now, not the finished A').toBe(
      b.id
    );
    runner.release(ana);
    await settleUntil(() => runner.turns.length === 3, "room C's question to run");
    runner.release(ana);
    await service.triggersIdle();
  });

  it('threads the answer to the message it answers', async () => {
    // Holding makes an out-of-order answer common rather than rare, which is the
    // condition `specs/room-participation` §5.3 specified this pointer for and
    // never shipped. It is set unconditionally, because a reader cannot tell from
    // the outside which answers waited.
    const [a, b] = open();
    service.post(a.id, { authorId: human, text: '@ana check the build' });
    await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana mid-turn in room A');
    const asked = service.post(b.id, { authorId: human, text: '@ana and the styles?' });
    await quiet();
    // Somebody else says something in the meantime, so the answer will not land
    // next to the question.
    service.post(b.id, { authorId: human, text: 'never mind, I will look' });
    await quiet();

    runner.release(ana);
    await settleUntil(() => runner.holdsFor(ana) === 1, "room B's question to become a turn");
    runner.release(ana, 'styles are fine');
    await settleUntil(() => postsBy(b.id, ana).length === 1, "Ana's late answer to land");
    // The turn answers the NEWEST message it was asked, which is the one the
    // pointer names — the reader can follow it back either way.
    expect(postsBy(b.id, ana)[0]!.body.answersEntryId).toBeDefined();
    expect([asked.id, log(b.id)[1]!.id]).toContain(postsBy(b.id, ana)[0]!.body.answersEntryId);
    await service.triggersIdle();
  });
});
