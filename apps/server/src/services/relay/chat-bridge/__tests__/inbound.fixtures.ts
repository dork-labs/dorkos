/**
 * Shared inbound setup for `ingest.test.ts` and the bridged-room security suite
 * (`bridged-room-security.*.test.ts`, chats-as-channels spec §9, DOR-633 /
 * DOR-880). Why the suite exists and what it does NOT claim are in the header
 * of `bridged-room-security.fence.test.ts`.
 *
 * `createRoomHarness` wires the real store, the real `AuthorRegistry`, the real
 * `RoomService`, and the real `RoomTriggerDispatcher` over an in-memory
 * `better-sqlite3`; only the turn runner is scripted, because the alternative is
 * a model call. The external author is a genuine one minted through
 * `RoomService.postExternal` → `AuthorRegistry.resolveExternal` off a real
 * `platform:telegram:tg-main:…` natural key — never a hand-set `authorOrigin`
 * string, so the origin the fence reads is the one the store derived.
 */
import { vi } from 'vitest';
import { createChatNoticeSender, type PublishResult } from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { AdapterBindingSchema, type AdapterBinding } from '@dorkos/shared/relay-schemas';
import { agentLookupFor, type RoomHarness } from '../../../rooms/__tests__/room-test-harness.js';
import type { CreateBridgedRoomRequest } from '../../../rooms/room-service.js';
import type { ExternalAuthorIdentity } from '../../../rooms/author-registry.js';
import { ChatBridge, BridgeLifecycle, type LifecycleBinding } from '../index.js';

export const ADAPTER = 'tg-main';
export const BINDING_ID = 'binding-ana';
export const AGENT_PATH = '/agents/ana';
export const agentLookup = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

/** A `relay.human.telegram.*` subject for a chat, DM or group. */
export function subjectFor(chatId: string, group = false): string {
  return group
    ? `relay.human.telegram.${ADAPTER}.group.${chatId}`
    : `relay.human.telegram.${ADAPTER}.${chatId}`;
}

/** A bridged binding, as `ingest`/`lifecycle` read it. */
export function bindingFor(roomId: string | null, chatId: string): LifecycleBinding {
  return { id: BINDING_ID, adapterId: ADAPTER, chatId, bridge: 'room', roomId };
}

/** The fields of an inbound Telegram envelope a test varies. */
export interface EnvelopeOpts {
  chatId: string;
  group?: boolean;
  content?: string;
  messageId?: number | string;
  fromId?: number | string | null;
  senderName?: string;
  /** A forum topic id, as the adapter puts it on `platformData.messageThreadId`. */
  messageThreadId?: number | string;
  /** A forum topic name — raw platform text, sanitized by `ingest` at the store. */
  threadName?: string;
  /** The bot's own @username, so a mention of it addresses the bound agent. */
  botUsername?: string;
  /** A raw media descriptor, as the adapter puts it on `platformData.media`. */
  media?: unknown;
  /** Extra platformData fields — used to plant a secret sentinel for §9.5. */
  extraPlatformData?: Record<string, unknown>;
}

/** Build an inbound envelope the way the Telegram adapter would publish one. */
export function envelopeFor(opts: EnvelopeOpts): RelayEnvelope {
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
        messageThreadId: opts.messageThreadId,
        threadName: opts.threadName,
        botUsername: opts.botUsername,
        media: opts.media,
        ...opts.extraPlatformData,
      },
    },
  };
}

/** A bridged-room create request for a Telegram group (override for a DM). */
export function bridgeRequest(
  harness: RoomHarness,
  overrides: Partial<CreateBridgedRoomRequest> = {}
): CreateBridgedRoomRequest {
  return {
    adapterId: ADAPTER,
    chatId: '555',
    bindingId: BINDING_ID,
    chatType: 'group',
    channelType: 'group',
    title: 'Ops Team',
    agentPath: AGENT_PATH,
    operatorAuthorId: harness.human,
    ...overrides,
  };
}

/** Miguel, a genuine external sender on the `tg-main` bot. */
export function miguel(overrides: Partial<ExternalAuthorIdentity> = {}): ExternalAuthorIdentity {
  return {
    platformType: 'telegram',
    instanceId: ADAPTER,
    platformUserId: '145223',
    displayName: 'Miguel',
    ...overrides,
  };
}

/** A minimal binding parsed through the REAL schema, so its defaults apply. */
export function parseBinding(overrides: Record<string, unknown> = {}): AdapterBinding {
  return AdapterBindingSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    adapterId: ADAPTER,
    agentId: 'agent-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

/** A real `ChatBridge` over the real service, with a real lifecycle + notice. */
export function makeIngest(harness: RoomHarness): ChatBridge {
  const publish = vi.fn(async (): Promise<PublishResult> => ({ messageId: 'm', deliveredTo: 1 }));
  const rows = new Map<string, LifecycleBinding>();
  const bindings = {
    getById: (id: string) => rows.get(id),
    update: vi.fn(async () => undefined),
  };
  const chatNotice = createChatNoticeSender({
    publish: publish as unknown as (s: string, p: unknown, o: unknown) => Promise<PublishResult>,
    resolveTarget: (subject: string) =>
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
  });
}
