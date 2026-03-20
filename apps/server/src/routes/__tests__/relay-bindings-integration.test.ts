/**
 * Integration tests for binding CRUD roundtrip, multi-instance adapters,
 * and observed chats pipeline.
 *
 * These tests exercise multi-step flows where state persists across
 * sequential HTTP requests, verifying end-to-end data integrity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRelayRouter } from '../relay.js';
import type { RelayCore } from '@dorkos/relay';
import { AdapterError, type AdapterManager } from '../../services/relay/adapter-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRelayCore(): RelayCore {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
    listMessages: vi.fn().mockReturnValue({ messages: [], nextCursor: undefined }),
    getMessage: vi.fn().mockReturnValue(null),
    listEndpoints: vi.fn().mockReturnValue([]),
    registerEndpoint: vi.fn().mockResolvedValue({
      subject: 'relay.test.endpoint',
      hash: 'abc123',
      maildirPath: '/tmp/maildir/abc123',
    }),
    unregisterEndpoint: vi.fn().mockResolvedValue(true),
    readInbox: vi.fn().mockReturnValue({ messages: [], nextCursor: undefined }),
    getDeadLetters: vi.fn().mockResolvedValue([]),
    getMetrics: vi.fn().mockReturnValue({ totalMessages: 0, byStatus: {}, bySubject: [] }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    onSignal: vi.fn().mockReturnValue(() => {}),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as RelayCore;
}

/**
 * In-memory binding store that persists state across requests within a test.
 *
 * Unlike the unit test mocks that return fixed values, this store tracks
 * actual state so CRUD roundtrip tests can verify data integrity.
 */
function createStatefulBindingStore() {
  const bindings = new Map<
    string,
    {
      id: string;
      adapterId: string;
      agentId: string;
      sessionStrategy: string;
      label: string;
      chatId?: string;
      channelType?: string;
      createdAt: string;
      updatedAt: string;
    }
  >();

  return {
    getAll: vi.fn(() => Array.from(bindings.values())),
    getById: vi.fn((id: string) => bindings.get(id)),
    create: vi.fn(async (input: Record<string, unknown>) => {
      const id = `b-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const now = new Date().toISOString();
      const binding = {
        id,
        adapterId: input.adapterId as string,
        agentId: input.agentId as string,
        sessionStrategy: (input.sessionStrategy as string) ?? 'per-chat',
        label: (input.label as string) ?? '',
        ...(input.chatId !== undefined ? { chatId: input.chatId as string } : {}),
        ...(input.channelType !== undefined ? { channelType: input.channelType as string } : {}),
        createdAt: now,
        updatedAt: now,
      };
      bindings.set(id, binding);
      return binding;
    }),
    update: vi.fn(async (id: string, updates: Record<string, unknown>) => {
      const existing = bindings.get(id);
      if (!existing) return undefined;
      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      };
      bindings.set(id, updated);
      return updated;
    }),
    delete: vi.fn(async (id: string) => {
      return bindings.delete(id);
    }),
  };
}

function createMockAdapterManager(overrides?: Partial<AdapterManager>): AdapterManager {
  return {
    listAdapters: vi.fn().mockReturnValue([]),
    getAdapter: vi.fn().mockReturnValue(undefined),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    getRegistry: vi.fn().mockReturnValue({ get: vi.fn() }),
    getCatalog: vi.fn().mockReturnValue([]),
    addAdapter: vi.fn().mockResolvedValue(undefined),
    removeAdapter: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
    getBindingStore: vi.fn().mockReturnValue(undefined),
    getBindingRouter: vi.fn().mockReturnValue(undefined),
    ...overrides,
  } as unknown as AdapterManager;
}

function createTestApp(adapterManager?: AdapterManager, traceStore?: unknown): express.Application {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/relay',
    createRelayRouter(
      createMockRelayCore() as unknown as RelayCore,
      adapterManager as AdapterManager | undefined,
      traceStore as never
    )
  );
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    }
  );
  return app;
}

// ---------------------------------------------------------------------------
// Binding CRUD Roundtrip
// ---------------------------------------------------------------------------

describe('Binding CRUD roundtrip', () => {
  let app: express.Application;
  let bindingStore: ReturnType<typeof createStatefulBindingStore>;

  beforeEach(() => {
    bindingStore = createStatefulBindingStore();
    const adapterManager = createMockAdapterManager({
      getBindingStore: vi.fn().mockReturnValue(bindingStore) as never,
    });
    app = createTestApp(adapterManager);
  });

  it('creates, reads, updates, and deletes a binding', async () => {
    // 1. Create
    const createRes = await request(app)
      .post('/api/relay/bindings')
      .send({
        adapterId: 'telegram-1',
        agentId: 'agent-1',
        sessionStrategy: 'per-chat',
        label: 'Test binding',
      })
      .expect(201);

    const bindingId = createRes.body.binding.id;
    expect(bindingId).toBeDefined();
    expect(createRes.body.binding.label).toBe('Test binding');
    expect(createRes.body.binding.sessionStrategy).toBe('per-chat');

    // 2. Read
    const readRes = await request(app).get(`/api/relay/bindings/${bindingId}`).expect(200);
    expect(readRes.body.binding.label).toBe('Test binding');
    expect(readRes.body.binding.adapterId).toBe('telegram-1');

    // 3. Update via PATCH
    const updateRes = await request(app)
      .patch(`/api/relay/bindings/${bindingId}`)
      .send({
        sessionStrategy: 'stateless',
        label: 'Updated binding',
        chatId: '12345',
      })
      .expect(200);
    expect(updateRes.body.binding.sessionStrategy).toBe('stateless');
    expect(updateRes.body.binding.label).toBe('Updated binding');
    expect(updateRes.body.binding.chatId).toBe('12345');

    // 4. Verify update persisted
    const verifyRes = await request(app).get(`/api/relay/bindings/${bindingId}`).expect(200);
    expect(verifyRes.body.binding.sessionStrategy).toBe('stateless');
    expect(verifyRes.body.binding.label).toBe('Updated binding');
    expect(verifyRes.body.binding.chatId).toBe('12345');

    // 5. Delete
    await request(app).delete(`/api/relay/bindings/${bindingId}`).expect(200);

    // 6. Verify gone
    await request(app).get(`/api/relay/bindings/${bindingId}`).expect(404);
  });

  it('clears optional fields with null values', async () => {
    // Create with chatId and channelType set
    const createRes = await request(app)
      .post('/api/relay/bindings')
      .send({
        adapterId: 'telegram-1',
        agentId: 'agent-1',
        sessionStrategy: 'per-chat',
        label: '',
        chatId: '12345',
        channelType: 'dm',
      })
      .expect(201);

    const bindingId = createRes.body.binding.id;

    // Clear chatId with null
    const updateRes = await request(app)
      .patch(`/api/relay/bindings/${bindingId}`)
      .send({ chatId: null })
      .expect(200);

    // null should be converted to undefined for clearing
    expect(updateRes.body.binding.chatId).toBeUndefined();
    // channelType should remain unchanged
    expect(updateRes.body.binding.channelType).toBe('dm');
  });

  it('lists all bindings after multiple creates', async () => {
    // Create two bindings
    await request(app)
      .post('/api/relay/bindings')
      .send({
        adapterId: 'telegram-1',
        agentId: 'agent-1',
      })
      .expect(201);

    await request(app)
      .post('/api/relay/bindings')
      .send({
        adapterId: 'telegram-2',
        agentId: 'agent-2',
        sessionStrategy: 'stateless',
      })
      .expect(201);

    // List all
    const listRes = await request(app).get('/api/relay/bindings').expect(200);

    expect(listRes.body.bindings).toHaveLength(2);
    const adapterIds = listRes.body.bindings.map((b: { adapterId: string }) => b.adapterId);
    expect(adapterIds).toContain('telegram-1');
    expect(adapterIds).toContain('telegram-2');
  });

  it('rejects PATCH with invalid session strategy', async () => {
    const createRes = await request(app)
      .post('/api/relay/bindings')
      .send({
        adapterId: 'telegram-1',
        agentId: 'agent-1',
      })
      .expect(201);

    const bindingId = createRes.body.binding.id;

    // Invalid strategy
    await request(app)
      .patch(`/api/relay/bindings/${bindingId}`)
      .send({ sessionStrategy: 'invalid-strategy' })
      .expect(400);

    // Verify original value is unchanged
    const readRes = await request(app).get(`/api/relay/bindings/${bindingId}`).expect(200);
    expect(readRes.body.binding.sessionStrategy).toBe('per-chat');
  });

  it('returns 404 when updating a deleted binding', async () => {
    const createRes = await request(app)
      .post('/api/relay/bindings')
      .send({
        adapterId: 'telegram-1',
        agentId: 'agent-1',
      })
      .expect(201);

    const bindingId = createRes.body.binding.id;

    // Delete it
    await request(app).delete(`/api/relay/bindings/${bindingId}`).expect(200);

    // Try to update the deleted binding
    await request(app)
      .patch(`/api/relay/bindings/${bindingId}`)
      .send({ label: 'Ghost binding' })
      .expect(404);
  });
});

// ---------------------------------------------------------------------------
// Multi-Instance Adapter Flow
// ---------------------------------------------------------------------------

describe('Multi-instance adapter flow', () => {
  it('supports multiple Telegram adapter instances in catalog', async () => {
    const adapterManager = createMockAdapterManager({
      getCatalog: vi.fn().mockReturnValue([
        {
          manifest: {
            type: 'telegram',
            displayName: 'Telegram',
            description: 'Telegram bot adapter',
            category: 'messaging',
            builtin: true,
            multiInstance: true,
            configFields: [],
          },
          instances: [
            {
              id: 'telegram-1',
              enabled: true,
              label: '@bot_one',
              status: {
                state: 'connected',
                messageCount: { inbound: 10, outbound: 5 },
                errorCount: 0,
              },
              config: { token: '***', mode: 'polling' },
            },
            {
              id: 'telegram-2',
              enabled: true,
              label: '@bot_two',
              status: {
                state: 'connected',
                messageCount: { inbound: 3, outbound: 1 },
                errorCount: 0,
              },
              config: { token: '***', mode: 'polling' },
            },
          ],
        },
      ]) as never,
    });

    const app = createTestApp(adapterManager);

    // Verify catalog returns both instances under the Telegram entry
    const catalogRes = await request(app).get('/api/relay/adapters/catalog').expect(200);

    expect(catalogRes.body).toHaveLength(1);
    expect(catalogRes.body[0].manifest.type).toBe('telegram');
    expect(catalogRes.body[0].instances).toHaveLength(2);
    expect(catalogRes.body[0].instances[0].id).toBe('telegram-1');
    expect(catalogRes.body[0].instances[0].label).toBe('@bot_one');
    expect(catalogRes.body[0].instances[1].id).toBe('telegram-2');
    expect(catalogRes.body[0].instances[1].label).toBe('@bot_two');
  });

  it('adds a second Telegram adapter when multiInstance is true', async () => {
    const adapterManager = createMockAdapterManager();
    const app = createTestApp(adapterManager);

    // Add first Telegram adapter
    await request(app)
      .post('/api/relay/adapters')
      .send({ type: 'telegram', id: 'telegram-1', config: { token: 'token1' } })
      .expect(201);

    // Add second Telegram adapter (should succeed because multiInstance is true)
    await request(app)
      .post('/api/relay/adapters')
      .send({ type: 'telegram', id: 'telegram-2', config: { token: 'token2' } })
      .expect(201);

    expect(vi.mocked(adapterManager.addAdapter)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(adapterManager.addAdapter)).toHaveBeenCalledWith(
      'telegram',
      'telegram-1',
      { token: 'token1' },
      undefined,
      undefined
    );
    expect(vi.mocked(adapterManager.addAdapter)).toHaveBeenCalledWith(
      'telegram',
      'telegram-2',
      { token: 'token2' },
      undefined,
      undefined
    );
  });

  it('rejects second instance when multiInstance is false', async () => {
    const adapterManager = createMockAdapterManager();
    // First call succeeds, second call rejects
    vi.mocked(adapterManager.addAdapter)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new AdapterError(
          "Adapter type 'claude-code' does not support multiple instances",
          'MULTI_INSTANCE_DENIED'
        )
      );

    const app = createTestApp(adapterManager);

    // First instance succeeds
    await request(app)
      .post('/api/relay/adapters')
      .send({ type: 'claude-code', id: 'cc-1', config: {} })
      .expect(201);

    // Second instance rejected
    const res = await request(app)
      .post('/api/relay/adapters')
      .send({ type: 'claude-code', id: 'cc-2', config: {} })
      .expect(400);

    expect(res.body.code).toBe('MULTI_INSTANCE_DENIED');
  });

  it('creates independent bindings for each adapter instance', async () => {
    const bindingStore = createStatefulBindingStore();
    const adapterManager = createMockAdapterManager({
      getBindingStore: vi.fn().mockReturnValue(bindingStore) as never,
    });
    const app = createTestApp(adapterManager);

    // Create binding for first adapter
    const binding1Res = await request(app)
      .post('/api/relay/bindings')
      .send({
        adapterId: 'telegram-1',
        agentId: 'agent-1',
        sessionStrategy: 'per-chat',
        label: 'Bot One binding',
      })
      .expect(201);

    // Create binding for second adapter
    const binding2Res = await request(app)
      .post('/api/relay/bindings')
      .send({
        adapterId: 'telegram-2',
        agentId: 'agent-2',
        sessionStrategy: 'stateless',
        label: 'Bot Two binding',
      })
      .expect(201);

    // Verify both exist and are distinct
    const listRes = await request(app).get('/api/relay/bindings').expect(200);

    expect(listRes.body.bindings).toHaveLength(2);

    const b1 = listRes.body.bindings.find(
      (b: { id: string }) => b.id === binding1Res.body.binding.id
    );
    const b2 = listRes.body.bindings.find(
      (b: { id: string }) => b.id === binding2Res.body.binding.id
    );

    expect(b1.adapterId).toBe('telegram-1');
    expect(b1.label).toBe('Bot One binding');
    expect(b2.adapterId).toBe('telegram-2');
    expect(b2.label).toBe('Bot Two binding');
  });
});

// ---------------------------------------------------------------------------
// Observed Chats Pipeline
// ---------------------------------------------------------------------------

describe('Observed chats pipeline', () => {
  function createMockTraceStore(chats: Record<string, unknown[]> = {}) {
    return {
      getObservedChats: vi.fn((adapterId: string, limit: number) => {
        const adapterChats = chats[adapterId] ?? [];
        return adapterChats.slice(0, limit);
      }),
      getSpanByMessageId: vi.fn(),
      getTrace: vi.fn(),
      getMetrics: vi.fn(),
      getAdapterEvents: vi.fn(),
    };
  }

  it('returns aggregated chats from trace data', async () => {
    const traceStore = createMockTraceStore({
      'telegram-1': [
        {
          chatId: '111',
          displayName: 'Alice',
          channelType: 'dm',
          lastMessageAt: '2026-03-10T12:00:00.000Z',
          messageCount: 2,
        },
        {
          chatId: '222',
          displayName: 'Dev Team',
          channelType: 'group',
          lastMessageAt: '2026-03-10T11:00:00.000Z',
          messageCount: 1,
        },
      ],
    });

    const adapterManager = createMockAdapterManager();
    const app = createTestApp(adapterManager, traceStore);

    const res = await request(app).get('/api/relay/adapters/telegram-1/chats').expect(200);

    expect(res.body.chats).toHaveLength(2);

    const chat111 = res.body.chats.find((c: { chatId: string }) => c.chatId === '111');
    expect(chat111.messageCount).toBe(2);
    expect(chat111.displayName).toBe('Alice');
    expect(chat111.channelType).toBe('dm');

    const chat222 = res.body.chats.find((c: { chatId: string }) => c.chatId === '222');
    expect(chat222.messageCount).toBe(1);
    expect(chat222.displayName).toBe('Dev Team');
  });

  it('returns empty array for unknown adapter', async () => {
    const traceStore = createMockTraceStore({});
    const adapterManager = createMockAdapterManager();
    const app = createTestApp(adapterManager, traceStore);

    const res = await request(app).get('/api/relay/adapters/nonexistent/chats').expect(200);

    expect(res.body.chats).toEqual([]);
  });

  it('returns 404 when trace store is unavailable', async () => {
    const adapterManager = createMockAdapterManager();
    // No trace store passed
    const app = createTestApp(adapterManager);

    const res = await request(app).get('/api/relay/adapters/telegram-1/chats').expect(404);

    expect(res.body.error).toBe('Tracing not available');
  });

  it('passes limit parameter to trace store', async () => {
    const traceStore = createMockTraceStore({});
    const adapterManager = createMockAdapterManager();
    const app = createTestApp(adapterManager, traceStore);

    await request(app).get('/api/relay/adapters/telegram-1/chats?limit=25').expect(200);

    expect(traceStore.getObservedChats).toHaveBeenCalledWith('telegram-1', 25);
  });

  it('clamps limit to valid range (1-500)', async () => {
    const traceStore = createMockTraceStore({});
    const adapterManager = createMockAdapterManager();
    const app = createTestApp(adapterManager, traceStore);

    // Exceeds max
    await request(app).get('/api/relay/adapters/telegram-1/chats?limit=9999').expect(200);
    expect(traceStore.getObservedChats).toHaveBeenCalledWith('telegram-1', 500);

    // Below min
    await request(app).get('/api/relay/adapters/telegram-1/chats?limit=0').expect(200);
    expect(traceStore.getObservedChats).toHaveBeenCalledWith('telegram-1', 1);
  });

  it('defaults limit to 100 when not provided', async () => {
    const traceStore = createMockTraceStore({});
    const adapterManager = createMockAdapterManager();
    const app = createTestApp(adapterManager, traceStore);

    await request(app).get('/api/relay/adapters/telegram-1/chats').expect(200);

    expect(traceStore.getObservedChats).toHaveBeenCalledWith('telegram-1', 100);
  });

  it('handles non-numeric limit gracefully', async () => {
    const traceStore = createMockTraceStore({});
    const adapterManager = createMockAdapterManager();
    const app = createTestApp(adapterManager, traceStore);

    await request(app).get('/api/relay/adapters/telegram-1/chats?limit=abc').expect(200);

    // NaN falls back to default of 100
    expect(traceStore.getObservedChats).toHaveBeenCalledWith('telegram-1', 100);
  });
});

// ---------------------------------------------------------------------------
// Cross-Concern: Binding + Observed Chats
// ---------------------------------------------------------------------------

describe('Binding creation with chat filter from observed data', () => {
  it('creates a binding with chatId derived from observed chats', async () => {
    const bindingStore = createStatefulBindingStore();
    const traceStore = {
      getObservedChats: vi.fn().mockReturnValue([
        {
          chatId: '999',
          displayName: 'Support Channel',
          channelType: 'channel',
          lastMessageAt: '2026-03-10T12:00:00.000Z',
          messageCount: 50,
        },
      ]),
      getSpanByMessageId: vi.fn(),
      getTrace: vi.fn(),
      getMetrics: vi.fn(),
      getAdapterEvents: vi.fn(),
    };

    const adapterManager = createMockAdapterManager({
      getBindingStore: vi.fn().mockReturnValue(bindingStore) as never,
    });
    const app = createTestApp(adapterManager, traceStore);

    // 1. Query observed chats to discover chatId
    const chatsRes = await request(app).get('/api/relay/adapters/telegram-1/chats').expect(200);

    expect(chatsRes.body.chats).toHaveLength(1);
    const observedChatId = chatsRes.body.chats[0].chatId;
    const observedChannelType = chatsRes.body.chats[0].channelType;

    // 2. Create a binding using the discovered chatId
    const createRes = await request(app)
      .post('/api/relay/bindings')
      .send({
        adapterId: 'telegram-1',
        agentId: 'agent-1',
        sessionStrategy: 'per-chat',
        label: 'Support binding',
        chatId: observedChatId,
        channelType: observedChannelType,
      })
      .expect(201);

    expect(createRes.body.binding.chatId).toBe('999');
    expect(createRes.body.binding.channelType).toBe('channel');

    // 3. Verify the binding is persisted
    const readRes = await request(app)
      .get(`/api/relay/bindings/${createRes.body.binding.id}`)
      .expect(200);

    expect(readRes.body.binding.chatId).toBe('999');
    expect(readRes.body.binding.channelType).toBe('channel');
    expect(readRes.body.binding.label).toBe('Support binding');
  });
});
