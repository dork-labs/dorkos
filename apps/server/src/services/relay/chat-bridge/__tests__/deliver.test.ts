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
import {
  buildBusyNotice,
  buildTurnFailedNotice,
  buildWaitingNotice,
} from '../../../rooms/notices/notice-copy.js';
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
  /**
   * The real operator name `ChatBridgeDelivery` resolves for the §6.7 prefix
   * (DOR-899) — `null` by default, the "nothing configured" case, so most
   * tests exercise the fallback path without asking for it.
   */
  let operatorDisplayName: () => string | null;

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
      operatorDisplayName: () => operatorDisplayName(),
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
    operatorDisplayName = () => null;
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

    // DOR-889: every bridge delivery asserts the server trust marker, or the
    // publish pipeline's bridge-principal guard would reject it as a
    // caller-supplied `relay.bridge.*` `from`. Both the reply and the initiate
    // above carry it.
    const markers = publish.mock.calls.map((c) => (c[2] as PublishOptions).serverBridgePrincipal);
    expect(markers.every((m) => m === true)).toBe(true);
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

  it('A6.9: with a real name configured, an operator post carries THAT name on the wire — never the "You" author-registry label — and NOT in the stored body (DOR-899)', async () => {
    operatorDisplayName = () => 'Dorian';
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const post = operatorPost(room.id, 'raw cockpit text');

    await delivery.deliverEntry(post);

    const wire = (publish.mock.calls[0][1] as Record<string, unknown>).content as string;
    // The author-registry row for this same author is still 'You' — proving
    // the wire prefix came from the real-name resolver, not that cache.
    expect(harness.authors.getById(harness.human)!.displayName).toBe('You');
    expect(wire).toBe('Dorian: raw cockpit text');
    // The stored entry body is exactly what was typed — no prefix (§6.7).
    expect(harness.store.getEntryById(room.id, post.id)!.body.text).toBe('raw cockpit text');
  });

  it('DOR-899: with no real name configured, an operator post falls back to a neutral wire label — NEVER "You:" — and the stored body is still unchanged', async () => {
    // operatorDisplayName resolves null by default (beforeEach) — the
    // "nothing configured" case.
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const post = operatorPost(room.id, 'raw cockpit text');

    await delivery.deliverEntry(post);

    const wire = (publish.mock.calls[0][1] as Record<string, unknown>).content as string;
    expect(wire).not.toMatch(/^You:/);
    expect(wire).toBe('Operator: raw cockpit text');
    expect(harness.store.getEntryById(room.id, post.id)!.body.text).toBe('raw cockpit text');
  });

  it('DOR-899: a bridged GROUP operator post gets the real-name prefix the same way a DM does — the fix is not room-kind-conditional', async () => {
    operatorDisplayName = () => 'Dorian';
    const group = harness.service.createBridgedRoom(bridgeRequest('555', true));
    const delivery = makeDelivery(bindingRow(group.id, '555'));
    const post = operatorPost(group.id, 'hello group');

    await delivery.deliverEntry(post);

    expect((publish.mock.calls[0][1] as Record<string, unknown>).content).toBe(
      'Dorian: hello group'
    );
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

  it('A10.2: a 429 holds the chat in seq order — the second delivery cannot publish during the first retry_after wait', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest('555'));
    const waits: number[] = [];
    // The tag of every publish, in call order — 'first' or 'second' by content.
    // This is the load-bearing assertion: a SET of outcomes ({both delivered},
    // {waits has 5000}) is satisfied by the WRONG interleaving too, so seq order
    // has to be proved on the ORDER of the calls themselves.
    const order: Array<'first' | 'second'> = [];
    let publishCount = 0;
    const delivery = new ChatBridgeDelivery({
      entries: harness.store,
      rooms: harness.service,
      bridges: harness.bridges,
      authors: harness.authors,
      publisher: {
        publish: (async (_subject: string, payload: unknown, _opts: PublishOptions) => {
          const content = (payload as { content?: string }).content ?? '';
          order.push(content.includes('first') ? 'first' : 'second');
          publishCount += 1;
          // The VERY FIRST publish (the first entry's first attempt) is rate
          // limited; everything after succeeds. If the chain held, "everything
          // after" is: the first entry's retry, then the second entry. If the
          // chain were broken, the second entry would publish DURING the first's
          // retry_after sleep and land here as the second call.
          if (publishCount === 1) {
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
    // Seq order held ACROSS the wait: the first entry is published (429) then
    // re-published (success) before the second entry is published at all. Remove
    // the per-chat serialization and the second would jump the queue during the
    // first's sleep, giving ['first', 'second', 'first'] — which this rejects.
    expect(order).toEqual(['first', 'first', 'second']);
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

    it('A6.6: a halted notice reaches a bridged DM by default and NOT a bridged channel', async () => {
      const dm = harness.service.createBridgedRoom(bridgeRequest('556'));
      const dmDelivery = makeDelivery(bindingRow(dm.id, '556'));
      binding = makeBinding({ canReply: true, canInitiate: true });
      const dmNotice = harness.service.postNotice(dm.id, {
        text: 'Everything here was stopped. Nothing was running at the time.',
        notice: 'halted',
      });
      expect(await dmDelivery.deliverEntry(dmNotice)).toBe('delivered');

      const ch = harness.service.createBridgedRoom({
        ...bridgeRequest('778', true),
        bindingId: 'binding-ch2',
      });
      const chDelivery = makeDelivery(bindingRow(ch.id, '778'));
      const chNotice = harness.service.postNotice(ch.id, {
        text: 'Everything here was stopped. Nothing was running at the time.',
        notice: 'halted',
      });
      expect(await chDelivery.deliverEntry(chNotice)).toBe('skipped');
    });

    it('the one per-bridge override turns delivery ON for a channel: turn_failed and halted both deliver', async () => {
      const ch = harness.service.createBridgedRoom({
        ...bridgeRequest('779', true),
        bindingId: 'binding-ch3',
      });
      harness.bridges.setDeliverNotices(ch.id, true);
      const chDelivery = makeDelivery(bindingRow(ch.id, '779'));
      binding = makeBinding({ canReply: true, canInitiate: true });

      const turnFailed = harness.service.postNotice(ch.id, {
        text: 'A turn failed.',
        notice: 'turn_failed',
      });
      expect(await chDelivery.deliverEntry(turnFailed)).toBe('delivered');

      const halted = harness.service.postNotice(ch.id, {
        text: 'Everything here was stopped. Nothing was running at the time.',
        notice: 'halted',
      });
      expect(await chDelivery.deliverEntry(halted)).toBe('delivered');
    });

    it('the one per-bridge override turns delivery OFF for a dm: turn_failed and halted both suppress', async () => {
      const dm = harness.service.createBridgedRoom(bridgeRequest('557'));
      harness.bridges.setDeliverNotices(dm.id, false);
      const dmDelivery = makeDelivery(bindingRow(dm.id, '557'));
      binding = makeBinding({ canReply: true, canInitiate: true });

      const turnFailed = harness.service.postNotice(dm.id, {
        text: 'A turn failed.',
        notice: 'turn_failed',
      });
      expect(await dmDelivery.deliverEntry(turnFailed)).toBe('skipped');

      const halted = harness.service.postNotice(dm.id, {
        text: 'Everything here was stopped. Nothing was running at the time.',
        notice: 'halted',
      });
      expect(await dmDelivery.deliverEntry(halted)).toBe('skipped');
    });

    describe('scope is the four stopped-agent codes — every other code is refused', () => {
      // A bridged DM delivers notices by default (§6.2), so every case below
      // isolates the NOTICE-CODE eligibility test from the deliverNotices gate
      // itself: each must be 'skipped' even though THIS bridge delivers notices.
      // One `it` per excluded code — `cascade_stopped`, `budget_reached`,
      // `agent_gone`, `agent_unavailable` — so a future code added to the wrong
      // set fails a named test, not a shared one. `agent_busy` and
      // `awaiting_approval` used to sit here and are now delivered (DOR-1359);
      // their cases moved to the block below.
      function dmDelivery(chatId: string) {
        const dm = harness.service.createBridgedRoom(bridgeRequest(chatId));
        binding = makeBinding({ canReply: true, canInitiate: true });
        return { dm, delivery: makeDelivery(bindingRow(dm.id, chatId)) };
      }

      it('cascade_stopped is never delivered', async () => {
        const { dm, delivery } = dmDelivery('601');
        const notice = harness.service.postNotice(dm.id, {
          text: 'Ana stopped replying here — this back-and-forth hit its automatic-reply limit.',
          notice: 'cascade_stopped',
        });
        expect(await delivery.deliverEntry(notice)).toBe('skipped');
      });

      it('budget_reached is never delivered', async () => {
        const { dm, delivery } = dmDelivery('602');
        const notice = harness.service.postNotice(dm.id, {
          text: 'This room has used up its automatic replies for the hour.',
          notice: 'budget_reached',
        });
        expect(await delivery.deliverEntry(notice)).toBe('skipped');
      });

      it('agent_gone is never delivered (it names an agent the platform person has no relationship with — spec §6.2)', async () => {
        const { dm, delivery } = dmDelivery('604');
        const notice = harness.service.postNotice(dm.id, {
          text: "Ana isn't set up on this machine any more, so it can't answer here.",
          notice: 'agent_gone',
        });
        expect(await delivery.deliverEntry(notice)).toBe('skipped');
      });

      it('agent_unavailable is never delivered (a bind failure is a DorkOS-side fault, not something the platform person can act on)', async () => {
        const { dm, delivery } = dmDelivery('606');
        const notice = harness.service.postNotice(dm.id, {
          text: "Ana couldn't be made ready to answer here just now. Send another message to try again.",
          notice: 'agent_unavailable',
        });
        expect(await delivery.deliverEntry(notice)).toBe('skipped');
      });
    });

    describe('DOR-1359: a stopped agent is reported to the chat — awaiting_approval and agent_busy', () => {
      /**
       * A bridged DM with an inbound message to root the notice at, so it
       * classifies as a REPLY the way a real waiting/busy notice does: both are
       * written by `RoomNoticeLog` stamped with the triggering entry's cascade,
       * and in a bridged room that entry is the message that arrived from the
       * chat.
       */
      function bridgedDm(chatId: string) {
        const dm = harness.service.createBridgedRoom(bridgeRequest(chatId));
        const delivery = makeDelivery(bindingRow(dm.id, chatId));
        const inbound = seedInbound(dm.id, chatId, 'can you do the thing?', `pm-${chatId}`);
        binding = makeBinding({ canReply: true, canInitiate: true });
        const ana = harness.authors.resolveAgent(AGENT_PATH, 'Ana');
        return { dm, delivery, inbound, ana };
      }

      /** The text of the single publish this delivery made. */
      function deliveredText(): string {
        expect(publish).toHaveBeenCalledTimes(1);
        return (publish.mock.calls[0][1] as Record<string, unknown>).content as string;
      }

      it('an awaiting_approval notice reaches the chat, word for word as the room wrote it', async () => {
        const { dm, delivery, inbound, ana } = bridgedDm('610');
        // The REAL copy builder, so the delivered words are pinned to
        // `notice-copy.ts` itself rather than to a string typed twice.
        const body = buildWaitingNotice('Ana', ana.id, 'approval');
        const notice = harness.service.postNotice(dm.id, body, { root: inbound.id, depth: 1 });

        expect(await delivery.deliverEntry(notice)).toBe('delivered');
        expect(deliveredText()).toBe(body.text);
        // The agent is named on the platform, which is the whole point of the
        // line — a chat reader has to know WHICH agent stopped.
        expect(deliveredText()).toContain('Ana');
      });

      it('the other two waiting kinds deliver their own words, not the approval one', async () => {
        const { dm, delivery, inbound, ana } = bridgedDm('611');
        const body = buildWaitingNotice('Ana', ana.id, 'question');
        const notice = harness.service.postNotice(dm.id, body, { root: inbound.id, depth: 1 });

        expect(await delivery.deliverEntry(notice)).toBe('delivered');
        expect(deliveredText()).toBe(body.text);
        expect(deliveredText()).toBe(
          "Ana has a question for you before it can carry on. Open Ana's session to answer — it gives up if nobody does."
        );
      });

      it('a delivered waiting line carries no tool name, path or command (DOR-613)', async () => {
        const { dm, delivery, inbound, ana } = bridgedDm('612');
        const body = buildWaitingNotice('Ana', ana.id, 'approval');
        const notice = harness.service.postNotice(dm.id, body, { root: inbound.id, depth: 1 });

        await delivery.deliverEntry(notice);

        // The room's line is deliberately vague; what crosses to the chat is
        // exactly that line, so the vagueness crosses with it.
        const text = deliveredText();
        expect(text).not.toMatch(/Bash|Write|Edit|Read|npm |rm -|\.\/|\/Users\//);
      });

      it('an agent_busy notice reaches the chat, word for word as the room wrote it — both busy variants', async () => {
        const { dm, delivery, inbound, ana } = bridgedDm('613');
        const body = buildBusyNotice('Ana', ana.id, 'working-elsewhere');
        const notice = harness.service.postNotice(dm.id, body, { root: inbound.id, depth: 1 });

        expect(await delivery.deliverEntry(notice)).toBe('delivered');
        expect(deliveredText()).toBe(body.text);
        // It still never names the other conversation (`notice-copy.ts`'s own
        // rule), so nothing about somebody else's room crosses to this chat.
        expect(deliveredText()).toBe(
          "Ana is working in another conversation right now, so it didn't pick this up. Send it again in a few minutes."
        );
      });

      it('the unknown busy variant delivers its own words too', async () => {
        const { dm, delivery, inbound, ana } = bridgedDm('614');
        const body = buildBusyNotice('Ana', ana.id, 'unknown');
        const notice = harness.service.postNotice(dm.id, body, { root: inbound.id, depth: 1 });

        expect(await delivery.deliverEntry(notice)).toBe('delivered');
        expect(deliveredText()).toBe(body.text);
      });

      it('damped on repeat: re-delivering the same waiting notice sends nothing more', async () => {
        // One wait produces one room entry (`RoomNoticeLog.reportWaiting` damps
        // per room+agent for the life of the turn), and the bridge turns one
        // room entry into exactly one platform message however many times it is
        // asked — the inline commit path and the catch-up scan both land here.
        const { dm, delivery, inbound, ana } = bridgedDm('615');
        const notice = harness.service.postNotice(
          dm.id,
          buildWaitingNotice('Ana', ana.id, 'approval'),
          { root: inbound.id, depth: 1 }
        );

        expect(await delivery.deliverEntry(notice)).toBe('delivered');
        expect(await delivery.deliverEntry(notice)).toBe('noop');
        expect(await delivery.deliverEntry(notice)).toBe('noop');
        expect(publish).toHaveBeenCalledTimes(1);
      });

      it('damped on repeat: re-delivering the same busy notice sends nothing more', async () => {
        const { dm, delivery, inbound, ana } = bridgedDm('616');
        const notice = harness.service.postNotice(
          dm.id,
          buildBusyNotice('Ana', ana.id, 'working-elsewhere'),
          { root: inbound.id, depth: 1 }
        );

        expect(await delivery.deliverEntry(notice)).toBe('delivered');
        expect(await delivery.deliverEntry(notice)).toBe('noop');
        expect(publish).toHaveBeenCalledTimes(1);
      });

      it('three busy refusals in one DM buzz the chat ONCE — the room writes three, the bridge sends one', async () => {
        // The defect this closes: `RoomNoticeLog.reportSilence` deliberately
        // does NOT damp a message that directly asked the agent, and in a `dm`
        // every human message counts as asking — which is what a bridged
        // private chat is. So the room log legitimately holds one busy line per
        // message, and without a damper of its own the bridge would push one
        // notification per message typed.
        const { dm, delivery, inbound, ana } = bridgedDm('619');
        const outcomes: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          const notice = harness.service.postNotice(
            dm.id,
            buildBusyNotice('Ana', ana.id, 'working-elsewhere'),
            { root: inbound.id, depth: 1 }
          );
          outcomes.push(await delivery.deliverEntry(notice));
        }

        // Three DISTINCT entries in the room log — this is not idempotence on
        // one entry, which the case above already covers.
        expect(noticesOf(dm.id, 'agent_busy')).toHaveLength(3);
        expect(outcomes).toEqual(['delivered', 'damped', 'damped']);
        expect(publish).toHaveBeenCalledTimes(1);
      });

      it("the damp lifts on the agent's next turn in that room: it answers, goes busy again, and the chat is told again", async () => {
        const { dm, delivery, inbound, ana } = bridgedDm('620');
        const first = harness.service.postNotice(
          dm.id,
          buildBusyNotice('Ana', ana.id, 'working-elsewhere'),
          { root: inbound.id, depth: 1 }
        );
        expect(await delivery.deliverEntry(first)).toBe('delivered');

        const damped = harness.service.postNotice(
          dm.id,
          buildBusyNotice('Ana', ana.id, 'working-elsewhere'),
          { root: inbound.id, depth: 1 }
        );
        expect(await delivery.deliverEntry(damped)).toBe('damped');

        // Ana answers here — her turn in this room reached an outcome, which is
        // the same re-arm `RoomNoticeLog.recovered` uses.
        expect(await delivery.deliverEntry(agentPost(dm.id, 'back now', inbound.id))).toBe(
          'delivered'
        );

        const afterRecovery = harness.service.postNotice(
          dm.id,
          buildBusyNotice('Ana', ana.id, 'working-elsewhere'),
          { root: inbound.id, depth: 1 }
        );
        expect(await delivery.deliverEntry(afterRecovery)).toBe('delivered');
        // Two busy lines and one answer reached the chat, in that order.
        expect(publish).toHaveBeenCalledTimes(3);
      });

      it('a turn_failed about that agent also re-arms the busy line — a broken turn is an outcome too', async () => {
        const { dm, delivery, inbound, ana } = bridgedDm('621');
        const first = harness.service.postNotice(dm.id, buildBusyNotice('Ana', ana.id, 'unknown'), {
          root: inbound.id,
          depth: 1,
        });
        expect(await delivery.deliverEntry(first)).toBe('delivered');

        const failed = harness.service.postNotice(dm.id, buildTurnFailedNotice('Ana', ana.id), {
          root: inbound.id,
          depth: 1,
        });
        expect(await delivery.deliverEntry(failed)).toBe('delivered');

        const afterFailure = harness.service.postNotice(
          dm.id,
          buildBusyNotice('Ana', ana.id, 'unknown'),
          { root: inbound.id, depth: 1 }
        );
        expect(await delivery.deliverEntry(afterFailure)).toBe('delivered');
      });

      it('a waiting line is NOT damped by the busy damper — two different agents, two different states', async () => {
        // The busy damper keys on `(room, agent)`; a waiting notice about the
        // same agent must still get through, because it reports a different
        // state with a different remedy.
        const { dm, delivery, inbound, ana } = bridgedDm('622');
        const busy = harness.service.postNotice(dm.id, buildBusyNotice('Ana', ana.id, 'unknown'), {
          root: inbound.id,
          depth: 1,
        });
        expect(await delivery.deliverEntry(busy)).toBe('delivered');

        const waiting = harness.service.postNotice(
          dm.id,
          buildWaitingNotice('Ana', ana.id, 'approval'),
          { root: inbound.id, depth: 1 }
        );
        expect(await delivery.deliverEntry(waiting)).toBe('delivered');
        expect(publish).toHaveBeenCalledTimes(2);
      });

      it('the damp is per ROOM: a second bridged DM hears about the same agent on its own account', async () => {
        const a = bridgedDm('623');
        const b = bridgedDm('624');
        const ana = a.ana;
        const first = harness.service.postNotice(
          a.dm.id,
          buildBusyNotice('Ana', ana.id, 'working-elsewhere'),
          { root: a.inbound.id, depth: 1 }
        );
        expect(await a.delivery.deliverEntry(first)).toBe('delivered');

        const second = harness.service.postNotice(
          b.dm.id,
          buildBusyNotice('Ana', ana.id, 'working-elsewhere'),
          { root: b.inbound.id, depth: 1 }
        );
        expect(await b.delivery.deliverEntry(second)).toBe('delivered');
      });

      it('both still obey deliverNotices: a bridged CHANNEL hears neither by default', async () => {
        const ch = harness.service.createBridgedRoom({
          ...bridgeRequest('617', true),
          bindingId: 'binding-ch-1359',
        });
        const chDelivery = makeDelivery(bindingRow(ch.id, '617'));
        binding = makeBinding({ canReply: true, canInitiate: true });
        const ana = harness.authors.resolveAgent(AGENT_PATH, 'Ana');

        const waiting = harness.service.postNotice(
          ch.id,
          buildWaitingNotice('Ana', ana.id, 'approval')
        );
        expect(await chDelivery.deliverEntry(waiting)).toBe('skipped');

        const busy = harness.service.postNotice(ch.id, buildBusyNotice('Ana', ana.id, 'unknown'));
        expect(await chDelivery.deliverEntry(busy)).toBe('skipped');
        expect(publish).not.toHaveBeenCalled();
      });

      it('both still obey the per-bridge override: a DM with deliverNotices off hears neither', async () => {
        const dm = harness.service.createBridgedRoom(bridgeRequest('618'));
        harness.bridges.setDeliverNotices(dm.id, false);
        const delivery = makeDelivery(bindingRow(dm.id, '618'));
        binding = makeBinding({ canReply: true, canInitiate: true });
        const ana = harness.authors.resolveAgent(AGENT_PATH, 'Ana');

        const waiting = harness.service.postNotice(
          dm.id,
          buildWaitingNotice('Ana', ana.id, 'approval')
        );
        expect(await delivery.deliverEntry(waiting)).toBe('skipped');

        const busy = harness.service.postNotice(dm.id, buildBusyNotice('Ana', ana.id, 'unknown'));
        expect(await delivery.deliverEntry(busy)).toBe('skipped');
        expect(publish).not.toHaveBeenCalled();
      });
    });

    it('turn_failed is re-rendered for the chat, not forwarded verbatim: the delivered text names no session', async () => {
      const dm = harness.service.createBridgedRoom(bridgeRequest('558'));
      const dmDelivery = makeDelivery(bindingRow(dm.id, '558'));
      binding = makeBinding({ canReply: true, canInitiate: true });
      const ana = harness.authors.resolveAgent(AGENT_PATH, 'Ana');
      const notice = harness.service.postNotice(dm.id, {
        text: "Ana ran into a problem and could not answer here. Open Ana's session to see what went wrong.",
        notice: 'turn_failed',
        subjectAuthorId: ana.id,
      });
      expect(await dmDelivery.deliverEntry(notice)).toBe('delivered');
      const [, payload] = publish.mock.calls[0] as [string, Record<string, unknown>];
      expect(payload.content).toBe(
        "Ana ran into a problem and couldn't answer. Try sending your message again."
      );
      expect(payload.content).not.toContain('session');
    });
  });

  describe('sweepStrandedRefs — the startup stranded-ref sweep (spec §10.1 crash divergence, DOR-898)', () => {
    /** An outbound ref written but never patched — simulates a crash between the write and the send. */
    function seedStrandedRef(roomId: string, chatId: string, entryId: string, createdAt: string) {
      harness.bridges.recordOutboundRef({
        roomId,
        entryId,
        chatId,
        adapterId: ADAPTER,
        createdAt,
      });
    }

    const WELL_PAST_THRESHOLD = new Date(Date.now() - 20 * 60_000).toISOString();

    it('a stranded null-id ref older than the threshold gets exactly one bridge_undelivered notice, and is neither deleted nor re-sent', async () => {
      const room = harness.service.createBridgedRoom(bridgeRequest('900'));
      const delivery = makeDelivery(bindingRow(room.id, '900'));
      const post = operatorPost(room.id, 'crashed before the send landed');
      seedStrandedRef(room.id, '900', post.id, WELL_PAST_THRESHOLD);

      await delivery.sweepStrandedRefs();

      // Never re-sent: the crashed send may have already reached the platform.
      expect(publish).not.toHaveBeenCalled();
      // Never deleted: a rollback would return the entry to the catch-up
      // scan's candidate set and risk a duplicate on the next reconnect.
      const ref = harness.bridges.findRefByEntry(post.id);
      expect(ref).not.toBeNull();
      expect(ref?.direction).toBe('outbound');
      expect(ref?.platformMessageId).toBeNull();
      // The same notice code the exhausted-retry path writes (spec §10.1) —
      // exactly one, naming this entry.
      const notices = noticesOf(room.id, 'bridge_undelivered');
      expect(notices).toHaveLength(1);
      expect(notices[0].body.text).toContain('crashed before the send landed');
    });

    it('a null-id ref younger than the threshold (a plausibly in-flight retry) is not swept', async () => {
      const room = harness.service.createBridgedRoom(bridgeRequest('901'));
      const delivery = makeDelivery(bindingRow(room.id, '901'));
      const post = operatorPost(room.id, 'still retrying, do not touch');
      seedStrandedRef(room.id, '901', post.id, new Date().toISOString());

      await delivery.sweepStrandedRefs();

      expect(publish).not.toHaveBeenCalled();
      expect(noticesOf(room.id, 'bridge_undelivered')).toHaveLength(0);
      // The ref is untouched either way — the point is no PREMATURE notice.
      expect(harness.bridges.findRefByEntry(post.id)?.platformMessageId).toBeNull();
    });

    it('a ref that already carries a platform id (delivered) is never swept', async () => {
      const room = harness.service.createBridgedRoom(bridgeRequest('902'));
      const delivery = makeDelivery(bindingRow(room.id, '902'));
      const post = operatorPost(room.id, 'delivered long ago');
      seedStrandedRef(room.id, '902', post.id, WELL_PAST_THRESHOLD);
      harness.bridges.patchOutboundPlatformId(post.id, 'tg-out-delivered');

      await delivery.sweepStrandedRefs();

      expect(publish).not.toHaveBeenCalled();
      expect(noticesOf(room.id, 'bridge_undelivered')).toHaveLength(0);
    });

    it('damping: two startup sweeps do not double-notice the same stranded ref', async () => {
      const room = harness.service.createBridgedRoom(bridgeRequest('903'));
      const delivery = makeDelivery(bindingRow(room.id, '903'));
      const post = operatorPost(room.id, 'crashed, and checked on twice');
      seedStrandedRef(room.id, '903', post.id, WELL_PAST_THRESHOLD);

      await delivery.sweepStrandedRefs();
      await delivery.sweepStrandedRefs();

      expect(noticesOf(room.id, 'bridge_undelivered')).toHaveLength(1);
      // Still neither deleted nor re-sent after the second pass.
      expect(publish).not.toHaveBeenCalled();
      expect(harness.bridges.findRefByEntry(post.id)?.platformMessageId).toBeNull();
    });
  });
});
