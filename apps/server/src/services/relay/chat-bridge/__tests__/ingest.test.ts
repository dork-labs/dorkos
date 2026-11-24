/**
 * `ChatBridge.ingest` — the inbound half of the bridge (chats-as-channels spec
 * §5), and the keystone of the feature: a platform message becomes a room post,
 * deduplicated, ordered by acceptance, and atomic with its external ref.
 *
 * **The real thing runs throughout** (`createRoomHarness`): the real
 * `RoomService`, the real `AuthorRegistry`, and — the point — the real
 * `RoomTriggerDispatcher`. The spec's mocking stance (§13) forbids mocking the
 * machinery under test; a mock of the dispatcher or the consent path would
 * encode the hypothesis instead of testing it. Only the turn RUNNER is scripted,
 * because the alternative is a model call, and only the file-backed
 * `BindingStore` is faked, because nothing here tests its persistence — the
 * §10.9 recovery only reads and flips the two fields the fake owns.
 *
 * Every "a turn ran / did not run" assertion observes the real dispatcher's own
 * record (`harness.runner.turns`), never a runtime call — A2.2's requirement.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChatNoticeSender, type PublishResult } from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import {
  createRoomHarness,
  settleUntil,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import {
  ChatBridge,
  BridgeLifecycle,
  INGEST_RATE_CEILING,
  type LifecycleBinding,
} from '../index.js';
import {
  ADAPTER,
  AGENT_PATH,
  BINDING_ID,
  agentLookup,
  bindingFor,
  envelopeFor,
  subjectFor,
  type EnvelopeOpts,
} from './inbound.fixtures.js';

describe('ChatBridge.ingest (chats-as-channels §5)', () => {
  let harness: RoomHarness;
  let publish: ReturnType<typeof vi.fn>;

  /** A `ChatBridge` over the real room service, with a real lifecycle + notice. */
  function makeBridge(seed: LifecycleBinding, now?: () => number): ChatBridge {
    const rows = new Map<string, LifecycleBinding>([[seed.id, { ...seed }]]);
    const bindings = {
      getById: (id: string) => rows.get(id),
      update: vi.fn(
        async (id: string, updates: { bridge?: 'off' | 'room'; roomId?: string | null }) => {
          const current = rows.get(id);
          if (!current) return undefined;
          const next = { ...current, ...updates };
          rows.set(id, next);
          return next;
        }
      ),
    };
    const chatNotice = createChatNoticeSender({
      publish: publish as unknown as (
        subject: string,
        payload: unknown,
        options: unknown
      ) => Promise<PublishResult>,
      resolveTarget: (subject) =>
        subject.startsWith(`relay.human.telegram.${ADAPTER}.`) ? { bindingId: BINDING_ID } : null,
    });
    return new ChatBridge({
      rooms: harness.service,
      bridges: harness.bridges,
      lifecycle: new BridgeLifecycle({
        rooms: harness.service,
        bridges: harness.bridges,
        bindings,
        chatNotice,
        operatorAuthorId: () => harness.human,
      }),
      chatNotice,
      now,
    });
  }

  /**
   * A bridged DM (or group, when `group`) on chat `555`, and a `send` that
   * ingests one message into it.
   */
  function bridgedChat(group: boolean, now?: () => number) {
    const room = harness.service.createBridgedRoom({
      adapterId: ADAPTER,
      chatId: '555',
      bindingId: BINDING_ID,
      chatType: group ? 'group' : 'private',
      channelType: group ? 'group' : null,
      title: group ? 'Team' : 'Miguel',
      agentPath: AGENT_PATH,
      operatorAuthorId: harness.human,
    });
    const binding = bindingFor(room.id, '555');
    const bridge = makeBridge(binding, now);
    const send = (opts: Omit<EnvelopeOpts, 'chatId' | 'group'>, envelope?: RelayEnvelope) =>
      bridge.ingest(binding, envelope ?? envelopeFor({ chatId: '555', group, ...opts }), {
        agentPath: AGENT_PATH,
      });
    return { room, bridge, send };
  }

  /** The text of every post in a room, in log order. */
  function postTexts(roomId: string): Array<string | undefined> {
    return harness.store
      .listEntries(roomId, { limit: 1000 })
      .filter((e) => e.kind === 'post')
      .map((e) => e.body.text);
  }

  beforeEach(() => {
    harness = createRoomHarness({ agents: agentLookup });
    publish = vi.fn(async (): Promise<PublishResult> => ({ messageId: 'm', deliveredTo: 1 }));
  });

  it('A5.1 + A2.2: the same platform message id ingested twice → one entry, one turn through the real dispatcher', async () => {
    const { room, send } = bridgedChat(false);

    const first = await send({ messageId: 7, content: 'hi' });
    await settleUntil(() => harness.runner.turns.length === 1, 'the DM turn to run');
    const dup = await send({ messageId: 7, content: 'hi again' });

    expect(first.status).toBe('ingested');
    expect(dup).toMatchObject({ status: 'refused', reason: 'duplicate_inbound' });
    // The person's message is written exactly once — the redelivery added
    // nothing. (The agent's own 'on it' reply is a separate, legitimate post,
    // so this counts the message text, not every post in the room.)
    expect(postTexts(room.id).filter((text) => text === 'hi')).toHaveLength(1);
    expect(postTexts(room.id)).not.toContain('hi again');
    // A2.2: the turn is the real dispatcher's own claim record.
    expect(harness.runner.turns).toHaveLength(1);
    expect(harness.runner.turns[0]).toMatchObject({ agentPath: AGENT_PATH, roomId: room.id });
    // §7.5: every accepted ingest stamps the bridge's activity.
    expect(harness.bridges.findBridgeByRoom(room.id)?.lastActivityAt).not.toBeNull();
  });

  // DOR-883: the group-add claim flow republishes a `my_chat_member` update
  // through the SAME unbound-chat path a message uses — including on a chat
  // that is already bridged. It deliberately carries NO `platformData.messageId`,
  // because this is the refusal that keeps that safe: no entry, no notice, no
  // turn over an event that said nothing.
  it('missing_message_id: an inbound envelope with no platform message id is refused, writing no room entry', async () => {
    const { room, send } = bridgedChat(true);
    const before = harness.store.listEntries(room.id, { limit: 100 });

    const envelope = envelopeFor({ chatId: '555', group: true, content: '' });
    delete (envelope.payload as { platformData?: { messageId?: unknown } }).platformData?.messageId;

    expect(await send({}, envelope)).toMatchObject({
      status: 'refused',
      reason: 'missing_message_id',
    });
    expect(harness.store.listEntries(room.id, { limit: 100 })).toEqual(before);
    expect(harness.runner.turns).toHaveLength(0);
  });

  it('A5.3: two concurrent inbound → two entries, seq in acceptance order', async () => {
    const { room, send } = bridgedChat(true);

    // Fired without awaiting between — the promise chain must still order them.
    const [a, b] = await Promise.all([
      send({ messageId: 1, content: 'first' }),
      send({ messageId: 2, content: 'second' }),
    ]);

    expect(a.status).toBe('ingested');
    expect(b.status).toBe('ingested');
    const posts = harness.store
      .listEntries(room.id, { limit: 100 })
      .filter((e) => e.kind === 'post');
    expect(posts.map((e) => e.body.text)).toEqual(['first', 'second']);
    // Strictly increasing seq in acceptance order, no interleaved partial state.
    expect(posts[0].seq).toBeLessThan(posts[1].seq);
  });

  it('A5.4: a bridged group, agent mention-only, unmentioned message → entry, NO turn, then unread next turn', async () => {
    const { room, send } = bridgedChat(true);

    await send({ messageId: 1, content: 'just chatter', botUsername: 'anabot' });
    // Prove the absence by the thing that happens instead: an entry with no turn.
    expect(postTexts(room.id)).toHaveLength(1);
    expect(harness.runner.turns).toHaveLength(0);

    // Now a mention triggers a turn, and the earlier chatter is in its context.
    await send({ messageId: 2, content: '@anabot look', botUsername: 'anabot' });
    await settleUntil(() => harness.runner.turns.length === 1, 'the mention to trigger a turn');
    // A5.5: @botusername triggers the bound agent.
    expect(harness.runner.turns[0].agentPath).toBe(AGENT_PATH);
    const seen = harness.runner.turns[0].roomContext.pending.map((e) => e.text);
    expect(seen).toContain('just chatter');
  });

  it('A5.6: the entry and its external ref are one transaction — a ref failure writes NEITHER', async () => {
    const { room, send } = bridgedChat(true);
    const before = harness.store.listEntries(room.id, { limit: 100 }).length;

    // Force the ref write to throw INSIDE the entry's transaction.
    const spy = vi.spyOn(harness.bridges, 'recordInboundRef').mockImplementationOnce(() => {
      throw new Error('ref write blew up');
    });

    await expect(send({ messageId: 9, content: 'atomic?' })).rejects.toThrow('ref write blew up');

    // Neither row: the entry rolled back with the ref.
    expect(harness.store.listEntries(room.id, { limit: 100 })).toHaveLength(before);
    expect(harness.bridges.findInboundRefByPlatformMessage(ADAPTER, '555', '9')).toBeNull();
    spy.mockRestore();

    // And the happy path writes BOTH, the ref carrying the forum topic id.
    expect((await send({ messageId: 9, content: 'atomic!', messageThreadId: 42 })).status).toBe(
      'ingested'
    );
    expect(harness.bridges.findInboundRefByPlatformMessage(ADAPTER, '555', '9')?.threadId).toBe(
      '42'
    );
  });

  it('A5.7: media becomes a placeholder entry — captioned, voice, an unknown kind, and a malformed descriptor', async () => {
    const { room, send } = bridgedChat(true);

    const results = [
      await send({ messageId: 2, content: 'my dog', media: { type: 'photo' } }),
      await send({ messageId: 3, content: '', media: { type: 'voice', durationSec: 14 } }),
      // Schema drift: a future media kind outside the closed enum. The old
      // all-or-nothing parse would lose the messageId with it and refuse as
      // `missing_message_id`; the field-scoped tolerance degrades it instead.
      await send({ messageId: 4, content: '', media: { type: 'gif' } }),
      // Not even an object: degrades to no media, so the caption stands alone.
      await send({ messageId: 5, content: 'hello', media: 'not-an-object' }),
    ];

    expect(results.map((r) => r.status)).toEqual(Array(4).fill('ingested'));
    expect(postTexts(room.id)).toEqual([
      '[photo]\nmy dog',
      '[voice message, 0:14]',
      '[attachment]',
      'hello',
    ]);
  });

  it('A5.8: a bridge:room binding with a missing room refuses with an in-chat notice and creates nothing', async () => {
    // A binding that names a room and chat with NO bridge row behind it.
    const bridge = makeBridge(bindingFor('no-such-room', '999'));

    const result = await bridge.ingest(
      bindingFor('no-such-room', '999'),
      envelopeFor({ chatId: '999', content: 'hello?' }),
      { agentPath: AGENT_PATH }
    );

    expect(result).toMatchObject({ status: 'refused', reason: 'broken_bridge' });
    // Told in-chat, once, under the system principal.
    expect(publish).toHaveBeenCalledWith(
      subjectFor('999'),
      expect.objectContaining({ content: expect.stringContaining('no longer connected') }),
      expect.objectContaining({ from: expect.stringContaining('relay.system.') })
    );
    // Nothing created: no bridge row appeared.
    expect(harness.bridges.findBridgeByChat(ADAPTER, '999')).toBeNull();
  });

  it('A5.9: past the ingest ceiling → refuses, one damped bridge_rate_limited notice, no entry', async () => {
    // A fixed clock so every accepted message shares the rolling window.
    const { room, send } = bridgedChat(true, () => 1_000_000);

    // Fill the ceiling with unmentioned messages — accepted, no turns.
    for (let i = 0; i < INGEST_RATE_CEILING; i += 1) {
      expect((await send({ messageId: i, content: `m${i}` })).status).toBe('ingested');
    }
    const over1 = await send({ messageId: 'over-1', content: 'too much' });
    const over2 = await send({ messageId: 'over-2', content: 'still too much' });

    expect(over1).toMatchObject({ status: 'refused', reason: 'bridge_rate_limited' });
    expect(over2).toMatchObject({ status: 'refused', reason: 'bridge_rate_limited' });
    expect(postTexts(room.id)).toHaveLength(INGEST_RATE_CEILING); // the refused ones wrote nothing
    // Exactly one notice — damped per room.
    const notices = harness.store
      .listEntries(room.id, { limit: 1000 })
      .filter((e) => e.kind === 'notice' && e.body.notice === 'bridge_rate_limited');
    expect(notices).toHaveLength(1);
    expect(harness.runner.turns).toHaveLength(0);
  });

  it('an inbound message with no resolvable platform user id gets no author and is refused (§4.1)', async () => {
    const { room, send } = bridgedChat(true);

    const result = await send({ content: 'who am i', fromId: null });

    expect(result).toMatchObject({ status: 'refused', reason: 'no_author' });
    expect(postTexts(room.id)).toHaveLength(0);
  });

  it('§10.9: a room archived out of band turns the bridge off and tells the chat once (A10.5)', async () => {
    const { room, send } = bridgedChat(false);
    // Archive the room out from under the live bridge.
    harness.service.updateRoom(room.id, harness.human, { archived: true });

    const a = await send({ messageId: 1, content: 'still there?' });
    const b = await send({ messageId: 2, content: 'hello?' });

    // The FIRST message is the one that catches ROOM_ARCHIVED and runs the §10.9
    // recovery; it stamps the bridge row archived. The SECOND then finds an
    // already-archived row and takes the broken-bridge path — the bridge is off,
    // so it never resurrects. Both refuse; neither writes an entry.
    expect(a).toMatchObject({ status: 'refused', reason: 'room_archived' });
    expect(b.status).toBe('refused');
    // The bridge row is stamped archived, and the chat was told exactly once —
    // the chat-notice sender's own damper (both paths use `channel_archived`).
    expect(harness.bridges.findBridgeByRoom(room.id)?.archivedAt).not.toBeNull();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(postTexts(room.id)).toHaveLength(0);
  });
});
