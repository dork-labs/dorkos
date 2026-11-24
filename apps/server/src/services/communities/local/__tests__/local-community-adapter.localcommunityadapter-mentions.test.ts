import { AGENT_PATH, OTHER_AGENT_PATH, setup, seed } from './local-community-adapter.fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import { LOCAL_COMMUNITY, type CommunityRoomListEvent } from '@dorkos/shared/community-adapter';
import { type RoomHarness } from '../../../rooms/__tests__/room-test-harness.js';
import { LocalCommunityAdapter } from '../local-community-adapter.js';

describe('LocalCommunityAdapter mentions', () => {
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
