import { describe, it, expect, vi } from 'vitest';
import {
  createBindingListHandler,
  createBindingCreateHandler,
  createBindingDeleteHandler,
  createDorkOsToolServer,
  type McpToolDeps,
} from '../../runtimes/claude-code/mcp-tools/index.js';
import { createBindingListSessionsHandler } from '../../runtimes/claude-code/mcp-tools/binding-tools.js';

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config: Record<string, unknown>) => config),
  tool: vi.fn(
    (
      name: string,
      desc: string,
      schema: Record<string, unknown>,
      handler: (...args: unknown[]) => unknown
    ) => ({
      name,
      description: desc,
      schema,
      handler,
    })
  ),
}));

/** Passthrough shape returned by mocked createSdkMcpServer */
interface MockServer {
  name: string;
  version: string;
  tools: { name: string; description: string }[];
}

/** Create a mock BindingStore with default stubs. */
function makeMockBindingStore(overrides?: Record<string, unknown>) {
  return {
    getAll: vi.fn().mockReturnValue([
      {
        id: 'b-1',
        adapterId: 'tg-main',
        agentId: 'agent-1',
        sessionStrategy: 'per-chat',
        label: 'Main Bot',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
    create: vi.fn().mockResolvedValue({
      id: 'b-new',
      adapterId: 'tg-main',
      agentId: 'agent-2',
      sessionStrategy: 'per-chat',
      label: '',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    }),
    delete: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeMockDeps(
  bindingStore?: ReturnType<typeof makeMockBindingStore> | undefined
): McpToolDeps {
  return {
    transcriptReader: {} as McpToolDeps['transcriptReader'],
    defaultCwd: '/test',
    bindingStore: bindingStore as unknown as McpToolDeps['bindingStore'],
  };
}

describe('Binding MCP Tools', () => {
  describe('binding_list', () => {
    it('returns BINDINGS_DISABLED when bindingStore is undefined', async () => {
      const handler = createBindingListHandler(makeMockDeps());
      const result = await handler();
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'BINDINGS_DISABLED' });
    });

    it('lists bindings with count', async () => {
      const store = makeMockBindingStore();
      const handler = createBindingListHandler(makeMockDeps(store));
      const result = await handler();
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(1);
      expect(data.bindings[0].id).toBe('b-1');
      expect(data.bindings[0].adapterId).toBe('tg-main');
      expect(store.getAll).toHaveBeenCalledOnce();
    });

    it('returns empty list when no bindings exist', async () => {
      const store = makeMockBindingStore({ getAll: vi.fn().mockReturnValue([]) });
      const handler = createBindingListHandler(makeMockDeps(store));
      const result = await handler();
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(0);
      expect(data.bindings).toEqual([]);
    });
  });

  describe('binding_create', () => {
    it('returns BINDINGS_DISABLED when bindingStore is undefined', async () => {
      const handler = createBindingCreateHandler(makeMockDeps());
      const result = await handler({ adapterId: 'x', agentId: 'y' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'BINDINGS_DISABLED' });
    });

    it('creates binding successfully', async () => {
      const store = makeMockBindingStore();
      const handler = createBindingCreateHandler(makeMockDeps(store));
      const result = await handler({
        adapterId: 'tg-main',
        agentId: 'agent-2',
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.binding.id).toBe('b-new');
      expect(data.binding.adapterId).toBe('tg-main');
      expect(store.create).toHaveBeenCalledWith(
        expect.objectContaining({
          adapterId: 'tg-main',
          agentId: 'agent-2',
          sessionStrategy: 'per-chat',
          label: '',
        })
      );
    });

    it('passes optional fields to create', async () => {
      const store = makeMockBindingStore();
      const handler = createBindingCreateHandler(makeMockDeps(store));
      await handler({
        adapterId: 'tg-main',
        agentId: 'agent-2',
        sessionStrategy: 'stateless',
        chatId: 'chat-123',
        channelType: 'dm',
        label: 'My Binding',
      });
      expect(store.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionStrategy: 'stateless',
          chatId: 'chat-123',
          channelType: 'dm',
          label: 'My Binding',
        })
      );
    });

    it('returns BINDING_CREATE_FAILED on error', async () => {
      const store = makeMockBindingStore({
        create: vi.fn().mockRejectedValue(new Error('Validation failed')),
      });
      const handler = createBindingCreateHandler(makeMockDeps(store));
      const result = await handler({ adapterId: 'x', agentId: 'y' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.code).toBe('BINDING_CREATE_FAILED');
      expect(data.error).toContain('Validation failed');
    });
  });

  describe('binding_delete', () => {
    it('returns BINDINGS_DISABLED when bindingStore is undefined', async () => {
      const handler = createBindingDeleteHandler(makeMockDeps());
      const result = await handler({ id: 'b-1' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'BINDINGS_DISABLED' });
    });

    it('returns Deleted on success', async () => {
      const store = makeMockBindingStore();
      const handler = createBindingDeleteHandler(makeMockDeps(store));
      const result = await handler({ id: 'b-1' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.result).toBe('Deleted');
      expect(data.id).toBe('b-1');
      expect(store.delete).toHaveBeenCalledWith('b-1');
    });

    it('returns Not found when id does not exist', async () => {
      const store = makeMockBindingStore({
        delete: vi.fn().mockResolvedValue(false),
      });
      const handler = createBindingDeleteHandler(makeMockDeps(store));
      const result = await handler({ id: 'nonexistent' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.result).toBe('Not found');
      expect(data.id).toBe('nonexistent');
    });
  });

  describe('binding_list_sessions', () => {
    const TEST_SESSIONS = [
      { key: 'b-1:user1:chat-abc', bindingId: 'b-1', chatId: 'chat-abc', sessionId: 'sess-1' },
      { key: 'b-1:user2:chat-xyz', bindingId: 'b-1', chatId: 'chat-xyz', sessionId: 'sess-2' },
    ];

    function makeMockBindingRouter(overrides?: Record<string, unknown>) {
      return {
        getSessionsByBinding: vi
          .fn()
          .mockReturnValue(
            TEST_SESSIONS.map(({ key, chatId, sessionId }) => ({ key, chatId, sessionId }))
          ),
        getAllSessions: vi.fn().mockReturnValue(TEST_SESSIONS),
        ...overrides,
      };
    }

    function makeMockAdapterManager(overrides?: Record<string, unknown>) {
      return {
        listAdapters: vi
          .fn()
          .mockReturnValue([{ config: { id: 'tg-main', type: 'telegram' }, status: 'connected' }]),
        ...overrides,
      };
    }

    function makeSessionDeps(
      opts: {
        bindingStore?: ReturnType<typeof makeMockBindingStore>;
        bindingRouter?: ReturnType<typeof makeMockBindingRouter>;
        adapterManager?: ReturnType<typeof makeMockAdapterManager>;
      } = {}
    ): McpToolDeps {
      return {
        transcriptReader: {} as McpToolDeps['transcriptReader'],
        defaultCwd: '/test',
        bindingStore: opts.bindingStore as unknown as McpToolDeps['bindingStore'],
        bindingRouter: opts.bindingRouter as unknown as McpToolDeps['bindingRouter'],
        adapterManager: opts.adapterManager as unknown as McpToolDeps['adapterManager'],
      };
    }

    it('returns enriched sessions with pre-computed relay subject', async () => {
      const store = makeMockBindingStore({
        getById: vi.fn().mockReturnValue({ adapterId: 'tg-main' }),
      });
      const router = makeMockBindingRouter();
      const adapterMgr = makeMockAdapterManager();
      const handler = createBindingListSessionsHandler(
        makeSessionDeps({ bindingStore: store, bindingRouter: router, adapterManager: adapterMgr })
      );

      const result = await handler({});
      const data = JSON.parse(result.content[0].text);

      expect(result.isError).toBeUndefined();
      expect(data.count).toBe(2);
      expect(data.sessions[0]).toMatchObject({
        bindingId: 'b-1',
        adapterId: 'tg-main',
        adapterType: 'telegram',
        chatId: 'chat-abc',
        sessionId: 'sess-1',
        subject: 'relay.human.telegram.tg-main.chat-abc',
      });
    });

    it('filters by bindingId when provided (calls getSessionsByBinding)', async () => {
      const store = makeMockBindingStore({
        getById: vi.fn().mockReturnValue({ adapterId: 'tg-main' }),
      });
      const router = makeMockBindingRouter();
      const adapterMgr = makeMockAdapterManager();
      const handler = createBindingListSessionsHandler(
        makeSessionDeps({ bindingStore: store, bindingRouter: router, adapterManager: adapterMgr })
      );

      await handler({ bindingId: 'b-1' });

      expect(router.getSessionsByBinding).toHaveBeenCalledWith('b-1');
      expect(router.getAllSessions).not.toHaveBeenCalled();
    });

    it('returns all sessions when bindingId omitted (calls getAllSessions)', async () => {
      const store = makeMockBindingStore({
        getById: vi.fn().mockReturnValue({ adapterId: 'tg-main' }),
      });
      const router = makeMockBindingRouter();
      const adapterMgr = makeMockAdapterManager();
      const handler = createBindingListSessionsHandler(
        makeSessionDeps({ bindingStore: store, bindingRouter: router, adapterManager: adapterMgr })
      );

      await handler({});

      expect(router.getAllSessions).toHaveBeenCalledOnce();
      expect(router.getSessionsByBinding).not.toHaveBeenCalled();
    });

    it('returns BINDINGS_DISABLED error when bindingRouter is undefined', async () => {
      const store = makeMockBindingStore();
      const handler = createBindingListSessionsHandler(makeSessionDeps({ bindingStore: store }));

      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'BINDINGS_DISABLED' });
    });

    it('returns BINDINGS_DISABLED error when bindingStore is undefined', async () => {
      const router = makeMockBindingRouter();
      const handler = createBindingListSessionsHandler(makeSessionDeps({ bindingRouter: router }));

      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'BINDINGS_DISABLED' });
    });

    it('subject follows pattern relay.human.{adapterType}.{adapterId}.{chatId}', async () => {
      const store = makeMockBindingStore({
        getById: vi.fn().mockReturnValue({ adapterId: 'slack-eng' }),
      });
      const router = makeMockBindingRouter({
        getAllSessions: vi
          .fn()
          .mockReturnValue([
            { key: 'b-2:u1:general', bindingId: 'b-2', chatId: 'general', sessionId: 'sess-10' },
          ]),
      });
      const adapterMgr = makeMockAdapterManager({
        listAdapters: vi
          .fn()
          .mockReturnValue([{ config: { id: 'slack-eng', type: 'slack' }, status: 'connected' }]),
      });
      const handler = createBindingListSessionsHandler(
        makeSessionDeps({ bindingStore: store, bindingRouter: router, adapterManager: adapterMgr })
      );

      const result = await handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.sessions[0].subject).toBe('relay.human.slack.slack-eng.general');
    });

    it('returns empty sessions array when no sessions exist', async () => {
      const store = makeMockBindingStore();
      const router = makeMockBindingRouter({
        getAllSessions: vi.fn().mockReturnValue([]),
      });
      const adapterMgr = makeMockAdapterManager();
      const handler = createBindingListSessionsHandler(
        makeSessionDeps({ bindingStore: store, bindingRouter: router, adapterManager: adapterMgr })
      );

      const result = await handler({});
      const data = JSON.parse(result.content[0].text);

      expect(result.isError).toBeUndefined();
      expect(data.count).toBe(0);
      expect(data.sessions).toEqual([]);
    });
  });

  describe('tool registration', () => {
    it('includes binding tools when bindingStore is provided', () => {
      const store = makeMockBindingStore();
      const server = createDorkOsToolServer(makeMockDeps(store)) as unknown as MockServer;
      const toolNames = server.tools.map((t) => t.name);
      expect(toolNames).toContain('binding_list');
      expect(toolNames).toContain('binding_create');
      expect(toolNames).toContain('binding_delete');
    });

    it('excludes binding tools when bindingStore is undefined', () => {
      const server = createDorkOsToolServer(makeMockDeps()) as unknown as MockServer;
      const toolNames = server.tools.map((t) => t.name);
      expect(toolNames).not.toContain('binding_list');
      expect(toolNames).not.toContain('binding_create');
      expect(toolNames).not.toContain('binding_delete');
    });
  });
});
