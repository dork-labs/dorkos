/** A disposed messaging generation must not retain closed stores or stop its successor. */
import { afterEach, expect, it } from 'vitest';
import { ChatMessageService } from '../../session/chat-messages/chat-message-service.js';
import { ChatMessageStore } from '../../session/chat-messages/chat-message-store.js';
import {
  disposeRoomSeatMessages,
  setRoomSeatMessageFactory,
  wireRoomSeatMessageLifetime,
} from '../../session/chat-messages/chat-message-current.js';
import { agentLookupFor, createRoomHarness, outcomeRunner } from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
});
const opened: Array<ReturnType<typeof createRoomHarness>> = [];
const closed = new Set<ReturnType<typeof createRoomHarness>>();
const services: ChatMessageService[] = [];
const caller = { sessionId: 'peer', agentPath: '/agents/ana' };

function fixture(id: string) {
  const turns: string[] = [];
  const h = createRoomHarness({
    agents,
    runner: outcomeRunner((request) => {
      turns.push(request.prompt);
      return { text: null };
    }),
  });
  opened.push(h);
  const room = h.service.createRoom(
    { kind: 'channel', title: id, members: [], agentPaths: ['/agents/bo'] },
    h.human
  );
  const author = h.authors.resolveAgent('/agents/bo', 'Bo').id;
  h.store.bindRoomSession(room.id, author, id, new Date().toISOString());
  const store = new ChatMessageStore(h.db);
  return {
    h,
    store,
    turns,
    id,
    factory: (receipts: ChatMessageStore, emit: (id: string) => void) =>
      h.service.createSeatMessages(receipts, emit),
  };
}

function messaging(f: ReturnType<typeof fixture>) {
  const lifetime = wireRoomSeatMessageLifetime(f.store, () => undefined);
  const service = new ChatMessageService({
    store: f.store,
    meshCore: () => undefined,
    seatMessages: lifetime.get,
    stopSeatMessages: lifetime.stop,
    describeSession: async () => ({
      bound: true,
      roomBound: true,
      launchOrigin: 'room',
      agentPath: '/agents/bo',
      startedByExtension: null,
    }),
    chatTitle: async () => null,
    sessionCwd: async () => '/agents/bo',
    isBusy: async () => false,
    dispatch: async () => {
      throw new Error('No ordinary dispatch into seats.');
    },
    steerInto: async () => false,
    interruptTurn: async () => false,
    canonicalId: async (id) => id,
    turnLevelOf: () => ({ asks: 'never', reach: 'everything' }),
    emitActivity: () => undefined,
    onLifecycle: () => () => undefined,
  });
  services.push(service);
  return { service, lifetime };
}

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  disposeRoomSeatMessages();
  for (const h of opened.splice(0)) if (!closed.has(h)) h.db.$client.close();
  closed.clear();
});

it('M9: dispose, close DB, fresh rooms-first boot, and stale service stop leave the successor live', async () => {
  disposeRoomSeatMessages();
  const first = fixture('old-seat');
  setRoomSeatMessageFactory(first.factory);
  const old = messaging(first);
  const sent = await old.service.send(caller, { to: first.id, message: 'First generation.' });
  await old.lifetime.get()!.idle();
  expect(first.store.get(sent.messageId)?.status).toBe('delivered');

  // Dispose the route while the old ChatMessageService object still exists. The old DB closes.
  disposeRoomSeatMessages();
  first.h.db.$client.close();
  closed.add(first.h);
  const fresh = fixture('fresh-seat');
  // This is deliberately before the fresh receipt lifetime: any retained old store is closed.
  expect(() => setRoomSeatMessageFactory(fresh.factory)).not.toThrow();
  const current = messaging(fresh);
  expect(() => old.service.stop()).not.toThrow();
  old.lifetime.stop();
  expect(current.lifetime.get()).toBeDefined();
  const receipt = await current.service.send(caller, {
    to: fresh.id,
    message: 'Fresh generation remains live.',
  });
  await current.lifetime.get()!.idle();
  expect(fresh.store.get(receipt.messageId)?.status).toBe('delivered');
  expect(fresh.turns).toHaveLength(1);
});
