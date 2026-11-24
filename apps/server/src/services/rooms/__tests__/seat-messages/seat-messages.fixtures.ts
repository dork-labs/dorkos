/**
 * Shared room, seat and chat-message wiring for the seat-message suites, the
 * DOR-4472 class proof: peer writes must enter a scoped, bounded, marked private
 * aside, never ordinary session dispatch or an automatic public body post.
 *
 * @module server/services/rooms/__tests__/seat-messages/seat-messages.fixtures
 */
import { afterEach, beforeEach, vi } from 'vitest';
import {
  ChatMessageService,
  type ChatMessageServiceDeps,
} from '../../../session/chat-messages/chat-message-service.js';
import { ChatMessageStore } from '../../../session/chat-messages/chat-message-store.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import type { RoomSeatMessagesPort } from '../../handoff/seat-message-types.js';
import type { RoomService } from '../../room-service.js';
import type { RoomTurnRequest } from '../../room-turn-port.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  roomSpec,
} from '../room-test-harness.js';

export const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
  '/agents/cy': { name: 'cy', displayName: 'Cy', responseMode: 'mention-only' },
});
export const caller = { sessionId: 'sender-chat', agentPath: '/agents/ana' };
export const loose = { asks: 'never', reach: 'everything' } as const;
export const mesh = {
  get: (id: string) => (id === 'agent-ana' ? { id, name: 'ana' } : undefined),
  getProjectPath: () => '/agents/ana',
  listWithPaths: () => [
    { id: 'agent-ana', name: 'ana', displayName: 'Ana', projectPath: '/agents/ana' },
    { id: 'agent-bo', name: 'bo', displayName: 'Ana', projectPath: '/agents/bo' },
  ],
};
export let harness: ReturnType<typeof createRoomHarness>;
export let receipts: ChatMessageStore;
export let chats: ChatMessageService;
export let roomId: string;
export let bo: string;
export let turns: RoomTurnRequest[];
export let unboundAliases: Set<string>;
export let dispatch: ReturnType<typeof vi.fn<NonNullable<ChatMessageServiceDeps['dispatch']>>>;
export let seatInbox: RoomSeatMessagesPort | undefined;
export let deps: ChatMessageServiceDeps;
export const deferredFinishes = new Set<() => void>();

/** Optional only so pre-fix proof fails on actual refusal, not an absent new export. */
export function inboxOf(service: RoomService): unknown {
  return (
    service as RoomService & {
      createSeatMessages?: (store: ChatMessageStore, emit: () => void) => typeof seatInbox;
    }
  ).createSeatMessages?.(receipts, () => undefined);
}

/**
 * Seat Bo in a fresh room and wire a chat-message service whose only way into
 * a seat is the private inbox. Call once at the top of each suite file.
 */
export function useSeatMessageRoom(): void {
  beforeEach(() => {
    turns = [];
    unboundAliases = new Set();
    deferredFinishes.clear();
    harness = createRoomHarness({
      agents,
      runner: outcomeRunner((request) => {
        turns.push(request);
        return { text: null };
      }),
    });
    const room = harness.service.createRoom(
      // Ana sends most private messages below, so she is a member (DOR-4547).
      roomSpec('channel', 'Build', ['/agents/bo', '/agents/ana']),
      harness.human
    );
    roomId = room.id;
    bo = harness.authors.resolveAgent('/agents/bo', 'Bo').id;
    harness.store.bindRoomSession(roomId, bo, 'seat-chat', new Date().toISOString());
    runtimeRegistry.setDb(harness.db);
    receipts = new ChatMessageStore(harness.db);
    seatInbox = inboxOf(harness.service) as typeof seatInbox;
    dispatch = vi.fn<NonNullable<ChatMessageServiceDeps['dispatch']>>(async () => {
      throw new Error('a seat must never use ordinary dispatch');
    });
    deps = {
      store: receipts,
      meshCore: () => mesh as never,
      describeSession: async (id) => ({
        bound: !unboundAliases.has(id),
        roomBound: true,
        launchOrigin: 'room',
        agentPath: '/agents/bo',
        startedByExtension: null,
      }),
      chatTitle: async () => 'Private title sentinel',
      sessionCwd: async () => '/agents/bo',
      isBusy: async () => false,
      dispatch,
      steerInto: vi.fn(async () => false),
      interruptTurn: vi.fn(async () => false),
      canonicalId: async (id) => id,
      turnLevelOf: () => loose,
      emitActivity: () => undefined,
      onLifecycle: () => () => undefined,
      seatMessages: () => seatInbox,
    };
    chats = new ChatMessageService(deps);
  });

  afterEach(async () => {
    for (const finish of deferredFinishes) finish();
    seatInbox?.stop();
    await seatInbox?.idle();
    chats.stop();
    vi.useRealTimers();
  });
}

/** Replace the seat inbox the service reads, for a suite that needs other bounds. */
export function setSeatInbox(next: RoomSeatMessagesPort | undefined): void {
  seatInbox = next;
}
