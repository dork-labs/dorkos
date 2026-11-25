import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createDb, notifications, runMigrations } from '@dorkos/db';
import { NotificationStore } from '../../notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../notifications/notification-service.js';
import {
  createRelayNotifyUserHandler,
  type McpToolDeps,
} from '../../runtimes/claude-code/mcp-tools/index.js';
import type { SenderIdentity } from '../../runtimes/claude-code/mcp-tools/relay-helpers.js';
import { AdapterBindingSchema } from '@dorkos/shared/relay-schemas';
import { resolveSenderIdentity } from '../../runtimes/claude-code/mcp-tools/relay-helpers.js';
import { resolveAgentHome } from '../agent-identity/index.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
  registerTestHomes,
} from '../agent-identity/__tests__/agent-home-fixture.js';

// Every scratch folder counts as a registered home here, so this suite's
// mocked mesh decides who is an agent, as it did before homes (DOR-2355).
beforeEach(() => registerEveryFolderAsHome());
afterEach(() => clearTestHomes());

vi.mock('../../relay/relay-state.js', () => ({ isRelayEnabled: vi.fn(() => true) }));

/** Server-injected identity for a registered agent (replaces the removed agentId arg). */
const NOTIFY: SenderIdentity = { subject: 'relay.agent.ns.agent-1', agentId: 'agent-1' };

/** Identity for a session that is not a registered agent (no bindings to notify through). */
const ANON: SenderIdentity = { subject: 'relay.session.scratch' };

/** A binding; `canInitiate: true` by default, the gate itself is tested below (DOR-239). */
function makeBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b-1',
    adapterId: 'tg-main',
    agentId: 'agent-1',
    sessionStrategy: 'per-chat',
    label: 'Main Bot',
    canInitiate: true,
    canReply: true,
    canReceive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Create a mock BindingStore with default stubs. */
function makeMockBindingStore(overrides?: Record<string, unknown>) {
  return {
    getAll: vi.fn().mockReturnValue([makeBinding()]),
    ...overrides,
  };
}

/** Create a mock BindingRouter with default stubs. */
function makeMockBindingRouter(overrides?: Record<string, unknown>) {
  return {
    getSessionsByBinding: vi.fn().mockReturnValue([
      {
        key: 'b-1:chat-42',
        scope: 'chat' as const,
        chatId: 'chat-42',
        sessionId: 'sess-1',
        lastActivityAt: 1,
      },
    ]),
    ...overrides,
  };
}

/** Create a mock AdapterManager with default stubs. */
function makeMockAdapterManager(overrides?: Record<string, unknown>) {
  return {
    listAdapters: vi.fn().mockReturnValue([
      {
        config: { id: 'tg-main', type: 'telegram', enabled: true, config: {} },
        status: { state: 'connected' },
      },
    ]),
    ...overrides,
  };
}

/** Create a mock BridgeStore with default stubs — no live bridges by default. */
function makeMockBridgeStore(overrides?: Record<string, unknown>) {
  return {
    listLiveBridges: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

/**
 * The seam the DM fallback writes through (DOR-1209); `deliverNotifyDm` itself runs for
 * real. The real room log is pinned in `services/relay/__tests__/notify-dm.test.ts`.
 */
function makeMockNotifyDm(overrides: Partial<McpToolDeps['notifyDm']> = {}) {
  return {
    rooms: {
      createRoom: vi.fn().mockReturnValue({ id: 'room-dm-1' }),
      post: vi.fn().mockReturnValue({ id: 'entry-1' }),
    },
    authors: { resolveAgent: vi.fn().mockReturnValue({ id: 'author-ana' }) },
    mesh: {
      getProjectPath: vi.fn().mockReturnValue('/agents/ana'),
      get: vi.fn().mockReturnValue({ name: 'ana', displayName: 'Ana' }),
    },
    operatorAuthorId: vi.fn().mockReturnValue('author-human'),
    logger: { warn: vi.fn() },
    ...overrides,
  } satisfies NonNullable<McpToolDeps['notifyDm']>;
}

/** A binding store holding exactly `bindings`. */
function storeOf(bindings: unknown[]): McpToolDeps['bindingStore'] {
  return makeMockBindingStore({
    getAll: vi.fn().mockReturnValue(bindings),
  }) as unknown as McpToolDeps['bindingStore'];
}

/** A binding router that has seen no active chat on any binding. */
function noActiveChats(): McpToolDeps['bindingRouter'] {
  return makeMockBindingRouter({
    getSessionsByBinding: vi.fn().mockReturnValue([]),
  }) as unknown as McpToolDeps['bindingRouter'];
}

function makeMockDeps(overrides: Partial<McpToolDeps> = {}): McpToolDeps {
  return {
    transcriptReader: {} as McpToolDeps['transcriptReader'],
    defaultCwd: '/test',
    dorkHome: '/tmp/dorkos-test-home',
    relayCore: {
      publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
    } as unknown as McpToolDeps['relayCore'],
    bindingStore: makeMockBindingStore() as unknown as McpToolDeps['bindingStore'],
    bindingRouter: makeMockBindingRouter() as unknown as McpToolDeps['bindingRouter'],
    adapterManager: makeMockAdapterManager() as unknown as McpToolDeps['adapterManager'],
    bridgeStore: makeMockBridgeStore() as unknown as McpToolDeps['bridgeStore'],
    ...overrides,
  };
}

/** Build the handler under test; the caller is the registered agent unless a test says otherwise. */
function makeHandler(deps: McpToolDeps, identity: SenderIdentity = NOTIFY) {
  return createRelayNotifyUserHandler(deps, identity);
}

describe('relay_notify_user', () => {
  it('never forwards agent-supplied notification options into the server receipt callback', async () => {
    const db = createDb(':memory:');
    runMigrations(db);
    setNotificationService(new NotificationService(new NotificationStore(db)));
    const onStored = vi.fn();
    const input = {
      message: 'The receipt stays server-owned.',
      onStored,
      opts: { onStored },
      options: { onStored },
    };
    try {
      const result = await makeHandler(makeMockDeps())(input);
      expect(result.isError).toBeUndefined();
      await expect.poll(() => db.select().from(notifications).all().length).toBe(1);
      expect(onStored).not.toHaveBeenCalled();
      const row = db.select().from(notifications).get()!;
      expect(JSON.parse(row.dataJson!)).toMatchObject({ message: input.message });
      expect(row.dataJson).not.toContain('onStored');
    } finally {
      setNotificationService(null);
      db.$client.close();
    }
  });

  it('sends to most recently active chat when channel omitted', async () => {
    const deps = makeMockDeps();
    const handler = makeHandler(deps);
    const result = await handler({ message: 'Hello user' });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.sent).toBe(true);
    expect(data.adapterId).toBe('tg-main');
    expect(data.chatId).toBe('chat-42');
    expect(data.messageId).toBe('msg-1');
    expect(data.subject).toBe('relay.human.telegram.tg-main.chat-42');
    // The publish `from` is the injected identity subject, not the bare agent
    // id — a bare id is not a relay subject and matches no access rule.
    expect(deps.relayCore!.publish).toHaveBeenCalledWith(
      'relay.human.telegram.tg-main.chat-42',
      'Hello user',
      { from: 'relay.agent.ns.agent-1' }
    );
  });

  it('filters by channel when specified (adapter ID match)', async () => {
    const bindings = [
      makeBinding({ id: 'b-1', adapterId: 'tg-main' }),
      makeBinding({ id: 'b-2', adapterId: 'slack-main' }),
    ];
    const deps = makeMockDeps({
      bindingStore: storeOf(bindings),
      bindingRouter: makeMockBindingRouter({
        getSessionsByBinding: vi.fn().mockImplementation((bindingId: string) => {
          if (bindingId === 'b-2')
            return [
              {
                key: 'b-2:chat-99',
                scope: 'chat' as const,
                chatId: 'chat-99',
                sessionId: 'sess-2',
                lastActivityAt: 1,
              },
            ];
          return [];
        }),
      }) as unknown as McpToolDeps['bindingRouter'],
    });
    const handler = makeHandler(deps);
    const result = await handler({
      message: 'Slack message',
      channel: 'slack-main',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.sent).toBe(true);
    expect(data.adapterId).toBe('slack-main');
    expect(data.chatId).toBe('chat-99');
  });

  it('returns NOT_AN_AGENT when the session is not a registered agent', async () => {
    const result = await makeHandler(makeMockDeps(), ANON)({ message: 'Hello' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('NOT_AN_AGENT');
  });

  it('returns NO_BINDING with availableChannels, and no DM, when the named channel is not bound', async () => {
    const notifyDm = makeMockNotifyDm();
    const deps = makeMockDeps({
      notifyDm,
      bindingStore: storeOf([makeBinding({ id: 'b-1', adapterId: 'tg-main' })]),
      adapterManager: makeMockAdapterManager({
        listAdapters: vi.fn().mockReturnValue([]),
      }) as unknown as McpToolDeps['adapterManager'],
    });
    const handler = makeHandler(deps);
    const result = await handler({
      message: 'Hello',
      channel: 'nonexistent',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('NO_BINDING');
    expect(data.availableChannels).toEqual(['tg-main']);
    // A message that asked for a named channel is never redirected to the DM.
    expect(notifyDm.rooms.post).not.toHaveBeenCalled();
  });

  it('returns SEND_FAILED when relayCore.publish throws', async () => {
    const deps = makeMockDeps({
      relayCore: {
        publish: vi.fn().mockRejectedValue(new Error('Network error')),
      } as unknown as McpToolDeps['relayCore'],
    });
    const result = await makeHandler(deps)({ message: 'Hello' });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('SEND_FAILED');
    expect(data.error).toContain('Network error');
  });

  it.each([
    { off: { relayCore: undefined }, code: 'RELAY_DISABLED' },
    { off: { bindingRouter: undefined, bindingStore: undefined }, code: 'BINDINGS_DISABLED' },
  ])('returns $code when that subsystem is off', async ({ off, code }) => {
    const result = await makeHandler(makeMockDeps(off))({ message: 'Hello' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe(code);
  });

  // A stock install has no Telegram or Slack connected, which used to make this
  // tool a silent no-op: the agent announced a finished job into nothing. The
  // message now goes to the agent's own direct message with the operator
  // (DOR-1209, point 3 of DOR-793).
  describe('DorkOS DM fallback (DOR-1209)', () => {
    /** Deps with no bindings at all — the stock install. */
    function noIntegrationDeps(notifyDm = makeMockNotifyDm()): McpToolDeps {
      return makeMockDeps({
        bindingStore: storeOf([]),
        notifyDm,
      });
    }

    it('posts into the agent-and-operator DM when nothing external is bound', async () => {
      const notifyDm = makeMockNotifyDm();
      const deps = noIntegrationDeps(notifyDm);
      const handler = makeHandler(deps);
      const result = await handler({ message: 'Deploy finished.' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        sent: true,
        surface: 'dorkos-dm',
        roomId: 'room-dm-1',
        entryId: 'entry-1',
      });
      // The 1:1 conversation, opened by the agent, holding exactly it and the
      // person — never a room per notification.
      expect(notifyDm.rooms.createRoom).toHaveBeenCalledWith(
        { kind: 'dm', title: 'Ana', members: ['author-human'], agentPaths: [] },
        'author-ana'
      );
      // An ordinary post in the agent's own name, carrying its words verbatim.
      expect(notifyDm.rooms.post).toHaveBeenCalledWith('room-dm-1', {
        authorId: 'author-ana',
        text: 'Deploy finished.',
      });
      // Nothing was published to the bus: there was no channel to publish to.
      expect(deps.relayCore!.publish).not.toHaveBeenCalled();
    });

    it('also catches the case where a binding exists but no chat has ever been active', async () => {
      const notifyDm = makeMockNotifyDm();
      const deps = makeMockDeps({
        bindingRouter: noActiveChats(),
        notifyDm,
      });
      const handler = makeHandler(deps);
      const result = await handler({ message: 'Nobody has messaged the bot yet.' });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).surface).toBe('dorkos-dm');
    });
  });

  // No hourly count bounds a note any more (ADR 261006-225605, DOR-2739): it
  // goes only where the operator configured, and each one lands in the inbox.
  describe('no hourly note ceiling (DOR-2739)', () => {
    it('sends every note, however many', async () => {
      const deps = makeMockDeps();
      const handler = makeHandler(deps);

      for (let i = 0; i < 15; i += 1) {
        const result = await handler({ message: `note ${i}` });
        expect(JSON.parse(result.content[0].text).sent).toBe(true);
      }
      expect(deps.relayCore!.publish).toHaveBeenCalledTimes(15);
    });
  });

  // DOR-1265: the setup consent. `canInitiate` defaults false, so nothing reaches
  // any external chat until a person switches it on for that binding.
  describe('where a note can actually land (DOR-1265)', () => {
    it('reaches nothing external until a person switches initiating on for that chat', async () => {
      // Read off the SCHEMA, not off this file's fixture — the fixture defaults
      // `canInitiate: true` for the convenience of the routing tests, and a claim
      // about what a fresh binding permits has to be asserted where fresh
      // bindings are actually made. A chat somebody just claimed carries no
      // permission to be spoken to first.
      const fresh = AdapterBindingSchema.parse({
        id: '00000000-0000-4000-8000-000000000000',
        adapterId: 'tg-main',
        agentId: 'agent-1',
        chatId: 'chat-42',
        channelType: 'group',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(fresh.canInitiate).toBe(false);

      const deps = makeMockDeps({
        bindingStore: storeOf([fresh]),
      });
      const handler = makeHandler(deps);
      const result = await handler({ message: 'Should never arrive' });

      expect(JSON.parse(result.content[0].text).code).toBe('INITIATE_NOT_ALLOWED');
      expect(deps.relayCore!.publish).not.toHaveBeenCalled();
    });
  });

  describe('canInitiate enforcement (DOR-239)', () => {
    it('blocks the send, and does not route around it to the DM, when canInitiate=false', async () => {
      const notifyDm = makeMockNotifyDm();
      const deps = makeMockDeps({
        notifyDm,
        bindingStore: storeOf([makeBinding({ canInitiate: false })]),
      });
      const handler = makeHandler(deps);
      const result = await handler({ message: 'Surprise!' });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.sent).toBe(false);
      expect(data.code).toBe('INITIATE_NOT_ALLOWED');
      expect(data.error).toMatch(/doesn't allow the agent to start conversations/i);
      expect(data.bindingId).toBe('b-1');
      expect(data.adapterId).toBe('tg-main');
      expect(deps.relayCore!.publish).not.toHaveBeenCalled();
      expect(notifyDm.rooms.post).not.toHaveBeenCalled();
    });

    it('excludes paused bindings entirely (enabled=false never routes a notify)', async () => {
      const deps = makeMockDeps({
        bindingStore: storeOf([makeBinding({ canInitiate: true, enabled: false })]),
      });
      const handler = makeHandler(deps);
      const result = await handler({ message: 'Should never arrive' });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.sent).toBe(false);
      // With its only binding paused, the agent has no channel to notify through.
      expect(deps.relayCore!.publish).not.toHaveBeenCalled();
    });
  });

  // A bridged binding vacates sessionMap (chats-as-channels spec §7.2), so
  // this tool must resolve through a live bridge row too, and publish under
  // the bridge delivery principal rather than the caller's own agent
  // identity (DOR-876, spec §7.5) — matching the run-completion path's other
  // proactive path so both honor identical binding/consent rules.
  describe('bridged bindings (§7.5)', () => {
    it('resolves and publishes under relay.bridge.initiate.* when the chat is bridged', async () => {
      const deps = makeMockDeps({
        bindingStore: storeOf([
          makeBinding({ bridge: 'room', roomId: 'room-1', chatId: 'chat-42' }),
        ]),
        // sessionMap fully vacated — nothing for the router to find (§7.2).
        bindingRouter: noActiveChats(),
        bridgeStore: makeMockBridgeStore({
          listLiveBridges: vi
            .fn()
            .mockReturnValue([
              { bindingId: 'b-1', chatId: 'chat-42', lastActivityAt: '2026-01-01T00:05:00.000Z' },
            ]),
        }) as unknown as McpToolDeps['bridgeStore'],
      });
      const handler = makeHandler(deps);
      const result = await handler({ message: 'Bridged heads up!' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.sent).toBe(true);
      expect(data.chatId).toBe('chat-42');
      // The bridge delivery principal, not the caller's identity, so the send is
      // gated as an initiate; DOR-889: plus the server trust marker the guard admits.
      expect(deps.relayCore!.publish).toHaveBeenCalledWith(
        'relay.human.telegram.tg-main.chat-42',
        'Bridged heads up!',
        { from: 'relay.bridge.initiate.tg-main.chat-42', serverBridgePrincipal: true }
      );
    });

    it('blocks the send when the bridged binding has canInitiate=false', async () => {
      const deps = makeMockDeps({
        bindingStore: storeOf([
          makeBinding({
            bridge: 'room',
            roomId: 'room-1',
            chatId: 'chat-42',
            canInitiate: false,
          }),
        ]),
        bindingRouter: noActiveChats(),
        bridgeStore: makeMockBridgeStore({
          listLiveBridges: vi.fn().mockReturnValue([{ bindingId: 'b-1', chatId: 'chat-42' }]),
        }) as unknown as McpToolDeps['bridgeStore'],
      });
      const handler = makeHandler(deps);
      const result = await handler({ message: 'Should never arrive' });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.code).toBe('INITIATE_NOT_ALLOWED');
      expect(deps.relayCore!.publish).not.toHaveBeenCalled();
    });
  });
});

describe('relay_notify_user, by identity anchor', () => {
  describe('from a folder that is nobody’s home (DOR-2091, spec `agent-home-desk` §3.1)', () => {
    // A named-agent turn can stand in a folder that resolves to no home — the
    // operator's default folder for an agent configured `workspace.mode:
    // 'none'`. The sender is looked up by the session's identity anchor, which
    // carries the turn's agent there, never by that directory, which the mesh
    // does not place. Seeded: reverting `resolveSenderIdentity` to ask the mesh
    // about `cwd` reddens the first case; ignoring the anchor it is handed
    // reddens the second.
    const SHARED_DEFAULT = '/work/shared-default';

    beforeEach(() => {
      registerTestHomes(['/agents/ana', '/agents/ben']);
    });

    afterEach(() => {
      clearTestHomes();
    });

    /** A mesh that places exactly one directory: Ana's own folder. */
    function anaMeshDeps(): McpToolDeps {
      return makeMockDeps({
        meshCore: {
          getSubjectByPath: vi.fn((p: string) =>
            p === '/agents/ana'
              ? { subject: 'relay.agent.ns.agent-1', agentId: 'agent-1' }
              : undefined
          ),
          get: vi.fn().mockReturnValue({ name: 'ana', displayName: 'Ana' }),
          getProjectPath: vi.fn().mockReturnValue('/agents/ana'),
        } as unknown as McpToolDeps['meshCore'],
      });
    }

    it('sends as the agent the turn is for', async () => {
      const deps = anaMeshDeps();
      const identity = resolveSenderIdentity(
        deps,
        SHARED_DEFAULT,
        resolveAgentHome(SHARED_DEFAULT, '/agents/ana')
      );
      expect(identity.agentId).toBe('agent-1');

      const result = await createRelayNotifyUserHandler(deps, identity)({ message: 'done' });
      expect(JSON.parse(result.content[0].text).sent).toBe(true);
    });

    it('sends as nobody for a turn for ANOTHER agent standing in Ana’s home', async () => {
      const deps = anaMeshDeps();
      const identity = resolveSenderIdentity(
        deps,
        '/agents/ana',
        resolveAgentHome('/agents/ana', '/agents/ben')
      );
      expect(identity.agentId).toBeUndefined();

      const result = await createRelayNotifyUserHandler(deps, identity)({ message: 'as Ana?' });
      expect(JSON.parse(result.content[0].text).code).toBe('NOT_AN_AGENT');
    });
  });
});
