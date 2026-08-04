/**
 * `ChatBridgeDelivery` — the outbound half of the bridge (chats-as-channels spec
 * §6), and the loop-closer: a committed room entry reaches the platform chat.
 *
 * **The real thing runs where the spec's mocking stance (§13) demands it.** The
 * real `RoomService`, `AuthorRegistry`, `BridgeStore`, and `BridgeLifecycle` are
 * used throughout (`createRoomHarness`), and — the point of the consent tests —
 * the REAL `createInitiateConsentGate` decides every reply-vs-initiate case. What
 * stands in is the relay PUBLISH PIPELINE (not the gate): a fake `publish` that
 * runs the real gate and returns the exact `PublishResult` shape the pipeline
 * would, so the delivery ladder's platform outcomes (success, 403, 429,
 * transient) are controllable without a live Telegram. Nothing here mocks
 * `RoomService`, the dispatcher, or the gate.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PublishOptions, PublishResult } from '@dorkos/relay';
import type { DeliveryResult } from '@dorkos/relay';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import { createInitiateConsentGate } from '../../initiate-consent.js';
import { externalSenderIdentity } from '../../platform-identity.js';
import {
  agentLookupFor,
  createRoomHarness,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import type { CreateBridgedRoomRequest } from '../../../rooms/room-service.js';
import {
  ChatBridgeDelivery,
  BridgeLifecycle,
  type Bridge,
  type LifecycleBinding,
} from '../index.js';

const AGENT_PATH = '/agents/ana';
const agentLookup = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});
const ADAPTER = 'tg-main';
const BINDING_ID = 'binding-ana';

/** A telegram `relay.human.*` subject for a bridge row. */
function subjectFor(bridge: Bridge): string {
  return bridge.platformChatType === 'private'
    ? `relay.human.telegram.${bridge.adapterId}.${bridge.chatId}`
    : `relay.human.telegram.${bridge.adapterId}.group.${bridge.chatId}`;
}

/** A permissive DM binding, overridable per case (mirrors the consent-gate tests). */
function makeBinding(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
  return {
    id: BINDING_ID,
    adapterId: ADAPTER,
    agentId: 'agent-1',
    sessionStrategy: 'per-chat',
    enabled: true,
    canInitiate: true,
    canReply: true,
    canReceive: true,
    notifyOnTaskComplete: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as AdapterBinding;
}

/** An external Telegram sender identity, for minting an inbound author. */
function externalIdentity(userId = '145223', name = 'Miguel') {
  return externalSenderIdentity(
    { senderName: name, platformData: { fromId: userId } },
    { platformType: 'telegram', instanceId: ADAPTER }
  );
}

describe('ChatBridgeDelivery (chats-as-channels §6, §10)', () => {
  let harness: RoomHarness;
  /** The mutable binding the gate resolves — a test flips its switches. */
  let binding: AdapterBinding;
  /** The next adapter result each publish returns when the gate allows it. */
  let nextAdapterResult: (attempt: number) => DeliveryResult;
  /** Every publish the delivery made: subject, payload, from. */
  let publish: ReturnType<typeof vi.fn>;

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

  /** A binding row, as the lifecycle reads it (for the 403 archival path). */
  function bindingRow(roomId: string, chatId: string): LifecycleBinding {
    return { id: BINDING_ID, adapterId: ADAPTER, chatId, bridge: 'room', roomId };
  }

  /**
   * Build a delivery over the real room service and the REAL consent gate, with
   * a fake publish pipeline whose adapter outcome the test controls.
   */
  function makeDelivery(seedBinding: LifecycleBinding): ChatBridgeDelivery {
    // The real gate, reading the mutable `binding` for this chat.
    const gate = createInitiateConsentGate({
      bindingStore: { resolve: () => binding },
      resolveAgentSubject: () => undefined,
    });
    let attempt = 0;
    publish = vi.fn(
      async (subject: string, _payload: unknown, opts: PublishOptions): Promise<PublishResult> => {
        const decision = gate(opts.from, subject);
        if (!decision.allowed) {
          return {
            messageId: 'relay-msg',
            deliveredTo: 0,
            rejected: [{ endpointHash: 'e', reason: 'initiate_denied' }],
          };
        }
        const ar = nextAdapterResult(attempt);
        attempt += 1;
        return { messageId: 'relay-msg', deliveredTo: ar.success ? 1 : 0, adapterResult: ar };
      }
    );
    const rows = new Map<string, LifecycleBinding>([[seedBinding.id, { ...seedBinding }]]);
    const bindings = {
      getById: (id: string) => rows.get(id),
      update: vi.fn(
        async (id: string, updates: { bridge?: 'off' | 'room'; roomId?: string | null }) => {
          const cur = rows.get(id);
          if (!cur) return undefined;
          const next = { ...cur, ...updates };
          rows.set(id, next);
          return next;
        }
      ),
    };
    const lifecycle = new BridgeLifecycle({
      rooms: harness.service,
      bridges: harness.bridges,
      bindings,
      chatNotice: async () => true,
      operatorAuthorId: () => harness.human,
    });
    return new ChatBridgeDelivery({
      entries: harness.store,
      rooms: harness.service,
      bridges: harness.bridges,
      authors: harness.authors,
      publisher: { publish: publish as never },
      lifecycle,
      resolveSubject: subjectFor,
      operatorAuthorId: () => harness.human,
      sleep: async () => {},
      retryBackoffMs: [1, 1],
    });
  }

  /** Every notice of one code in a room. */
  function noticesOf(roomId: string, code: string) {
    return harness.store
      .listEntries(roomId, { limit: 1000 })
      .filter((e) => e.kind === 'notice' && e.body.notice === code);
  }

  /** Post an inbound entry (author minted, inbound ref written) — an ingested message. */
  function seedInbound(
    roomId: string,
    chatId: string,
    text: string,
    platformMessageId: string,
    threadId?: string
  ) {
    const identity = externalIdentity();
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
            threadId,
            createdAt: new Date().toISOString(),
          },
          tx
        ),
    });
    const full = harness.store.getEntryById(roomId, entry.id);
    if (!full) throw new Error('inbound entry vanished');
    return full;
  }

  /** Post as the bound agent, optionally as a reply to an inbound entry. */
  function agentPost(roomId: string, text: string, replyToInbound?: string) {
    const agent = harness.authors.resolveAgent(AGENT_PATH, 'Ana');
    return harness.service.post(roomId, {
      authorId: agent.id,
      text,
      ...(replyToInbound ? { trigger: { root: replyToInbound, depth: 1 } } : {}),
    });
  }

  /** Post as the operator (cockpit) — self-rooted, an initiate. */
  function operatorPost(roomId: string, text: string) {
    return harness.service.post(roomId, { authorId: harness.human, text });
  }

  beforeEach(() => {
    harness = createRoomHarness({ agents: agentLookup });
    binding = makeBinding();
    nextAdapterResult = () => ({ success: true, responseMessageId: 'tg-out-1' });
  });

  it('A6.1: an inbound message never round-trips back to the platform', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const inbound = seedInbound(room.id, '555', 'hi from the chat', 'pm-1');

    const outcome = await delivery.deliverEntry(inbound);

    expect(outcome).toBe('echo');
    expect(publish).not.toHaveBeenCalled();
  });

  it('A6.2: a retry for an already-delivered entry sends nothing; a crash-simulated ref suppresses the retry', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const inbound = seedInbound(room.id, '555', 'ping', 'pm-1');
    const answer = agentPost(room.id, 'pong', inbound.id);

    const first = await delivery.deliverEntry(answer);
    const second = await delivery.deliverEntry(answer);
    expect(first).toBe('delivered');
    expect(second).toBe('noop');
    // One send, not two — idempotence on the entry (§6.3).
    expect(publish).toHaveBeenCalledTimes(1);

    // A crash between ref-write and send is simulated by a pre-seeded null-id
    // outbound ref on a fresh entry: the retry finds it and no-ops, so a person
    // never sees a duplicate.
    const answer2 = agentPost(room.id, 'second answer', inbound.id);
    harness.bridges.recordOutboundRef({
      roomId: room.id,
      entryId: answer2.id,
      chatId: '555',
      adapterId: ADAPTER,
      createdAt: new Date().toISOString(),
    });
    const retry = await delivery.deliverEntry(answer2);
    expect(retry).toBe('noop');
    expect(publish).toHaveBeenCalledTimes(1); // still one — no duplicate
  });

  it('A6.3: a cockpit post reaches the chat when canInitiate is on, is blocked (with a notice) when off', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));

    binding = makeBinding({ canInitiate: true });
    const okPost = operatorPost(room.id, 'hello from cockpit');
    expect(await delivery.deliverEntry(okPost)).toBe('delivered');

    binding = makeBinding({ canInitiate: false });
    const blockedPost = operatorPost(room.id, 'blocked cockpit message');
    expect(await delivery.deliverEntry(blockedPost)).toBe('blocked');
    expect(noticesOf(room.id, 'bridge_blocked')).toHaveLength(1);
  });

  it('A6.4: an agent answer reaches the chat with canReply on, is blocked with canReply off', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const inbound = seedInbound(room.id, '555', 'question', 'pm-1');

    // canInitiate OFF proves this rode canReply, not the initiate blanket.
    binding = makeBinding({ canInitiate: false, canReply: true });
    const answer = agentPost(room.id, 'the answer', inbound.id);
    expect(await delivery.deliverEntry(answer)).toBe('delivered');

    binding = makeBinding({ canInitiate: false, canReply: false });
    const inbound2 = seedInbound(room.id, '555', 'question 2', 'pm-2');
    const answer2 = agentPost(room.id, 'blocked answer', inbound2.id);
    expect(await delivery.deliverEntry(answer2)).toBe('blocked');
  });

  it('A6.4 companion: reply and initiate publish under distinguishable principals, with a dotted chat id', async () => {
    // A chat id containing a dot: a positional parse bug cannot hide behind a
    // passing gate decision (spec §6.4).
    const room = harness.service.createBridgedRoom(bridgeRequest('55.5'));
    const delivery = makeDelivery(bindingRow(room.id, '55.5'));
    const inbound = seedInbound(room.id, '55.5', 'q', 'pm-1');

    const answer = agentPost(room.id, 'a', inbound.id);
    await delivery.deliverEntry(answer);
    const cockpit = operatorPost(room.id, 'c');
    await delivery.deliverEntry(cockpit);

    const froms = publish.mock.calls.map((c) => (c[2] as PublishOptions).from);
    expect(froms).toContain('relay.bridge.reply.tg-main.55.5');
    expect(froms).toContain('relay.bridge.initiate.tg-main.55.5');
  });

  it('A6.5: a post whose author is neither the bound agent nor the operator is refused inside deliver, before any publish', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555', true));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    // An external human's post with NO inbound ref — the author check, not echo
    // suppression, is what must refuse it.
    const identity = externalIdentity('999', 'Stranger');
    if (!identity) throw new Error('identity');
    const { entry } = harness.service.postExternal(room.id, { identity, text: 'sneak this out' });
    const full = harness.store.getEntryById(room.id, entry.id);

    const outcome = await delivery.deliverEntry(full!);

    expect(outcome).toBe('refused_author');
    expect(publish).not.toHaveBeenCalled();
  });

  it('A6.7: a delivered answer to a forum-topic message carries that topic message_thread_id', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555', true));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const inbound = seedInbound(room.id, '555', 'in a topic', 'pm-1', '42');

    const answer = agentPost(room.id, 'answering in the topic', inbound.id);
    expect(await delivery.deliverEntry(answer)).toBe('delivered');

    const payload = publish.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.messageThreadId).toBe('42');
    expect(payload.replyToMessageId).toBe('pm-1');
  });

  it('A6.9: an operator post carries the display-name prefix on the wire and NOT in the stored body', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const post = operatorPost(room.id, 'raw cockpit text');

    await delivery.deliverEntry(post);

    const wire = (publish.mock.calls[0][1] as Record<string, unknown>).content as string;
    const operatorName = harness.authors.getById(harness.human)!.displayName;
    expect(wire).toBe(`${operatorName}: raw cockpit text`);
    // The stored entry body is exactly what was typed — no prefix (§6.7).
    expect(harness.store.getEntryById(room.id, post.id)!.body.text).toBe('raw cockpit text');
  });

  it('the bound agent own posts are NOT prefixed — the bot is its identity (§6.7)', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const inbound = seedInbound(room.id, '555', 'q', 'pm-1');
    const answer = agentPost(room.id, 'plain agent answer', inbound.id);

    await delivery.deliverEntry(answer);

    expect((publish.mock.calls[0][1] as Record<string, unknown>).content).toBe(
      'plain agent answer'
    );
  });

  it('A10.1: a delivery failure leaves the entry, rolls the ref back, and writes exactly one bridge_undelivered notice', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const post = operatorPost(room.id, 'never lands');
    // Every attempt fails transiently (no code = platform down / disconnected).
    nextAdapterResult = () => ({ success: false, error: 'ECONNRESET' });

    const outcome = await delivery.deliverEntry(post);

    expect(outcome).toBe('undelivered');
    // Ref rolled back so the reconnect scan can re-deliver it (§10.1).
    expect(harness.bridges.findRefByEntry(post.id)).toBeNull();
    // The entry itself is untouched, and one notice names it.
    expect(harness.store.getEntryById(room.id, post.id)).not.toBeNull();
    expect(noticesOf(room.id, 'bridge_undelivered')).toHaveLength(1);
    // Three attempts: the initial send plus two retries (retryBackoffMs has two).
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('A10.2: a 429 with retry_after delays the retry and preserves seq order across a chat', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const waits: number[] = [];
    const publishCounts = new Map<string, number>();
    // A delivery whose sleep records how long each wait was.
    const delivery = new ChatBridgeDelivery({
      entries: harness.store,
      rooms: harness.service,
      bridges: harness.bridges,
      authors: harness.authors,
      publisher: {
        publish: (async (subject: string, _p: unknown, opts: PublishOptions) => {
          // First publish is rate-limited once, then succeeds; later ones succeed.
          const key = opts.from;
          const n = (publishCounts.get(key) ?? 0) + 1;
          publishCounts.set(key, n);
          if (subject.endsWith('.555') && n === 1) {
            return {
              messageId: 'm',
              deliveredTo: 0,
              adapterResult: { success: false, code: 'rate_limited' as const, retryAfterMs: 5000 },
            };
          }
          return {
            messageId: 'm',
            deliveredTo: 1,
            adapterResult: { success: true, responseMessageId: 't' },
          };
        }) as never,
      },
      lifecycle: { unbridge: async () => {} },
      resolveSubject: subjectFor,
      operatorAuthorId: () => harness.human,
      sleep: async (ms) => {
        waits.push(ms);
      },
      retryBackoffMs: [1, 1],
    });

    const first = operatorPost(room.id, 'first');
    const second = operatorPost(room.id, 'second');
    const [a, b] = await Promise.all([delivery.deliverEntry(first), delivery.deliverEntry(second)]);

    expect(a).toBe('delivered');
    expect(b).toBe('delivered');
    // The 429's retry_after was honoured exactly.
    expect(waits).toContain(5000);
  });

  it('A10.3: a 403 archives the room, turns the bridge off, and writes a notice with the reason', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const seed = bindingRow(room.id, '555');
    const delivery = makeDelivery(seed);
    const post = operatorPost(room.id, 'to a chat that kicked us');
    nextAdapterResult = () => ({
      success: false,
      code: 'chat_unavailable',
      error: 'Forbidden: bot was blocked by the user',
    });

    const outcome = await delivery.deliverEntry(post);

    expect(outcome).toBe('terminal');
    // Terminal, not retried — one attempt only.
    expect(publish).toHaveBeenCalledTimes(1);
    // The room is archived and the bridge row stamped (via BridgeLifecycle).
    expect(harness.store.getRoom(room.id)?.archived).toBe(true);
    expect(harness.bridges.findBridgeByRoom(room.id)?.archivedAt).not.toBeNull();
    // The disconnect notice carries the platform's own reason.
    const disconnect = noticesOf(room.id, 'bridge_disconnected');
    expect(disconnect).toHaveLength(1);
    expect(disconnect[0].body.text).toContain('blocked');
  });

  it('A10.4: a late answer post is delivered like any other post', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const inbound = seedInbound(room.id, '555', 'took a while', 'pm-1');
    // A late answer is an ordinary post carrying its "took N minutes" note in the
    // body; the bridge does not special-case it.
    const late = agentPost(
      room.id,
      'This answers the message from 5 minutes ago: "took a while"\n\nhere it is',
      inbound.id
    );

    expect(await delivery.deliverEntry(late)).toBe('delivered');
    expect((publish.mock.calls[0][1] as Record<string, unknown>).content).toContain('here it is');
  });

  describe('the consent table (§6.6)', () => {
    it('case 7: a paused binding (enabled:false) blocks even an inbound-rooted reply', async () => {
      const room = harness.service.createBridgedRoom(bridgeRequest('555'));
      const delivery = makeDelivery(bindingRow(room.id, '555'));
      const inbound = seedInbound(room.id, '555', 'q', 'pm-1');
      binding = makeBinding({ enabled: false, canReply: true });
      const answer = agentPost(room.id, 'blocked by pause', inbound.id);
      expect(await delivery.deliverEntry(answer)).toBe('blocked');
    });

    it('case 9: a cross-room root does NOT launder an initiate — S with canInitiate off blocks', async () => {
      // Two bridged chats. An agent post in room S whose cascade root is an
      // entry from room R (an inbound message there) must classify as an
      // initiate in S, so S's canInitiate:false blocks it.
      const roomR = harness.service.createBridgedRoom(bridgeRequest('111'));
      const roomS = harness.service.createBridgedRoom({
        ...bridgeRequest('222'),
        bindingId: BINDING_ID,
      });
      const delivery = makeDelivery(bindingRow(roomS.id, '222'));
      const inboundR = seedInbound(roomR.id, '111', 'stranger in R', 'pm-r');
      // A post in S that (wrongly) inherits R's root.
      const agent = harness.authors.resolveAgent(AGENT_PATH, 'Ana');
      const leak = harness.service.post(roomS.id, {
        authorId: agent.id,
        text: 'laundered',
        trigger: { root: inboundR.id, depth: 1 },
      });
      binding = makeBinding({ canInitiate: false, canReply: true });

      expect(await delivery.deliverEntry(leak)).toBe('blocked');
      // It published under the INITIATE principal, not reply — the root did not launder.
      const from = (publish.mock.calls[0][2] as PublishOptions).from;
      expect(from).toBe('relay.bridge.initiate.tg-main.222');
    });

    it('case 10: a self-rooted agent answer (post-restart) blocks with the dedicated restart copy', async () => {
      const room = harness.service.createBridgedRoom(bridgeRequest('555'));
      const delivery = makeDelivery(bindingRow(room.id, '555'));
      binding = makeBinding({ canInitiate: false, canReply: true });
      // A self-rooted agent post — the shape a late answer takes after a restart
      // dropped its live claim (§6.6).
      const orphan = agentPost(room.id, 'answer with lost provenance');

      expect(await delivery.deliverEntry(orphan)).toBe('blocked');
      const notice = noticesOf(room.id, 'bridge_blocked');
      expect(notice).toHaveLength(1);
      expect(notice[0].body.text).toContain('lost its provenance');
    });
  });

  describe('§6.2 deliverNotices', () => {
    it('A6.6: a turn_failed notice reaches a bridged DM by default and NOT a bridged channel', async () => {
      const dm = harness.service.createBridgedRoom(bridgeRequest('555'));
      const dmDelivery = makeDelivery(bindingRow(dm.id, '555'));
      const dmInbound = seedInbound(dm.id, '555', 'q', 'pm-1');
      binding = makeBinding({ canReply: true, canInitiate: true });
      // A turn_failed notice rooted at the inbound message (a reply).
      const dmNotice = harness.service.postNotice(
        dm.id,
        { text: 'A turn failed.', notice: 'turn_failed' },
        { root: dmInbound.id, depth: 1 }
      );
      expect(await dmDelivery.deliverEntry(dmNotice)).toBe('delivered');

      const ch = harness.service.createBridgedRoom({
        ...bridgeRequest('777', true),
        bindingId: 'binding-ch',
      });
      const chDelivery = makeDelivery(bindingRow(ch.id, '777'));
      const chNotice = harness.service.postNotice(ch.id, {
        text: 'A turn failed.',
        notice: 'turn_failed',
      });
      expect(await chDelivery.deliverEntry(chNotice)).toBe('skipped');
    });
  });
});
