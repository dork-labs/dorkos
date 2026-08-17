import { describe, it, expect, vi } from 'vitest';
import {
  createRelayNotifyUserHandler,
  type McpToolDeps,
} from '../../runtimes/claude-code/mcp-tools/index.js';
import type { SenderIdentity } from '../../runtimes/claude-code/mcp-tools/relay-helpers.js';
import { NotifyBudget } from '../../relay/notify-budget.js';
import { AdapterBindingSchema } from '@dorkos/shared/relay-schemas';
import { resolveSenderIdentity } from '../../runtimes/claude-code/mcp-tools/relay-helpers.js';
import { createCanUseTool } from '../../runtimes/claude-code/messaging/interactive-handlers.js';

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
    // An allowance of its own per deps object (DOR-1265). Every test here sends
    // as `agent-1`, so one shared budget would make each test depend on how many
    // notes the tests above it sent — and, past the tenth, fail for a reason that
    // has nothing to do with what it asserts. The ceiling's own behaviour is the
    // subject of its own describe block, below.
    notifyBudget: new NotifyBudget(),
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

/**
 * Build the handler under test.
 *
 * The hourly allowance rides on `deps` and is therefore shared by every handler
 * built from the same deps — which is the production property (one budget per
 * install, handed to every session) and the one a test has to be able to drive
 * both ways.
 *
 * @param deps - The tool dependencies under test.
 * @param identity - Who is calling; the registered agent unless a test says otherwise.
 */
function makeHandler(deps: McpToolDeps, identity: SenderIdentity = NOTIFY) {
  return createRelayNotifyUserHandler(deps, identity);
}

describe('relay_notify_user', () => {
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
    const handler = makeHandler(deps);
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
    const handler = makeHandler(deps, ANON);
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
    const handler = makeHandler(deps);
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
    const handler = makeHandler(deps);
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
    const handler = makeHandler(deps);
    const result = await handler({ message: 'Hello' });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('SEND_FAILED');
    expect(data.error).toContain('Network error');
  });

  it('returns RELAY_DISABLED when relayCore is undefined', async () => {
    const deps = makeMockDeps({ relayCore: undefined });
    const handler = makeHandler(deps);
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
    const handler = makeHandler(deps);
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
    const handler = makeHandler(deps);
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
        bindingRouter: makeMockBindingRouter({
          getSessionsByBinding: vi.fn().mockReturnValue([]),
        }) as unknown as McpToolDeps['bindingRouter'],
        notifyDm,
      });
      const handler = makeHandler(deps);
      const result = await handler({ message: 'Nobody has messaged the bot yet.' });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).surface).toBe('dorkos-dm');
    });

    it('leaves the external path untouched when an integration can carry it', async () => {
      const notifyDm = makeMockNotifyDm();
      const deps = makeMockDeps({ notifyDm });
      const handler = makeHandler(deps);
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
      const handler = makeHandler(deps);
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
      const handler = makeHandler(deps);
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
      const handler = makeHandler(deps);
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
      const handler = makeHandler(deps);
      const result = await handler({ message: 'Nowhere to go.' });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).code).toBe('NO_BINDING');
    });
  });

  // DOR-1265. This verb stopped asking a person's permission, because the card it
  // raised in a room turn was a card nobody was watching — so the hourly count is
  // now the only thing between a looping agent and somebody's evening. It is a
  // MECHANISM rather than a line in a prompt, per `.claude/rules/room-conduct.md`.
  describe('the hourly note ceiling (DOR-1265)', () => {
    /** The sentence an agent gets back, and the one it can act on. */
    const SPENT = 'You have sent as many notes as you can for now — say it here instead, or wait.';

    /** A second registered agent, for the isolation case. */
    const OTHER: SenderIdentity = { subject: 'relay.agent.ns.agent-2', agentId: 'agent-2' };

    /** A budget on a clock the test moves, so an hour costs no wall time. */
    function budgetOnAClock(limit: number) {
      let clock = 1_000_000;
      return {
        budget: new NotifyBudget({ limit: () => limit, now: () => clock }),
        advance: (ms: number) => {
          clock += ms;
        },
      };
    }

    it('sends up to the ceiling and then says so in words the agent can act on', async () => {
      const { budget } = budgetOnAClock(2);
      const deps = makeMockDeps({ notifyBudget: budget });
      const handler = makeHandler(deps);

      expect(JSON.parse((await handler({ message: 'one' })).content[0].text).sent).toBe(true);
      expect(JSON.parse((await handler({ message: 'two' })).content[0].text).sent).toBe(true);

      const refused = await handler({ message: 'three' });
      expect(refused.isError).toBe(true);
      const data = JSON.parse(refused.content[0].text);
      expect(data.sent).toBe(false);
      expect(data.code).toBe('NOTIFY_RATE_LIMITED');
      expect(data.error).toBe(SPENT);
      // The refused note reached nobody: two publishes, not three.
      expect(deps.relayCore!.publish).toHaveBeenCalledTimes(2);
    });

    it('caps the DorkOS DM the same way it caps a connected chat app', async () => {
      // The fallback surface is the one a stock install actually uses, so a cap
      // that only counted the integration path would bound almost nobody.
      const notifyDm = makeMockNotifyDm();
      const { budget } = budgetOnAClock(1);
      const deps = makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi.fn().mockReturnValue([]),
        }) as unknown as McpToolDeps['bindingStore'],
        notifyDm,
        notifyBudget: budget,
      });
      const handler = makeHandler(deps);

      expect(JSON.parse((await handler({ message: 'one' })).content[0].text).surface).toBe(
        'dorkos-dm'
      );
      const refused = await handler({ message: 'two' });
      expect(JSON.parse(refused.content[0].text).code).toBe('NOTIFY_RATE_LIMITED');
      expect(notifyDm.rooms.post).toHaveBeenCalledTimes(1);
    });

    it('gives the allowance back as the hour rolls off', async () => {
      const { budget, advance } = budgetOnAClock(1);
      const deps = makeMockDeps({ notifyBudget: budget });
      const handler = makeHandler(deps);

      await handler({ message: 'one' });
      expect(JSON.parse((await handler({ message: 'two' })).content[0].text).code).toBe(
        'NOTIFY_RATE_LIMITED'
      );

      advance(60 * 60_000 + 1_000);
      expect(JSON.parse((await handler({ message: 'later' })).content[0].text).sent).toBe(true);
    });

    it('spends one agent’s allowance and never another’s', async () => {
      // Both agents have a chat of their own to notify through, so the only thing
      // that can stop the second one is the first one's spending.
      const { budget } = budgetOnAClock(1);
      const deps = makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi
            .fn()
            .mockReturnValue([makeBinding(), makeBinding({ id: 'b-2', agentId: 'agent-2' })]),
        }) as unknown as McpToolDeps['bindingStore'],
        notifyBudget: budget,
      });
      const ana = makeHandler(deps, NOTIFY);
      const bo = makeHandler(deps, OTHER);

      await ana({ message: 'mine' });
      expect(JSON.parse((await ana({ message: 'again' })).content[0].text).code).toBe(
        'NOTIFY_RATE_LIMITED'
      );
      expect(JSON.parse((await bo({ message: 'mine too' })).content[0].text).sent).toBe(true);
    });

    it('charges nothing for a call that was going to be refused anyway', async () => {
      // Somebody turned "Agent can start conversations" off. The agent should not
      // also lose a note off its hour for a message that never left the machine.
      const { budget } = budgetOnAClock(1);
      const deps = makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi.fn().mockReturnValue([makeBinding({ canInitiate: false })]),
        }) as unknown as McpToolDeps['bindingStore'],
        notifyBudget: budget,
      });
      const handler = makeHandler(deps);

      expect(JSON.parse((await handler({ message: 'blocked' })).content[0].text).code).toBe(
        'INITIATE_NOT_ALLOWED'
      );
      // No card was raised for it either: the auto-allow does not mean the tool
      // does whatever it is asked, it means the ANSWER comes from the binding the
      // operator configured rather than from a prompt nobody sees.
      // The whole allowance is still there for a message that can actually go.
      expect(budget.tryReserve('agent-1')).toBe(true);
    });

    it('charges nothing for a note the DM could not deliver', async () => {
      // The stock-install failure: the mesh cannot place the sending agent, so
      // `deliverNotifyDm` refuses and nobody is written to. Charging for those
      // would spend the whole hour on notes that reached no one and then report
      // it back as "you have been too chatty" — the honest diagnosis replaced by
      // a wrong one.
      const notifyDm = makeMockNotifyDm({
        mesh: {
          getProjectPath: vi.fn().mockReturnValue(undefined),
          get: vi.fn().mockReturnValue(undefined),
        },
      });
      const { budget } = budgetOnAClock(3);
      const deps = makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi.fn().mockReturnValue([]),
        }) as unknown as McpToolDeps['bindingStore'],
        notifyDm,
        notifyBudget: budget,
      });
      const handler = makeHandler(deps);

      for (const message of ['one', 'two', 'three']) {
        const result = await handler({ message });
        // The old non-delivery, unchanged — never the rate-limit sentence.
        expect(JSON.parse(result.content[0].text).code).toBe('NO_BINDING');
      }

      // Nothing landed, so nothing was spent: the full allowance is intact for
      // the moment the mesh can place this agent again.
      expect([1, 2, 3].map(() => budget.tryReserve('agent-1'))).toEqual([true, true, true]);
    });

    it('is one allowance per install, not one per session', async () => {
      // The mutation this kills: constructing a budget alongside the handlers.
      // The `dorkos` tool server is rebuilt per session, so a per-handler budget
      // is a ceiling an agent resets by opening a new session — and every test
      // above would still pass. Two handlers off one deps object is exactly what
      // two sessions on one install get (`index.ts` builds `mcpToolDeps` once and
      // hands the same object to every `createDorkOsToolServer`).
      const { budget } = budgetOnAClock(1);
      const deps = makeMockDeps({ notifyBudget: budget });

      const firstSession = makeHandler(deps);
      const secondSession = makeHandler(deps);

      expect(JSON.parse((await firstSession({ message: 'one' })).content[0].text).sent).toBe(true);
      expect(JSON.parse((await secondSession({ message: 'two' })).content[0].text).code).toBe(
        'NOTIFY_RATE_LIMITED'
      );
    });
  });

  // DOR-1265, and the correction to how the auto-allow was first written up. It
  // is NOT true that a note can only reach the operator: it goes wherever the
  // operator already pointed it, and a claimed chat may hold other people. What
  // the auto-allow removed is the per-call card an operator watching a DIRECT
  // session could have denied — the same trade DOR-1229 made for the room verbs.
  // What it did not remove is the setup consent: `canInitiate` defaults false, so
  // nothing reaches any external chat until a person switches it on for that
  // binding.
  describe('where a note can actually land (DOR-1265)', () => {
    it('reaches a GROUP chat, because claiming one and switching initiating on is how a person asks for that', async () => {
      // Groups are claimable (`bridgeChatTypeForBinding` maps group/supergroup to
      // `channelType: 'group'`), and nothing downstream of the claim treats a
      // group binding differently — `resolveNotifyTarget` never reads
      // `channelType`. So the note lands in a room with other people in it. That
      // is the operator's own prior decision, made twice: once to claim the chat
      // for this agent, once to allow it to start conversations there.
      const deps = makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi
            .fn()
            .mockReturnValue([makeBinding({ channelType: 'group', canInitiate: true })]),
        }) as unknown as McpToolDeps['bindingStore'],
      });
      const handler = makeHandler(deps);
      const result = await handler({ message: 'The deploy finished.' });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).sent).toBe(true);
      expect(deps.relayCore!.publish).toHaveBeenCalledWith(
        'relay.human.telegram.tg-main.chat-42',
        'The deploy finished.',
        { from: 'relay.agent.ns.agent-1' }
      );
    });

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
        bindingStore: makeMockBindingStore({
          getAll: vi.fn().mockReturnValue([fresh]),
        }) as unknown as McpToolDeps['bindingStore'],
      });
      const handler = makeHandler(deps);
      const result = await handler({ message: 'Should never arrive' });

      expect(JSON.parse(result.content[0].text).code).toBe('INITIATE_NOT_ALLOWED');
      expect(deps.relayCore!.publish).not.toHaveBeenCalled();
    });
  });

  // DOR-1265. The gate that lets this call through and the tool that runs it ask
  // DIFFERENT questions of DIFFERENT stores, and the gap between them is a real
  // (harmless, but real) behaviour worth pinning rather than assuming away.
  //
  // - The gate (`createCanUseTool` → `createInSessionContextResolver` →
  //   `AgentIdentityService.describeAgent`) reads an unrevoked row in
  //   `agent_identity_tokens`, keyed on the session's cwd.
  // - The tool (`resolveSenderIdentity` → `meshCore.getSubjectByPath`) reads the
  //   MESH registry, keyed on the same cwd. It has to: the relay `from` is an
  //   authorization principal that ACL rules match on, and only the mesh knows
  //   the agent's canonical subject.
  //
  // Two stores, one key. Where they disagree the gate is the permissive one, so
  // the failure is a turn that proceeds and gets a structured NOT_AN_AGENT back
  // rather than anything reaching a person. Unifying them is not a small change
  // (it would mean giving the gate a mesh dependency, or the tool a subject it
  // cannot use), so the divergence is documented and pinned instead.
  describe('the gate and the tool resolve identity from different stores (DOR-1265)', () => {
    it('lets the call through on a token identity and then answers NOT_AN_AGENT when the mesh cannot place it', async () => {
      const session = {
        permissionMode: 'default' as const,
        pendingInteractions: new Map(),
        eventQueue: [],
        eventQueueNotify: vi.fn(),
        cwd: '/agents/ana',
      };
      // The gate's half: a live token for this directory, so no card is raised.
      const canUseTool = createCanUseTool(
        session,
        { debug: () => {}, info: () => {} },
        undefined,
        () => Promise.resolve({ identity: { agentPath: '/agents/ana' } })
      );
      const verdict = await canUseTool(
        'mcp__dorkos__relay_notify_user',
        { message: 'the deploy finished' },
        { signal: new AbortController().signal, toolUseID: 'notify-1' }
      );
      expect(verdict).toEqual({
        behavior: 'allow',
        updatedInput: { message: 'the deploy finished' },
      });
      expect(session.eventQueue).toHaveLength(0);

      // The tool's half, resolved for real rather than hand-written: the mesh
      // does not place this directory, so there is no `agentId` to send as.
      const deps = makeMockDeps({
        meshCore: {
          getSubjectByPath: vi.fn().mockReturnValue(undefined),
        } as unknown as McpToolDeps['meshCore'],
      });
      const identity = resolveSenderIdentity(deps, session.cwd);
      expect(identity.agentId).toBeUndefined();

      const result = await createRelayNotifyUserHandler(
        deps,
        identity
      )({
        message: 'the deploy finished',
      });
      expect(JSON.parse(result.content[0].text).code).toBe('NOT_AN_AGENT');
      expect(deps.relayCore!.publish).not.toHaveBeenCalled();
    });

    it('agrees with the gate when the mesh does place the directory, which is the room-turn case', async () => {
      // A room turn hands the addressed agent's own directory to the session
      // (`room-turn-runner.ts`), and that agent is in the mesh by construction —
      // it was dispatched to because it is registered. So the two lookups agree
      // wherever this fix was meant to work.
      const deps = makeMockDeps({
        meshCore: {
          getSubjectByPath: vi
            .fn()
            .mockReturnValue({ subject: 'relay.agent.ns.agent-1', agentId: 'agent-1' }),
        } as unknown as McpToolDeps['meshCore'],
      });
      const identity = resolveSenderIdentity(deps, '/agents/ana');
      expect(identity.agentId).toBe('agent-1');

      const result = await createRelayNotifyUserHandler(deps, identity)({ message: 'done' });
      expect(JSON.parse(result.content[0].text).sent).toBe(true);
    });
  });

  describe('canInitiate enforcement (DOR-239)', () => {
    it('blocks the send when the resolved binding has canInitiate=false', async () => {
      const deps = makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi.fn().mockReturnValue([makeBinding({ canInitiate: false })]),
        }) as unknown as McpToolDeps['bindingStore'],
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
      // Nothing should have been published to the channel.
      expect(deps.relayCore!.publish).not.toHaveBeenCalled();
    });

    it('excludes paused bindings entirely (enabled=false never routes a notify)', async () => {
      const deps = makeMockDeps({
        bindingStore: makeMockBindingStore({
          getAll: vi.fn().mockReturnValue([makeBinding({ canInitiate: true, enabled: false })]),
        }) as unknown as McpToolDeps['bindingStore'],
      });
      const handler = makeHandler(deps);
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
      const handler = makeHandler(deps);
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
      const handler = makeHandler(deps);
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
      const handler = makeHandler(deps);
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
      const handler = makeHandler(deps);
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
