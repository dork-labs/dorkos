/** Origin/ledger conflicts use real metadata, room authority and bridge adoption. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import {
  ChatMessageService,
  type ChatMessageServiceDeps,
} from '../../session/chat-messages/chat-message-service.js';
import { ChatMessageStore } from '../../session/chat-messages/chat-message-store.js';
import { describeSessionFor } from '../../extensions/agent-send/agent-send-defaults.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { BridgeSessionAdopter } from '../../relay/chat-bridge/adopt-session.js';
import { roomSessionPlace } from '../repo/room-turn-place.js';
import { agentLookupFor, createRoomHarness, outcomeRunner } from './room-test-harness.js';
import type { RoomTurnRequest } from '../room-turn-port.js';

const home = '/agents/origin-seat';
const caller = { sessionId: 'origin-peer', agentPath: '/agents/peer' };
let harness: ReturnType<typeof createRoomHarness>;
let store: ChatMessageStore;
let inbox: ReturnType<typeof harness.service.createSeatMessages>;
let chats: ChatMessageService;
let turns: RoomTurnRequest[];
let dispatch: ReturnType<typeof vi.fn<NonNullable<ChatMessageServiceDeps['dispatch']>>>;
let describeSession: ReturnType<typeof describeSessionFor>;

beforeEach(() => {
  turns = [];
  harness = createRoomHarness({
    agents: agentLookupFor({
      [home]: { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
    }),
    runner: outcomeRunner((request) => {
      turns.push(request);
      return { text: null };
    }),
  });
  runtimeRegistry.setDb(harness.db);
  runtimeRegistry.register(new FakeAgentRuntime('claude-code'));
  store = new ChatMessageStore(harness.db);
  inbox = harness.service.createSeatMessages(store, () => undefined);
  const placement = roomSessionPlace({
    bindings: harness.store.sessionLedger,
    authors: harness.authors,
    worktrees: () => null,
  });
  describeSession = describeSessionFor(() => placement);
  dispatch = vi.fn<NonNullable<ChatMessageServiceDeps['dispatch']>>(async () => {
    throw new Error('Private seats never use ordinary dispatch');
  });
  chats = new ChatMessageService({
    store,
    meshCore: () => undefined,
    describeSession,
    chatTitle: async () => null,
    sessionCwd: async () => home,
    isBusy: async () => false,
    dispatch,
    steerInto: async () => false,
    interruptTurn: async () => false,
    canonicalId: async (id) => id,
    turnLevelOf: () => ({ asks: 'never', reach: 'everything' }),
    emitActivity: () => undefined,
    onLifecycle: () => () => undefined,
    seatMessages: () => inbox,
  });
});

afterEach(async () => {
  inbox.stop();
  await inbox.idle();
  chats.stop();
});

function recordOwner(sessionId: string, origin: string | null): void {
  harness.db.$client
    .prepare(
      `INSERT INTO session_metadata(session_id,runtime,agent_path,launch_origin,created_at)
    VALUES (?, 'claude-code', ?, ?, '2026-11-15')`
    )
    .run(sessionId, home, origin);
}
function room(bridged: boolean, chatType: 'group' | 'private' = 'group') {
  return bridged
    ? harness.service.createBridgedRoom({
        adapterId: 'origin-telegram',
        chatId: '555',
        bindingId: 'origin-binding',
        chatType,
        channelType: chatType === 'group' ? 'group' : null,
        title: 'Origin bridge',
        agentPath: home,
        operatorAuthorId: harness.human,
      })
    : harness.service.createRoom(
        { kind: 'channel', title: 'Origin room', members: [], agentPaths: [home] },
        harness.human
      );
}
async function adopt(roomId: string, sessionId: string) {
  const author = harness.authors.resolveAgent(home, 'Bo');
  const adopter = new BridgeSessionAdopter({
    takeChatSession: async (bindingId, chatId) => {
      expect([bindingId, chatId]).toEqual(['origin-binding', '555']);
      return { sessionId };
    },
    getSessionRuntimeType: (id) => runtimeRegistry.getSessionRuntimeType(id),
    probe: {
      canProbe: (runtime) => runtime === 'claude-code',
      hasTranscript: async (root, id) => {
        expect([root, id]).toEqual([home, sessionId]);
        return { exists: true };
      },
    },
    resolveAgentRoot: () => home,
    rooms: harness.service,
  });
  expect(
    await adopter.adoptAtBridge({
      bindingId: 'origin-binding',
      chatId: '555',
      agentId: 'origin-agent',
      roomId,
      agentAuthorId: author.id,
    })
  ).toEqual({ adopted: true, sessionId });
}

it.each([
  'relay-binding',
  'outside-sender',
  'connector-event',
  'schedule',
  'heartbeat',
  'harness',
  null,
])('M6: an unbridged ledger cannot upgrade closed origin %s', async (origin) => {
  const target = room(false);
  harness.store.bindRoomSession(
    target.id,
    harness.authors.resolveAgent(home, 'Bo').id,
    'origin-target',
    new Date().toISOString()
  );
  recordOwner('origin-target', origin);
  expect(await describeSession('origin-target')).toMatchObject({
    bound: true,
    roomBound: true,
    agentPath: home,
    launchOrigin: origin,
  });
  await expect(
    chats.send(caller, { to: 'origin-target', message: 'Do not upgrade a closed origin.' })
  ).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  expect(store.listSentFrom(caller.sessionId)).toHaveLength(0);
  expect(turns).toHaveLength(0);
  expect(dispatch).not.toHaveBeenCalled();
});

it.each(['schedule', 'heartbeat', 'outside-sender', 'connector-event', 'harness'])(
  'M6: a bridge cannot upgrade known closed origin %s',
  async (origin) => {
    const target = room(true);
    recordOwner('origin-target', origin);
    // This is an inconsistent legacy ledger, not an adopter candidate from the router.
    harness.store.bindRoomSession(
      target.id,
      harness.authors.resolveAgent(home, 'Bo').id,
      'origin-target',
      new Date().toISOString()
    );
    await expect(
      chats.send(caller, { to: 'origin-target', message: 'No unattended turn.' })
    ).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    expect(turns).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  }
);

it.each([
  ['relay-binding', 'group'],
  ['relay-binding', 'private'],
  [null, 'group'],
  [null, 'private'],
] as const)(
  'M6: actual adoption preserves bound %s origin in bridged room type %s',
  async (origin, chatType) => {
    const target = room(true, chatType);
    recordOwner('origin-adopted', origin);
    await adopt(target.id, 'origin-adopted');
    expect(await describeSession('origin-adopted')).toMatchObject({
      bound: true,
      roomBound: true,
      agentPath: home,
      launchOrigin: origin,
    });
    const receipt = await chats.send(caller, {
      to: 'origin-adopted',
      message: 'Private adopted-seat request.',
    });
    await inbox.idle();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.roomContext.triggerEntryId).toBeNull();
    expect(store.get(receipt.messageId)?.status).toBe('delivered');
    expect(dispatch).not.toHaveBeenCalled();
  }
);

it('M6: metadata-free adoption remains closed until actual room ownership is recorded', async () => {
  const target = room(true);
  await adopt(target.id, 'metadata-free-adopted');
  expect(await describeSession('metadata-free-adopted')).toMatchObject({
    bound: false,
    roomBound: true,
  });
  await expect(
    chats.send(caller, { to: 'metadata-free-adopted', message: 'No guessed owner.' })
  ).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  await runtimeRegistry.persistSessionRuntime(
    'metadata-free-adopted',
    'claude-code',
    { kind: 'room', externalAuthor: false },
    home
  );
  expect(await describeSession('metadata-free-adopted')).toMatchObject({
    bound: true,
    agentPath: home,
    launchOrigin: 'room',
  });
  const receipt = await chats.send(caller, { to: 'metadata-free-adopted', message: 'Now bound.' });
  await inbox.idle();
  expect(store.get(receipt.messageId)?.status).toBe('delivered');
});

it.each(['interactive', 'session-relay'])(
  'M6: real Direct room ownership preserves existing %s eligibility',
  async (origin) => {
    const { DirectChats } = await import('../direct-chat/direct-chats.js');
    const direct = new DirectChats({
      store: harness.store,
      authors: harness.authors,
      rooms: harness.service,
      operator: () => harness.authors.getById(harness.human)!,
      mintSessionId: () => 'direct-origin',
    });
    const target = direct.ensureForAgent(home, 'Bo');
    recordOwner(target.sessionId, origin);
    expect(await describeSession(target.sessionId)).toMatchObject({
      bound: true,
      roomBound: true,
      agentPath: home,
      launchOrigin: origin,
    });
    const receipt = await chats.send(caller, {
      to: target.sessionId,
      message: 'Existing Direct eligibility.',
    });
    await inbox.idle();
    expect(turns).toHaveLength(1);
    expect(store.get(receipt.messageId)?.status).toBe('delivered');
  }
);

it.each(['archive', 'binding-change', 'native-rekey'] as const)(
  'M6: legacy bridge authority is rechecked after placement %s',
  async (change) => {
    const target = room(true);
    recordOwner('bridge-placement-old', 'relay-binding');
    await adopt(target.id, 'bridge-placement-old');
    const { triggers } = harness.service as unknown as {
      triggers: import('../room-trigger.js').RoomTriggerDispatcher;
    };
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const placing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalPlace = triggers.placeTurn.bind(triggers);
    vi.spyOn(triggers, 'placeTurn').mockImplementation(async (...args) => {
      entered();
      await barrier;
      return originalPlace(...args);
    });
    try {
      const receipt = await chats.send(caller, {
        to: 'bridge-placement-old',
        message: 'Keep exact bridge authority.',
      });
      await placing;
      if (change === 'archive') harness.bridges.archiveBridge(target.id, new Date().toISOString());
      else if (change === 'binding-change')
        harness.bridges.rebindBridge(target.id, 'replacement-binding');
      else
        harness.store.sessionLedger.rebindBySessionId(
          'bridge-placement-old',
          'bridge-placement-current'
        );
      release();
      await inbox.idle();
      if (change === 'native-rekey') {
        expect(turns).toHaveLength(1);
        expect(turns[0]?.sessionId).toBe('bridge-placement-current');
        expect(store.get(receipt.messageId)?.status).toBe('delivered');
      } else {
        expect(turns).toHaveLength(0);
        expect(store.get(receipt.messageId)?.status).toBe('failed');
      }
    } finally {
      inbox.stop();
      release();
      await inbox.idle();
    }
  }
);
