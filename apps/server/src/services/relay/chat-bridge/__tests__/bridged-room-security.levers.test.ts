/**
 * The bridged-room security suite (chats-as-channels spec §9, DOR-633 /
 * DOR-880): the structural levers a stranger cannot pull (§9.3), the consent
 * floor (A3.1), and the permission mode — the real bound — that no bridge path
 * raises (§9.6). Why the suite exists, and what it does NOT claim, is in the
 * header of `bridged-room-security.fence.test.ts`; shared setup is in
 * `inbound.fixtures.ts`.
 *
 * Two levers are pinned beside the code they guard rather than here, each by a
 * test that fails for the same break: the ingest ceiling (`ingest.test.ts`,
 * A5.9) and `deliver`'s author check (`deliver.test.ts`, A6.5).
 *
 * @module server/services/relay/chat-bridge/__tests__/bridged-room-security.levers
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { authors as authorRows, rooms as roomRows, roomEntries as roomEntryRows } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import type { RelayCore } from '@dorkos/relay';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import { createRoomHarness, type RoomHarness } from '../../../rooms/__tests__/room-test-harness.js';
import { RoomTurnBudget } from '../../../rooms/limits/turn-budget.js';
import { evaluateCascade } from '../../../rooms/cascade-guard.js';
import {
  isServerOnlyPrincipal,
  isConsentExemptPrincipal,
  createInitiateConsentGate,
} from '../../initiate-consent.js';
import { relayRoutesListener } from '../../../../routes/__tests__/relay-routes-listener.js';
import { BridgeLifecycle, type LifecycleBinding, type BridgeCreateInput } from '../index.js';
import {
  ADAPTER,
  AGENT_PATH,
  BINDING_ID,
  agentLookup,
  bindingFor,
  bridgeRequest,
  envelopeFor,
  makeIngest,
  miguel,
  parseBinding,
  subjectFor,
} from './inbound.fixtures.js';

// The `/api` chain the Relay route runs behind reads config (login, the host
// allowlist); nothing here sets any, and nothing else in this file reads it.
vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

const fixtureTarget = swappableServer();

describe('bridged-room security suite (chats-as-channels §9): the levers and the permission mode', () => {
  let harness: RoomHarness;

  beforeEach(() => {
    harness = createRoomHarness({ agents: agentLookup });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §9.6 — the permission mode, the real bound, is never raised by a bridge
  // ───────────────────────────────────────────────────────────────────────────

  describe('§9.6 permission mode — no bridge path raises it above `default`', () => {
    it('A9.6: every bridge write path leaves permissionMode untouched — enumerated, not sampled', async () => {
      // The bridge subsystem's binding-writer surface is `{ bridge?, roomId? }`
      // ONLY (`BridgeBindingWriter.update`), so it is type-level impossible for a
      // bridge path to write `permissionMode`. This test proves that empirically
      // across EVERY lifecycle write path by recording every `update` call's keys
      // and re-reading the persisted binding after each. A future edit that added
      // a `permissionMode` write to any of these paths would fail here.
      const seedBinding: AdapterBinding = parseBinding({ chatId: '555' });
      expect(seedBinding.permissionMode).toBe('default');

      const rows = new Map<string, AdapterBinding>([
        [BINDING_ID, { ...seedBinding, id: BINDING_ID }],
      ]);
      const updateKeys: string[][] = [];
      const bindings = {
        getById: (id: string): LifecycleBinding | undefined => {
          const b = rows.get(id);
          return b
            ? {
                id: b.id,
                adapterId: b.adapterId,
                chatId: b.chatId,
                bridge: b.bridge,
                roomId: b.roomId,
              }
            : undefined;
        },
        update: vi.fn(
          async (id: string, updates: { bridge?: 'off' | 'room'; roomId?: string | null }) => {
            updateKeys.push(Object.keys(updates));
            const cur = rows.get(id);
            if (!cur) return undefined;
            const next = { ...cur, ...updates } as AdapterBinding;
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
        // The adopter is not a permission-mode writer; a minimal stand-in keeps
        // the create path real without a runtime transcript probe.
        adopter: { adoptAtBridge: async () => ({ adopted: false }) } as never,
      });

      const createInput: BridgeCreateInput = {
        adapterId: ADAPTER,
        chatId: '555',
        bindingId: BINDING_ID,
        agentId: 'agent-1',
        chatType: 'group',
        channelType: 'group',
        title: 'Ops Team',
        agentPath: AGENT_PATH,
      };

      // Path 1: bridge() fresh create.
      await lifecycle.bridge(createInput);
      expect(rows.get(BINDING_ID)?.permissionMode).toBe('default');
      // Path 2: bridge() replay (the room already exists → the idempotent branch).
      await lifecycle.bridge(createInput);
      expect(rows.get(BINDING_ID)?.permissionMode).toBe('default');
      // Path 3: rebridge() — same agent, reuse the surviving row.
      await lifecycle.rebridge({
        adapterId: ADAPTER,
        chatId: '555',
        bindingId: BINDING_ID,
        agentPath: AGENT_PATH,
      });
      expect(rows.get(BINDING_ID)?.permissionMode).toBe('default');
      // Path 4: unbridge() — bridge → off.
      await lifecycle.unbridge(BINDING_ID);
      expect(rows.get(BINDING_ID)?.permissionMode).toBe('default');

      // Not one write across every path touched permissionMode: each update
      // carried only bridge/roomId keys.
      expect(updateKeys.length).toBeGreaterThan(0);
      for (const keys of updateKeys) {
        expect(keys.every((k) => k === 'bridge' || k === 'roomId')).toBe(true);
        expect(keys).not.toContain('permissionMode');
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §9.3 — the structural levers, one per row of the spec table
  // ───────────────────────────────────────────────────────────────────────────

  // §9.3 lever 1 (an unaddressed stranger in a bridged group triggers no turn)
  // is pinned by `ingest.test.ts` A5.4, through the real ingest path.

  describe('§9.3 lever 2 — a stranger cannot make an agent run repeatedly', () => {
    it("the turn budget's per-room and global ceilings both refuse past their cap", () => {
      const perRoomBudget = new RoomTurnBudget({
        db: createTestDb(),
        limits: { perRoom: () => 1, global: () => 100 },
      });
      expect(perRoomBudget.tryReserve('room-1').allowed).toBe(true);
      expect(perRoomBudget.tryReserve('room-1')).toEqual({
        allowed: false,
        scope: 'room',
        counted: false,
      });

      const globalBudget = new RoomTurnBudget({
        db: createTestDb(),
        limits: { perRoom: () => 100, global: () => 1 },
      });
      expect(globalBudget.tryReserve('room-a').allowed).toBe(true);
      // A different room — only the GLOBAL cap can be what refuses it.
      expect(globalBudget.tryReserve('room-b')).toEqual({
        allowed: false,
        scope: 'global',
        counted: false,
      });
    });

    it('the cascade guard refuses past the depth ceiling and once an author has had its turns in the cascade', () => {
      const target = '/agents/ana';
      const limits = { maxAgentDepth: 3, maxTurnsPerAgentPerCascade: 2 };
      expect(
        evaluateCascade(target, { root: 'r', depth: 3, turnsByAuthor: new Map() }, limits)
      ).toMatchObject({ allowed: false, reason: 'depth' });
      expect(
        evaluateCascade(
          target,
          { root: 'r', depth: 0, turnsByAuthor: new Map([[target, 2]]) },
          limits
        )
      ).toMatchObject({ allowed: false, reason: 'repeat' });
    });
  });

  describe('§9.3 lever 3 — a stranger cannot speak to a chat the operator never connected (A9.7)', () => {
    it('A6.10: the route guard and the two consent predicates keep `relay.bridge.*` unassertable without collapsing the exempt set', () => {
      // The predicate pin: `relay.bridge.*` is server-only (a client may not
      // assert it) yet deliberately NON-exempt (the gate still evaluates it).
      // Collapsing the two — the mistake that first opened this hole — would flip
      // one of these and go red.
      for (const from of ['relay.bridge.reply.tg1.chat-42', 'relay.bridge.initiate.tg1.chat-42']) {
        expect(isServerOnlyPrincipal(from)).toBe(true);
        expect(isConsentExemptPrincipal(from)).toBe(false);
      }
      // The three genuinely-exempt principals are both server-only AND exempt.
      for (const from of ['agent:ana', 'relay.system.tasks', 'relay.human.telegram.tg1.bot']) {
        expect(isServerOnlyPrincipal(from)).toBe(true);
        expect(isConsentExemptPrincipal(from)).toBe(true);
      }
      // An ordinary client principal is neither.
      expect(isServerOnlyPrincipal('relay.human.console')).toBe(false);
      expect(isServerOnlyPrincipal('relay.agent.claude-code.s1')).toBe(false);
    });

    it('A6.10: `POST /api/relay/messages` rejects a client-asserted `relay.bridge.*` principal 403, publishing nothing', async () => {
      // Independently of the predicate: the real route wired with the real guard
      // must reject a spoofed bridge principal before it reaches the relay.
      const relayCore = makeMockRelayCore();
      const res = await request(fixtureTarget.mount(relayRoutesListener({ relayCore })))
        .post('/api/relay/messages')
        .send({
          subject: 'relay.human.telegram.tg1.chat-42',
          payload: { text: 'spoofed as the bot' },
          from: 'relay.bridge.reply.tg1.chat-42',
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('reserved_sender');
      expect(vi.mocked(relayCore.publish)).not.toHaveBeenCalled();
    });
  });

  describe('§9.3 lever 4 — a stranger cannot start a conversation on any channel', () => {
    it('`canInitiate` defaults to false, and the consent gate denies a `relay.bridge.initiate.*` publish until it is turned on', () => {
      const subject = subjectFor('555');
      const initiatePrincipal = `relay.bridge.initiate.${ADAPTER}.555`;

      // canInitiate omitted → false by default.
      let binding: AdapterBinding = parseBinding({ chatId: '555' });
      expect(binding.canInitiate).toBe(false);
      const gate = createInitiateConsentGate({
        bindingStore: { resolve: () => binding },
        resolveAgentSubject: () => undefined,
      });

      expect(gate(initiatePrincipal, subject).allowed).toBe(false);

      binding = { ...binding, canInitiate: true };
      expect(gate(initiatePrincipal, subject).allowed).toBe(true);
      // The same-room-same-chat provenance rule (§6.6) that stops a stranger's
      // mention in room R from laundering an initiate into room S is pinned by
      // the consent table's cross-room case
      // (`deliver.test.ts`, "case 9");
      // this test pins the switch that case ultimately lands on.
    });
  });

  describe('§9.3 lever 5 — a stranger cannot get an agent added to a room', () => {
    it('`addMember` refuses a non-operator author (room-service.ts requireOperator)', () => {
      const room = harness.service.createBridgedRoom(bridgeRequest(harness));
      const stranger = harness.service.postExternal(room.id, { identity: miguel(), text: 'hi' });
      // The stranger is now a member — but membership is not authority. Adding an
      // agent is operator-only, so a stranger cannot pull a second agent in.
      expect(() =>
        harness.service.addMember(room.id, stranger.author.id, { agentPath: '/agents/bob' })
      ).toThrow(expect.objectContaining({ code: 'OPERATOR_ONLY' }));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // A3.1 — the consent floor, and §9.5 — secrets
  // ───────────────────────────────────────────────────────────────────────────

  describe('A3.1 consent floor — an inbound from an unconnected chat manufactures nothing', () => {
    it('ingest for a bridged binding with no live room creates no room, no author, no entry, and runs no turn', async () => {
      // Until a person claims-and-bridges a chat there is no room. The bridge
      // machinery cannot manufacture one from an inbound message: a binding whose
      // room does not exist is a broken bridge that tells the chat and writes
      // nothing — it must not resurrect a room the person never created (or
      // archived out of band).
      const bridge = makeIngest(harness);
      const authorsBefore = harness.db.select().from(authorRows).all().length;

      const res = await bridge.ingest(
        bindingFor(null, '999'),
        envelopeFor({ chatId: '999', messageId: 1, content: 'let me in' }),
        { agentPath: AGENT_PATH }
      );

      expect(res).toMatchObject({ status: 'refused', reason: 'broken_bridge' });
      expect(harness.db.select().from(roomRows).all()).toHaveLength(0);
      expect(harness.db.select().from(roomEntryRows).all()).toHaveLength(0);
      // No stranger author was minted (the operator's own author may pre-exist).
      expect(harness.db.select().from(authorRows).all()).toHaveLength(authorsBefore);
      expect(harness.runner.turns).toHaveLength(0);
    });
  });
});

/** A fully-shaped mock `RelayCore` for the HTTP route-guard test. */
function makeMockRelayCore(): RelayCore {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'm', deliveredTo: 1 }),
    listMessages: vi.fn().mockReturnValue({ messages: [], nextCursor: undefined }),
    getMessage: vi.fn().mockReturnValue(null),
    getMessageDetail: vi.fn().mockReturnValue(null),
    listEndpoints: vi.fn().mockReturnValue([]),
    registerEndpoint: vi.fn().mockResolvedValue({ subject: 's', hash: 'h', maildirPath: '/tmp/h' }),
    unregisterEndpoint: vi.fn().mockResolvedValue(true),
    readInbox: vi.fn().mockReturnValue({ messages: [], nextCursor: undefined }),
    getDeadLetters: vi.fn().mockResolvedValue([]),
    getMetrics: vi.fn().mockReturnValue({ totalMessages: 0, byStatus: {}, bySubject: [] }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    onSignal: vi.fn().mockReturnValue(() => {}),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as RelayCore;
}
