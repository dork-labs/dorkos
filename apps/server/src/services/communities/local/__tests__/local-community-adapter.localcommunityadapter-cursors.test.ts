import {
  AGENT_PATH,
  setup,
  ABSENT,
  refusalFrom,
  ownShape,
  seed,
} from './local-community-adapter.fixtures.js';
import { describe, expect, it } from 'vitest';
import {
  CommunityMemberNotFoundError,
  CommunityRoomNotFoundError,
  LOCAL_COMMUNITY,
  StaleCommunityCursorError,
  type CommunityCursor,
} from '@dorkos/shared/community-adapter';
import { STREAM_EPOCH } from '../../../../lib/stream-cursor.js';
import { LocalCommunityAdapter } from '../local-community-adapter.js';

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
});

describe('LocalCommunityAdapter roster', () => {
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
