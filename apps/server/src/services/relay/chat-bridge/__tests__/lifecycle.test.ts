/**
 * `BridgeLifecycle` — the coordinator that ties the room half of a bridge
 * lifecycle event (archive, un-archive, swap) to the binding half (flip
 * `bridge`/`roomId`), and the §10.9 seam DOR-870's `ingest` calls when a post
 * lands on a room archived out of band (chats-as-channels spec §3.5, §10.9).
 *
 * The real `RoomService` and `BridgeStore` run throughout (`createRoomHarness`),
 * and the real `createChatNoticeSender` carries the §10.9 chat notice — the
 * spec's mocking stance (§13) forbids mocking the thing under test, and A10.5's
 * whole claim is about the SENDER'S OWN damper. Only the binding store is a fake:
 * the production one is file-backed and async, and nothing here tests its
 * persistence — only that the coordinator flips the two fields it owns.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChatNoticeSender, chatNoticeText, type PublishResult } from '@dorkos/relay';
import {
  agentLookupFor,
  createRoomHarness,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import type { CreateBridgedRoomRequest } from '../../../rooms/room-service.js';
import { BridgeLifecycle, type LifecycleBinding } from '../lifecycle.js';

const agentLookup = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
});

const CHAT_SUBJECT = 'relay.human.telegram.tg-main.555';

/** A tiny in-memory stand-in for the file-backed `BindingStore`. */
function fakeBindings(seed: LifecycleBinding) {
  const rows = new Map<string, LifecycleBinding>([[seed.id, { ...seed }]]);
  return {
    rows,
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
}

describe('BridgeLifecycle', () => {
  let harness: RoomHarness;

  function bridgeDm(overrides: Partial<CreateBridgedRoomRequest> = {}): CreateBridgedRoomRequest {
    return {
      adapterId: 'tg-main',
      chatId: '555',
      bindingId: 'binding-ana',
      chatType: 'private',
      channelType: null,
      title: 'Miguel',
      agentPath: '/agents/ana',
      operatorAuthorId: harness.human,
      ...overrides,
    };
  }

  /** A chat-notice sender over a store that knows exactly this one bound chat. */
  function noticeHarness() {
    const publish = vi.fn(async (): Promise<PublishResult> => ({
      messageId: 'm1',
      deliveredTo: 1,
    }));
    const notify = createChatNoticeSender({
      publish,
      resolveTarget: (subject) => (subject === CHAT_SUBJECT ? { bindingId: 'binding-ana' } : null),
    });
    return { publish, notify };
  }

  function lifecycle(
    bindings: ReturnType<typeof fakeBindings>,
    notify = noticeHarness().notify
  ): BridgeLifecycle {
    return new BridgeLifecycle({
      rooms: harness.service,
      bridges: harness.bridges,
      bindings,
      chatNotice: notify,
      operatorAuthorId: () => harness.human,
    });
  }

  beforeEach(() => {
    harness = createRoomHarness({ agents: agentLookup });
  });

  it('unbridge archives the room, stamps the row, and flips the binding off', async () => {
    const room = harness.service.createBridgedRoom(bridgeDm());
    const bindings = fakeBindings({
      id: 'binding-ana',
      adapterId: 'tg-main',
      chatId: '555',
      bridge: 'room',
      roomId: room.id,
    });

    await lifecycle(bindings).unbridge('binding-ana');

    expect(harness.store.getRoom(room.id)?.archived).toBe(true);
    expect(harness.bridges.findBridgeByRoom(room.id)?.archivedAt).not.toBeNull();
    expect(bindings.rows.get('binding-ana')).toMatchObject({ bridge: 'off', roomId: null });
  });

  it('unbridge is a no-op on a binding that is not bridged', async () => {
    const bindings = fakeBindings({
      id: 'binding-ana',
      adapterId: 'tg-main',
      chatId: '555',
      bridge: 'off',
      roomId: null,
    });
    await expect(lifecycle(bindings).unbridge('binding-ana')).resolves.toBeUndefined();
    expect(bindings.update).not.toHaveBeenCalled();
  });

  it('rebridge un-archives the room and flips the binding back on', async () => {
    const room = harness.service.createBridgedRoom(bridgeDm());
    const bindings = fakeBindings({
      id: 'binding-ana',
      adapterId: 'tg-main',
      chatId: '555',
      bridge: 'room',
      roomId: room.id,
    });
    const coordinator = lifecycle(bindings);

    await coordinator.unbridge('binding-ana');
    const back = await coordinator.rebridge({
      adapterId: 'tg-main',
      chatId: '555',
      bindingId: 'binding-ana',
      agentPath: '/agents/ana',
    });

    expect(back.id).toBe(room.id);
    expect(harness.store.getRoom(room.id)?.archived).toBe(false);
    expect(bindings.rows.get('binding-ana')).toMatchObject({ bridge: 'room', roomId: room.id });
  });

  describe('the §10.9 seam: a room archived out of band (A10.5)', () => {
    it('turns the bridge off exactly once and notifies the chat once, under a racing double call', async () => {
      const room = harness.service.createBridgedRoom(bridgeDm());
      // Archive the room out of band, the way something outside the bridge would.
      harness.service.updateRoom(room.id, harness.human, { archived: true });

      const bindings = fakeBindings({
        id: 'binding-ana',
        adapterId: 'tg-main',
        chatId: '555',
        bridge: 'room',
        roomId: room.id,
      });
      const { publish, notify } = noticeHarness();
      const coordinator = lifecycle(bindings, notify);

      // Two inbound messages both caught ROOM_ARCHIVED before either flip
      // persisted — both reach the handler with the SAME 'room' snapshot.
      const snapshot: LifecycleBinding = {
        id: 'binding-ana',
        adapterId: 'tg-main',
        chatId: '555',
        bridge: 'room',
        roomId: room.id,
      };
      await coordinator.onRoomArchivedDuringIngest(snapshot, CHAT_SUBJECT);
      await coordinator.onRoomArchivedDuringIngest(snapshot, CHAT_SUBJECT);

      // The bridge is off, the row is stamped, and the chat was told once — the
      // sender's own damper is what makes the second call say nothing.
      expect(bindings.rows.get('binding-ana')).toMatchObject({ bridge: 'off', roomId: null });
      expect(harness.bridges.findBridgeByRoom(room.id)?.archivedAt).not.toBeNull();
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith(
        CHAT_SUBJECT,
        { content: chatNoticeText('channel_archived') },
        expect.objectContaining({ from: expect.stringContaining('relay.system.') })
      );
    });
  });
});
