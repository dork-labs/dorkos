/**
 * The full loop, end to end (chats-as-channels §5 + §6): a platform message
 * becomes a room post, the room's own turn machinery answers it, and the answer
 * is delivered back to the platform — the inbound never round-tripping.
 *
 * Everything is real (`RoomService`, the dispatcher, `ChatBridge`,
 * `ChatBridgeDelivery`, `BridgeCatchUp`, the consent gate, and the
 * `setEntryCommitListener` → `onCommit` wiring) except the turn RUNNER and the
 * platform transport: a publish that runs the real gate and returns the
 * pipeline's `PublishResult` (§13).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChatNoticeSender, type PublishResult, type PublishOptions } from '@dorkos/relay';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import { composeRegistry } from '../../../core/capabilities/index.js';
import { roomsDomain } from '../../../rooms/room-capabilities.js';
import { createInitiateConsentGate } from '../../initiate-consent.js';
import {
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
  type LifecycleBinding,
} from '../index.js';
import {
  ADAPTER,
  AGENT_PATH,
  BINDING_ID,
  agentLookup,
  makeBinding,
  subjectFor,
} from './deliver.fixtures.js';
import { envelopeFor } from './inbound.fixtures.js';

const CHAT_ID = '555';

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
    binding = makeBinding({ canInitiate: false });

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
      envelopeFor({ chatId: CHAT_ID, messageId: 7, content: 'are you there?' }),
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

  it('post_to_room cannot send an agent post outside when the bridge cannot initiate', async () => {
    const room = harness.service.createBridgedRoom(bridgeRequest());
    binding = makeBinding({ canInitiate: false });
    const author = harness.authors.resolveAgent(AGENT_PATH, 'Ana');
    const sessionId = 'bridge-seat-post-fixture';
    harness.store.bindRoomSession(room.id, author.id, sessionId, new Date().toISOString());
    const registry = composeRegistry([roomsDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: harness.service },
    });
    const result = (await registry.invoke(
      'rooms.post',
      { roomId: room.id, text: 'Keep this local', confirm: true },
      {
        identity: {
          agentPath: AGENT_PATH,
          displayName: 'Ana',
          createdAt: new Date().toISOString(),
        },
        sessionId,
        retryChannel: 'mcp-argument',
      }
    )) as { posted: boolean; entryId: string };
    expect(result.posted).toBe(true);
    await settleUntil(
      () =>
        harness.store
          .listEntries(room.id, { limit: 100 })
          .some((entry) => entry.body.notice === 'bridge_blocked'),
      'tool post is blocked by the real consent gate'
    );
    expect(harness.store.getEntryById(room.id, result.entryId)?.body.text).toBe('Keep this local');
    expect(harness.bridges.findRefByEntry(result.entryId)?.platformMessageId ?? null).toBeNull();
    const sends = await Promise.all(
      publish.mock.results.map((call) => call.value as Promise<PublishResult>)
    );
    expect(sends.length).toBeGreaterThan(0);
    expect(sends.every((send) => send.deliveredTo === 0 && send.adapterResult === undefined)).toBe(
      true
    );
  });
});
