import { describe, it, expect, vi } from 'vitest';
import {
  createRelayNotifyUserHandler,
  type McpToolDeps,
} from '../../runtimes/claude-code/mcp-tools/index.js';

/** Minimal binding shape matching AdapterBinding fields used by the handler. */
function makeBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b-1',
    adapterId: 'tg-main',
    agentId: 'agent-1',
    sessionStrategy: 'per-chat',
    label: 'Main Bot',
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
    getSessionsByBinding: vi
      .fn()
      .mockReturnValue([{ key: 'b-1:chat-42', chatId: 'chat-42', sessionId: 'sess-1' }]),
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
    ...overrides,
  };
}

describe('relay_notify_user', () => {
  it('sends to most recently active chat when channel omitted', async () => {
    const deps = makeMockDeps();
    const handler = createRelayNotifyUserHandler(deps);
    const result = await handler({ message: 'Hello user', agentId: 'agent-1' });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.sent).toBe(true);
    expect(data.adapterId).toBe('tg-main');
    expect(data.chatId).toBe('chat-42');
    expect(data.messageId).toBe('msg-1');
    expect(data.subject).toBe('relay.human.telegram.tg-main.chat-42');
    expect(deps.relayCore!.publish).toHaveBeenCalledWith(
      'relay.human.telegram.tg-main.chat-42',
      'Hello user',
      { from: 'agent-1' }
    );
  });

  it('filters by channel when specified (adapter ID match)', async () => {
    const bindings = [
      makeBinding({ id: 'b-1', adapterId: 'tg-main', agentId: 'agent-1' }),
      makeBinding({ id: 'b-2', adapterId: 'slack-main', agentId: 'agent-1' }),
    ];
    const deps = makeMockDeps({
      bindingStore: makeMockBindingStore({
        getAll: vi.fn().mockReturnValue(bindings),
      }) as unknown as McpToolDeps['bindingStore'],
      bindingRouter: makeMockBindingRouter({
        getSessionsByBinding: vi.fn().mockImplementation((bindingId: string) => {
          if (bindingId === 'b-2')
            return [{ key: 'b-2:chat-99', chatId: 'chat-99', sessionId: 'sess-2' }];
          return [];
        }),
      }) as unknown as McpToolDeps['bindingRouter'],
    });
    const handler = createRelayNotifyUserHandler(deps);
    const result = await handler({
      message: 'Slack message',
      channel: 'slack-main',
      agentId: 'agent-1',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.sent).toBe(true);
    expect(data.adapterId).toBe('slack-main');
    expect(data.chatId).toBe('chat-99');
  });

  it('filters by channel when specified (adapter type match)', async () => {
    const bindings = [
      makeBinding({ id: 'b-1', adapterId: 'tg-lifeos', agentId: 'agent-1' }),
      makeBinding({ id: 'b-2', adapterId: 'slack-ops', agentId: 'agent-1' }),
    ];
    const deps = makeMockDeps({
      bindingStore: makeMockBindingStore({
        getAll: vi.fn().mockReturnValue(bindings),
      }) as unknown as McpToolDeps['bindingStore'],
      bindingRouter: makeMockBindingRouter({
        getSessionsByBinding: vi.fn().mockImplementation((bindingId: string) => {
          if (bindingId === 'b-1')
            return [{ key: 'b-1:chat-77', chatId: 'chat-77', sessionId: 'sess-3' }];
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
    const handler = createRelayNotifyUserHandler(deps);
    // Use type name "telegram" which doesn't directly match adapter IDs
    const result = await handler({
      message: 'Telegram via type',
      channel: 'telegram',
      agentId: 'agent-1',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.sent).toBe(true);
    expect(data.adapterId).toBe('tg-lifeos');
    expect(data.chatId).toBe('chat-77');
  });

  it('returns MISSING_AGENT_ID when agentId not provided', async () => {
    const deps = makeMockDeps();
    const handler = createRelayNotifyUserHandler(deps);
    const result = await handler({ message: 'Hello' } as Parameters<typeof handler>[0]);

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('MISSING_AGENT_ID');
  });

  it('returns NO_BINDING with availableChannels when no matching binding', async () => {
    const deps = makeMockDeps({
      bindingStore: makeMockBindingStore({
        getAll: vi
          .fn()
          .mockReturnValue([makeBinding({ id: 'b-1', adapterId: 'tg-main', agentId: 'agent-1' })]),
      }) as unknown as McpToolDeps['bindingStore'],
      adapterManager: makeMockAdapterManager({
        listAdapters: vi.fn().mockReturnValue([]),
      }) as unknown as McpToolDeps['adapterManager'],
    });
    const handler = createRelayNotifyUserHandler(deps);
    const result = await handler({
      message: 'Hello',
      channel: 'nonexistent',
      agentId: 'agent-1',
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
    const handler = createRelayNotifyUserHandler(deps);
    const result = await handler({ message: 'Hello', agentId: 'agent-1' });

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
    const handler = createRelayNotifyUserHandler(deps);
    const result = await handler({ message: 'Hello', agentId: 'agent-1' });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('SEND_FAILED');
    expect(data.error).toContain('Network error');
  });

  it('returns RELAY_DISABLED when relayCore is undefined', async () => {
    const deps = makeMockDeps({ relayCore: undefined });
    const handler = createRelayNotifyUserHandler(deps);
    const result = await handler({ message: 'Hello', agentId: 'agent-1' });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('RELAY_DISABLED');
  });

  it('returns BINDINGS_DISABLED when bindingRouter/bindingStore undefined', async () => {
    const deps = makeMockDeps({
      bindingRouter: undefined,
      bindingStore: undefined,
    });
    const handler = createRelayNotifyUserHandler(deps);
    const result = await handler({ message: 'Hello', agentId: 'agent-1' });

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
    const handler = createRelayNotifyUserHandler(deps);
    const result = await handler({ message: 'Done!', agentId: 'agent-1' });

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
});
