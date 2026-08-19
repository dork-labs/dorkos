/**
 * `BridgeCatchUp` — the catch-up scan (chats-as-channels spec §6.1), the
 * AUTHORITY for outbound delivery. It walks the durable log for undelivered
 * entries and hands each to the real {@link ChatBridgeDelivery}, so an entry
 * committed while the adapter was down is delivered on the next trigger — driven
 * by the scan, never by the live `RoomBroadcaster` stream (which drops events
 * for absent subscribers).
 *
 * The real `RoomService`, `BridgeStore`, and `ChatBridgeDelivery` run throughout
 * (`createRoomHarness`); only the relay publish pipeline is faked, so a delivery
 * can be made to fail while "down" and succeed after "reconnect".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PublishOptions, PublishResult } from '@dorkos/relay';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import type { CreateBridgedRoomRequest } from '../../../rooms/room-service.js';
import { RoomBroadcaster } from '../../../rooms/room-stream.js';
import { externalSenderIdentity } from '../../platform-identity.js';
import { buildBusyNotice } from '../../../rooms/notices/notice-copy.js';
import { BridgeCatchUp, ChatBridgeDelivery, type Bridge } from '../index.js';

const AGENT_PATH = '/agents/ana';
const agentLookup = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});
const ADAPTER = 'tg-main';
const BINDING_ID = 'binding-ana';

function subjectFor(bridge: Bridge): string {
  return bridge.platformChatType === 'private'
    ? `relay.human.telegram.${bridge.adapterId}.${bridge.chatId}`
    : `relay.human.telegram.${bridge.adapterId}.group.${bridge.chatId}`;
}

describe('BridgeCatchUp (chats-as-channels §6.1)', () => {
  let harness: RoomHarness;
  /** Whether the (faked) platform is currently reachable. */
  let platformUp: boolean;
  /** Every publish attempt, for exactly-once assertions. */
  let publish: ReturnType<typeof vi.fn>;
  let delivery: ChatBridgeDelivery;
  let catchUp: BridgeCatchUp;

  function bridgeRequest(chatId: string, group = false): CreateBridgedRoomRequest {
    return {
      adapterId: ADAPTER,
      chatId,
      bindingId: BINDING_ID,
      chatType: group ? 'group' : 'private',
      channelType: group ? 'group' : null,
      title: group ? 'Team' : 'Miguel',
      agentPath: AGENT_PATH,
      operatorAuthorId: harness.human,
    };
  }

  /** Post an inbound entry with its inbound ref — an ingested message. */
  function seedInbound(roomId: string, chatId: string, text: string, platformMessageId: string) {
    const identity = externalSenderIdentity(
      { senderName: 'Miguel', platformData: { fromId: '145223' } },
      { platformType: 'telegram', instanceId: ADAPTER }
    );
    if (!identity) throw new Error('identity');
    const { entry } = harness.service.postExternal(roomId, {
      identity,
      text,
      recordRef: (entryId, tx) =>
        harness.bridges.recordInboundRef(
          {
            roomId,
            entryId,
            chatId,
            adapterId: ADAPTER,
            platformMessageId,
            createdAt: new Date().toISOString(),
          },
          tx
        ),
    });
    const full = harness.store.getEntryById(roomId, entry.id);
    if (!full) throw new Error('inbound entry vanished');
    return full;
  }

  function agentPost(roomId: string, text: string, replyToInbound?: string) {
    const agent = harness.authors.resolveAgent(AGENT_PATH, 'Ana');
    return harness.service.post(roomId, {
      authorId: agent.id,
      text,
      ...(replyToInbound ? { trigger: { root: replyToInbound, depth: 1 } } : {}),
    });
  }

  beforeEach(() => {
    // A silent runner: an inbound message triggers a turn that says nothing, so
    // the only deliverable posts are the ones each test writes explicitly — the
    // scan's candidate set stays deterministic.
    harness = createRoomHarness({ agents: agentLookup, runner: scriptedRunner(() => null) });
    platformUp = true;
    let out = 0;
    publish = vi.fn(
      async (
        _subject: string,
        _payload: unknown,
        _opts: PublishOptions
      ): Promise<PublishResult> => {
        if (!platformUp) {
          // Adapter down / disconnected: nothing routed anywhere.
          return { messageId: 'm', deliveredTo: 0 };
        }
        out += 1;
        return {
          messageId: 'm',
          deliveredTo: 1,
          adapterResult: { success: true, responseMessageId: `tg-${out}` },
        };
      }
    );
    delivery = new ChatBridgeDelivery({
      entries: harness.store,
      rooms: harness.service,
      bridges: harness.bridges,
      authors: harness.authors,
      publisher: { publish: publish as never },
      lifecycle: { unbridge: async () => {} },
      resolveSubject: subjectFor,
      operatorAuthorId: () => harness.human,
      sleep: async () => {},
      retryBackoffMs: [1, 1],
    });
    catchUp = new BridgeCatchUp({ bridges: harness.bridges, entries: harness.store, delivery });
    delivery.setRecoveryHook((roomId) => void catchUp.scanRoom(roomId));
  });

  it('A10.7: an entry committed while the adapter is down is delivered after reconnect, exactly once, by the scan', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    // A live-stream subscriber that is DROPPED before the entry commits: with no
    // subscriber, `RoomBroadcaster.publish` drops the event, so the live fan-out
    // cannot be what carries this delivery — only the scan can.
    const broadcaster = (harness.service as unknown as { broadcaster: RoomBroadcaster })
      .broadcaster;
    const ac = new AbortController();
    void broadcaster.subscribe(room.id, ac.signal);
    ac.abort();
    expect(broadcaster.subscriberCount(room.id)).toBe(0);

    const inbound = seedInbound(room.id, '555', 'q while down', 'pm-1');
    // The adapter is DOWN when the answer commits — an inline attempt would fail
    // and roll its ref back, leaving the entry ref-less.
    platformUp = false;
    const answer = agentPost(room.id, 'answer written while down', inbound.id);
    expect(await delivery.deliverEntry(answer)).toBe('undelivered');
    expect(harness.bridges.findRefByEntry(answer.id)).toBeNull();

    // Reconnect: clear the failed down-attempts, then the scan is the ONLY thing
    // that runs, and it delivers the entry in exactly one send.
    platformUp = true;
    publish.mockClear();
    await catchUp.scanRoom(room.id);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(harness.bridges.findRefByEntry(answer.id)?.direction).toBe('outbound');

    // Exactly once: a second scan finds the ref and delivers nothing more.
    await catchUp.scanRoom(room.id);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('A10.7 sibling: a deliverNotices-eligible turn_failed committed while down catches up (a post-scoped scan would strand it)', async () => {
    // A bridged DM delivers notices by default (§6.2).
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const inbound = seedInbound(room.id, '555', 'do a thing', 'pm-1');
    const ana = harness.authors.resolveAgent(AGENT_PATH, 'Ana');
    // The turn crashes while the adapter is down; the notice is committed but not
    // delivered. It is a NOTICE, not a post — a scan scoped to kind:'post' would
    // never catch it up, which is exactly the notice a bridged DM exists to send.
    const notice = harness.service.postNotice(
      room.id,
      {
        text: "Ana ran into a problem and could not answer here. Open Ana's session to see what went wrong.",
        notice: 'turn_failed',
        subjectAuthorId: ana.id,
      },
      { root: inbound.id, depth: 1 }
    );

    await catchUp.scanRoom(room.id);

    expect(harness.bridges.findRefByEntry(notice.id)?.direction).toBe('outbound');
    // The DELIVERED content is re-rendered for a bridged reader (§6.2) rather
    // than forwarded verbatim — the stored line above points a cockpit reader
    // at "Ana's session", which a person on the platform chat has no way to
    // open (`bridgeTurnFailedText`, notices/notice-copy.ts).
    const delivered = publish.mock.calls.filter(
      (c) =>
        (c[1] as Record<string, unknown>).content ===
        "Ana ran into a problem and couldn't answer. Try sending your message again."
    );
    expect(delivered).toHaveLength(1);
  });

  it('delivers undelivered entries in seq order and advances the cursor', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const inbound = seedInbound(room.id, '555', 'q', 'pm-1');
    const a1 = agentPost(room.id, 'answer one', inbound.id);
    const a2 = agentPost(room.id, 'answer two', inbound.id);

    await catchUp.scanRoom(room.id);

    const contents = publish.mock.calls.map((c) => (c[1] as Record<string, unknown>).content);
    expect(contents).toEqual(['answer one', 'answer two']);
    // The cursor advanced past the last delivered entry.
    expect(harness.bridges.findBridgeByRoom(room.id)!.lastDeliveredSeq).toBeGreaterThanOrEqual(
      a2.seq
    );
    expect(a1.seq).toBeLessThan(a2.seq);
  });

  it('scanAll and scanAdapter enumerate live bridges', async () => {
    const r1 = harness.service.createBridgedRoom(bridgeRequest('111'));
    const r2 = harness.service.createBridgedRoom({ ...bridgeRequest('222'), bindingId: 'b2' });
    const i1 = seedInbound(r1.id, '111', 'q1', 'pm-1');
    const i2 = seedInbound(r2.id, '222', 'q2', 'pm-2');
    agentPost(r1.id, 'to 111', i1.id);
    agentPost(r2.id, 'to 222', i2.id);

    await catchUp.scanAll();
    const contents = publish.mock.calls.map((c) => (c[1] as Record<string, unknown>).content);
    expect(contents).toContain('to 111');
    expect(contents).toContain('to 222');
  });

  it('a transient failure stops the scan without advancing the cursor past the undelivered entry', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const inbound = seedInbound(room.id, '555', 'q', 'pm-1');
    const answer = agentPost(room.id, 'will not land', inbound.id);
    platformUp = false;

    await catchUp.scanRoom(room.id);

    // Nothing delivered, and the cursor did NOT move past the undelivered entry,
    // so the next reconnect re-attempts it.
    expect(harness.bridges.findRefByEntry(answer.id)).toBeNull();
    expect(harness.bridges.findBridgeByRoom(room.id)!.lastDeliveredSeq).toBeLessThan(answer.seq);

    platformUp = true;
    await catchUp.scanRoom(room.id);
    expect(harness.bridges.findRefByEntry(answer.id)?.direction).toBe('outbound');
  });

  it('DOR-1359: a damped repeat busy notice settles the cursor — the scan moves past it and delivers what follows', async () => {
    // `damped` must NOT stop the walk: a repeat will never become deliverable
    // on a later pass, so a scan that stopped on it would stall the room
    // forever and every entry behind it would go undelivered.
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const inbound = seedInbound(room.id, '555', 'are you there?', 'pm-1');
    const ana = harness.authors.resolveAgent(AGENT_PATH, 'Ana');
    const cascade = { root: inbound.id, depth: 1 };
    const first = harness.service.postNotice(
      room.id,
      buildBusyNotice('Ana', ana.id, 'held-too-long'),
      cascade
    );
    const repeat = harness.service.postNotice(
      room.id,
      buildBusyNotice('Ana', ana.id, 'held-too-long'),
      cascade
    );
    const behind = agentPost(room.id, 'queued behind the repeat', inbound.id);

    await catchUp.scanRoom(room.id);

    // The first busy line and the post behind the damped repeat both landed;
    // the repeat itself never did.
    expect(harness.bridges.findRefByEntry(first.id)?.direction).toBe('outbound');
    expect(harness.bridges.findRefByEntry(repeat.id)).toBeNull();
    expect(harness.bridges.findRefByEntry(behind.id)?.direction).toBe('outbound');
    // The cursor cleared the whole room rather than parking on the repeat.
    expect(harness.bridges.findBridgeByRoom(room.id)!.lastDeliveredSeq).toBe(behind.seq);
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
