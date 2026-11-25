/**
 * Shared setup for the `ChatBridgeDelivery` tests (`deliver.*.test.ts`) — the
 * outbound half of the bridge (chats-as-channels spec §6), and the loop-closer:
 * a committed room entry reaches the platform chat.
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
import { beforeEach, vi, type Mock } from 'vitest';
import type { PublishOptions, PublishResult, DeliveryResult } from '@dorkos/relay';
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

export const AGENT_PATH = '/agents/ana';
export const agentLookup = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});
export const ADAPTER = 'tg-main';
export const BINDING_ID = 'binding-ana';

/** A telegram `relay.human.*` subject for a bridge row. */
export function subjectFor(bridge: Bridge): string {
  return bridge.platformChatType === 'private'
    ? `relay.human.telegram.${bridge.adapterId}.${bridge.chatId}`
    : `relay.human.telegram.${bridge.adapterId}.group.${bridge.chatId}`;
}

/** A permissive DM binding, overridable per case (mirrors the consent-gate tests). */
export function makeBinding(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
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
export function externalIdentity(userId = '145223', name = 'Miguel') {
  return externalSenderIdentity(
    { senderName: name, platformData: { fromId: userId } },
    { platformType: 'telegram', instanceId: ADAPTER }
  );
}

/** A binding row, as the lifecycle reads it (for the 403 archival path). */
export function bindingRow(roomId: string, chatId: string): LifecycleBinding {
  return { id: BINDING_ID, adapterId: ADAPTER, chatId, bridge: 'room', roomId };
}

/** The standing-card port the waiting-notice suppression reads (spec `ask-entitlement` §5.4). */
export type StandingCards = {
  hasStandingCard: (roomId: string, authorId: string | undefined) => boolean;
};

/** The mutable per-test state and helpers every delivery test shares. */
export interface DeliveryFixture {
  harness: RoomHarness;
  /** The mutable binding the gate resolves — a test flips its switches. */
  binding: AdapterBinding;
  /** The next adapter result each publish returns when the gate allows it. */
  nextAdapterResult: (attempt: number) => DeliveryResult;
  /** Every publish the delivery made: subject, payload, from. */
  publish: Mock;
  /**
   * The real operator name `ChatBridgeDelivery` resolves for the §6.7 prefix
   * (DOR-899) — `null` by default, the "nothing configured" case.
   */
  operatorDisplayName: () => string | null;
  bridgeRequest: (chatId: string, group?: boolean) => CreateBridgedRoomRequest;
  makeDelivery: (seedBinding: LifecycleBinding, asks?: StandingCards) => ChatBridgeDelivery;
  noticesOf: (roomId: string, code: string) => ReturnType<RoomHarness['store']['listEntries']>;
  seedInbound: (
    roomId: string,
    chatId: string,
    text: string,
    platformMessageId: string,
    threadId?: string
  ) => NonNullable<ReturnType<RoomHarness['store']['getEntryById']>>;
  agentPost: (
    roomId: string,
    text: string,
    replyToInbound?: string
  ) => ReturnType<RoomHarness['service']['post']>;
  operatorPost: (roomId: string, text: string) => ReturnType<RoomHarness['service']['post']>;
}

/**
 * Register a `beforeEach` that resets a fresh harness, and return the fixture
 * the tests read. Helpers read the fixture's current fields at call time, so a
 * test may reassign `t.harness`, `t.binding` or `t.nextAdapterResult` freely.
 */
export function useDeliveryFixture(): DeliveryFixture {
  const t = {
    bridgeRequest(chatId: string, group = false): CreateBridgedRoomRequest {
      return {
        adapterId: ADAPTER,
        chatId,
        bindingId: BINDING_ID,
        chatType: group ? 'group' : 'private',
        channelType: group ? 'group' : null,
        title: group ? 'Team' : 'Miguel',
        agentPath: AGENT_PATH,
        operatorAuthorId: t.harness.human,
      };
    },

    /**
     * Build a delivery over the real room service and the REAL consent gate, with
     * a fake publish pipeline whose adapter outcome the test controls.
     *
     * @param seedBinding - The binding row the lifecycle reads.
     * @param asks - Whether a bridged Approve/Deny card is standing. Omitted
     *   means the bridged-card path is not wired.
     */
    makeDelivery(seedBinding: LifecycleBinding, asks?: StandingCards): ChatBridgeDelivery {
      const gate = createInitiateConsentGate({
        bindingStore: { resolve: () => t.binding },
        resolveAgentSubject: () => undefined,
      });
      let attempt = 0;
      t.publish = vi.fn(
        async (
          subject: string,
          _payload: unknown,
          opts: PublishOptions
        ): Promise<PublishResult> => {
          const decision = gate(opts.from, subject);
          if (!decision.allowed) {
            return {
              messageId: 'relay-msg',
              deliveredTo: 0,
              rejected: [{ endpointHash: 'e', reason: 'initiate_denied' }],
            };
          }
          const ar = t.nextAdapterResult(attempt);
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
        rooms: t.harness.service,
        bridges: t.harness.bridges,
        bindings,
        chatNotice: async () => true,
        operatorAuthorId: () => t.harness.human,
      });
      return new ChatBridgeDelivery({
        entries: t.harness.store,
        rooms: t.harness.service,
        bridges: t.harness.bridges,
        authors: t.harness.authors,
        publisher: { publish: t.publish as never },
        lifecycle,
        resolveSubject: subjectFor,
        operatorAuthorId: () => t.harness.human,
        operatorDisplayName: () => t.operatorDisplayName(),
        sleep: async () => {},
        retryBackoffMs: [1, 1],
        ...(asks ? { asks } : {}),
      });
    },

    noticesOf(roomId: string, code: string) {
      return t.harness.store
        .listEntries(roomId, { limit: 1000 })
        .filter((e) => e.kind === 'notice' && e.body.notice === code);
    },

    /** Post an inbound entry (author minted, inbound ref written) — an ingested message. */
    seedInbound(
      roomId: string,
      chatId: string,
      text: string,
      platformMessageId: string,
      threadId?: string
    ) {
      const identity = externalIdentity();
      if (!identity) throw new Error('identity');
      const { entry } = t.harness.service.postExternal(roomId, {
        identity,
        text,
        recordRef: (entryId, tx) =>
          t.harness.bridges.recordInboundRef(
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
      const full = t.harness.store.getEntryById(roomId, entry.id);
      if (!full) throw new Error('inbound entry vanished');
      return full;
    },

    /** Post as the bound agent, optionally as a reply to an inbound entry. */
    agentPost(roomId: string, text: string, replyToInbound?: string) {
      const agent = t.harness.authors.resolveAgent(AGENT_PATH, 'Ana');
      return t.harness.service.post(roomId, {
        authorId: agent.id,
        text,
        ...(replyToInbound ? { trigger: { root: replyToInbound, depth: 1 } } : {}),
      });
    },

    /** Post as the operator — self-rooted, an initiate. */
    operatorPost(roomId: string, text: string) {
      return t.harness.service.post(roomId, { authorId: t.harness.human, text });
    },
  } as DeliveryFixture;

  beforeEach(() => {
    t.harness = createRoomHarness({ agents: agentLookup });
    t.binding = makeBinding();
    t.nextAdapterResult = () => ({ success: true, responseMessageId: 'tg-out-1' });
    t.operatorDisplayName = () => null;
  });

  return t;
}
