/**
 * The full loop, end to end (chats-as-channels §5 + §6): a platform message
 * becomes a room post, the room's own turn machinery answers it, and the answer
 * is delivered back to the platform — with the inbound message never round-
 * tripping.
 *
 * **What is real here is the point.** The real `RoomService`, the real
 * `RoomTriggerDispatcher` (only its turn RUNNER is scripted, because the
 * alternative is a model call), the real `AuthorRegistry`, the real
 * `BridgeStore`, the real `ChatBridge` ingest, the real `ChatBridgeDelivery`,
 * the real `BridgeCatchUp`, the REAL `createInitiateConsentGate`, and — the
 * wiring this task adds — the real `RoomService.setEntryCommitListener` →
 * `ChatBridgeDelivery.onCommit` inline path. The one fake is the platform
 * transport: a publish that runs the real gate and returns the `PublishResult`
 * the relay pipeline would, so the send is observable without a live Telegram.
 * The grammY `Bot` boundary itself is exercised by the Telegram adapter's own
 * tests (reply/topic targeting and the returned message id); here the platform
 * is faked one layer up, at the relay publish. Nothing mocks `RoomService`, the
 * dispatcher, or the gate (§13).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChatNoticeSender, type PublishResult, type PublishOptions } from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import { createInitiateConsentGate } from '../../initiate-consent.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  settleUntil,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import type { CreateBridgedRoomRequest } from '../../../rooms/room-service.js';
import {
  ChatBridge,
  ChatBridgeDelivery,
  BridgeCatchUp,
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
const CHAT_ID = '555';

function subjectFor(bridge: Bridge): string {
  return bridge.platformChatType === 'private'
    ? `relay.human.telegram.${bridge.adapterId}.${bridge.chatId}`
    : `relay.human.telegram.${bridge.adapterId}.group.${bridge.chatId}`;
}

function makeBinding(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
  return {
    id: BINDING_ID,
    adapterId: ADAPTER,
    agentId: 'agent-1',
    sessionStrategy: 'per-chat',
    enabled: true,
    canInitiate: false,
    canReply: true,
    canReceive: true,
    notifyOnTaskComplete: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as AdapterBinding;
}

/** An inbound Telegram envelope, as the adapter publishes one. */
function inboundEnvelope(messageId: number, content: string): RelayEnvelope {
  return {
    id: `env-${messageId}`,
    subject: `relay.human.telegram.${ADAPTER}.${CHAT_ID}`,
    from: `telegram.${ADAPTER}.bot`,
    budget: {
      hopCount: 0,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 60_000,
      callBudgetRemaining: 5,
    },
    createdAt: new Date().toISOString(),
    payload: {
      content,
      senderName: 'Miguel',
      platformData: { chatId: CHAT_ID, messageId, chatType: 'private', fromId: 145223 },
    },
  };
}

describe('chat bridge — full inbound → room → turn → outbound (chats-as-channels §5, §6)', () => {
  let harness: RoomHarness;
  let binding: AdapterBinding;
  /** Every send the delivery published — the fake platform transport. */
  let publish: ReturnType<typeof vi.fn>;
  let integration: { ingest: ChatBridge; delivery: ChatBridgeDelivery; catchUp: BridgeCatchUp };

  function bridgeRequest(): CreateBridgedRoomRequest {
    return {
      adapterId: ADAPTER,
      chatId: CHAT_ID,
      bindingId: BINDING_ID,
      chatType: 'private',
      channelType: null,
      title: 'Miguel',
      agentPath: AGENT_PATH,
      operatorAuthorId: harness.human,
    };
  }

  function bindingRow(roomId: string): LifecycleBinding {
    return { id: BINDING_ID, adapterId: ADAPTER, chatId: CHAT_ID, bridge: 'room', roomId };
  }

  beforeEach(() => {
    // The agent answers 'the answer' to every turn — a scripted RUNNER, not a
    // scripted dispatcher: the real dispatcher still decides whether a turn runs.
    harness = createRoomHarness({
      agents: agentLookup,
      runner: scriptedRunner(() => 'the answer'),
    });
    binding = makeBinding();

    // The one fake: a publish that runs the REAL consent gate and returns the
    // pipeline's PublishResult shape, so a send is observable.
    const gate = createInitiateConsentGate({
      bindingStore: { resolve: () => binding },
      resolveAgentSubject: () => undefined,
    });
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
        return {
          messageId: 'relay-msg',
          deliveredTo: 1,
          adapterResult: { success: true, responseMessageId: 'tg-out' },
        };
      }
    );

    const rows = new Map<string, LifecycleBinding>();
    const bindingWriter = {
      getById: (id: string) => rows.get(id),
      update: vi.fn(async () => undefined),
    };
    const chatNotice = createChatNoticeSender({
      publish: publish as never,
      resolveTarget: () => ({ bindingId: BINDING_ID }),
    });
    const lifecycle = new BridgeLifecycle({
      rooms: harness.service,
      bridges: harness.bridges,
      bindings: bindingWriter,
      chatNotice,
      operatorAuthorId: () => harness.human,
    });
    const ingest = new ChatBridge({
      rooms: harness.service,
      bridges: harness.bridges,
      lifecycle,
      chatNotice,
    });
    const delivery = new ChatBridgeDelivery({
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
    const catchUp = new BridgeCatchUp({
      bridges: harness.bridges,
      entries: harness.store,
      delivery,
    });
    delivery.setRecoveryHook((roomId) => void catchUp.scanRoom(roomId));

    // THE WIRING under test: every committed entry runs the inline delivery.
    harness.service.setEntryCommitListener((entry) => delivery.onCommit(entry));

    integration = { ingest, delivery, catchUp };
  });

  it('an inbound message becomes a post, the turn answers, and the answer reaches the platform — the inbound never round-trips', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest());

    // Inbound: a real ingest writes the room post and triggers a real turn.
    const result = await integration.ingest.ingest(
      bindingRow(room.id),
      inboundEnvelope(7, 'are you there?'),
      {
        agentPath: AGENT_PATH,
      }
    );
    expect(result.status).toBe('ingested');

    // The turn runs, its answer commits, and the inline hook delivers it.
    await settleUntil(
      () =>
        publish.mock.calls.some((c) => (c[1] as Record<string, unknown>).content === 'the answer'),
      'the agent answer to reach the platform'
    );

    // The answer went out as a REPLY (canInitiate is off, canReply on — it rode
    // canReply), targeting the inbound message.
    const sent = publish.mock.calls.find(
      (c) => (c[1] as Record<string, unknown>).content === 'the answer'
    )!;
    expect((sent[2] as PublishOptions).from).toBe(`relay.bridge.reply.${ADAPTER}.${CHAT_ID}`);
    expect((sent[1] as Record<string, unknown>).replyToMessageId).toBe('7');

    // The inbound message itself was NEVER published back to the platform (echo
    // suppression) — no send carried its text.
    expect(
      publish.mock.calls.some((c) => (c[1] as Record<string, unknown>).content === 'are you there?')
    ).toBe(false);

    // The answer's outbound ref carries the platform id the send returned.
    const answer = harness.store
      .listEntries(room.id, { limit: 100 })
      .find((e) => e.body.text === 'the answer')!;
    expect(harness.bridges.findRefByEntry(answer.id)?.platformMessageId).toBe('tg-out');
  });

  it('a cockpit post with canInitiate off is blocked and stays in the room', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest());
    binding = makeBinding({ canInitiate: false });

    // The operator speaks into their own bridged chat from the cockpit.
    const post = harness.service.post(room.id, {
      authorId: harness.human,
      text: 'hello from cockpit',
    });

    await settleUntil(
      () =>
        harness.store
          .listEntries(room.id, { limit: 100 })
          .some((e) => e.kind === 'notice' && e.body.notice === 'bridge_blocked'),
      'the blocked notice to land'
    );

    // The delivery was refused by the gate, so the post's outbound ref was never
    // patched with a platform id — it stayed here, undelivered (§6.6). (The gate
    // runs INSIDE publish, so a publish call is how it was evaluated; the honest
    // signal that nothing reached the chat is the un-patched ref, not the absence
    // of a call.)
    expect(harness.bridges.findRefByEntry(post.id)?.platformMessageId ?? null).toBeNull();
    // The post itself is still in the room.
    expect(harness.store.getEntryById(room.id, post.id)).not.toBeNull();
  });
});
