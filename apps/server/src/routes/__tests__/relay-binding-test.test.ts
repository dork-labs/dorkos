/**
 * Tests for POST /api/relay/bindings/:id/test — synthetic binding test probe.
 *
 * Exercises the test route's error handling (404, 409, 503), happy path,
 * and rate limiting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRelayRouter } from '../relay.js';
import type { RelayCore } from '@dorkos/relay';
import type { AdapterManager } from '../../services/relay/adapter-manager.js';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';

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

function createMockBinding(overrides?: Partial<AdapterBinding>): AdapterBinding {
  return {
    id: 'b-test-1',
    adapterId: 'telegram-1',
    agentId: 'agent-1',
    sessionStrategy: 'per-chat',
    label: 'Test binding',
    enabled: true,
    canInitiate: false,
    canReply: true,
    canReceive: true,
    permissionMode: 'acceptEdits',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createMockAdapterManager(overrides?: Partial<AdapterManager>): AdapterManager {
  return {
    listAdapters: vi.fn().mockReturnValue([]),
    getAdapter: vi.fn().mockReturnValue({ id: 'mock-adapter' }),
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
    getMeshCore: vi.fn().mockReturnValue(undefined),
    ...overrides,
  } as unknown as AdapterManager;
}

function createTestApp(adapterManager?: AdapterManager): express.Application {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/relay',
    createRelayRouter(
      createMockRelayCore() as unknown as RelayCore,
      adapterManager as AdapterManager | undefined
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
// POST /api/relay/bindings/:id/test
// ---------------------------------------------------------------------------

describe('POST /api/relay/bindings/:id/test', () => {
  let app: express.Application;
  let mockBindingStore: {
    getAll: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let mockBindingRouter: {
    testBinding: ReturnType<typeof vi.fn>;
    cleanupOrphanedSessions: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockBindingStore = {
      getAll: vi.fn().mockReturnValue([]),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    mockBindingRouter = {
      testBinding: vi.fn(),
      cleanupOrphanedSessions: vi.fn().mockResolvedValue(0),
    };
  });

  it('returns 200 with test result for a healthy binding', async () => {
    const binding = createMockBinding();
    mockBindingStore.getById.mockReturnValue(binding);
    mockBindingRouter.testBinding.mockReturnValue({
      ok: true,
      resolved: true,
      latencyMs: 3,
      wouldDeliverTo: 'agent-1',
      details: 'Routing succeeded. No agent was invoked.',
    });

    const adapterManager = createMockAdapterManager({
      getBindingStore: vi.fn().mockReturnValue(mockBindingStore) as never,
      getBindingRouter: vi.fn().mockReturnValue(mockBindingRouter) as never,
    });
    app = createTestApp(adapterManager);

    const res = await request(app).post('/api/relay/bindings/b-test-1/test').expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.resolved).toBe(true);
    expect(res.body.latencyMs).toBe(3);
    expect(res.body.wouldDeliverTo).toBe('agent-1');
    expect(res.body.details).toBe('Routing succeeded. No agent was invoked.');
    expect(mockBindingRouter.testBinding).toHaveBeenCalledWith('b-test-1');
  });

  it('returns 200 with ok=false when routing fails', async () => {
    const binding = createMockBinding();
    mockBindingStore.getById.mockReturnValue(binding);
    mockBindingRouter.testBinding.mockReturnValue({
      ok: false,
      resolved: false,
      latencyMs: 1,
      reason: "Agent 'agent-1' not found in mesh registry",
    });

    const adapterManager = createMockAdapterManager({
      getBindingStore: vi.fn().mockReturnValue(mockBindingStore) as never,
      getBindingRouter: vi.fn().mockReturnValue(mockBindingRouter) as never,
    });
    app = createTestApp(adapterManager);

    const res = await request(app).post('/api/relay/bindings/b-test-1/test').expect(200);

    expect(res.body.ok).toBe(false);
    expect(res.body.resolved).toBe(false);
    expect(res.body.reason).toContain('not found in mesh registry');
  });

  it('returns 404 for unknown binding ID', async () => {
    mockBindingStore.getById.mockReturnValue(undefined);

    const adapterManager = createMockAdapterManager({
      getBindingStore: vi.fn().mockReturnValue(mockBindingStore) as never,
      getBindingRouter: vi.fn().mockReturnValue(mockBindingRouter) as never,
    });
    app = createTestApp(adapterManager);

    const res = await request(app).post('/api/relay/bindings/nonexistent/test').expect(404);

    expect(res.body.error).toBe('Binding not found');
    expect(mockBindingRouter.testBinding).not.toHaveBeenCalled();
  });

  it('returns 409 when binding is paused (enabled=false)', async () => {
    const binding = createMockBinding({ enabled: false });
    mockBindingStore.getById.mockReturnValue(binding);

    const adapterManager = createMockAdapterManager({
      getBindingStore: vi.fn().mockReturnValue(mockBindingStore) as never,
      getBindingRouter: vi.fn().mockReturnValue(mockBindingRouter) as never,
    });
    app = createTestApp(adapterManager);

    const res = await request(app).post('/api/relay/bindings/b-test-1/test').expect(409);

    expect(res.body.error).toBe('Binding is paused. Resume to run a test.');
    expect(mockBindingRouter.testBinding).not.toHaveBeenCalled();
  });

  it('returns 503 when binding subsystem is not available', async () => {
    const adapterManager = createMockAdapterManager({
      getBindingStore: vi.fn().mockReturnValue(undefined) as never,
    });
    app = createTestApp(adapterManager);

    const res = await request(app).post('/api/relay/bindings/b-test-1/test').expect(503);

    expect(res.body.error).toBe('Binding subsystem not available');
  });

  it('returns 503 when binding router is not available', async () => {
    const binding = createMockBinding();
    mockBindingStore.getById.mockReturnValue(binding);

    const adapterManager = createMockAdapterManager({
      getBindingStore: vi.fn().mockReturnValue(mockBindingStore) as never,
      getBindingRouter: vi.fn().mockReturnValue(undefined) as never,
    });
    app = createTestApp(adapterManager);

    const res = await request(app).post('/api/relay/bindings/b-test-1/test').expect(503);

    expect(res.body.error).toBe('Binding router not available');
  });

  it('returns 500 when router throws an unexpected error', async () => {
    const binding = createMockBinding();
    mockBindingStore.getById.mockReturnValue(binding);
    mockBindingRouter.testBinding.mockImplementation(() => {
      throw new Error('Unexpected adapter failure');
    });

    const adapterManager = createMockAdapterManager({
      getBindingStore: vi.fn().mockReturnValue(mockBindingStore) as never,
      getBindingRouter: vi.fn().mockReturnValue(mockBindingRouter) as never,
    });
    app = createTestApp(adapterManager);

    const res = await request(app).post('/api/relay/bindings/b-test-1/test').expect(500);

    expect(res.body.error).toBe('Unexpected adapter failure');
  });

  it('never invokes the agent runtime during a test', async () => {
    const binding = createMockBinding();
    mockBindingStore.getById.mockReturnValue(binding);
    mockBindingRouter.testBinding.mockReturnValue({
      ok: true,
      resolved: true,
      latencyMs: 2,
      wouldDeliverTo: 'agent-1',
      details: 'Routing succeeded. No agent was invoked.',
    });

    const mockCreateSession = vi.fn();
    const adapterManager = createMockAdapterManager({
      getBindingStore: vi.fn().mockReturnValue(mockBindingStore) as never,
      getBindingRouter: vi.fn().mockReturnValue(mockBindingRouter) as never,
    });
    app = createTestApp(adapterManager);

    await request(app).post('/api/relay/bindings/b-test-1/test').expect(200);

    // Verify no session creation happened — the test must not invoke the agent
    expect(mockCreateSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rate Limiting
// ---------------------------------------------------------------------------

describe('POST /api/relay/bindings/:id/test — rate limiting', () => {
  it('enforces rate limit after 10 requests per minute', async () => {
    const binding = createMockBinding();
    const mockBindingStore = {
      getAll: vi.fn().mockReturnValue([]),
      getById: vi.fn().mockReturnValue(binding),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    const mockBindingRouter = {
      testBinding: vi.fn().mockReturnValue({
        ok: true,
        resolved: true,
        latencyMs: 1,
        wouldDeliverTo: 'agent-1',
        details: 'Routing succeeded. No agent was invoked.',
      }),
      cleanupOrphanedSessions: vi.fn().mockResolvedValue(0),
    };

    const adapterManager = createMockAdapterManager({
      getBindingStore: vi.fn().mockReturnValue(mockBindingStore) as never,
      getBindingRouter: vi.fn().mockReturnValue(mockBindingRouter) as never,
    });
    const app = createTestApp(adapterManager);

    // Send 10 requests (all should succeed)
    for (let i = 0; i < 10; i++) {
      await request(app).post('/api/relay/bindings/b-test-1/test').expect(200);
    }

    // 11th request should be rate-limited
    const res = await request(app).post('/api/relay/bindings/b-test-1/test').expect(429);

    expect(res.body.error).toBe('Too many test requests, try again in a minute');
  });
});
