import { describe, it, expect, vi } from 'vitest';
import {
  agentLookupFor,
  createRoomHarness,
  roomSpec,
  scriptedRunner,
} from '../room-test-harness.js';

import { agentLookup } from './room-service.fixtures.js';

describe('RoomService — the repeat rule holds across a thread boundary', () => {
  /**
   * The one place the thread change makes a real bound TIGHTER
   * (room-participation spec §3.4, ADR 260728-022013).
   *
   * `turnsByAuthorInCascade` is scoped `(room_id, cascade_root)`. Under the
   * child-room shape, a cascade that went from a channel into a thread crossed a
   * `room_id` boundary, the per-cascade turn count reset, and the same authors
   * got a fresh allowance inside one exchange — the cross-room carve-out
   * ADR 260726-170127 documented and could not close. A thread reply now carries
   * the CHANNEL's `room_id`, so the count does not reset and A → thread → A
   * spends A's allowance instead of running to the depth ceiling.
   *
   * Driven through the real dispatcher: the guard's absence is only visible
   * under a cascade, so a test that called the guard directly would prove
   * nothing about the path that ships.
   */
  const agents = agentLookupFor({
    '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
    '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
  });

  it('refuses a cascade that opens a thread and comes back to the same author', async () => {
    const harness = createRoomHarness({
      agents,
      runner: scriptedRunner(() => 'on it'),
      // Well clear of anything this exchange can reach, so a refusal below is
      // the repeat rule and never the depth ceiling wearing its clothes. It is
      // also what makes a broken repeat rule LOUD here rather than subtle: an
      // A → B → A loop that is not stopped runs to this number.
      maxAgentDepth: 10,
    });
    const room = harness.service.createRoom(roomSpec('channel', 'Backend'), harness.human);

    // The root goes in before either agent does, so neither is in this cascade
    // by way of a TOP-LEVEL entry. Everything that puts them in it from here is
    // a thread reply — which is exactly the thing the child-room shape kept out
    // of the set, and the thing this test has to be able to see.
    const root = harness.service.post(room.id, {
      authorId: harness.human,
      text: 'the deploy is stuck',
    });
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toEqual([]);

    const anaId = harness.service.addMember(room.id, harness.human, {
      agentPath: '/agents/ana',
      responseMode: 'always',
    }).authorId;
    const boId = harness.service.addMember(room.id, harness.human, {
      agentPath: '/agents/bo',
      responseMode: 'always',
    }).authorId;

    // Ana moves the exchange into a thread off the person's message, carrying
    // the cascade she is answering under — the same stamp
    // `RoomTriggerDispatcher` puts on a reply, passed explicitly so this is a
    // settled state rather than a race against her own in-flight claim.
    const anasReply = harness.service.post(room.id, {
      authorId: anaId,
      text: 'taking this to a thread',
      replyTo: root.id,
      trigger: { root: root.id, depth: 1 },
    });
    await harness.service.triggersIdle();

    // The mechanism FIRST, so a failure names which half broke: Ana's reply is
    // in the CHANNEL's log, under the channel's cascade. Under the child-room
    // shape all of that moved into a room of its own.
    expect(anasReply.roomId).toBe(room.id);
    expect(anasReply.threadRootEntryId).toBe(root.id);
    expect(anasReply.cascadeRoot).toBe(root.id);

    // Exactly one turn: Bo answered Ana, in the thread. Ana was then refused on
    // Bo's answer, because her thread reply put her in this cascade — the
    // repeat rule holding across a boundary it used to reset at
    // (room-participation spec §3.4). A set that skipped thread replies would
    // never have found her, and A → B → A would have run to `maxAgentDepth`.
    expect(harness.runner.turns).toHaveLength(1);
    expect(harness.runner.turns[0].authorId).toBe(boId);

    // Bo answered inside the thread rather than beside it, which is what makes
    // the hop above a real one and not a message that escaped to the top level.
    const bosAnswer = harness.service
      .listEntries(room.id, harness.human, { limit: 50 })
      .find((entry) => entry.authorId === boId && entry.kind === 'post');
    expect(bosAnswer?.threadRootEntryId).toBe(root.id);
    expect([...harness.service.turnsByAuthorInCascade(room.id, root.id).keys()].sort()).toEqual(
      // The exact set: both agents, the person, and the system author that wrote
      // the refusal notice. Naming it beats "contains Ana", which would still
      // pass if Bo had fallen out of his own cascade.
      [harness.human, anaId, boId, harness.authors.system().id].sort()
    );
  });

  it('reports a refusal inside the thread it happened in', async () => {
    // `I3` — a refusal is visible. Visible at the channel's top level, about a
    // turn that was refused inside a thread, is a notice the reader cannot
    // connect to anything. Under the child-room shape this was free, because the
    // refusal was written into the thread's own room.
    //
    // Driven off the BUDGET refusal rather than the cascade one, because it is
    // the deterministic path: two agents refusing each other race on roster
    // order, and a test built on that shape passes about half the time
    // (`room-silence.test.ts` says so at length).
    const harness = createRoomHarness({
      agents,
      runner: scriptedRunner(() => 'on it'),
      maxAutomaticTurnsPerRoomPerHour: 0,
    });
    const room = harness.service.createRoom(roomSpec('channel', 'Backend'), harness.human);
    // The root goes in BEFORE Ana does, so the room's one budget notice is spent
    // on the thread reply rather than on this: the notice is keyed on the room
    // and re-armed only when the room can spend again.
    const root = harness.service.post(room.id, {
      authorId: harness.human,
      text: 'the deploy is stuck',
    });
    await harness.service.triggersIdle();
    expect(
      harness.service
        .listEntries(room.id, harness.human, { limit: 50 })
        .filter((e) => e.kind === 'notice')
    ).toEqual([]);

    const anaId = harness.service.addMember(room.id, harness.human, {
      agentPath: '/agents/ana',
      responseMode: 'always',
    }).authorId;
    harness.service.post(room.id, { authorId: harness.human, text: 'any idea?', replyTo: root.id });
    await harness.service.triggersIdle();

    const notices = harness.service
      .listEntries(room.id, harness.human, { limit: 50 })
      .filter((entry) => entry.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].body.notice).toBe('budget_reached');
    // The whole point: it is IN the thread, not beside it.
    expect(notices[0].threadRootEntryId).toBe(root.id);
    expect(notices[0].parentEntryId).toBe(root.id);
    // Ana really was the agent that would have run, so this is a refusal and not
    // an empty room writing a notice about nobody.
    expect(
      harness.service.getRoom(room.id, harness.human)?.members.map((m) => m.authorId)
    ).toContain(anaId);
  });
});

describe('RoomService — a thread reply is an addressing act', () => {
  /**
   * What the cockpit's new reply affordance actually costs (DOR-731).
   *
   * Replying in a thread posts through `POST /:id/threads`, which is
   * `RoomService.post` with a `replyTo` — so it runs the SAME addressing,
   * budget and cascade rules an ordinary post does. The client adds no
   * mechanism for any of that, which is exactly why it has to be pinned here:
   * nothing in the browser can tell "the reply reached the agent" apart from
   * "the reply rendered" if the agent never had to answer.
   *
   * `mention-only` on purpose. A channel seeds `engaged`, which would leave Ana
   * answerable for ten minutes after the first message and make the SECOND
   * assertion below true for a reason that has nothing to do with the thread.
   */
  const agents = agentLookupFor({
    '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
  });

  it('triggers the agent a reply names, and answers inside the same thread', async () => {
    const harness = createRoomHarness({
      agents,
      runner: scriptedRunner(() => 'the cache is cold'),
    });
    const room = harness.service.createRoom(roomSpec('channel', 'Backend'), harness.human);
    const ana = harness.service.addMember(room.id, harness.human, {
      agentPath: '/agents/ana',
      responseMode: 'mention-only',
    }).authorId;
    // No lead: this case is about a thread reply as an addressing act, and a
    // lead would answer the unaddressed post (DOR-2823).
    harness.service.updateRoom(room.id, harness.human, { leadAuthorId: null });

    // A root nobody is named in: the thread is the only thing that can trigger her.
    const root = harness.service.post(room.id, {
      authorId: harness.human,
      text: 'the build is slow',
    });
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toEqual([]);

    harness.service.post(room.id, {
      authorId: harness.human,
      text: `@ana any idea?`,
      replyTo: root.id,
    });
    await harness.service.triggersIdle();

    // She ran, and she ran on the reply's own words.
    expect(harness.runner.turns).toHaveLength(1);
    expect(harness.runner.turns[0]?.authorId).toBe(ana);
    expect(harness.runner.turns[0]?.prompt).toBe('@ana any idea?');

    // And her answer is in the thread, not loose in the room. An answer that
    // surfaced in the channel would move the conversation out from under the
    // aside it belongs to — the thing threads exist to prevent.
    const log = harness.service.listEntries(room.id, harness.human, { limit: 50 });
    const answer = log.find((entry) => entry.authorId === ana);
    expect(answer?.body.text).toBe('the cache is cold');
    expect(answer?.threadRootEntryId).toBe(root.id);
  });

  it('spends the room budget the same way a top-level message does', async () => {
    // The reply route adds no fresh allowance. A thread that could not run out
    // would be a way around the one limit that keeps a room from running all
    // night.
    const harness = createRoomHarness({
      agents,
      runner: scriptedRunner(() => null),
      maxAutomaticTurnsPerRoomPerHour: 1,
    });
    const room = harness.service.createRoom(roomSpec('channel', 'Backend'), harness.human);
    harness.service.addMember(room.id, harness.human, {
      agentPath: '/agents/ana',
      responseMode: 'mention-only',
    });

    const root = harness.service.post(room.id, { authorId: harness.human, text: '@ana ping' });
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(1);

    harness.service.post(room.id, {
      authorId: harness.human,
      text: '@ana again',
      replyTo: root.id,
    });
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(1);
  });
});

describe('RoomService — a committed post never fails because dispatching from it did', () => {
  // The poster's own successful message used to 500.
  //
  // `dispatch` runs its target selection SYNCHRONOUSLY inside `post`, and the
  // routes map anything that is not a `RoomError` to a 500 — so one SQLite write
  // that lost a race, deep inside trigger selection, surfaced to the person as a
  // failure of the message they had just sent. It was already committed,
  // published, and visible to everyone else in the room.
  //
  // Losing the replies to a message is bad, visible in the room, and recoverable
  // by asking again. Losing the message looks like a broken product.

  const agents = agentLookupFor({
    '/agents/ana': { name: 'ana', displayName: 'Ana' },
    '/agents/bo': { name: 'bo', displayName: 'Bo' },
  });

  /** A channel holding Ana and Bo, each answering only when named. */
  function open(): ReturnType<typeof createRoomHarness> & { roomId: string } {
    const harness = createRoomHarness({ agents, runner: scriptedRunner(() => 'on it') });
    const room = harness.service.createRoom(roomSpec('channel', 'Backend'), harness.human);
    for (const agentPath of ['/agents/ana', '/agents/bo']) {
      harness.service.addMember(room.id, harness.human, {
        agentPath,
        responseMode: 'mention-only',
      });
    }
    return { ...harness, roomId: room.id };
  }

  it('drops only the agent whose session binding could not be written', async () => {
    // Two agents named by one message, and the first bind throws. The binds run
    // in their own pass BEFORE any claim is taken, so there is nothing to unwind
    // — the failed target simply never becomes one, and the other still answers.
    const harness = open();
    const realBind = harness.store.bindRoomSession.bind(harness.store);
    let firstBind = true;
    const bindings = vi.spyOn(harness.store, 'bindRoomSession').mockImplementation((...args) => {
      if (!firstBind) return realBind(...args);
      firstBind = false;
      throw new Error('SQLITE_BUSY: database is locked');
    });

    const entry = harness.service.post(harness.roomId, {
      authorId: harness.human,
      text: '@ana @bo can you both look?',
    });
    await harness.service.triggersIdle();
    bindings.mockRestore();

    // The message is committed and returned, not a 500.
    expect(entry.body.text).toBe('@ana @bo can you both look?');
    expect(
      harness.service.listEntries(harness.roomId, harness.human, { limit: 10 })
    ).toContainEqual(expect.objectContaining({ id: entry.id }));
    // One agent lost its turn; the other kept it.
    expect(harness.runner.turns).toHaveLength(1);
    // And nothing is left saying somebody is working. A claim taken for a target
    // that never ran would be re-stated every ten seconds forever, which is the
    // one stale indicator a client's TTL cannot heal.
    expect(harness.service.listRooms(harness.human)[0].working).toBe(0);
  });

  it('keeps the message when trigger selection throws outright', async () => {
    // The whole dispatch, not one target: whatever else in there learns to throw
    // later is covered by the same guard.
    const harness = open();
    const provenance = vi.spyOn(harness.store, 'turnsByAuthorInCascade').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    const entry = harness.service.post(harness.roomId, {
      authorId: harness.human,
      text: '@ana can you look?',
    });
    await harness.service.triggersIdle();
    provenance.mockRestore();

    expect(
      harness.service.listEntries(harness.roomId, harness.human, { limit: 10 })
    ).toContainEqual(expect.objectContaining({ id: entry.id }));
    expect(harness.runner.turns).toHaveLength(0);
    expect(harness.service.listRooms(harness.human)[0].working).toBe(0);
  });
});

describe('RoomService — a presence glimpse stops at this cockpit', () => {
  it('gives the bridge the verb and never the target, while the room keeps both', () => {
    // The boundary in one publish (ADR 260819-022127). The room's own stream is
    // this operator's cockpit and their session pane already shows them the
    // identical string; a bridged chat is other people's surface, where the
    // room's durable waiting notice already refuses to name files and commands.
    const { service, human } = createRoomHarness({ agents: agentLookup });
    const room = service.createRoom(roomSpec('channel', 'Backend', ['/agents/ana']), human);

    const broadcast: unknown[] = [];
    const deliver = service.stream.publish.bind(service.stream);
    vi.spyOn(service.stream, 'publish').mockImplementation((roomId, event) => {
      broadcast.push(event);
      deliver(roomId, event);
    });
    const forwarded: Array<Record<string, unknown> | undefined> = [];
    service.setSignalListener((_roomId, _signal, _authorId, presence) => {
      forwarded.push(presence as Record<string, unknown> | undefined);
    });

    service.publishSignal(room.id, 'progress', 'author-ana', {
      state: 'working',
      entryId: 'entry-1',
      since: '2026-07-30T04:00:00.000Z',
      activity: { toolName: 'Read', target: 'standup.md' },
    });

    // The bridge hears the shape of the work and not its content.
    expect(forwarded).toEqual([
      {
        state: 'working',
        entryId: 'entry-1',
        since: '2026-07-30T04:00:00.000Z',
        activity: { toolName: 'Read' },
      },
    ]);
    // And the SAME publish still carried the whole reading to this room's own
    // readers. Stripping both would be the other way to break this.
    expect(broadcast.at(-1)).toMatchObject({
      type: 'signal',
      activity: { toolName: 'Read', target: 'standup.md' },
    });
  });

  it('hands the bridge a payload with no reading exactly as it was', () => {
    // Most presence frames carry none — a turn before its first tool, and every
    // `done`. The strip must not mint an empty `activity` for them.
    const { service, human } = createRoomHarness({ agents: agentLookup });
    const room = service.createRoom(roomSpec('channel', 'Backend', ['/agents/ana']), human);
    const forwarded: Array<Record<string, unknown> | undefined> = [];
    service.setSignalListener((_roomId, _signal, _authorId, presence) => {
      forwarded.push(presence as Record<string, unknown> | undefined);
    });

    service.publishSignal(room.id, 'progress', 'author-ana', {
      state: 'done',
      entryId: 'entry-1',
      since: '2026-07-30T04:00:00.000Z',
    });

    expect(forwarded).toEqual([
      { state: 'done', entryId: 'entry-1', since: '2026-07-30T04:00:00.000Z' },
    ]);
  });
});
