/**
 * @vitest-environment node
 *
 * What the shared suite cannot reach: the cases that are specific to wrapping
 * THIS backend.
 *
 * The conformance run next door proves the contract. These prove the four
 * things only a local adapter can be asked about — a cursor refused for a reason
 * no fixture can arrange, a room that exists and is invisible being refused
 * exactly like one that does not exist, the local-only columns that must never
 * reach the wire, and the shipped room semantics this wrapper is obliged to keep
 * (idempotent removal, a monotonic read cursor, an archived room that still
 * reads).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CommunityMemberNotFoundError,
  CommunityRoomNotFoundError,
  LOCAL_COMMUNITY,
  StaleCommunityCursorError,
  type CommunityCursor,
  type CommunityRoomListEvent,
} from '@dorkos/shared/community-adapter';
import { STREAM_EPOCH } from '../../../../lib/stream-cursor.js';
import { RoomStore } from '../../../rooms/room-store.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import { LocalCommunityAdapter } from '../local-community-adapter.js';
import { localCommunityIdentity } from '../register-local-community.js';

/** The one agent this file can put on a roster, for the cases that need a second member. */
const AGENT_PATH = '/Users/planted/agents/ana';

/** A second agent, for the cases that need a room the identity under test is NOT in. */
const OTHER_AGENT_PATH = '/Users/planted/agents/other';

/** One adapter over one fresh in-memory install. */
function setup(): { adapter: LocalCommunityAdapter; harness: RoomHarness; store: RoomStore } {
  const harness = createRoomHarness({
    agents: agentLookupFor({ [AGENT_PATH]: { name: 'Ana' } }),
    runner: scriptedRunner(() => null),
  });
  const store = new RoomStore(harness.db);
  const adapter = new LocalCommunityAdapter({
    service: harness.service,
    store,
    // The production resolver, not a stub — it reads the store, which is what
    // makes "the store will not answer" reachable below.
    resolveIdentity: localCommunityIdentity(harness.authors),
  });
  return { adapter, harness, store };
}

/** A room id no install holds — what a caller probing for someone else's room has. */
const ABSENT = 'no-such-room-id';

/**
 * The error a synchronous refusal threw, or a failure naming what came back
 * instead. A returned stream is the wrong answer as loudly as a wrong error is.
 *
 * @param call - The call that must refuse at call time.
 */
function refusalFrom(call: () => unknown): Error {
  try {
    call();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a refusal at call time; the call returned instead');
}

/**
 * An error's own enumerable properties, with the room id it was asked about
 * normalized away — so two refusals about two different rooms are comparable on
 * everything except the address each was handed.
 *
 * @param err - The refusal to read.
 * @param roomId - The id to normalize out of every string value.
 */
function ownShape(err: Error, roomId: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(err).map(([key, value]) => [
      key,
      typeof value === 'string' ? value.replaceAll(roomId, '<id>') : value,
    ])
  );
}

/** A channel with two entries, opened through the port. */
async function seed(adapter: LocalCommunityAdapter, title = 'Backend'): Promise<string> {
  const room = await adapter.createRoom({ title });
  await adapter.post(room.roomId, { text: 'one' });
  await adapter.post(room.roomId, { text: 'two' });
  return room.roomId;
}

describe('LocalCommunityAdapter cursors', () => {
  it('refuses a cursor another community minted', async () => {
    // The suite's cross-community case needs a second community, and a second
    // LOCAL one cannot exist: `'local'` is reserved and this process has one
    // store. So the value is built the only way it can arise here — handed in
    // by a caller holding a remote room's cursor.
    const { adapter } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);
    const foreign = `01K1BXCQ4M7GKZ9V0S2R7XQ3AB|${roomId}|${STREAM_EPOCH}|1` as CommunityCursor;

    expect(() => adapter.subscribeRoom(roomId, foreign)).toThrow(StaleCommunityCursorError);
    await expect(adapter.listEntries(roomId, { cursor: foreign })).rejects.toBeInstanceOf(
      StaleCommunityCursorError
    );
  });

  it('refuses a cursor from a superseded epoch, rather than serving its seq', async () => {
    // A room's `seq` IS durable, so this cursor names a real entry — which is
    // exactly why it has to be refused rather than bounded: the same integer in
    // a different epoch is a different promise about what a stream carries.
    const { adapter } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);
    const stale = `${LOCAL_COMMUNITY}|${roomId}|${STREAM_EPOCH - 1}|1` as CommunityCursor;

    expect(() => adapter.subscribeRoom(roomId, stale)).toThrow(StaleCommunityCursorError);
  });

  it('refuses a cursor ahead of the room, never suppressing what it has not sent', async () => {
    const { adapter } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);
    const ahead = `${LOCAL_COMMUNITY}|${roomId}|${STREAM_EPOCH}|99999` as CommunityCursor;

    expect(() => adapter.subscribeRoom(roomId, ahead)).toThrow(StaleCommunityCursorError);
  });

  it('refuses a malformed cursor rather than reading a number out of it', async () => {
    const { adapter } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);

    expect(() => adapter.subscribeRoom(roomId, '7' as CommunityCursor)).toThrow(
      StaleCommunityCursorError
    );
  });
});

describe('LocalCommunityAdapter room visibility', () => {
  it('refuses a room it cannot show and a room that is not there identically', async () => {
    // The half of the port's unknown-room contract the shared suite says it
    // does NOT assert: a room that exists and is invisible must be refused with
    // the same error AND the same message as one that does not exist. Arranging
    // it needs a second identity, which no port method can mint — so it is
    // proven here, against the visibility rule that ships.
    const { adapter, harness, store } = setup();
    await adapter.connect();
    const roomId = await seed(adapter, 'The owner’s own room');

    // A non-owner sees only the rooms it belongs to, and this one belongs to
    // the operator alone.
    const stranger = harness.authors.resolveAgent('/Users/planted/agents/stranger', 'Stranger').id;
    const asStranger = new LocalCommunityAdapter({
      service: harness.service,
      store,
      resolveIdentity: () => stranger,
    });
    await asStranger.connect();

    // Both ways a caller can ask, because the refusal must not depend on which.
    // The second probe is the one that pins the ORDER of the two checks: a
    // local cursor is bounded against what the room holds, and a room that is
    // not there holds nothing — so an adapter that validated the cursor before
    // the room would answer `StaleCommunityCursorError` for the absent room
    // (seq 1 is "ahead" of maxSeq 0) and `CommunityRoomNotFoundError` for the
    // invisible one. Two typed refusals that differ IS the probe the identical
    // message closes, re-opened one line earlier.
    const probes = [
      { asked: 'with no cursor', cursor: (): CommunityCursor | undefined => undefined },
      {
        asked: 'with a cursor addressed to the room asked about',
        cursor: (id: string) =>
          `${LOCAL_COMMUNITY}|${id}|${STREAM_EPOCH}|1` as CommunityCursor | undefined,
      },
    ];

    for (const { asked, cursor } of probes) {
      const invisible = refusalFrom(() => asStranger.subscribeRoom(roomId, cursor(roomId)));
      const absent = refusalFrom(() => asStranger.subscribeRoom(ABSENT, cursor(ABSENT)));

      expect(invisible, `${asked}: a room this identity cannot see is refused`).toBeInstanceOf(
        CommunityRoomNotFoundError
      );
      expect(absent, `${asked}: a room that is not there is refused the same way`).toBeInstanceOf(
        CommunityRoomNotFoundError
      );
      // Indistinguishable down to the message, once the id each was asked about
      // is normalized away. Any difference is the probe that would tell a
      // caller holding an id that somebody else's room exists.
      expect(
        invisible.message.replace(roomId, '<id>'),
        `${asked}: an invisible room and an absent one must read identically`
      ).toBe(absent.message.replace(ABSENT, '<id>'));
      // And nothing hangs off the error either. Message equality alone would
      // let a later `reason` field carry the difference the message no longer
      // does, so the shape is compared too — keys first, because "one refusal
      // grew a field" is the failure worth naming, then values.
      expect(
        Object.keys(invisible).sort(),
        `${asked}: a field on one refusal and not the other is a probe`
      ).toEqual(Object.keys(absent).sort());
      expect(
        ownShape(invisible, roomId),
        `${asked}: no property may differ once the id is normalized`
      ).toEqual(ownShape(absent, ABSENT));
    }
  });
});

describe('LocalCommunityAdapter projection', () => {
  it('keeps this machine off the wire', async () => {
    // This used to name `workspaceId`, the one local-only room column, and
    // assert it was absent. That column is gone (spec `project-rooms` §3.1,
    // DOR-1591) — a room's own files are now a `room-repo.json` sidecar and a
    // `room_repos` cache row, further from this port than the column ever was —
    // and rewriting the assertion as "the serialized room holds no path" would
    // have been vacuous, because nothing this projection reads carries one any
    // more.
    //
    // So the guard is stated the way it can still fail: the projected room's
    // fields are pinned exactly. A local-only field added to `CommunityRoom`
    // later — a repo path, a checkout, anything named after this machine —
    // reddens this, which a "does not contain a path" check would not.
    const { adapter, harness } = setup();
    await adapter.connect();
    const created = harness.service.createRoom(
      { kind: 'channel', title: 'Bound', members: [], agentPaths: [AGENT_PATH] },
      harness.human
    );

    const room = await adapter.getRoom(created.id);
    expect(room).not.toBeNull();
    expect(Object.keys(room!).sort()).toEqual([
      'archived',
      'community',
      'createdAt',
      'kind',
      'lastActivityAt',
      'roomId',
      'slug',
      'title',
      'topic',
      'unreadCount',
    ]);

    // The member half, which DOES have something to strip: an agent's natural
    // key is its absolute home directory, and no roster projection may carry
    // one to another community.
    const members = await adapter.listMembers(created.id);
    expect(members.some((m) => m.kind === 'agent')).toBe(true);
    expect(JSON.stringify(members)).not.toContain('/Users/planted');
  });

  it('rolls a thread up onto its root, and counts the root out of its own replies', async () => {
    const { adapter } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);
    const [root] = (await adapter.listEntries(roomId)).entries;
    await adapter.post(roomId, { text: 'first answer', parentEntryId: root!.id });
    await adapter.post(roomId, { text: 'second answer', parentEntryId: root!.id });

    const page = await adapter.listEntries(roomId);
    const rolled = page.entries.find((entry) => entry.id === root!.id);
    expect(
      rolled?.thread?.replyCount,
      '"2 replies" means two answers, not the opener plus one'
    ).toBe(2);
    expect(rolled?.thread?.lastReplyAt).toBeTruthy();
    expect(
      page.entries.find((entry) => entry.id !== root!.id)?.thread,
      'an entry with no replies carries no summary at all'
    ).toBeUndefined();
  });

  it('lists an archived room, because an archived room still reads', async () => {
    const { adapter } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);
    await adapter.updateRoom(roomId, { archived: true });

    const listed = (await adapter.listRooms()).find((room) => room.roomId === roomId);
    expect(listed?.archived).toBe(true);
    await expect(adapter.getRoom(roomId)).resolves.not.toBeNull();
  });
});

describe('LocalCommunityAdapter roster and read cursor', () => {
  it('removes a member idempotently, the way the port requires', async () => {
    const { adapter, harness } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);

    // Nobody by that id was ever in the room; the shipped service calls that a
    // typed refusal, and the port calls it the outcome the caller asked for.
    await expect(adapter.removeMember(roomId, 'nobody-by-that-id')).resolves.toBeUndefined();
    await expect(adapter.removeMember(roomId, harness.human)).resolves.toBeUndefined();
    await expect(
      adapter.removeMember(roomId, harness.human),
      'removing someone twice is still removed'
    ).resolves.toBeUndefined();
  });

  it('reports no read cursor until one is set, then keeps it monotonic', async () => {
    const { adapter } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);
    const { entries } = await adapter.listEntries(roomId);

    await expect(adapter.getReadCursor(roomId), 'nothing read yet is null, not zero').resolves.toBe(
      null
    );

    await adapter.setReadCursor(roomId, entries[1]!.cursor);
    await expect(adapter.getReadCursor(roomId)).resolves.toBe(entries[1]!.cursor);

    // A stale client must not be able to un-read a room for a second one
    // holding the same membership.
    await adapter.setReadCursor(roomId, entries[0]!.cursor);
    await expect(adapter.getReadCursor(roomId)).resolves.toBe(entries[1]!.cursor);
  });
});

describe('LocalCommunityAdapter signals', () => {
  it('forwards a signal its OWN producer published, payload intact', async () => {
    // `signals: 'both'` claims two directions, and the shared suite can only
    // check one of them: it has no way to make a backend produce a signal of its
    // own, so C15 only ever sees what it published itself. The direction that
    // matters for presence is the other one — the producer is the trigger
    // dispatcher, and nobody would care about an indicator only the person
    // working can see — so it is pinned here, against the room's real channel.
    const { adapter, harness } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);
    const [first] = (await adapter.listEntries(roomId)).entries;
    const agent = harness.authors.resolveAgent(AGENT_PATH, 'Ana');

    const iterator = adapter.subscribeRoom(roomId)[Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).value?.type).toBe('snapshot');

      // Exactly the call the dispatcher makes at claim, agent and all.
      harness.service.publishSignal(roomId, 'progress', agent.id, {
        state: 'working',
        entryId: first!.id,
        since: '2026-07-29T00:00:00.000Z',
      });
      const presence = await iterator.next();
      expect(presence.value?.type, 'a signal the room produced reaches the port').toBe('signal');
      expect(presence.value).toMatchObject({
        signal: 'progress',
        // The agent, NOT the connected human: an indicator attributed to
        // whoever holds the connection would name the wrong worker in every
        // case this feature exists for.
        memberId: agent.id,
        payload: {
          state: 'working',
          memberId: agent.id,
          entryId: first!.id,
          since: '2026-07-29T00:00:00.000Z',
        },
      });

      // A signal with no lifecycle carries no payload — an empty one would
      // claim a presence that is not there.
      harness.service.publishSignal(roomId, 'typing', harness.human);
      const typing = await iterator.next();
      expect(typing.value).toEqual({
        type: 'signal',
        signal: 'typing',
        memberId: harness.human,
        at: expect.any(String),
      });

      // ...and one durable entry behind them, so "the signals arrived" cannot be
      // confused with a stream that forwards everything it is handed: the entry
      // still arrives, in order, after them.
      const posted = await adapter.post(roomId, { text: 'after the signals' });
      const entry = await iterator.next();
      expect(entry.value?.type).toBe('entry');
      expect(entry.value?.type === 'entry' && entry.value.entry.id).toBe(posted.entryId);
    } finally {
      await iterator.return?.();
    }
  });

  it('carries no activity across the port, target or otherwise', async () => {
    // The room's own signal can say what a turn is DOING (DOR-1351). The port
    // does not carry it: `CommunityPresencePayloadSchema` has no field for one,
    // and adding it would be the first half of a leak somebody completes later
    // (ADR 260819-022127). This is the test that turns that decision into a
    // guarantee — red the moment somebody completes the projection out of
    // tidiness.
    const { adapter, harness } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);
    const [first] = (await adapter.listEntries(roomId)).entries;
    const agent = harness.authors.resolveAgent(AGENT_PATH, 'Ana');

    const iterator = adapter.subscribeRoom(roomId)[Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).value?.type).toBe('snapshot');

      harness.service.publishSignal(roomId, 'progress', agent.id, {
        state: 'working',
        entryId: first!.id,
        since: '2026-07-29T00:00:00.000Z',
        activity: { toolName: 'Read', target: 'standup.md' },
      });

      const presence = await iterator.next();
      const payload =
        presence.value?.type === 'signal' ? (presence.value.payload as object | undefined) : {};
      // Not the target, and not the bare verb either.
      expect(payload).toEqual({
        state: 'working',
        memberId: agent.id,
        entryId: first!.id,
        since: '2026-07-29T00:00:00.000Z',
      });
    } finally {
      await iterator.return?.();
    }
  });

  it('refuses to publish presence about somebody who is not in the room', async () => {
    // `memberId` is not decoration: whatever it says lands verbatim on every
    // subscriber's presence line as "X is working". The port leaves it
    // unvalidated for backends whose identity model is foreign to ours — ours
    // is this install's own author namespace, so a ghost id is a claim this
    // backend can see is false, and publishing it would put a worker on the
    // wall who does not exist. Refused loudly, and NEVER quietly re-attributed
    // to the caller: a fallback turns a bad id into "the operator is working".
    const { adapter } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);

    await expect(
      adapter.publishSignal(roomId, 'progress', { state: 'working', memberId: 'ghost-nobody' })
    ).rejects.toBeInstanceOf(CommunityMemberNotFoundError);
  });

  it('still lets one room member publish presence about another — the documented gap', async () => {
    // The residual this adapter does NOT close, pinned so it stays a decision
    // rather than a surprise: the roster check proves the subject EXISTS, not
    // that it is working. Mechanical honesty needs the claim map, which lives
    // in the dispatcher. That is tolerable only while every caller is
    // server-side code that already knows what it started — which is why the
    // method's doc requires claim-gating before any route or MCP tool exposes
    // it, and why this test is here to fail loudly if that day arrives quietly.
    const { adapter, harness } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);
    const member = harness.service.addMember(roomId, harness.human, {
      agentPath: AGENT_PATH,
      responseMode: 'silent',
    });

    await expect(
      adapter.publishSignal(roomId, 'progress', { state: 'working', memberId: member.authorId })
    ).resolves.toBeUndefined();
  });

  it('refuses to signal into a room it cannot see', async () => {
    // The port does not contract this method against an unknown room, so the
    // adapter answers the way it answers everywhere else: a room id is not a
    // capability. Without the check, a caller holding any id could put "someone
    // is working" onto a stream it is not allowed to read.
    const { adapter } = setup();
    await adapter.connect();

    await expect(adapter.publishSignal(ABSENT, 'progress', { state: 'working' })).rejects.toThrow(
      CommunityRoomNotFoundError
    );
  });
});

describe('LocalCommunityAdapter mentions', () => {
  it('round-trips the mentions the caller resolved, even when the text names nobody', async () => {
    // The port carries `mentions` on `post` and on the committed entry, and says
    // outright why: `responseMode: 'mention-only'` is unusable without it. This
    // adapter used to drop the field on the floor, so a caller that had already
    // resolved who it was addressing — the only thing the port lets it do — was
    // silently addressing nobody.
    const { adapter, harness } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);
    const agentId = harness.service.addMember(roomId, harness.human, {
      agentPath: AGENT_PATH,
    }).authorId;

    const posted = await adapter.post(roomId, {
      text: 'a line with no at-sign in it at all',
      mentions: [agentId],
    });

    const entry = (await adapter.listEntries(roomId)).entries.find((e) => e.id === posted.entryId);
    expect(
      entry?.mentions,
      'a mention the caller resolved is the entry’s, whatever the text says'
    ).toEqual([agentId]);
  });

  it('keeps what the text resolves to, and never repeats a name it already found', async () => {
    const { adapter, harness } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);
    const member = harness.service.addMember(roomId, harness.human, { agentPath: AGENT_PATH });
    const handle = harness.authors.getMany([member.authorId]).get(member.authorId)?.handle;
    expect(handle, 'the arrangement needs an addressable member').toBeTruthy();

    const posted = await adapter.post(roomId, {
      text: `over to you @${handle}`,
      mentions: [member.authorId],
    });

    const entry = (await adapter.listEntries(roomId)).entries.find((e) => e.id === posted.entryId);
    expect(entry?.mentions, 'named twice is still one member').toEqual([member.authorId]);
  });

  it('drops a mention naming somebody this room does not hold', async () => {
    // The same answer the text path gives an unresolvable `@name`: it is not an
    // error, it is somebody addressing a name this room has nobody for. What it
    // must not become is a way to address a member of a room the caller cannot
    // see.
    const { adapter, harness } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);
    const outsider = harness.authors.resolveAgent('/Users/planted/agents/outsider', 'Out').id;

    const posted = await adapter.post(roomId, { text: 'nothing to see', mentions: [outsider] });

    const entry = (await adapter.listEntries(roomId)).entries.find((e) => e.id === posted.entryId);
    expect(entry?.mentions, 'a stranger is not addressable by supplying their id').toEqual([]);
  });
});

describe('LocalCommunityAdapter room list', () => {
  /**
   * One room-list event, or a failure naming what was waited for. A room that
   * never leaves a sidebar is exactly a stream that never yields, so the
   * timeout IS the assertion here.
   *
   * @param iterator - The room-list stream to read.
   * @param what - What is being waited for, for the failure message.
   */
  async function nextListEvent(
    iterator: AsyncIterator<CommunityRoomListEvent>,
    what: string
  ): Promise<CommunityRoomListEvent> {
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 250).unref?.()
      ),
    ]);
    if (result.done) throw new Error(`the room-list stream ended before ${what}`);
    return result.value;
  }

  /**
   * An adapter connected as an agent rather than as the operator, plus the room
   * that agent is in.
   *
   * The identity matters and is the whole reason this case cannot live in the
   * shared suite: the operator sees every room on her own machine, so no act
   * available through the port takes a room out of HER view. An agent's view is
   * its memberships, which is the view a remote community gives everybody.
   */
  function asAgentIn(title: string): {
    harness: RoomHarness;
    adapter: LocalCommunityAdapter;
    agentId: string;
    roomId: string;
  } {
    const { harness, store } = setup();
    const room = harness.service.createRoom(
      { kind: 'channel', title, members: [], agentPaths: [AGENT_PATH] },
      harness.human
    );
    const agentId = harness.authors.resolveAgent(AGENT_PATH, 'Ana').id;
    const adapter = new LocalCommunityAdapter({
      service: harness.service,
      store,
      resolveIdentity: () => agentId,
    });
    return { harness, adapter, agentId, roomId: room.id };
  }

  it('reports a room that has left this identity’s view as removed', async () => {
    // The port has a `room_removed` event and this adapter never emitted one, so
    // a room somebody was ejected from stayed in their sidebar until the process
    // restarted — visible forever, and unreadable the moment it was clicked.
    const { harness, adapter, agentId, roomId } = asAgentIn('Backend');
    await adapter.connect();
    const iterator = adapter.subscribeRoomList()[Symbol.asyncIterator]();
    try {
      expect(
        (await adapter.listRooms()).map((room) => room.roomId),
        'the arrangement is only meaningful while the room IS in this view'
      ).toEqual([roomId]);

      harness.service.removeMember(roomId, harness.human, agentId);

      expect(await nextListEvent(iterator, 'the room_removed event')).toEqual({
        type: 'room_removed',
        community: LOCAL_COMMUNITY,
        roomId,
      });
      await expect(
        adapter.listRooms(),
        'and the room really is gone from the listing it was removed from'
      ).resolves.toEqual([]);
    } finally {
      await iterator.return?.();
    }
  });

  it('says nothing about a room this identity has never been able to see', async () => {
    // **The refusal machinery, re-opened on the room-list stream.** Visibility
    // read at the moment of a removal answers `null` for a room this identity
    // was never in — identically to one it was just ejected from — so an adapter
    // that emits on "invisible now" tells every listener the id of every room on
    // the machine the moment anybody leaves one. That is the same probe
    // `CommunityRoomNotFoundError` carries no reason field to keep closed, and
    // it leaks the one thing an id is not allowed to confirm: that somebody
    // else's room exists.
    //
    // The fix is a TRANSITION, not a state: only a room that left a view this
    // adapter had already reported is a room that went away.
    const { harness, adapter, roomId } = asAgentIn('Mine');
    await adapter.connect();
    const theirs = harness.service.createRoom(
      { kind: 'channel', title: 'Theirs', members: [], agentPaths: [] },
      harness.human
    );
    const stranger = harness.authors.resolveAgent(OTHER_AGENT_PATH, 'Other').id;
    harness.service.addMember(theirs.id, harness.human, { authorId: stranger });
    expect(
      (await adapter.listRooms()).map((room) => room.roomId),
      'the arrangement is only meaningful while the other room is invisible here'
    ).toEqual([roomId]);

    const iterator = adapter.subscribeRoomList()[Symbol.asyncIterator]();
    try {
      harness.service.removeMember(theirs.id, harness.human, stranger);

      await expect(
        nextListEvent(iterator, 'nothing at all'),
        'a room this identity never had cannot be a room it has lost — naming it is the probe'
      ).rejects.toThrow(/timed out/);
    } finally {
      await iterator.return?.();
    }
  });

  it('reports a room entering this identity’s view as added', async () => {
    // The other half of the same transition. A view is a membership here, so a
    // room arrives the moment this identity is put on its roster — and an
    // adapter that only ever watched `room_created` would never mention a room
    // that already existed when the invitation came.
    const { harness, adapter, agentId } = asAgentIn('Mine');
    await adapter.connect();
    const later = harness.service.createRoom(
      { kind: 'channel', title: 'Later', members: [], agentPaths: [] },
      harness.human
    );
    const iterator = adapter.subscribeRoomList()[Symbol.asyncIterator]();
    try {
      harness.service.addMember(later.id, harness.human, { authorId: agentId });

      const event = await nextListEvent(iterator, 'the room_added event');
      expect(event.type).toBe('room_added');
      expect(event.type === 'room_added' && event.room.roomId).toBe(later.id);
    } finally {
      await iterator.return?.();
    }
  });

  it('never reports a room this identity cannot see, however it changed', async () => {
    // `room_created` and `room_updated` rode the store rather than the
    // visibility rule, so a listener was told about every room on the machine —
    // the operator's direct messages included — with its title and topic
    // attached. Worse than the id leak above, and the same fix closes it.
    const { harness, adapter } = asAgentIn('Mine');
    await adapter.connect();
    const iterator = adapter.subscribeRoomList()[Symbol.asyncIterator]();
    try {
      const theirs = harness.service.createRoom(
        { kind: 'channel', title: 'Payroll', members: [], agentPaths: [] },
        harness.human
      );
      harness.service.updateRoom(theirs.id, harness.human, { title: 'Payroll v2' });

      await expect(
        nextListEvent(iterator, 'nothing at all'),
        'a room this identity cannot list must not arrive on its stream either'
      ).rejects.toThrow(/timed out/);
    } finally {
      await iterator.return?.();
    }
  });

  it('says nothing when a removal leaves this identity’s view unchanged', async () => {
    // Somebody else leaving a room is not this identity losing it. An adapter
    // that emitted `room_removed` on every membership change would empty a
    // sidebar the first time an agent was taken off a roster.
    const { harness, adapter, roomId } = asAgentIn('Backend');
    await adapter.connect();
    const other = harness.authors.resolveAgent(OTHER_AGENT_PATH, 'Other').id;
    harness.service.addMember(roomId, harness.human, { authorId: other });
    const iterator = adapter.subscribeRoomList()[Symbol.asyncIterator]();
    try {
      harness.service.removeMember(roomId, harness.human, other);

      await expect(
        nextListEvent(iterator, 'nothing at all'),
        'a room this identity can still see is not a room that went away'
      ).rejects.toThrow(/timed out/);
    } finally {
      await iterator.return?.();
    }
  });
});

describe('LocalCommunityAdapter subscription teardown', () => {
  it('leaves nothing registered when opening a stream fails part-way', async () => {
    // A subscription that throws before it returns a stream leaves nobody able
    // to end it — so it must leave nothing to end. The broadcaster is the half
    // that is observable from outside; the other half (this adapter's own room
    // registry and its fan-out listener) is structural, because nothing fallible
    // runs after registration.
    const { adapter, harness, store } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);
    vi.spyOn(store, 'listEntries').mockImplementation(() => {
      throw new Error('the store gave out mid-read');
    });

    expect(() => adapter.subscribeRoom(roomId)).toThrow('the store gave out mid-read');
    expect(
      harness.service.stream.subscriberCount(roomId),
      'the live subscriber opened before the read is released when the read fails'
    ).toBe(0);
  });
});

describe('LocalCommunityAdapter connection', () => {
  it('types a store that will not answer as unreachable, and never throws', async () => {
    const { adapter, harness } = setup();
    harness.db.$client.close();

    const connection = await adapter.connect();
    expect(connection.status).toBe('unreachable');
    expect(connection.identity).toBeUndefined();
    expect(connection.error, 'a failed connection says what happened, for the log').toBeTruthy();
  });

  it('reports the owner as the connected identity', async () => {
    const { adapter, harness } = setup();
    const connection = await adapter.connect();
    expect(connection.status).toBe('connected');
    expect(connection.identity).toEqual({
      community: LOCAL_COMMUNITY,
      memberId: harness.human,
    });
  });
});
