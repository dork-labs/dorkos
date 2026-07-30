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
  CommunityRoomNotFoundError,
  LOCAL_COMMUNITY,
  StaleCommunityCursorError,
  type CommunityCursor,
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

/** One adapter over one fresh in-memory install. */
function setup(): { adapter: LocalCommunityAdapter; harness: RoomHarness; store: RoomStore } {
  const harness = createRoomHarness({
    agents: agentLookupFor({}),
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
    // Two local-only columns, and neither belongs to a community: `workspaceId`
    // binds a room to a checkout on THIS machine, and an author's natural key is
    // an absolute directory.
    const { adapter, harness } = setup();
    await adapter.connect();
    const created = harness.service.createRoom(
      {
        kind: 'channel',
        title: 'Bound',
        members: [],
        agentPaths: [],
        workspaceId: '/Users/planted/checkouts/dorkos',
      },
      harness.human
    );

    const room = await adapter.getRoom(created.id);
    expect(room).not.toBeNull();
    expect(Object.keys(room!), 'no room field names a path on this machine').not.toContain(
      'workspaceId'
    );
    expect(JSON.stringify(room)).not.toContain('/Users/planted');
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
  it('observes no signal, not just emits none', async () => {
    // `signals: 'none'` claims two things, and the shared suite can only check
    // one of them: it has no way to make a backend produce a signal of its own,
    // so its quiet-window assertion passes against an adapter that would happily
    // forward one. The local backend HAS a live signal channel, so the second
    // half — "neither emits nor observes" — has to be pinned here.
    const { adapter, harness } = setup();
    await adapter.connect();
    const roomId = await seed(adapter);

    const iterator = adapter.subscribeRoom(roomId)[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      expect(first.value?.type).toBe('snapshot');

      // Real signals, published the way the room's own producers publish them.
      harness.service.publishSignal(roomId, 'typing', harness.human);
      harness.service.publishSignal(roomId, 'progress', harness.human);
      // ...and one durable entry behind them, so "nothing arrived" cannot be
      // confused with "the stream was not delivering".
      const posted = await adapter.post(roomId, { text: 'after the signals' });

      const next = await iterator.next();
      expect(next.value?.type, 'a signal-less adapter forwards no signal').toBe('entry');
      expect(next.value?.type === 'entry' && next.value.entry.id).toBe(posted.entryId);
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
