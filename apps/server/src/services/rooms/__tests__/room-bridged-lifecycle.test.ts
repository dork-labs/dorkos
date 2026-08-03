/**
 * `RoomService.archiveBridgedRoom` and `RoomService.rebridge` — the room half of
 * the bridge lifecycle (chats-as-channels spec §3.5, DOR-869/task 1.5). Every
 * test proves a property the spec's own table calls load-bearing:
 *
 * - **§3.5 / A3.6** — un-bridging archives the room and STAMPS the bridge row,
 *   but deletes nothing: the row, its external refs, and the whole log survive,
 *   and re-bridging to the same agent un-archives the SAME room id and appends
 *   to the SAME log.
 * - **§3.5 / A3.6b** — re-bridging the same `(adapterId, chatId)` to a DIFFERENT
 *   agent adopts the surviving row and its room. Same room id, the roster's
 *   bound agent swapped, the old agent's `(room, agent)` session dropped, the
 *   external refs intact, ONE notice naming the swap — and the swapped-in agent
 *   is `mention-only` at every observable point, including after a simulated
 *   failure of a step FOLLOWING the roster add (which proves the mode was seeded
 *   IN the add, never patched after).
 * - **§3.5 / §10.3** — a forced disconnect writes the platform's own reason into
 *   the room's disconnect notice.
 *
 * The real `RoomStore` and `BridgeStore` run throughout (`createRoomHarness`, an
 * in-memory `better-sqlite3` connection): the claims are about what lands in
 * SQLite across the room, membership, session, and bridge tables, which a mocked
 * store could not prove either way.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService, CreateBridgedRoomRequest } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import type { BridgeStore } from '../../relay/chat-bridge/bridge-store.js';
import { agentLookupFor, createRoomHarness } from './room-test-harness.js';

const agentLookup = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always', emoji: '🐙' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
});

describe('bridge lifecycle: unbridge, archive, re-bridge, agent swap', () => {
  let service: RoomService;
  let store: RoomStore;
  let bridges: BridgeStore;
  let authors: AuthorRegistry;
  let human: string;

  function bridgeDm(overrides: Partial<CreateBridgedRoomRequest> = {}): CreateBridgedRoomRequest {
    return {
      adapterId: 'tg-main',
      chatId: '555',
      bindingId: 'binding-ana',
      chatType: 'private',
      channelType: null,
      title: 'Miguel',
      agentPath: '/agents/ana',
      operatorAuthorId: human,
      ...overrides,
    };
  }

  function bridgeChannel(
    overrides: Partial<CreateBridgedRoomRequest> = {}
  ): CreateBridgedRoomRequest {
    return bridgeDm({ chatType: 'group', channelType: 'group', title: 'Ops Team', ...overrides });
  }

  /** Record an inbound external ref, the way `ingest` will (spec §5.2 step 6). */
  function recordInboundRef(roomId: string, entryId: string, platformMessageId: string): void {
    bridges.recordInboundRef({
      roomId,
      entryId,
      chatId: '555',
      adapterId: 'tg-main',
      platformMessageId,
      createdAt: new Date().toISOString(),
    });
  }

  beforeEach(() => {
    ({ service, store, bridges, authors, human } = createRoomHarness({ agents: agentLookup }));
  });

  describe('un-bridging archives and preserves the row + refs (A3.6)', () => {
    it('archives the room, stamps the bridge row, and deletes neither the row nor its refs', () => {
      const room = service.createBridgedRoom(bridgeDm());
      const entry = service.postExternal(room.id, {
        identity: {
          platformType: 'telegram',
          instanceId: 'tg-main',
          platformUserId: '145223',
          displayName: 'Miguel',
        },
        text: 'hello from the chat',
      });
      recordInboundRef(room.id, entry.entry.id, 'msg-1');

      service.archiveBridgedRoom(room.id, human);

      // The room is archived.
      expect(store.getRoom(room.id)?.archived).toBe(true);
      // The bridge row survives and is stamped archived — not deleted.
      const bridge = bridges.findBridgeByChat('tg-main', '555');
      expect(bridge).not.toBeNull();
      expect(bridge?.roomId).toBe(room.id);
      expect(bridge?.archivedAt).not.toBeNull();
      // The external ref survives — this is what keeps echo suppression working
      // across the gap.
      expect(bridges.findRefByEntry(entry.entry.id)).not.toBeNull();
      // The log is untouched: the disconnect notice is the only thing added.
      const entries = store.listEntries(room.id, { limit: 50 });
      expect(entries.some((e) => e.id === entry.entry.id)).toBe(true);
      const notice = entries.find((e) => e.body.notice === 'bridge_disconnected');
      expect(notice).toBeDefined();
    });

    it('writes the disconnect notice BEFORE the archive, so it lands in the log', () => {
      const room = service.createBridgedRoom(bridgeDm());
      service.archiveBridgedRoom(room.id, human);
      const notice = service
        .listEntries(room.id, human, { limit: 10 })
        .find((e) => e.body.notice === 'bridge_disconnected');
      expect(notice).toBeDefined();
      expect(notice?.body.text.length).toBeGreaterThan(0);
    });

    it('is idempotent on a room already archived out of band — stamps the row, adds no second notice', () => {
      const room = service.createBridgedRoom(bridgeDm());
      // Archive the room directly, as an out-of-band archive would (§10.9),
      // leaving the bridge row un-stamped.
      service.updateRoom(room.id, human, { archived: true });
      expect(bridges.findBridgeByRoom(room.id)?.archivedAt).toBeNull();

      service.archiveBridgedRoom(room.id, human);

      // The row is now stamped, and no disconnect notice was posted into the
      // already-archived room (postNotice would have refused it anyway).
      expect(bridges.findBridgeByRoom(room.id)?.archivedAt).not.toBeNull();
      const notices = store
        .listEntries(room.id, { limit: 50 })
        .filter((e) => e.body.notice === 'bridge_disconnected');
      expect(notices).toHaveLength(0);
    });

    it('refuses a non-owner caller', () => {
      const harness = createRoomHarness({ agents: agentLookup, ownerUserId: 'owner-1' });
      const room = harness.service.createBridgedRoom({
        adapterId: 'tg-main',
        chatId: '555',
        bindingId: 'binding-ana',
        chatType: 'private',
        channelType: null,
        title: 'Miguel',
        agentPath: '/agents/ana',
        operatorAuthorId: harness.human,
      });
      const stranger = harness.authors.resolveAgent('/agents/ana', 'Ana').id;
      expect(() => harness.service.archiveBridgedRoom(room.id, stranger)).toThrow(
        expect.objectContaining({ code: 'OPERATOR_ONLY' })
      );
    });
  });

  describe('re-bridging to the SAME agent reuses the same room (A3.6)', () => {
    it('un-archives the same room id and keeps the same log', () => {
      const room = service.createBridgedRoom(bridgeDm());
      const first = service.postExternal(room.id, {
        identity: {
          platformType: 'telegram',
          instanceId: 'tg-main',
          platformUserId: '145223',
          displayName: 'Miguel',
        },
        text: 'first message',
      });
      recordInboundRef(room.id, first.entry.id, 'msg-1');
      service.archiveBridgedRoom(room.id, human);

      const again = service.rebridge({
        adapterId: 'tg-main',
        chatId: '555',
        bindingId: 'binding-ana',
        agentPath: '/agents/ana',
        operatorAuthorId: human,
      });

      // Same room, brought back to life.
      expect(again.id).toBe(room.id);
      expect(again.created).toBe(false);
      expect(store.getRoom(room.id)?.archived).toBe(false);
      expect(bridges.findBridgeByRoom(room.id)?.archivedAt).toBeNull();
      // The ref survives the round trip.
      expect(bridges.findRefByEntry(first.entry.id)).not.toBeNull();

      // A new inbound message appends to the SAME log — the first message is
      // still there, and the new one lands beside it.
      const second = service.postExternal(room.id, {
        identity: {
          platformType: 'telegram',
          instanceId: 'tg-main',
          platformUserId: '145223',
          displayName: 'Miguel',
        },
        text: 'second message',
      });
      const ids = store.listEntries(room.id, { limit: 50 }).map((e) => e.id);
      expect(ids).toContain(first.entry.id);
      expect(ids).toContain(second.entry.id);
    });

    it('does not swap the roster or post a swap notice for the same agent', () => {
      const room = service.createBridgedRoom(bridgeDm());
      service.archiveBridgedRoom(room.id, human);
      service.rebridge({
        adapterId: 'tg-main',
        chatId: '555',
        bindingId: 'binding-ana',
        agentPath: '/agents/ana',
        operatorAuthorId: human,
      });
      const agents = service
        .getRoom(room.id, human)
        ?.members.filter((m) => m.author.kind === 'agent');
      expect(agents).toHaveLength(1);
      expect(authors.getById(agents![0].authorId)?.naturalKey).toBe('/agents/ana');
      const swap = service
        .listEntries(room.id, human, { limit: 50 })
        .find((e) => e.body.notice === 'bridge_agent_swapped');
      expect(swap).toBeUndefined();
    });

    it('auto-suffixes a channel slug on re-bridge instead of throwing SLUG_TAKEN when the released slug was taken (A3.4)', () => {
      // Bridge a Telegram group "Ops Team" → slug `ops-team`.
      const room = service.createBridgedRoom(bridgeChannel({ title: 'Ops Team' }));
      expect(room.slug).toBe('ops-team');
      const first = service.postExternal(room.id, {
        identity: {
          platformType: 'telegram',
          instanceId: 'tg-main',
          platformUserId: '145223',
          displayName: 'Miguel',
        },
        text: 'first message',
      });

      // Unbridge — the slug is released.
      service.archiveBridgedRoom(room.id, human);

      // Another live channel takes `ops-team` while the bridge is away.
      const usurper = service.createRoom(
        { kind: 'channel', title: 'Ops Team', members: [], agentPaths: [] },
        human
      );
      expect(usurper.slug).toBe('ops-team');

      // Re-bridging the original chat must SUCCEED, auto-suffixing its slug the
      // way the create path does — never throwing SLUG_TAKEN, which would wedge
      // the rebind on a platform-sourced title nobody typed (and, because the
      // room half runs first, wedge the binding flip with it).
      const again = service.rebridge({
        adapterId: 'tg-main',
        chatId: '555',
        bindingId: 'binding-ana',
        agentPath: '/agents/ana',
        operatorAuthorId: human,
      });

      // Same room and same log, just a suffixed slug.
      expect(again.id).toBe(room.id);
      expect(again.slug).toBe('ops-team-2');
      expect(store.getRoom(room.id)?.archived).toBe(false);
      expect(store.listEntries(room.id, { limit: 50 }).map((e) => e.id)).toContain(first.entry.id);
    });

    it('refuses a re-bridge for a chat with no surviving bridge row', () => {
      expect(() =>
        service.rebridge({
          adapterId: 'tg-main',
          chatId: 'never-bridged',
          bindingId: 'binding-x',
          agentPath: '/agents/ana',
          operatorAuthorId: human,
        })
      ).toThrow(expect.objectContaining({ code: 'NO_SURVIVING_BRIDGE' }));
    });
  });

  describe('re-bridging to a DIFFERENT agent adopts the row and swaps (A3.6b)', () => {
    it('keeps the room id, swaps the bound agent, drops the old session, keeps the refs, posts ONE notice', () => {
      const room = service.createBridgedRoom(bridgeChannel());
      const anaId = authors.resolveAgent('/agents/ana', 'Ana').id;
      // Give Ana a (room, agent) session, so the swap has something to drop.
      store.bindRoomSession(room.id, anaId, 'ana-session-1', new Date().toISOString());
      expect(store.getRoomSession(room.id, anaId)).toBe('ana-session-1');

      const entry = service.postExternal(room.id, {
        identity: {
          platformType: 'telegram',
          instanceId: 'tg-main',
          platformUserId: '145223',
          displayName: 'Miguel',
        },
        text: 'hello everyone',
      });
      recordInboundRef(room.id, entry.entry.id, 'msg-1');
      service.archiveBridgedRoom(room.id, human);

      const swapped = service.rebridge({
        adapterId: 'tg-main',
        chatId: '555',
        bindingId: 'binding-bo',
        agentPath: '/agents/bo',
        operatorAuthorId: human,
      });

      // Same room, adopted not re-minted.
      expect(swapped.id).toBe(room.id);
      expect(store.listRooms({ includeArchived: true })).toHaveLength(1);

      // The roster's bound agent is now Bo, and Ana has left.
      const agentMembers = swapped.members.filter((m) => m.author.kind === 'agent');
      expect(agentMembers).toHaveLength(1);
      const boId = authors.resolveAgent('/agents/bo', 'Bo').id;
      expect(agentMembers[0].authorId).toBe(boId);

      // Ana's (room, agent) session is dropped — orphaned, never migrated.
      expect(store.getRoomSession(room.id, anaId)).toBeNull();

      // The external ref survives, so echo suppression stays continuous.
      expect(bridges.findRefByEntry(entry.entry.id)).not.toBeNull();

      // The bridge row is re-pointed to the new binding.
      expect(bridges.findBridgeByRoom(room.id)?.bindingId).toBe('binding-bo');
      expect(bridges.findBridgeByRoom(room.id)?.archivedAt).toBeNull();

      // Exactly one swap notice, naming both agents.
      const swaps = service
        .listEntries(room.id, human, { limit: 50 })
        .filter((e) => e.body.notice === 'bridge_agent_swapped');
      expect(swaps).toHaveLength(1);
      expect(swaps[0].body.text).toMatch(/Ana/);
      expect(swaps[0].body.text).toMatch(/Bo/);
    });

    it('seeds the swapped-in channel agent mention-only at every observable point', () => {
      const room = service.createBridgedRoom(bridgeChannel());
      service.archiveBridgedRoom(room.id, human);
      const swapped = service.rebridge({
        adapterId: 'tg-main',
        chatId: '555',
        bindingId: 'binding-bo',
        agentPath: '/agents/bo',
        operatorAuthorId: human,
      });
      const boMember = swapped.members.find((m) => m.author.kind === 'agent');
      expect(boMember?.responseMode).toBe('mention-only');
      // Re-read from the store — proves what committed, not what was returned.
      const reread = service
        .getRoom(room.id, human)
        ?.members.find((m) => m.author.kind === 'agent');
      expect(reread?.responseMode).toBe('mention-only');
    });

    it('keeps the swapped-in agent mention-only even when a step AFTER the add fails (proves the seed is in the add)', () => {
      const room = service.createBridgedRoom(bridgeChannel());
      service.archiveBridgedRoom(room.id, human);

      // Force the bridge re-point — a step that runs strictly AFTER the roster
      // add — to throw. If the mode were seeded by a follow-up patch instead of
      // inside the add, this failure would strand Bo at the channel default
      // (`engaged`). Because it is seeded IN the add, Bo is already mention-only
      // by the time this throws.
      const boom = new Error('simulated re-point failure');
      const spy = vi.spyOn(bridges, 'rebindBridge').mockImplementation(() => {
        throw boom;
      });

      expect(() =>
        service.rebridge({
          adapterId: 'tg-main',
          chatId: '555',
          bindingId: 'binding-bo', // different from binding-ana, so rebindBridge runs
          agentPath: '/agents/bo',
          operatorAuthorId: human,
        })
      ).toThrow(boom);
      spy.mockRestore();

      // Bo is on the roster, mention-only, despite the later failure. And no
      // swap notice was posted — that step never ran.
      const boId = authors.resolveAgent('/agents/bo', 'Bo').id;
      const boMember = service.getRoom(room.id, human)?.members.find((m) => m.authorId === boId);
      expect(boMember?.responseMode).toBe('mention-only');
      const swap = service
        .listEntries(room.id, human, { limit: 50 })
        .find((e) => e.body.notice === 'bridge_agent_swapped');
      expect(swap).toBeUndefined();
    });

    it('seeds the swapped-in DM agent with the manifest default, not mention-only', () => {
      const room = service.createBridgedRoom(bridgeDm());
      service.archiveBridgedRoom(room.id, human);
      const swapped = service.rebridge({
        adapterId: 'tg-main',
        chatId: '555',
        bindingId: 'binding-bo',
        agentPath: '/agents/bo',
        operatorAuthorId: human,
      });
      const boMember = swapped.members.find((m) => m.author.kind === 'agent');
      expect(boMember?.responseMode).toBe('always');
    });
  });

  describe('a forced disconnect writes the platform reason (§10.3)', () => {
    it('puts the bot-blocked reason into the disconnect notice', () => {
      const room = service.createBridgedRoom(bridgeDm());
      service.archiveBridgedRoom(room.id, human, {
        reason: 'the bot was blocked by the user',
      });
      const notice = service
        .listEntries(room.id, human, { limit: 10 })
        .find((e) => e.body.notice === 'bridge_disconnected');
      expect(notice?.body.text).toMatch(/blocked by the user/);
    });
  });
});
