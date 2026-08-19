/**
 * Stopping ONE agent in a room, and leaving the others working.
 *
 * The room-wide halt (`room-stopped-turns.test.ts`) is the verb; this is the
 * same verb with a scope, and everything that makes the room-wide one correct
 * has to hold here for the same reasons and in the same order. Three of those
 * orderings are what most of this file is about:
 *
 * 1. The stopped dispatch is marked BEFORE the first `await`, so a turn that
 *    streams its last words after the interrupt has them thrown away — the
 *    two-second race measured on 2026-08-15 (DOR-1232).
 * 2. The durable line is written BEFORE the claim is released, so no indicator
 *    ever drops ahead of the entry explaining it.
 * 3. The gather buffer is dropped BEFORE the claim is released, because
 *    releasing a claim is what resumes a held collection.
 *
 * **The runtime that IGNORES the interrupt is not incidental here.** A runtime
 * that stops promptly releases the claim through `runOne` anyway, so a
 * `haltAgent` that forgot to release — or that released the wrong key — would
 * pass against a well-behaved one.
 *
 * Driven through the real service and the real dispatcher, like every other room
 * suite: only the runner stands in, because the alternative is a model call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  RoomEntry,
  RoomEvent,
  RoomSignalEvent,
  RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import type { CollectWindow } from '../room-collect.js';
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
});

/** How this room's own line reads for the three outcomes, in full. */
const STOPPED_ANA = {
  interrupted:
    'You stopped Ana. Ana was working here and has been interrupted. Send a message to start it again.',
  unstarted:
    'You stopped Ana. Ana had not started yet, so it will not answer what was waiting. Send a message to ask again.',
  idle: 'You stopped Ana. Ana was not working here at the time.',
};

describe('stopping one agent in a room', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let runner: GatedRunner;
  let room: RoomWithRoster;
  let human: string;
  let ana: string;
  let bo: string;
  let published: Array<{ roomId: string; event: RoomEvent }> = [];
  /**
   * Sampled at the instant of every publish, for the one scenario that is about
   * the ORDER of two effects.
   *
   * One tap for the suite rather than a second `spyOn` at the call site: a
   * second spy binds the first one and recurses until the stack gives out.
   */
  let onPublish: ((roomId: string, event: RoomEvent) => void) | null = null;

  /**
   * Wire a room holding Ana and Bo, with the stream tapped.
   *
   * @param opts.runner - The runtime this room runs on. The default is the one
   *   that comes back WITH the answer it had already produced when it was
   *   interrupted, because that is the runtime the product has (DOR-1232).
   * @param opts.collect - The gather window, for the scenarios that are about
   *   what an agent had not read yet.
   */
  function open(opts: { runner?: GatedRunner; collect?: CollectWindow } = {}): void {
    runner = opts.runner ?? gatedRunner({ interruptedTurnStillAnswers: true });
    ({ service, authors, human } = createRoomHarness({
      agents,
      runner,
      ...(opts.collect && { collect: opts.collect }),
    }));
    published = [];
    onPublish = null;
    const broadcaster = service.stream;
    const deliver = broadcaster.publish.bind(broadcaster);
    vi.spyOn(broadcaster, 'publish').mockImplementation((roomId, event) => {
      published.push({ roomId, event });
      onPublish?.(roomId, event);
      deliver(roomId, event);
    });
    room = service.createRoom(
      {
        kind: 'channel',
        title: 'Backend',
        members: [],
        agentPaths: ['/agents/ana', '/agents/bo'],
      },
      human
    );
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    bo = authors.resolveAgent('/agents/bo', 'Bo').id;
    // `mention-only`, so who answers is a property of the message rather than of
    // an engagement window: a second message in a scenario must not re-trigger
    // an agent whose first turn is still being held.
    for (const authorId of [ana, bo]) {
      service.updateMembership(room.id, human, authorId, 'mention-only');
    }
  }

  /** Every entry in a room, oldest first. */
  function log(roomId = room.id): RoomEntry[] {
    return service.listEntries(roomId, human, { limit: 200 });
  }

  /** Just the `halted` lines — the room saying somebody stopped something. */
  function haltedLines(roomId = room.id): RoomEntry[] {
    return log(roomId).filter((entry) => entry.body.notice === 'halted');
  }

  /** What one agent actually posted, which a stop has to leave empty. */
  function postsBy(authorId: string): RoomEntry[] {
    return log().filter((entry) => entry.kind === 'post' && entry.authorId === authorId);
  }

  /** Every presence signal about one agent in this room, in order. */
  function presenceFor(authorId: string): RoomSignalEvent[] {
    return published
      .filter((sent) => sent.roomId === room.id)
      .map((sent) => sent.event)
      .filter((event): event is RoomSignalEvent => event.type === 'signal')
      .filter((event) => event.authorId === authorId);
  }

  beforeEach(() => {
    open();
  });

  it('stops the named agent and leaves the other one working', async () => {
    // **The whole point of the feature, and the defect it is aimed at.** A
    // `haltAgent` that enumerated the claim map the way the room-wide halt does
    // would take Bo's claim with Ana's, and Bo's answer would never post — which
    // is the exact loss the peek's old single-Stop forced on a person.
    service.post(room.id, { authorId: human, text: '@ana @bo take a look' });
    await settleUntil(() => runner.turns.length === 2, 'both agents to be mid-turn');

    expect(await service.haltAgent(room.id, ana, human)).toBe(1);

    // Ana was interrupted; Bo was not asked to stop at all.
    expect(runner.interrupted.map((call) => call.agentPath)).toEqual(['/agents/ana']);
    // Bo is still holding its turn, and the room still says one agent is working.
    expect(runner.holdsFor(bo)).toBe(1);
    expect(service.listRooms(human, {})[0].working).toBe(1);

    // And Bo's answer lands, while Ana's is thrown away.
    runner.release(bo);
    await service.triggersIdle();
    expect(postsBy(bo).map((entry) => entry.body.text)).toEqual(['on it']);
    expect(postsBy(ana)).toHaveLength(0);
  });

  it("throws away the stopped turn's answer when it lands in the same instant as the stop", async () => {
    // **The 2026-08-15 race** (DOR-1232), at its tightest: the interrupt IS what
    // closes the stream, and the stream still carries the answer the model had
    // finished producing — so the turn settles inside the stop's own `await`.
    // Red if the mark is set anywhere after that await, which is why the mark is
    // the first statement in the method.
    service.post(room.id, { authorId: human, text: '@ana write me a slow poem' });
    await settleUntil(() => runner.holdsFor(ana) > 0, 'Ana to be mid-turn');

    await service.haltAgent(room.id, ana, human);
    await service.triggersIdle();

    expect(postsBy(ana)).toHaveLength(0);
    expect(log().filter((entry) => entry.kind === 'notice')).toHaveLength(1);
    expect(haltedLines()).toHaveLength(1);
  });

  it('throws it away even when the runtime ignores the interrupt entirely', async () => {
    // The other half of the same race, and the one that says the mark has to
    // OUTLIVE the stop: this runtime keeps running and closes minutes later with
    // the whole answer in it. Red if the mark is never set, or if it is
    // forgotten when the stop returns rather than at the turn's own terminal.
    open({ runner: gatedRunner({ interruptEndsTurn: false }) });
    service.post(room.id, { authorId: human, text: '@ana write me a slow poem' });
    await settleUntil(() => runner.holdsFor(ana) > 0, 'Ana to be mid-turn');

    await service.haltAgent(room.id, ana, human);
    // Long afterwards, the runtime finally comes back with what it had.
    runner.release(ana);
    await service.triggersIdle();

    expect(postsBy(ana)).toHaveLength(0);
    // And nothing ELSE was said either: a `turn_failed` under the stop would be
    // the room apologising for obeying.
    expect(log().filter((entry) => entry.kind === 'notice')).toHaveLength(1);
    expect(haltedLines()).toHaveLength(1);
  });

  it('writes exactly one halted line, naming who stopped whom', async () => {
    service.post(room.id, { authorId: human, text: '@ana have a look' });
    await settleUntil(() => runner.holdsFor(ana) > 0, 'Ana to be mid-turn');

    await service.haltAgent(room.id, ana, human);

    const halted = haltedLines();
    expect(halted).toHaveLength(1);
    // The subject is what tells this apart from a room-wide stop on the wire:
    // absent means the room, present names one agent.
    expect(halted[0].body.subjectAuthorId).toBe(ana);
    expect(halted[0].body.notice).toBe('halted');
    expect(halted[0].authorId).toBe(authors.system().id);
    expect(halted[0].body.text).toBe(STOPPED_ANA.interrupted);
    // Bo is not named anywhere in it, and Bo is still working.
    expect(halted[0].body.text).not.toContain('Bo');
    runner.release(bo);
  });

  it('says nothing the second time, and says it again once the agent works again', async () => {
    // Pressing Stop again where nothing has happened since is the same question
    // asked twice. Red if the damping key is the room id, or if `workStarted`
    // forgot the author — the second press would speak, or the third would not.
    await service.haltAgent(room.id, ana, human);
    await service.haltAgent(room.id, ana, human);
    expect(haltedLines()).toHaveLength(1);

    service.post(room.id, { authorId: human, text: '@ana try again' });
    await settleUntil(() => runner.holdsFor(ana) > 0, 'Ana to take a fresh claim');
    await service.haltAgent(room.id, ana, human);

    expect(haltedLines()).toHaveLength(2);
    expect(haltedLines()[1].body.text).toBe(STOPPED_ANA.interrupted);
  });

  it('stopping one agent does not silence a line about the other', async () => {
    // Two different statements about two different members. Red if the damping
    // key is the room id, which would make Bo's stop silent.
    await service.haltAgent(room.id, ana, human);
    await service.haltAgent(room.id, bo, human);

    expect(haltedLines().map((entry) => entry.body.subjectAuthorId)).toEqual([ana, bo]);
    expect(haltedLines()[1].body.text).toBe('You stopped Bo. Bo was not working here at the time.');
  });

  it('a room-wide stop after a per-agent one still speaks', async () => {
    // The bigger statement is one everybody in the room needs, so the two keys
    // never damp each other. Red if they are merged.
    await service.haltAgent(room.id, ana, human);
    await service.haltRoom(room.id, human);

    const lines = haltedLines();
    expect(lines).toHaveLength(2);
    expect(lines[0].body.subjectAuthorId).toBe(ana);
    // The room-wide line is about the room, so it names nobody.
    expect(lines[1].body.subjectAuthorId).toBeUndefined();
    expect(lines[1].body.text).toBe(
      'Everything here was stopped. Nothing was running at the time.'
    );
  });

  it('drops what the agent had not read yet, so it does not answer it a macrotask later', async () => {
    // **Releasing a claim is what resumes the collection parked behind it**, so
    // a stop that left the buffer alone would start, one macrotask later, a turn
    // for exactly the message the person pressed Stop over — a control action
    // turning itself back into a reaction. That is why the drop is on the same
    // synchronous path as the release and ahead of it. The runtime here never
    // comes back, so the stop's own release is the only one there is.
    open({ runner: gatedRunner({ interruptEndsTurn: false }) });
    service.post(room.id, { authorId: human, text: '@ana start on the report' });
    await settleUntil(() => runner.holdsFor(ana) > 0, 'Ana to be mid-turn');
    service.post(room.id, { authorId: human, text: '@ana and the appendix too' });
    await settleUntil(
      () => log().some((entry) => entry.body.text === '@ana and the appendix too'),
      'the second message to land and park behind the live turn'
    );

    await service.haltAgent(room.id, ana, human);
    // The stopped turn finally closes, which is what would run the parked batch.
    runner.release(ana);
    await service.triggersIdle();

    expect(runner.turns).toHaveLength(1);
    expect(postsBy(ana)).toHaveLength(0);
    expect(haltedLines()[0].body.text).toBe(STOPPED_ANA.interrupted);
  });

  it("leaves the other agent's gathered messages alone", async () => {
    // Red if the drop is room-scoped: Bo's batch would be thrown away by a stop
    // that was never about Bo, and the question nobody stopped would go
    // unanswered.
    open({
      runner: gatedRunner({ interruptEndsTurn: false }),
      collect: { debounceMs: 40, maxEntries: 20 },
    });
    service.post(room.id, { authorId: human, text: '@ana @bo what do you both think?' });

    // Stopped mid-gather: neither has a claim yet, and both are waiting to.
    expect(await service.haltAgent(room.id, ana, human)).toBe(0);
    await settleUntil(() => runner.holdsFor(bo) > 0, "Bo's gathered batch to become a turn");

    expect(runner.turns.map((turn) => turn.authorId)).toEqual([bo]);
    // Ana's line says what the stop found: a turn that had not started.
    expect(haltedLines()[0].body.text).toBe(STOPPED_ANA.unstarted);
    runner.release(bo);
    await service.triggersIdle();
    expect(postsBy(ana)).toHaveLength(0);
  });

  it('releases the claim through the seam, so the indicator drops', async () => {
    // `done` is published in `releaseClaim` and nowhere else, so a stop that
    // deleted from the claim map would leave the map right, every watching
    // client wrong, and the republish timer still ticking. The stubborn runtime
    // is what makes this the ONLY release: nothing ever settles that turn.
    open({ runner: gatedRunner({ interruptEndsTurn: false }) });
    service.post(room.id, { authorId: human, text: '@ana have a look' });
    await settleUntil(() => runner.holdsFor(ana) > 0, 'Ana to be mid-turn');

    await service.haltAgent(room.id, ana, human);

    expect(presenceFor(ana).map((event) => event.state)).toEqual(['working', 'done']);
    // Bo never claimed anything, so nothing was published about Bo at all.
    expect(presenceFor(bo)).toHaveLength(0);
    expect(service.listRooms(human, {})[0].working).toBe(0);
  });

  it('writes the durable line before the indicator drops', async () => {
    // An indicator that vanishes ahead of the entry explaining it is a room
    // going quiet for no visible reason. Sampled inside the publisher because
    // the ORDER is what is being measured and it is unobservable afterwards —
    // both facts are true once the dust settles, whichever way round they
    // landed. Red if the notice moves below `releaseClaim`.
    open({ runner: gatedRunner({ interruptEndsTurn: false }) });
    service.post(room.id, { authorId: human, text: '@ana have a look' });
    await settleUntil(() => runner.holdsFor(ana) > 0, 'Ana to be mid-turn');
    let lineWasAlreadyThere: boolean | null = null;
    onPublish = (roomId, event) => {
      if (
        roomId === room.id &&
        event.type === 'signal' &&
        event.authorId === ana &&
        event.state === 'done' &&
        lineWasAlreadyThere === null
      ) {
        lineWasAlreadyThere = haltedLines().some((entry) => entry.body.subjectAuthorId === ana);
      }
    };

    await service.haltAgent(room.id, ana, human);

    expect(lineWasAlreadyThere).toBe(true);
  });

  it('stopping an idle agent still says so', async () => {
    // Pressing Stop is a question, and silence is not an answer to it. Red if
    // the method returns early before the notice.
    expect(await service.haltAgent(room.id, ana, human)).toBe(0);

    expect(haltedLines()).toHaveLength(1);
    expect(haltedLines()[0].body.text).toBe(STOPPED_ANA.idle);
    expect(haltedLines()[0].body.subjectAuthorId).toBe(ana);
    expect(runner.interrupted).toHaveLength(0);
  });

  it('does not mute: the next message is answered normally', async () => {
    // Stop ends a turn; it does not change a setting. Red if the stop left any
    // per-agent state that refuses the next trigger.
    service.post(room.id, { authorId: human, text: '@ana have a look' });
    await settleUntil(() => runner.holdsFor(ana) > 0, 'Ana to be mid-turn');
    await service.haltAgent(room.id, ana, human);
    await service.triggersIdle();

    service.post(room.id, { authorId: human, text: '@ana never mind — what is 2 + 2?' });
    await settleUntil(() => runner.turns.length === 2, 'the next message to run a normal turn');
    runner.release(ana);
    await service.triggersIdle();

    expect(postsBy(ana).map((entry) => entry.body.text)).toEqual(['on it']);
  });

  it('stopping an agent here does not touch its turn in another room', async () => {
    // The claim is resolved by `(room, agent)`, never by the agent's directory.
    // Red if it is read by `agentPath`: stopping Ana in a room where it is idle
    // would reach into a conversation this caller may not even be looking at.
    const other = service.createRoom(
      { kind: 'channel', title: 'Frontend', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    service.updateMembership(other.id, human, ana, 'mention-only');
    service.post(other.id, { authorId: human, text: '@ana look at the styles' });
    await settleUntil(() => runner.holdsFor(ana) > 0, 'Ana to be mid-turn in the other room');

    expect(await service.haltAgent(room.id, ana, human)).toBe(0);

    expect(runner.interrupted).toHaveLength(0);
    expect(haltedLines()[0].body.text).toBe(STOPPED_ANA.idle);
    // The other room said nothing, and its turn is still running.
    expect(haltedLines(other.id)).toHaveLength(0);
    expect(runner.holdsFor(ana)).toBe(1);
    runner.release(ana);
    await service.triggersIdle();
  });

  describe('what it refuses', () => {
    it('refuses an agent trying to stop a room-mate', async () => {
      // Scoping the verb makes it more tempting, not less: an agent stopping one
      // room-mate is the arbitration this domain has declined twice.
      await expect(service.haltAgent(room.id, bo, ana)).rejects.toMatchObject({
        code: 'PEOPLE_ONLY',
      });
      // A refusal that still speaks would be a way to make a room say things.
      expect(log()).toHaveLength(0);
    });

    it('refuses a room it cannot resolve before it looks at the roster', async () => {
      // The room gate runs first, so a caller who cannot see the room learns
      // nothing about who is on it.
      await expect(service.haltAgent('no-such-room', ana, human)).rejects.toMatchObject({
        code: 'ROOM_NOT_FOUND',
      });
    });

    it('refuses a name that is not an agent on this roster', async () => {
      // Answering `0` for a name that is not there would hide a client bug
      // behind a success.
      await expect(service.haltAgent(room.id, 'nobody', human)).rejects.toMatchObject({
        code: 'MEMBER_NOT_FOUND',
      });
      // A person on the roster is refused by the same code, and the sentence is
      // literally true: there is no AGENT by that id here.
      await expect(service.haltAgent(room.id, human, human)).rejects.toMatchObject({
        code: 'MEMBER_NOT_FOUND',
      });
      expect(log()).toHaveLength(0);
    });
  });
});
