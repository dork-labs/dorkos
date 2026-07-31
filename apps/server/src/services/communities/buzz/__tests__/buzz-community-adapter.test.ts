/**
 * @vitest-environment node
 *
 * What the shared conformance suite structurally cannot reach on this backend.
 *
 * The suite proves the port's contract. These prove the things that are true of
 * Buzz specifically and would otherwise be nobody's assertion: that a deeper
 * thread keeps its ancestry, that a private channel is invisible, that a poll
 * reports a room going away, that the unadmitted disclosure is something a person
 * can act on, and that nothing at all is readable before the handshake.
 */
import { describe, expect, it } from 'vitest';
import type {
  CommunityCursor,
  CommunityRef,
  CommunityRoomEvent,
} from '@dorkos/shared/community-adapter';
import { BuzzCommunityAdapter } from '../buzz-community-adapter.js';
import { deriveBuzzIdentity } from '../buzz-identity.js';
import { FakeBuzzRelay } from './fake-buzz-relay.js';

/** The credential every adapter here derives its key from. */
const CREDENTIAL = 'a'.repeat(63) + '2';

/** Fast enough that a poll assertion is a test rather than a wait. */
const POLL_INTERVAL_MS = 10;

/** Our pubkey, as the relay knows it. */
const PUBKEY = deriveBuzzIdentity(CREDENTIAL).pubkey;

/**
 * An adapter over a relay that has already admitted our key.
 *
 * @param relay - The relay to talk to.
 */
function adapterOn(relay: FakeBuzzRelay, historyPageSize = 2): BuzzCommunityAdapter {
  relay.admitToRelay(PUBKEY);
  return new BuzzCommunityAdapter({
    community: 'buzz-test' as CommunityRef,
    relayUrl: 'ws://fake-relay.test/',
    credential: CREDENTIAL,
    openSocket: relay.socketFactory(),
    roomListPollIntervalMs: POLL_INTERVAL_MS,
    connectTimeoutMs: 500,
    // Small enough that every historical read comes back saturated, so the
    // window walk runs rather than being skipped by an under-full first page.
    historyPageSize,
  });
}

/** Pull events from a room stream until `predicate` matches, or fail loudly. */
async function until(
  iterator: AsyncIterator<CommunityRoomEvent>,
  predicate: (event: CommunityRoomEvent) => boolean,
  what: string
): Promise<CommunityRoomEvent> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const next = await iterator.next();
    if (next.done) throw new Error(`stream ended before ${what}`);
    if (predicate(next.value)) return next.value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('BuzzCommunityAdapter history, against what the relay actually holds', () => {
  // THE ONLY GROUND TRUTH IN THIS DIRECTORY, and it is why these cases exist
  // rather than another conformance registration. The shared suite has no
  // independent view of a room: it checks the adapter's paging against the
  // adapter's own full read, so a history walk that silently truncates is
  // self-consistent and passes every assertion in it, at any page size and any
  // depth. Only a fixture that KNOWS WHAT IT WROTE can tell the difference.
  //
  // The seed is shaped to make the walk work for it: more entries than a page
  // holds, ties inside one second so a boundary must land in the middle of one,
  // and a page size small enough that every read comes back saturated.
  for (const limitSemantics of ['newest', 'oldest'] as const) {
    it(`reads back every entry the relay holds when limit keeps the ${limitSemantics}`, async () => {
      const relay = new FakeBuzzRelay({ limitSemantics });
      const adapter = adapterOn(relay);
      await adapter.connect();
      const channelId = relay.createChannel();

      // Seven entries over four seconds, two of them shared. A walk that steps
      // by timestamp alone splits a tie; one that trusts a page's end without
      // asking drops whatever is beyond it.
      const seconds = [1000, 1000, 1001, 1002, 1002, 1003, 1004];
      const written = seconds.map((createdAt, index) =>
        relay.post({ channelId, authorSecret: 'writer', text: `entry ${index}`, createdAt })
      );
      const expected = [...written]
        .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
        .map((event) => event.id);
      await adapter.listRooms();

      const paged: string[] = [];
      let cursor: CommunityCursor | undefined;
      for (let guard = 0; guard < 50; guard += 1) {
        const page = await adapter.listEntries(
          channelId,
          cursor ? { cursor, limit: 2 } : { limit: 2 }
        );
        paged.push(...page.entries.map((entry) => entry.id));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      expect(
        paged,
        'paging must visit every entry the relay holds, exactly once, in the total order'
      ).toEqual(expected);
      expect(
        (await adapter.listEntries(channelId, { limit: 500 })).entries.map((entry) => entry.id),
        'and a single wide read must agree with the paged walk'
      ).toEqual(expected);

      await adapter.disconnect();
    });
  }

  it('replays every entry after a cursor onto a resumed subscription', async () => {
    // The same ground truth, on the other surface. A resume that is short is a
    // gap, and the shared suite's U6 can only check the resume against the same
    // truncated read it would compare it to.
    const relay = new FakeBuzzRelay({ limitSemantics: 'oldest' });
    const adapter = adapterOn(relay);
    await adapter.connect();
    const channelId = relay.createChannel();
    const written = [1000, 1000, 1001, 1002, 1003].map((createdAt, index) =>
      relay.post({ channelId, authorSecret: 'writer', text: `entry ${index}`, createdAt })
    );
    await adapter.listRooms();

    const ordered = [...written].sort(
      (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1)
    );
    const first = await adapter.listEntries(channelId, { limit: 1 });
    expect(first.entries[0]!.id).toBe(ordered[0]!.id);

    const iterator = adapter
      .subscribeRoom(channelId, first.entries[0]!.cursor)
      [Symbol.asyncIterator]();
    try {
      const snapshot = await until(iterator, (e) => e.type === 'snapshot', 'the resumed snapshot');
      expect(
        snapshot.type === 'snapshot' ? snapshot.entries.map((entry) => entry.id) : [],
        'a resume replays everything after the cursor — every one of them'
      ).toEqual(ordered.slice(1).map((event) => event.id));
    } finally {
      await iterator.return?.();
      await adapter.disconnect();
    }
  });
});

describe('BuzzCommunityAdapter', () => {
  it('reads a thread deeper than one level without flattening it', async () => {
    // `threadDepth: 'unbounded'` is the flag; this is the behaviour behind it.
    // The shared suite can only exercise a thread ceiling through `post`, which
    // this backend refuses — so without this assertion the deepest structural
    // mismatch in the whole port would be declared and never demonstrated.
    const relay = new FakeBuzzRelay();
    const adapter = adapterOn(relay);
    await adapter.connect();

    const channelId = relay.createChannel();
    const root = relay.post({ channelId, authorSecret: 'writer', text: 'the question' });
    const reply = relay.post({
      channelId,
      authorSecret: 'writer',
      text: 'an answer',
      rootId: root.id,
    });
    const deeper = relay.post({
      channelId,
      authorSecret: 'writer',
      text: 'an answer to the answer',
      rootId: root.id,
      parentId: reply.id,
    });

    const topLevel = await adapter.listEntries(channelId, { limit: 50 });
    expect(
      topLevel.entries.map((entry) => entry.id),
      'a default read is the timeline: the root only, replies excluded'
    ).toEqual([root.id]);

    const thread = await adapter.listEntries(channelId, { thread: root.id, limit: 50 });
    expect(
      thread.entries.map((entry) => entry.id),
      'a thread read returns the whole subtree, because every descendant tags the root'
    ).toEqual([reply.id, deeper.id]);

    const deepest = thread.entries.find((entry) => entry.id === deeper.id)!;
    expect(deepest.threadRootEntryId, 'the root is preserved').toBe(root.id);
    expect(
      deepest.parentEntryId,
      'and so is the parent — a level-two reply that reported the root as its parent would have lost the ancestry the flag promises to keep'
    ).toBe(reply.id);

    await adapter.disconnect();
  });

  it('never shows a private channel it is not a member of', async () => {
    const relay = new FakeBuzzRelay();
    const adapter = adapterOn(relay);
    await adapter.connect();

    const open = relay.createChannel({ name: 'open-to-all' });
    const secret = relay.createChannel({ name: 'not-for-us', visibility: 'private' });

    const rooms = await adapter.listRooms();
    expect(rooms.map((room) => room.roomId)).toEqual([open]);
    await expect(
      adapter.getRoom(secret),
      'an invisible channel resolves null, exactly as an absent one does'
    ).resolves.toBeNull();
    await expect(
      adapter.listMembers(secret),
      'and its roster is empty rather than a refusal'
    ).resolves.toEqual([]);

    await adapter.disconnect();
  });

  it('reports a channel appearing and disappearing on the room-list stream', async () => {
    const relay = new FakeBuzzRelay();
    const adapter = adapterOn(relay);
    await adapter.connect();
    const channelId = relay.createChannel({ name: 'temporary' });
    await adapter.listRooms();

    const iterator = adapter.subscribeRoomList()[Symbol.asyncIterator]();
    try {
      relay.deleteChannel(channelId);
      const deadline = Date.now() + 2_000;
      let removed = false;
      while (!removed && Date.now() < deadline) {
        const next = await iterator.next();
        if (next.done) break;
        removed = next.value.type === 'room_removed' && next.value.roomId === channelId;
      }
      expect(
        removed,
        'a poll is how this backend notices, and the consumer never learns that'
      ).toBe(true);
    } finally {
      await iterator.return?.();
      await adapter.disconnect();
    }
  });

  it('delivers a message posted after the snapshot, live', async () => {
    const relay = new FakeBuzzRelay();
    const adapter = adapterOn(relay);
    await adapter.connect();
    const channelId = relay.createChannel();
    relay.post({ channelId, authorSecret: 'writer', text: 'before' });
    await adapter.listRooms();

    const iterator = adapter.subscribeRoom(channelId)[Symbol.asyncIterator]();
    try {
      const snapshot = await until(iterator, (e) => e.type === 'snapshot', 'the opening snapshot');
      expect(snapshot.type === 'snapshot' && snapshot.entries).toHaveLength(1);

      const posted = relay.post({ channelId, authorSecret: 'writer', text: 'after' });
      const live = await until(
        iterator,
        (e) => e.type === 'entry' && e.entry.id === posted.id,
        'the live entry'
      );
      expect(live.type === 'entry' && live.entry.text).toBe('after');
    } finally {
      await iterator.return?.();
      await adapter.disconnect();
    }
  });

  it('tells a person what to do about a community that has not admitted it', async () => {
    const relay = new FakeBuzzRelay({ requireRelayMembership: true });
    const adapter = new BuzzCommunityAdapter({
      community: 'buzz-test' as CommunityRef,
      relayUrl: 'ws://fake-relay.test/',
      credential: CREDENTIAL,
      openSocket: relay.socketFactory(),
      connectTimeoutMs: 500,
    });

    const connection = await adapter.connect();
    expect(connection.status).toBe('not-admitted');
    // The disclosure is the whole point of the status: a person who is told
    // "unauthorized" goes looking for a key they cannot see and never will,
    // because there is no key to fix. This one names the only action there is.
    expect(connection.disclosure).toMatch(/ask them/i);
    expect(
      connection.disclosure,
      "and it is plain language, not the relay's protocol string"
    ).not.toContain('restricted:');
    expect(connection.error, 'which is kept, for the log').toContain('restricted:');
    await adapter.disconnect();
  });

  it("drops a community's cached rooms when it stops admitting us", async () => {
    // Normative on the port rather than a cache's discretion: a member who was
    // removed and a key that was never admitted reach the same status, so one
    // rule covers both.
    const relay = new FakeBuzzRelay({ requireRelayMembership: true });
    const adapter = adapterOn(relay);
    await adapter.connect();
    relay.createChannel();
    expect(await adapter.listRooms()).toHaveLength(1);

    relay.removeFromRelay(PUBKEY);
    await adapter.disconnect();
    const again = await adapter.connect();
    expect(again.status).toBe('not-admitted');
    expect(
      () => adapter.subscribeRoom(relay.relayPubkey),
      'nothing cached survives a refusal, so nothing can be streamed out of it'
    ).toThrow();
  });

  it('reads nothing at all before the handshake', async () => {
    // The premise the ticket started from — a keyless read-only adapter — is
    // refuted here rather than only in a research note. A read before the
    // handshake fails outright: it never becomes a partial listing, which is
    // what an adapter that treated auth as optional would produce. (The relay's
    // own `auth-required` refusal is the other half, and the fake speaks it —
    // this side is what a caller sees.)
    const relay = new FakeBuzzRelay();
    const adapter = adapterOn(relay);
    relay.createChannel();
    await expect(adapter.listRooms()).rejects.toThrow(/not connected/);
    await adapter.disconnect();
  });
});
