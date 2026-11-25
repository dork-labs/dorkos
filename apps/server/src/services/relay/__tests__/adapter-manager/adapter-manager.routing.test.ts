import {
  CONFIG_PATH,
  VALID_CONFIG,
  fakeAdapter,
  freshHarness,
  initAndStart,
  mockDeps,
  mockGetMe,
  withConfig,
} from './adapter-manager.fixtures.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { taskDispatchSubject } from '@dorkos/shared/relay-schemas';
import { AdapterRegistry } from '@dorkos/relay';
import type { AdapterStatus, RelayAdapter, RelayPublisher } from '@dorkos/relay';
import { AdapterManager, normalizeAgentRuntimes } from '../../adapter-manager.js';
import type { AdapterMeshCoreLike } from '../../adapter-manager.js';
import { BridgeStore } from '../../chat-bridge/bridge-store.js';
import { RoomStore } from '../../../rooms/room-store.js';

/** A bridge store with one chat on tg-main bridged to `roomId`. */
function bridgedRoom(roomId: string, platformChatType: 'group' | 'private'): BridgeStore {
  const db = createTestDb();
  new RoomStore(db).createRoom(
    {
      id: roomId,
      kind: platformChatType === 'group' ? 'channel' : 'dm',
      slug: roomId,
      title: roomId,
      topic: null,
      createdAt: '2026-08-04T00:00:00.000Z',
    },
    []
  );
  const bridges = new BridgeStore(db);
  bridges.createBridge({
    roomId,
    adapterId: 'tg-main',
    chatId: '145223',
    channelType: platformChatType === 'group' ? 'group' : null,
    platformTitle: null,
    platformChatType,
    bindingId: 'binding-ana',
    deliverNotices: false,
    createdAt: '2026-08-04T00:00:00.000Z',
  });
  return bridges;
}

describe('AdapterManager routing', () => {
  let manager: AdapterManager;
  let registry: AdapterRegistry;

  beforeEach(() => {
    ({ manager, registry } = freshHarness());
  });

  describe('buildContext()', () => {
    /** A manager whose mesh knows `paths`, or that has no mesh at all. */
    function withMesh(paths?: Record<string, string>): AdapterManager {
      const meshCore: AdapterMeshCoreLike | undefined = paths && {
        getProjectPath: (agentId: string) => paths[agentId],
      };
      return new AdapterManager(registry, CONFIG_PATH, { ...mockDeps, meshCore });
    }

    it.each([
      ['relay.agent.01JN4M2X5SZMHXP3EZFM9DWRXFK', '01JN4M2X5SZMHXP3EZFM9DWRXFK', 'claude-code'],
      ['relay.agent.codex.sess-123', 'sess-123', 'codex'],
    ])('resolves %s to the agent directory and runtime', (subject, agentId, runtime) => {
      const ctx = withMesh({ [agentId]: '/home/user/proj' }).buildContext(subject);
      expect(ctx).toEqual({ agent: { directory: '/home/user/proj', runtime } });
    });

    it('has no context for an unknown agent, a missing mesh or a non-agent subject', () => {
      expect(withMesh({}).buildContext('relay.agent.UNKNOWN')).toBeUndefined();
      expect(withMesh().buildContext('relay.agent.01JN4M2X')).toBeUndefined();
      const mesh = withMesh({ 'some-id': '/p' });
      expect(mesh.buildContext('relay.human.console.client-1')).toBeUndefined();
      expect(mesh.buildContext('relay.system.tasks.sched-1')).toBeUndefined();
    });
  });

  // DOR-768: the wrap keyed the lone runtime under a hardcoded 'claude-code',
  // so a TestModeRuntime was invisible to every lookup and the relay went quiet.
  it('normalizeAgentRuntimes() keys a lone runtime under its own type', () => {
    const runtime = {
      type: 'test-mode',
      ensureSession: vi.fn(),
      sendMessage: vi.fn(),
      approveTool: vi.fn(),
      interruptQuery: vi.fn(),
    };
    expect([...normalizeAgentRuntimes({ agentManager: runtime }).keys()]).toEqual(['test-mode']);
    const bare = {
      ensureSession: vi.fn(),
      sendMessage: vi.fn(),
      approveTool: vi.fn(),
      interruptQuery: vi.fn(),
    };
    expect([...normalizeAgentRuntimes({ agentManager: bare }).keys()]).toEqual(['claude-code']);
  });

  describe('canRunTaskOnBus (DOR-1614, DOR-1636)', () => {
    // An always-true answer strands codex/opencode runs on a bus that would
    // refuse them; an always-false one silently sends every run direct. It runs
    // against a REAL AdapterRegistry because liveness is the question.
    const SUBJECT = taskDispatchSubject('01J8ZQ2K3M4N5P6Q7R8S9T0V');
    let live: AdapterRegistry;

    beforeEach(() => {
      live = new AdapterRegistry();
      live.setLogger({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
      live.setRelay({} as RelayPublisher);
    });

    const withRuntimes = (types: string[]): AdapterManager =>
      new AdapterManager(live, CONFIG_PATH, {
        ...mockDeps,
        agentRuntimes: new Map(
          types.map((t) => [
            t,
            {
              ensureSession: vi.fn(),
              sendMessage: vi.fn(),
              approveTool: vi.fn(),
              interruptQuery: vi.fn(),
            },
          ])
        ),
      });

    /** An adapter claiming the task-dispatch prefix, reporting `state`. */
    const tasksReceiver = (state: AdapterStatus['state'] = 'connected'): RelayAdapter =>
      fakeAdapter('claude-code', ['relay.agent.', 'relay.system.tasks.'], {
        getStatus: () => ({ state, messageCount: { inbound: 0, outbound: 0 }, errorCount: 0 }),
      });

    it('says yes for a live receiver and a runtime the map holds, no for one it never registered', async () => {
      await live.register(tasksReceiver());
      const m = withRuntimes(['claude-code', 'codex']);

      expect(m.canRunTaskOnBus('codex', SUBJECT)).toEqual({ deliverable: true });
      expect(m.canRunTaskOnBus('opencode', SUBJECT)).toEqual({
        deliverable: false,
        reason: 'runtime-not-on-bus',
      });
    });

    it('says no once the adapter is DISABLED, though the runtime map is untouched', async () => {
      withConfig(
        JSON.stringify({
          adapters: [
            { id: 'claude-code', type: 'claude-code', enabled: true, builtin: true, config: {} },
          ],
        })
      );
      const m = withRuntimes(['claude-code']);
      await initAndStart(m);
      expect(m.canRunTaskOnBus('claude-code', SUBJECT)).toEqual({ deliverable: true });

      await m.disable('claude-code');

      expect(m.canRunTaskOnBus('claude-code', SUBJECT)).toEqual({
        deliverable: false,
        reason: 'no-receiver',
      });
    });

    it('says no for a receiver that is registered but not connected', async () => {
      await live.register(tasksReceiver('error'));
      expect(withRuntimes(['claude-code']).canRunTaskOnBus('claude-code', SUBJECT)).toEqual({
        deliverable: false,
        reason: 'receiver-not-connected',
      });
    });
  });

  describe('authorizeBridgedApproval (spec `ask-entitlement` §5.3)', () => {
    // The adapters gate the click in process; this runs before the runtime is
    // touched, because the relay bus carries no authority of its own.
    const ROOM_ID = 'room-approval-1';
    const BOUND_SESSION = 'session-in-a-room';
    const roomSessionBindings = {
      bindingForSession: (sessionId: string) =>
        sessionId === BOUND_SESSION ? { roomId: ROOM_ID, authorId: 'author-ana' } : undefined,
    };

    /** A manager whose tg-main names `approvers`, with `ROOM_ID` bridged to it (or not). */
    async function managerWithApprovers(approvers: unknown, bridged = true) {
      withConfig(
        JSON.stringify({
          adapters: [
            {
              id: 'tg-main',
              type: 'telegram',
              enabled: false,
              config: { token: 'bot-token-123', mode: 'polling', approverAllowlist: approvers },
            },
          ],
        })
      );
      const m = new AdapterManager(registry, CONFIG_PATH, {
        ...mockDeps,
        roomBridges: bridged ? bridgedRoom(ROOM_ID, 'private') : new BridgeStore(createTestDb()),
        roomSessionBindings,
      });
      await initAndStart(m);
      return m;
    }

    it.each([
      ['an allowlisted person', ['145223'], true, BOUND_SESSION, 'telegram', '145223', true],
      ['somebody not on the list', ['145223'], true, BOUND_SESSION, 'telegram', '999999', false],
      ['everybody on an empty list', [], true, BOUND_SESSION, 'telegram', '145223', false],
      ['a click with no name', ['145223'], true, BOUND_SESSION, 'telegram', undefined, false],
      [
        'an id from the one-per-line form',
        ' 145223 \n 999999 ',
        true,
        BOUND_SESSION,
        'telegram',
        '145223',
        true,
      ],
      ['a room with no live bridge', ['145223'], false, BOUND_SESSION, 'telegram', '145223', false],
      // A platform user id is unique only within its own platform.
      ['a click from another platform', ['145223'], true, BOUND_SESSION, 'slack', '145223', false],
      // A stated boundary, not a fail-open default (spec Non-Goals).
      [
        'a session no room owns (direct-bind gate)',
        ['145223'],
        true,
        'session-nobody-owns',
        'telegram',
        '999999',
        true,
      ],
    ] as const)(
      '%s',
      async (_name, approvers, bridged, sessionId, platform, respondedBy, expected) => {
        const m = await managerWithApprovers(approvers, bridged);
        expect(m.authorizeBridgedApproval({ sessionId, platform, respondedBy })).toBe(expected);
      }
    );

    it('refuses everything when the room-session binding port is not wired', async () => {
      // Fail CLOSED: without the port a room-bound session looks direct-bound.
      withConfig(VALID_CONFIG);
      const m = new AdapterManager(registry, CONFIG_PATH, {
        ...mockDeps,
        roomBridges: bridgedRoom(ROOM_ID, 'private'),
      });
      await initAndStart(m);

      expect(
        m.authorizeBridgedApproval({
          sessionId: BOUND_SESSION,
          platform: 'telegram',
          respondedBy: '145223',
        })
      ).toBe(false);
    });
  });

  describe('refreshBridgeVisibility (chats-as-channels §8)', () => {
    const ROOM_ID = 'room-visibility-1';

    // §8 exists so a partially-visible group is never reported as fully seen;
    // both directions are pinned so an inverted branch fails one of them.
    it.each([
      [true, 'everything'],
      [false, 'mentions-only'],
    ] as const)(
      'stamps the bridge from getMe (canReadAllGroupMessages %s -> %s)',
      async (canRead, expected) => {
        const bridges = bridgedRoom(ROOM_ID, 'group');
        mockGetMe.mockResolvedValueOnce({ username: 'bot', canReadAllGroupMessages: canRead });
        withConfig(VALID_CONFIG);
        await initAndStart(
          new AdapterManager(registry, CONFIG_PATH, { ...mockDeps, roomBridges: bridges })
        );

        // The refresh is fire-and-forget from the lifecycle broadcast.
        await vi.waitFor(() => {
          expect(bridges.findBridgeByRoom(ROOM_ID)?.visibility).toBe(expected);
        });
        expect(bridges.findBridgeByRoom(ROOM_ID)?.visibilityCheckedAt).not.toBeNull();
      }
    );
  });

  // DOR-883: the group-add claim flow leaves a chat through the live adapter.
  it("leaveChat() calls the live adapter's own leaveChat, and refuses adapters that cannot", async () => {
    const leaveChat = vi.fn().mockResolvedValue(undefined);
    await registry.register(fakeAdapter('tg-main', 'relay.human.tg-main', { leaveChat }));
    await registry.register(fakeAdapter('wh-main', 'relay.human.wh-main'));

    await manager.leaveChat('tg-main', '555');
    expect(leaveChat.mock.calls).toEqual([['555']]);

    await expect(manager.leaveChat('ghost', '555')).rejects.toThrow(/not registered/i);
    await expect(manager.leaveChat('wh-main', '555')).rejects.toThrow(
      /does not support leaving a chat/i
    );
  });
});
