/**
 * `BridgeCatchUp` — the catch-up scan (chats-as-channels spec §6.1), the
 * AUTHORITY for outbound delivery. It walks the durable log for undelivered
 * entries and hands each to the real {@link ChatBridgeDelivery}, so an entry
 * committed while the adapter was down is delivered on the next trigger — driven
 * by the scan, never by the live `RoomBroadcaster` stream (which drops events
 * for absent subscribers).
 *
 * The delivery setup is the shared one in `deliver.fixtures.ts`; only the
 * platform outcome is faked, so a delivery fails while "down" and succeeds
 * after "reconnect".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRoomHarness, scriptedRunner } from '../../../rooms/__tests__/room-test-harness.js';
import { buildBusyNotice } from '../../../rooms/notices/notice-copy.js';
import { BridgeCatchUp, type ChatBridgeDelivery } from '../index.js';
import { AGENT_PATH, agentLookup, bindingRow, useDeliveryFixture } from './deliver.fixtures.js';

describe('BridgeCatchUp (chats-as-channels §6.1)', () => {
  const t = useDeliveryFixture();
  const { bridgeRequest, makeDelivery, seedInbound, agentPost } = t;
  let platformUp: boolean;
  let delivery: ChatBridgeDelivery;
  let catchUp: BridgeCatchUp;

  /** A bridged DM on chat 555 with one inbound message to answer. */
  function bridgedDm() {
    const room = t.harness.service.createBridgedRoom(bridgeRequest('555'));
    delivery = makeDelivery(bindingRow(room.id, '555'));
    catchUp = new BridgeCatchUp({
      bridges: t.harness.bridges,
      entries: t.harness.store,
      delivery,
    });
    const inbound = seedInbound(room.id, '555', 'q', 'pm-1');
    return { room, inbound };
  }

  const contents = () => t.publish.mock.calls.map((c) => (c[1] as { content?: string }).content);
  const cursor = (roomId: string) => t.harness.bridges.findBridgeByRoom(roomId)!.lastDeliveredSeq;

  beforeEach(() => {
    // A silent runner: an inbound message triggers a turn that says nothing, so
    // the only deliverable entries are the ones each test writes.
    t.harness = createRoomHarness({ agents: agentLookup, runner: scriptedRunner(() => null) });
    platformUp = true;
    t.nextAdapterResult = () =>
      platformUp
        ? { success: true, responseMessageId: 'tg-out' }
        : { success: false, error: 'down' };
  });

  it('A10.7: an entry committed while the adapter is down is delivered after reconnect, exactly once, by the scan', async () => {
    const { room, inbound } = bridgedDm();
    // A live-stream subscriber DROPPED before the entry commits: the broadcaster
    // drops the event, so only the scan can carry this delivery.
    const ac = new AbortController();
    void t.harness.service.stream.subscribe(room.id, ac.signal);
    ac.abort();
    expect(t.harness.service.stream.subscriberCount(room.id)).toBe(0);

    platformUp = false;
    const answer = agentPost(room.id, 'answer written while down', inbound.id);
    expect(await delivery.deliverEntry(answer)).toBe('undelivered');
    expect(t.harness.bridges.findRefByEntry(answer.id)).toBeNull();

    platformUp = true;
    t.publish.mockClear();
    await catchUp.scanRoom(room.id);
    await catchUp.scanRoom(room.id);
    expect(contents()).toEqual(['answer written while down']);
    expect(t.harness.bridges.findRefByEntry(answer.id)?.direction).toBe('outbound');
  });

  it('a transient failure parks the cursor; the next scan delivers everything in seq order', async () => {
    const { room, inbound } = bridgedDm();
    const a1 = agentPost(room.id, 'answer one', inbound.id);
    const a2 = agentPost(room.id, 'answer two', inbound.id);

    platformUp = false;
    await catchUp.scanRoom(room.id);
    expect(t.harness.bridges.findRefByEntry(a1.id)).toBeNull();
    expect(cursor(room.id)).toBeLessThan(a1.seq);

    platformUp = true;
    t.publish.mockClear();
    await catchUp.scanRoom(room.id);
    expect(contents()).toEqual(['answer one', 'answer two']);
    expect(cursor(room.id)).toBeGreaterThanOrEqual(a2.seq);
  });

  it('a notice catches up too, not just posts (a post-scoped scan would strand turn_failed)', async () => {
    const { room, inbound } = bridgedDm();
    const ana = t.harness.authors.resolveAgent(AGENT_PATH, 'Ana');
    const notice = t.harness.service.postNotice(
      room.id,
      { text: 'Ana ran into a problem.', notice: 'turn_failed', subjectAuthorId: ana.id },
      { root: inbound.id, depth: 1 }
    );

    await catchUp.scanRoom(room.id);

    expect(t.harness.bridges.findRefByEntry(notice.id)?.direction).toBe('outbound');
  });

  it('DOR-1359: a damped repeat busy notice settles the cursor — the scan moves past it and delivers what follows', async () => {
    // A repeat never becomes deliverable, so a scan that stopped on it would
    // stall the room forever.
    const { room, inbound } = bridgedDm();
    const ana = t.harness.authors.resolveAgent(AGENT_PATH, 'Ana');
    const busy = () =>
      t.harness.service.postNotice(room.id, buildBusyNotice('Ana', ana.id, 'held-too-long'), {
        root: inbound.id,
        depth: 1,
      });
    const first = busy();
    const repeat = busy();
    const behind = agentPost(room.id, 'queued behind the repeat', inbound.id);

    await catchUp.scanRoom(room.id);

    expect(t.harness.bridges.findRefByEntry(first.id)?.direction).toBe('outbound');
    expect(t.harness.bridges.findRefByEntry(repeat.id)).toBeNull();
    expect(t.harness.bridges.findRefByEntry(behind.id)?.direction).toBe('outbound');
    expect(cursor(room.id)).toBe(behind.seq);
  });
});
