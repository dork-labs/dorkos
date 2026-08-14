import { describe, it, expect, vi } from 'vitest';
import {
  createRelayNotifyUserHandler,
  type McpToolDeps,
} from '../../runtimes/claude-code/mcp-tools/index.js';
import type { SenderIdentity } from '../../runtimes/claude-code/mcp-tools/relay-helpers.js';

/** Server-injected identity for a registered agent (replaces the removed agentId arg). */
const NOTIFY: SenderIdentity = { subject: 'relay.agent.ns.agent-1', agentId: 'agent-1' };

/** Identity for a session that is not a registered agent (no bindings to notify through). */
const ANON: SenderIdentity = { subject: 'relay.session.scratch' };

/**
 * Minimal binding shape matching AdapterBinding fields used by the handler.
 *
 * Defaults `canInitiate: true` so the routing/channel-matching tests in this
 * file (which predate the DOR-239 permission gate) don't need to opt in —
 * the permission itself is covered by the dedicated `canInitiate` tests below.
 */
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
 * The rooms/authors/mesh seam the DM fallback writes through (DOR-1209).
 *
 * The seam is faked, not the fallback: `deliverNotifyDm` itself runs for real
 * here, so these tests still exercise the resolution order and the refusals.
 * What the DM write does to a real room log is pinned against a real room
 * service in `services/relay/__tests__/notify-dm.test.ts`.
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

function makeMockDeps(overrides: Partial<McpToolDeps> = {}): McpToolDeps {
  return {
    transcriptReader: {} as McpToolDeps['transcriptReader'],
    defaultCwd: '/test',
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

describe('relay_notify_user', () => {
  it('sends to most recently active chat when channel omitted', async () => {
    const deps = makeMockDeps();
    const handler = createRelayNotifyUserHandler(deps, NOTIFY);
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
      bindingStore: makeMockBindingStore({
        getAll: vi.fn().mockReturnValue(bindings),
      }) as unknown as McpToolDeps['bindingStore'],
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
    const handler = createRelayNotifyUserHandler(deps, NOTIFY);
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

  it('filters by channel when specified (adapter type match)', async () => {
    const bindings = [
      makeBinding({ id: 'b-1', adapterId: 'tg-lifeos' }),
      makeBinding({ id: 'b-2', adapterId: 'slack-ops' }),
    ];
    const deps = makeMockDeps({
      bindingStore: makeMockBindingStore({
        getAll: vi.fn().mockReturnValue(bindings),
      }) as unknown as McpToolDeps['bindingStore'],
      bindingRouter: makeMockBindingRouter({
        getSessionsByBinding: vi.fn().mockImplementation((bindingId: string) => {
          if (bindingId === 'b-1')
            return [
              {
                key: 'b-1:chat-77',
                scope: 'chat' as const,
                chatId: 'chat-77',
                sessionId: 'sess-3',
                lastActivityAt: 1,
              },
            ];
          return [];
        }),
      }) as unknown as McpToolDeps['bindingRouter'],
      adapterManager: makeMockAdapterManager({
        listAdapters: vi.fn().mockReturnValue([
          {
            config: { id: 'tg-lifeos', type: 'telegram', enabled: true, config: {} },
            status: { state: 'connected' },
          },
          {
            config: { id: 'slack-ops', type: 'slack', enabled: true, config: {} },
            status: { state: 'connected' },
          },
        ]),
      }) as unknown as McpToolDeps['adapterManager'],
    });
    const handler = createRelayNotifyUserHandler(deps, NOTIFY);
    // Use type name "telegram" which doesn't directly match adapter IDs
    const result = await handler({
      message: 'Telegram via type',
      channel: 'telegram',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.sent).toBe(true);
    expect(data.adapterId).toBe('tg-lifeos');
    expect(data.chatId).toBe('chat-77');
  });

  it('returns NOT_AN_AGENT when the session is not a registered agent', async () => {
    const deps = makeMockDeps();
    const handler = createRelayNotifyUserHandler(deps, ANON);
    const result = await handler({ message: 'Hello' });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('NOT_AN_AGENT');
  });

  it('returns NO_BINDING with availableChannels when no matching binding', async () => {
    const deps = makeMockDeps({
      bindingStore: makeMockBindingStore({
        getAll: vi.fn().mockReturnValue([makeBinding({ id: 'b-1', adapterId: 'tg-main' })]),
      }) as unknown as McpToolDeps['bindingStore'],
      adapterManager: makeMockAdapterManager({
        listAdapters: vi.fn().mockReturnValue([]),
      }) as unknown as McpToolDeps['adapterManager'],
    });
    const handler = createRelayNotifyUserHandler(deps, NOTIFY);
    const result = await handler({
      message: 'Hello',
      channel: 'nonexistent',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('NO_BINDING');
    expect(data.availableChannels).toEqual(['tg-main']);
  });

  it('returns NO_ACTIVE_SESSIONS when bindings exist but no chat sessions', async () => {
    const deps = makeMockDeps({
      bindingRouter: makeMockBindingRouter({
        getSessionsByBinding: vi.fn().mockReturnValue([]),
      }) as unknown as McpToolDeps['bindingRouter'],
    });
    const handler = createRelayNotifyUserHandler(deps, NOTIFY);
    const result = await handler({ message: 'Hello' });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('NO_ACTIVE_SESSIONS');
    expect(data.availableAdapters).toEqual(['tg-main']);
  });

  it('returns SEND_FAILED when relayCore.publish throws', async () => {
    const deps = makeMockDeps({
      relayCore: {
        publish: vi.fn().mockRejectedValue(new Error('Network error')),
      } as unknown as McpToolDeps['relayCore'],
    });
    const handler = createRelayNotifyUserHandler(deps, NOTIFY);
    const result = await handler({ message: 'Hello' });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('SEND_FAILED');
    expect(data.error).toContain('Network error');
  });

  it('returns RELAY_DISABLED when relayCore is undefined', async () => {
    const deps = makeMockDeps({ relayCore: undefined });
    const handler = createRelayNotifyUserHandler(deps, NOTIFY);
    const result = await handler({ message: 'Hello' });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('RELAY_DISABLED');
  });

  it('returns BINDINGS_DISABLED when bindingRouter/bindingStore undefined', async () => {
    const deps = makeMockDeps({
      bindingRouter: undefined,
      bindingStore: undefined,
    });
    const handler = createRelayNotifyUserHandler(deps, NOTIFY);
    const result = await handler({ message: 'Hello' });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('BINDINGS_DISABLED');
  });

  it('on success returns sent:true with subject, adapterId, chatId, messageId', async () => {
    const deps = makeMockDeps({
      relayCore: {
        publish: vi.fn().mockResolvedValue({ messageId: 'msg-42', deliveredTo: 1 }),
      } as unknown as McpToolDeps['relayCore'],
    });
    const handler = createRelayNotifyUserHandler(deps, NOTIFY);
    const result = await handler({ message: 'Done!' });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.sent).toBe(true);
    expect(data.subject).toBe('relay.human.telegram.tg-main.chat-42');
    expect(data.adapterId).toBe('tg-main');
    expect(data.adapterType).toBe('telegram');
    expect(data.chatId).toBe('chat-42');
    expect(data.messageId).toBe('msg-42');
    expect(data.deliveredTo).toBe(1);
  });

  // A stock install has no Telegram or Slack connected, which used to make this
  // tool a silent no-op: the agent announced a finished job into nothing. The
  // message now goes to the agent's own direct message with the operator
  // (DOR-1209, point 3 of DOR-793).
  describe('DorkOS DM fallback (DOR-1209)', () => {
    /** Deps with no bindings at all — the stock install. */
    function noIntegrationDeps(notifyDm = makeMockNotifyDm()): McpToolDeps {
      return makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi.fn().mockReturnValue([]),
        }) as unknown as McpToolDeps['bindingStore'],
        notifyDm,
      });
    }

    it('posts into the agent-and-operator DM when nothing external is bound', async () => {
      const notifyDm = makeMockNotifyDm();
      const deps = noIntegrationDeps(notifyDm);
      const handler = createRelayNotifyUserHandler(deps, NOTIFY);
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
        bindingRouter: makeMockBindingRouter({
          getSessionsByBinding: vi.fn().mockReturnValue([]),
        }) as unknown as McpToolDeps['bindingRouter'],
        notifyDm,
      });
      const handler = createRelayNotifyUserHandler(deps, NOTIFY);
      const result = await handler({ message: 'Nobody has messaged the bot yet.' });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).surface).toBe('dorkos-dm');
    });

    it('leaves the external path untouched when an integration can carry it', async () => {
      const notifyDm = makeMockNotifyDm();
      const deps = makeMockDeps({ notifyDm });
      const handler = createRelayNotifyUserHandler(deps, NOTIFY);
      const result = await handler({ message: 'Hello user' });

      const data = JSON.parse(result.content[0].text);
      expect(data.sent).toBe(true);
      expect(data.surface).toBe('integration');
      expect(data.chatId).toBe('chat-42');
      expect(deps.relayCore!.publish).toHaveBeenCalledWith(
        'relay.human.telegram.tg-main.chat-42',
        'Hello user',
        { from: 'relay.agent.ns.agent-1' }
      );
      // First preference means the DM is not also written — one message, one place.
      expect(notifyDm.rooms.post).not.toHaveBeenCalled();
    });

    it('does not redirect a message that asked for a named channel', async () => {
      const notifyDm = makeMockNotifyDm();
      const deps = makeMockDeps({
        adapterManager: makeMockAdapterManager({
          listAdapters: vi.fn().mockReturnValue([]),
        }) as unknown as McpToolDeps['adapterManager'],
        notifyDm,
      });
      const handler = createRelayNotifyUserHandler(deps, NOTIFY);
      const result = await handler({ message: 'Slack or nothing', channel: 'slack' });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).code).toBe('NO_BINDING');
      expect(notifyDm.rooms.post).not.toHaveBeenCalled();
    });

    it('does not route around a binding whose owner turned initiating off', async () => {
      const notifyDm = makeMockNotifyDm();
      const deps = makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi.fn().mockReturnValue([makeBinding({ canInitiate: false })]),
        }) as unknown as McpToolDeps['bindingStore'],
        notifyDm,
      });
      const handler = createRelayNotifyUserHandler(deps, NOTIFY);
      const result = await handler({ message: 'Surprise!' });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).code).toBe('INITIATE_NOT_ALLOWED');
      expect(notifyDm.rooms.post).not.toHaveBeenCalled();
    });

    it('reports the old non-delivery — without throwing — when the DM cannot be reached', async () => {
      const notifyDm = makeMockNotifyDm({
        mesh: {
          getProjectPath: vi.fn().mockReturnValue(undefined),
          get: vi.fn().mockReturnValue(undefined),
        },
      });
      const deps = noIntegrationDeps(notifyDm);
      const handler = createRelayNotifyUserHandler(deps, NOTIFY);
      const result = await handler({ message: 'Nowhere to go.' });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.code).toBe('NO_BINDING');
      expect(data.sent).toBe(false);
      // Loudly, rather than silently: the message reached nobody.
      expect(notifyDm.logger!.warn).toHaveBeenCalled();
    });

    it('reports the old non-delivery when rooms are not wired at all', async () => {
      const deps = makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi.fn().mockReturnValue([]),
        }) as unknown as McpToolDeps['bindingStore'],
        notifyDm: undefined,
      });
      const handler = createRelayNotifyUserHandler(deps, NOTIFY);
      const result = await handler({ message: 'Nowhere to go.' });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).code).toBe('NO_BINDING');
    });
  });

  describe('canInitiate enforcement (DOR-239)', () => {
    it('blocks the send when the resolved binding has canInitiate=false', async () => {
      const deps = makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi.fn().mockReturnValue([makeBinding({ canInitiate: false })]),
        }) as unknown as McpToolDeps['bindingStore'],
      });
      const handler = createRelayNotifyUserHandler(deps, NOTIFY);
      const result = await handler({ message: 'Surprise!' });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.sent).toBe(false);
      expect(data.code).toBe('INITIATE_NOT_ALLOWED');
      expect(data.error).toMatch(/doesn't allow the agent to start conversations/i);
      expect(data.bindingId).toBe('b-1');
      expect(data.adapterId).toBe('tg-main');
      // Nothing should have been published to the channel.
      expect(deps.relayCore!.publish).not.toHaveBeenCalled();
    });

    it('excludes paused bindings entirely (enabled=false never routes a notify)', async () => {
      const deps = makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi.fn().mockReturnValue([makeBinding({ canInitiate: true, enabled: false })]),
        }) as unknown as McpToolDeps['bindingStore'],
      });
      const handler = createRelayNotifyUserHandler(deps, NOTIFY);
      const result = await handler({ message: 'Should never arrive' });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.sent).toBe(false);
      // With its only binding paused, the agent has no channel to notify through.
      expect(deps.relayCore!.publish).not.toHaveBeenCalled();
    });

    it('allows the send when the resolved binding has canInitiate=true', async () => {
      const deps = makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi.fn().mockReturnValue([makeBinding({ canInitiate: true })]),
        }) as unknown as McpToolDeps['bindingStore'],
      });
      const handler = createRelayNotifyUserHandler(deps, NOTIFY);
      const result = await handler({ message: 'Heads up!' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.sent).toBe(true);
      expect(deps.relayCore!.publish).toHaveBeenCalledWith(
        'relay.human.telegram.tg-main.chat-42',
        'Heads up!',
        { from: 'relay.agent.ns.agent-1' }
      );
    });
  });

  // Reply routing (an agent responding to an inbound <relay_context> turn) never
  // calls relay_notify_user — the runtime adapter forwards replies automatically
  // (see context-builder.ts <relay_tools> outbound rules) straight through
  // BindingRouter's inbound subscription, a code path this handler never
  // touches. That "replies still flow when canInitiate=false" regression is
  // covered directly in binding-router.test.ts, see:
  // "canInitiate=false does not block inbound routing — replies keep flowing (DOR-239)".

  // A bridged binding vacates sessionMap (chats-as-channels spec §7.2), so
  // this tool must resolve through a live bridge row too, and publish under
  // the bridge delivery principal rather than the caller's own agent
  // identity (DOR-876, spec §7.5) — matching TaskCompletionNotifier's other
  // proactive path so both honor identical binding/consent rules.
  describe('bridged bindings (§7.5)', () => {
    it('resolves and publishes under relay.bridge.initiate.* when the chat is bridged', async () => {
      const deps = makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi
            .fn()
            .mockReturnValue([
              makeBinding({ bridge: 'room', roomId: 'room-1', chatId: 'chat-42' }),
            ]),
        }) as unknown as McpToolDeps['bindingStore'],
        // sessionMap fully vacated — nothing for the router to find (§7.2).
        bindingRouter: makeMockBindingRouter({
          getSessionsByBinding: vi.fn().mockReturnValue([]),
        }) as unknown as McpToolDeps['bindingRouter'],
        bridgeStore: makeMockBridgeStore({
          listLiveBridges: vi
            .fn()
            .mockReturnValue([
              { bindingId: 'b-1', chatId: 'chat-42', lastActivityAt: '2026-01-01T00:05:00.000Z' },
            ]),
        }) as unknown as McpToolDeps['bridgeStore'],
      });
      const handler = createRelayNotifyUserHandler(deps, NOTIFY);
      const result = await handler({ message: 'Bridged heads up!' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.sent).toBe(true);
      expect(data.chatId).toBe('chat-42');
      // The distinguishing assertion: NOT the caller's own agent identity —
      // the bridge delivery principal, so the send is gated as an initiate
      // through the bridge consent branch, not the agent-sender check.
      // DOR-889: the bridged notify asserts the server trust marker alongside
      // the bridge principal, so the pipeline's bridge-principal guard admits
      // this trusted server publisher.
      expect(deps.relayCore!.publish).toHaveBeenCalledWith(
        'relay.human.telegram.tg-main.chat-42',
        'Bridged heads up!',
        { from: 'relay.bridge.initiate.tg-main.chat-42', serverBridgePrincipal: true }
      );
    });

    it('blocks the send when the bridged binding has canInitiate=false', async () => {
      const deps = makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi.fn().mockReturnValue([
            makeBinding({
              bridge: 'room',
              roomId: 'room-1',
              chatId: 'chat-42',
              canInitiate: false,
            }),
          ]),
        }) as unknown as McpToolDeps['bindingStore'],
        bindingRouter: makeMockBindingRouter({
          getSessionsByBinding: vi.fn().mockReturnValue([]),
        }) as unknown as McpToolDeps['bindingRouter'],
        bridgeStore: makeMockBridgeStore({
          listLiveBridges: vi.fn().mockReturnValue([{ bindingId: 'b-1', chatId: 'chat-42' }]),
        }) as unknown as McpToolDeps['bridgeStore'],
      });
      const handler = createRelayNotifyUserHandler(deps, NOTIFY);
      const result = await handler({ message: 'Should never arrive' });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.code).toBe('INITIATE_NOT_ALLOWED');
      expect(deps.relayCore!.publish).not.toHaveBeenCalled();
    });

    it('builds a correct principal for a chat id containing a dot (positional parse, not split-on-dot)', async () => {
      // `buildBridgePrincipal`/`parseBridgePrincipal` read `classification` and
      // `adapterId` from fixed positions and treat everything after as the chat
      // id, rejoined — never by counting dots. A Telegram chat id can itself
      // contain one (e.g. a forum-topic-qualified id), so this pins that a
      // dotted chat id lands whole in `from`, rather than getting truncated or
      // shifting the adapterId read.
      const deps = makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi
            .fn()
            .mockReturnValue([
              makeBinding({ bridge: 'room', roomId: 'room-1', chatId: '123.456' }),
            ]),
        }) as unknown as McpToolDeps['bindingStore'],
        bindingRouter: makeMockBindingRouter({
          getSessionsByBinding: vi.fn().mockReturnValue([]),
        }) as unknown as McpToolDeps['bindingRouter'],
        bridgeStore: makeMockBridgeStore({
          listLiveBridges: vi
            .fn()
            .mockReturnValue([
              { bindingId: 'b-1', chatId: '123.456', lastActivityAt: '2026-01-01T00:05:00.000Z' },
            ]),
        }) as unknown as McpToolDeps['bridgeStore'],
      });
      const handler = createRelayNotifyUserHandler(deps, NOTIFY);
      const result = await handler({ message: 'Topic-qualified chat' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.sent).toBe(true);
      expect(data.chatId).toBe('123.456');
      expect(deps.relayCore!.publish).toHaveBeenCalledWith(
        'relay.human.telegram.tg-main.123.456',
        'Topic-qualified chat',
        { from: 'relay.bridge.initiate.tg-main.123.456', serverBridgePrincipal: true }
      );
    });
  });
});
