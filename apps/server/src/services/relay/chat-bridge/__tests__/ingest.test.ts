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
  agentLookupFor,
  createRoomHarness,
  settleUntil,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import type { CreateBridgedRoomRequest } from '../../../rooms/room-service.js';
import { RoomRoster } from '../../../rooms/room-roster.js';
import { resolveMentions } from '../../../rooms/mentions.js';
import {
  ChatBridge,
  BridgeLifecycle,
  INGEST_RATE_CEILING,
  type LifecycleBinding,
} from '../index.js';

const AGENT_PATH = '/agents/ana';
const agentLookup = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

const ADAPTER = 'tg-main';
const BINDING_ID = 'binding-ana';

/** A `relay.human.telegram.*` subject for a chat, DM or group. */
function subjectFor(chatId: string, group = false): string {
  return group
    ? `relay.human.telegram.${ADAPTER}.group.${chatId}`
    : `relay.human.telegram.${ADAPTER}.${chatId}`;
}

interface EnvelopeOpts {
  chatId: string;
  group?: boolean;
  content?: string;
  messageId?: number | string;
  fromId?: number | string | null;
  senderName?: string;
  botUsername?: string;
  media?: unknown;
  messageThreadId?: number | string;
  threadName?: string;
}

/** Build an inbound envelope the way the Telegram adapter would publish one. */
function envelopeFor(opts: EnvelopeOpts): RelayEnvelope {
  return {
    id: `env-${opts.messageId ?? '0'}`,
    subject: subjectFor(opts.chatId, opts.group),
    from: 'telegram.tg-main.bot',
    budget: {
      hopCount: 0,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 60_000,
      callBudgetRemaining: 5,
    },
    createdAt: new Date().toISOString(),
    payload: {
      content: opts.content ?? '',
      senderName: opts.senderName ?? 'Miguel',
      platformData: {
        chatId: opts.chatId,
        messageId: opts.messageId ?? 100,
        chatType: opts.group ? 'group' : 'private',
        fromId: opts.fromId === null ? undefined : (opts.fromId ?? 145223),
        botUsername: opts.botUsername,
        media: opts.media,
        messageThreadId: opts.messageThreadId,
        threadName: opts.threadName,
      },
    },
  };
}

/** A bridged binding, as `ingest` reads it. */
function bindingFor(roomId: string | null, chatId: string): LifecycleBinding {
  return { id: BINDING_ID, adapterId: ADAPTER, chatId, bridge: 'room', roomId };
}

describe('ChatBridge.ingest (chats-as-channels §5)', () => {
  let harness: RoomHarness;
  let publish: ReturnType<typeof vi.fn>;

  /** The bridged-room create request for a DM or a group. */
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

  /** Every notice of one code in a room's log. */
  function noticesOf(roomId: string, code: string): unknown[] {
    return harness.store
      .listEntries(roomId, { limit: 1000 })
      .filter((e) => e.kind === 'notice' && e.body.notice === code);
  }

  beforeEach(() => {
    harness = createRoomHarness({ agents: agentLookup });
    publish = vi.fn(async (): Promise<PublishResult> => ({ messageId: 'm', deliveredTo: 1 }));
  });

  it('A5.1: the same platform message id ingested twice → one entry, one turn', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const bridge = makeBridge(bindingFor(room.id, '555'));

    const first = await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({ chatId: '555', messageId: 7, content: 'hi' }),
      { agentPath: AGENT_PATH }
    );
    await settleUntil(() => harness.runner.turns.length === 1, 'the DM turn to run');
    const dup = await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({ chatId: '555', messageId: 7, content: 'hi again' }),
      { agentPath: AGENT_PATH }
    );

    expect(first.status).toBe('ingested');
    expect(dup).toMatchObject({ status: 'refused', reason: 'duplicate_inbound' });
    // The person's message is written exactly once — the redelivery added
    // nothing. (The agent's own 'on it' reply is a separate, legitimate post,
    // so this counts the message text, not every post in the room.)
    const messageEntries = harness.store
      .listEntries(room.id, { limit: 100 })
      .filter((e) => e.body.text === 'hi');
    expect(messageEntries).toHaveLength(1);
    expect(
      harness.store.listEntries(room.id, { limit: 100 }).some((e) => e.body.text === 'hi again')
    ).toBe(false);
    expect(harness.runner.turns).toHaveLength(1);
  });

  // DOR-883: the group-add claim flow republishes a `my_chat_member` update
  // through the SAME unbound-chat path a message uses — including on a chat
  // that is already bridged (a bot removed and re-added to a group it once
  // left). It deliberately carries NO `platformData.messageId`, because this
  // is the refusal that keeps that safe: no entry, no notice, no turn over an
  // event that said nothing. This test is the general-purpose proof of that
  // refusal (`missing_message_id` had no direct test before this task, only a
  // comment referencing it).
  it('missing_message_id: an inbound envelope with no platform message id is refused, writing no room entry', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555', true));
    const bridge = makeBridge(bindingFor(room.id, '555'));
    const before = harness.store.listEntries(room.id, { limit: 100 });

    const envelope = envelopeFor({ chatId: '555', group: true, content: '' });
    delete (envelope.payload as { platformData?: { messageId?: unknown } }).platformData?.messageId;

    const result = await bridge.ingest(bindingFor(room.id, '555'), envelope, {
      agentPath: AGENT_PATH,
    });

    expect(result).toMatchObject({ status: 'refused', reason: 'missing_message_id' });
    expect(harness.store.listEntries(room.id, { limit: 100 })).toEqual(before);
    expect(harness.runner.turns).toHaveLength(0);
  });

  it('A2.2: a bridged DM turn goes through the real dispatcher (observed as a turn claim)', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const bridge = makeBridge(bindingFor(room.id, '555'));

    await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({ chatId: '555', content: 'are you there?' }),
      { agentPath: AGENT_PATH }
    );
    await settleUntil(() => harness.runner.turns.length === 1, 'the dispatcher to claim a turn');

    expect(harness.runner.turns[0]).toMatchObject({ agentPath: AGENT_PATH, roomId: room.id });
  });

  it('A5.3: two concurrent inbound → two entries, seq in acceptance order', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555', true));
    const bridge = makeBridge(bindingFor(room.id, '555'));

    // Fired without awaiting between — the promise chain must still order them.
    const [a, b] = await Promise.all([
      bridge.ingest(
        bindingFor(room.id, '555'),
        envelopeFor({ chatId: '555', group: true, messageId: 1, content: 'first' }),
        { agentPath: AGENT_PATH }
      ),
      bridge.ingest(
        bindingFor(room.id, '555'),
        envelopeFor({ chatId: '555', group: true, messageId: 2, content: 'second' }),
        { agentPath: AGENT_PATH }
      ),
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
    const room = harness.service.createBridgedRoom(bridgeRequest('555', true));
    const bridge = makeBridge(bindingFor(room.id, '555'));

    await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({
        chatId: '555',
        group: true,
        messageId: 1,
        content: 'just chatter',
        botUsername: 'anabot',
      }),
      { agentPath: AGENT_PATH }
    );
    // Prove the absence by the thing that happens instead: an entry with no turn.
    const posts = harness.store
      .listEntries(room.id, { limit: 100 })
      .filter((e) => e.kind === 'post');
    expect(posts).toHaveLength(1);
    expect(harness.runner.turns).toHaveLength(0);

    // Now a mention triggers a turn, and the earlier chatter is in its context.
    await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({
        chatId: '555',
        group: true,
        messageId: 2,
        content: '@anabot look',
        botUsername: 'anabot',
      }),
      { agentPath: AGENT_PATH }
    );
    await settleUntil(() => harness.runner.turns.length === 1, 'the mention to trigger a turn');
    const seen = harness.runner.turns[0].roomContext.pending.map((e) => e.text);
    expect(seen).toContain('just chatter');
  });

  it('A5.5: @botusername triggers the bound agent; the extra candidate never displaces another member', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555', true));
    const bridge = makeBridge(bindingFor(room.id, '555'));

    await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({ chatId: '555', group: true, content: '@anabot hello', botUsername: 'anabot' }),
      { agentPath: AGENT_PATH }
    );
    await settleUntil(
      () => harness.runner.turns.length === 1,
      'the @botusername mention to trigger a turn'
    );
    expect(harness.runner.turns[0].agentPath).toBe(AGENT_PATH);

    // Non-displacement, at the seam the spec names (§5.4). The mechanism is that
    // the extra name is appended AFTER the agent's own handle, and resolution is
    // first-claimant-wins — over names within a candidate, and over candidates in
    // roster order. Two deterministic checks prove both halves.
    //
    // (a) The augment lands LAST on the agent's candidate, behind its real
    //     handle, so the agent still advertises and owns `ana`.
    const roster = new RoomRoster({
      store: harness.store,
      authors: harness.authors,
      agents: agentLookup,
      readCursors: harness.readCursors,
    });
    const agentAuthor = harness.authors.resolveAgent(AGENT_PATH, 'Ana');
    const candidates = roster.addressingCandidates(room.id, {
      agentPath: AGENT_PATH,
      names: ['anabot'],
    });
    const agentCandidate = candidates.live.find((c) => c.authorId === agentAuthor.id);
    expect(agentCandidate?.names).toEqual(['ana', 'anabot']);
    expect(resolveMentions('@ana', candidates.live)).toEqual([agentAuthor.id]);

    // (b) A member EARLIER in the roster who already owns `anabot` keeps it — the
    //     augmented agent, coming after, cannot steal a claimed name.
    const withEarlierRival = [
      { authorId: 'rival', names: ['anabot'] },
      { authorId: agentAuthor.id, names: ['ana', 'anabot'] },
    ];
    expect(resolveMentions('@anabot', withEarlierRival)).toEqual(['rival']);
  });

  it('A5.6: the entry and its external ref are one transaction — a ref failure writes NEITHER', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555', true));
    const bridge = makeBridge(bindingFor(room.id, '555'));
    const before = harness.store.listEntries(room.id, { limit: 100 }).length;

    // Force the ref write to throw INSIDE the entry's transaction.
    const spy = vi.spyOn(harness.bridges, 'recordInboundRef').mockImplementationOnce(() => {
      throw new Error('ref write blew up');
    });

    await expect(
      bridge.ingest(
        bindingFor(room.id, '555'),
        envelopeFor({ chatId: '555', group: true, messageId: 9, content: 'atomic?' }),
        { agentPath: AGENT_PATH }
      )
    ).rejects.toThrow('ref write blew up');

    // Neither row: the entry rolled back with the ref.
    expect(harness.store.listEntries(room.id, { limit: 100 })).toHaveLength(before);
    expect(harness.bridges.findInboundRefByPlatformMessage(ADAPTER, '555', '9')).toBeNull();
    spy.mockRestore();

    // And the happy path writes BOTH.
    const ok = await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({ chatId: '555', group: true, messageId: 9, content: 'atomic!' }),
      { agentPath: AGENT_PATH }
    );
    expect(ok.status).toBe('ingested');
    expect(harness.bridges.findInboundRefByPlatformMessage(ADAPTER, '555', '9')).not.toBeNull();
  });

  it('A5.7: a captionless photo → one [photo] entry; a captioned one → placeholder + caption', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555', true));
    const bridge = makeBridge(bindingFor(room.id, '555'));

    await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({
        chatId: '555',
        group: true,
        messageId: 1,
        content: '',
        media: { type: 'photo' },
      }),
      { agentPath: AGENT_PATH }
    );
    await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({
        chatId: '555',
        group: true,
        messageId: 2,
        content: 'my dog',
        media: { type: 'photo' },
      }),
      { agentPath: AGENT_PATH }
    );
    await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({
        chatId: '555',
        group: true,
        messageId: 3,
        content: '',
        media: { type: 'voice', durationSec: 14 },
      }),
      { agentPath: AGENT_PATH }
    );

    const texts = harness.store
      .listEntries(room.id, { limit: 100 })
      .filter((e) => e.kind === 'post')
      .map((e) => e.body.text);
    expect(texts).toContain('[photo]');
    expect(texts).toContain('[photo]\nmy dog');
    expect(texts).toContain('[voice message, 0:14]');
  });

  it('media schema drift: an unknown media kind still ingests as [attachment], not a missing_message_id drop', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555', true));
    const bridge = makeBridge(bindingFor(room.id, '555'));

    // A future media kind a newer adapter might send, outside the closed enum.
    // The old all-or-nothing parse would lose the messageId with it and refuse
    // as `missing_message_id`; the field-scoped tolerance degrades it instead.
    const unknown = await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({
        chatId: '555',
        group: true,
        messageId: 7,
        content: '',
        media: { type: 'gif' },
      }),
      { agentPath: AGENT_PATH }
    );
    expect(unknown.status).toBe('ingested');

    // A media descriptor that is not even an object degrades to no media, so the
    // caption stands alone — still one entry, still ingested.
    const malformed = await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({
        chatId: '555',
        group: true,
        messageId: 8,
        content: 'hello',
        media: 'not-an-object',
      }),
      { agentPath: AGENT_PATH }
    );
    expect(malformed.status).toBe('ingested');

    const texts = harness.store
      .listEntries(room.id, { limit: 100 })
      .filter((e) => e.kind === 'post')
      .map((e) => e.body.text);
    expect(texts).toContain('[attachment]');
    expect(texts).toContain('hello');
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
    const room = harness.service.createBridgedRoom(bridgeRequest('555', true));
    // A fixed clock so every accepted message shares the rolling window.
    const bridge = makeBridge(bindingFor(room.id, '555'), () => 1_000_000);

    // Fill the ceiling with unmentioned messages — accepted, no turns.
    for (let i = 0; i < 60; i += 1) {
      const r = await bridge.ingest(
        bindingFor(room.id, '555'),
        envelopeFor({ chatId: '555', group: true, messageId: i, content: `m${i}` }),
        { agentPath: AGENT_PATH }
      );
      expect(r.status).toBe('ingested');
    }
    const over1 = await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({ chatId: '555', group: true, messageId: 60, content: 'too much' }),
      { agentPath: AGENT_PATH }
    );
    const over2 = await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({ chatId: '555', group: true, messageId: 61, content: 'still too much' }),
      { agentPath: AGENT_PATH }
    );

    expect(over1).toMatchObject({ status: 'refused', reason: 'bridge_rate_limited' });
    expect(over2).toMatchObject({ status: 'refused', reason: 'bridge_rate_limited' });
    const posts = harness.store
      .listEntries(room.id, { limit: 1000 })
      .filter((e) => e.kind === 'post');
    expect(posts).toHaveLength(60); // the 61st and 62nd wrote nothing
    // Exactly one notice — damped per room.
    expect(noticesOf(room.id, 'bridge_rate_limited')).toHaveLength(1);
    expect(harness.runner.turns).toHaveLength(0);
  });

  it('rate maps are bounded: an aged-out window and a stale notice stamp are both evicted', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555', true));
    let clock = 1_000_000;
    const bridge = makeBridge(bindingFor(room.id, '555'), () => clock);
    // Reach into the instance's private maps — the growth this test guards is
    // internal and has no observable behaviour until it is a memory leak.
    const maps = bridge as unknown as {
      rateWindows: Map<string, number[]>;
      rateNoticedAt: Map<string, number>;
    };

    // Trip the ceiling: the chat holds a rate window, and the room a notice stamp.
    for (let i = 0; i < INGEST_RATE_CEILING; i += 1) {
      await bridge.ingest(
        bindingFor(room.id, '555'),
        envelopeFor({ chatId: '555', group: true, messageId: i, content: `m${i}` }),
        { agentPath: AGENT_PATH }
      );
    }
    const over = await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({ chatId: '555', group: true, messageId: 999, content: 'too much' }),
      { agentPath: AGENT_PATH }
    );
    expect(over).toMatchObject({ status: 'refused', reason: 'bridge_rate_limited' });
    expect(maps.rateWindows.size).toBe(1);
    expect(maps.rateNoticedAt.size).toBe(1);

    // Jump well past both the rolling window and the notice damp window, then
    // accept one more message. `overCeiling` evicts the fully-aged window (then
    // re-adds just this message), and the accepted path drops the stale stamp.
    clock += 3_600_000; // one hour — past the 60s window and the 10min damp
    const ok = await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({ chatId: '555', group: true, messageId: 1000, content: 'later' }),
      { agentPath: AGENT_PATH }
    );
    expect(ok.status).toBe('ingested');
    expect(maps.rateNoticedAt.size).toBe(0); // stale stamp evicted
    expect(maps.rateWindows.size).toBe(1); // the aged window was evicted and re-created
    expect([...maps.rateWindows.values()][0]).toHaveLength(1); // only the new message

    // And a message that ages out with no acceptance behind it evicts the window
    // entirely: a no-author message runs the ceiling check, then refuses.
    clock += 3_600_000;
    await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({ chatId: '555', group: true, messageId: 1001, content: 'ghost', fromId: null }),
      { agentPath: AGENT_PATH }
    );
    expect(maps.rateWindows.size).toBe(0); // nothing left behind
  });

  it('A5.10: a forum-topic message carries the topic id and a SANITIZED topic name on its ref', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555', true));
    const bridge = makeBridge(bindingFor(room.id, '555'));

    const result = await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({
        chatId: '555',
        group: true,
        messageId: 5,
        content: 'in a topic',
        messageThreadId: 42,
        threadName: 'Release <b>2.0</b>',
      }),
      { agentPath: AGENT_PATH }
    );

    expect(result.status).toBe('ingested');
    const ref = harness.bridges.findInboundRefByPlatformMessage(ADAPTER, '555', '5');
    expect(ref?.threadId).toBe('42');
    // Sanitized at the store (§9.2, A9.3): no angle brackets survive.
    expect(ref?.threadName).toBeTruthy();
    expect(ref?.threadName).not.toContain('<');
    expect(ref?.threadName).not.toContain('>');
  });

  it('an inbound message with no resolvable platform user id gets no author and is refused (§4.1)', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555', true));
    const bridge = makeBridge(bindingFor(room.id, '555'));

    const result = await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({ chatId: '555', group: true, content: 'who am i', fromId: null }),
      { agentPath: AGENT_PATH }
    );

    expect(result).toMatchObject({ status: 'refused', reason: 'no_author' });
    expect(
      harness.store.listEntries(room.id, { limit: 100 }).filter((e) => e.kind === 'post')
    ).toHaveLength(0);
  });

  it('§10.9: a room archived out of band turns the bridge off and tells the chat once (A10.5)', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const seed = bindingFor(room.id, '555');
    const bridge = makeBridge(seed);
    // Archive the room out from under the live bridge.
    harness.service.updateRoom(room.id, harness.human, { archived: true });

    const a = await bridge.ingest(
      seed,
      envelopeFor({ chatId: '555', messageId: 1, content: 'still there?' }),
      { agentPath: AGENT_PATH }
    );
    const b = await bridge.ingest(
      seed,
      envelopeFor({ chatId: '555', messageId: 2, content: 'hello?' }),
      { agentPath: AGENT_PATH }
    );

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
    expect(
      harness.store.listEntries(room.id, { limit: 100 }).filter((e) => e.kind === 'post')
    ).toHaveLength(0);
  });

  it('stamps lastActivityAt on every accepted ingest (§7.5)', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555', true));
    const bridge = makeBridge(bindingFor(room.id, '555'), () => 5_000_000);
    expect(harness.bridges.findBridgeByRoom(room.id)?.lastActivityAt).toBeNull();

    await bridge.ingest(
      bindingFor(room.id, '555'),
      envelopeFor({ chatId: '555', group: true, content: 'ping' }),
      { agentPath: AGENT_PATH }
    );

    expect(harness.bridges.findBridgeByRoom(room.id)?.lastActivityAt).toBe(
      new Date(5_000_000).toISOString()
    );
  });
});
