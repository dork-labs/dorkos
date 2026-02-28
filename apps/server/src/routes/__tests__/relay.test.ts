import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRelayRouter } from '../relay.js';
import type { RelayCore, AdapterRegistry, WebhookAdapter } from '@dorkos/relay';
import { AdapterError, type AdapterManager } from '../../services/relay/adapter-manager.js';

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

describe('Relay routes', () => {
  let app: express.Application;
  let relayCore: ReturnType<typeof createMockRelayCore>;

  beforeEach(() => {
    relayCore = createMockRelayCore();
    app = express();
    app.use(express.json());
    app.use('/api/relay', createRelayRouter(relayCore as unknown as RelayCore));
    app.use(
      (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err.message });
      },
    );
  });

  describe('POST /api/relay/messages', () => {
    it('publishes a message and returns result', async () => {
      const res = await request(app).post('/api/relay/messages').send({
        subject: 'relay.test.topic',
        payload: { hello: 'world' },
        from: 'relay.agent.sender',
      });

      expect(res.status).toBe(200);
      expect(res.body.messageId).toBe('msg-1');
      expect(res.body.deliveredTo).toBe(1);
      expect(vi.mocked(relayCore.publish)).toHaveBeenCalledWith(
        'relay.test.topic',
        { hello: 'world' },
        expect.objectContaining({ from: 'relay.agent.sender' }),
      );
    });

    it('returns 400 for missing required fields', async () => {
      const res = await request(app).post('/api/relay/messages').send({ payload: {} });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 422 when publish throws', async () => {
      const error = new Error('Access denied');
      (error as Error & { code: string }).code = 'ACCESS_DENIED';
      vi.mocked(relayCore.publish).mockRejectedValue(error);

      const res = await request(app).post('/api/relay/messages').send({
        subject: 'relay.test.topic',
        payload: {},
        from: 'relay.agent.sender',
      });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('Access denied');
      expect(res.body.code).toBe('ACCESS_DENIED');
    });
  });

  describe('GET /api/relay/messages', () => {
    it('returns messages list', async () => {
      const mockMessages = [
        {
          id: 'msg-1',
          subject: 'relay.test',
          sender: 'agent-a',
          endpointHash: 'h1',
          status: 'new' as const,
          createdAt: '2026-02-24T00:00:00Z',
          ttl: Date.now() + 60000,
        },
      ];
      vi.mocked(relayCore.listMessages).mockReturnValue({
        messages: mockMessages,
        nextCursor: undefined,
      });

      const res = await request(app).get('/api/relay/messages');

      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(1);
      expect(res.body.messages[0].id).toBe('msg-1');
    });

    it('passes query filters to listMessages', async () => {
      await request(app).get('/api/relay/messages?subject=relay.test&status=new&limit=10');

      expect(vi.mocked(relayCore.listMessages)).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'relay.test', status: 'new', limit: 10 }),
      );
    });

    it('returns 400 for invalid status filter', async () => {
      const res = await request(app).get('/api/relay/messages?status=invalid');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  describe('GET /api/relay/messages/:id', () => {
    it('returns a message when found', async () => {
      vi.mocked(relayCore.getMessage).mockReturnValue({
        id: 'msg-1',
        subject: 'relay.test',
        sender: 'agent-a',
        endpointHash: 'h1',
        status: 'new',
        createdAt: '2026-02-24T00:00:00Z',
        ttl: Date.now() + 60000,
      });

      const res = await request(app).get('/api/relay/messages/msg-1');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('msg-1');
    });

    it('returns 404 when message not found', async () => {
      const res = await request(app).get('/api/relay/messages/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Message not found');
    });
  });

  describe('GET /api/relay/endpoints', () => {
    it('returns endpoint list', async () => {
      vi.mocked(relayCore.listEndpoints).mockReturnValue([
        { subject: 'relay.system.console', hash: 'abc', maildirPath: '/tmp/m/abc', registeredAt: '2026-02-24T00:00:00Z' },
      ]);

      const res = await request(app).get('/api/relay/endpoints');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].subject).toBe('relay.system.console');
    });
  });

  describe('POST /api/relay/endpoints', () => {
    it('registers an endpoint', async () => {
      const res = await request(app)
        .post('/api/relay/endpoints')
        .send({ subject: 'relay.agent.new' });

      expect(res.status).toBe(201);
      expect(res.body.subject).toBe('relay.test.endpoint');
      expect(vi.mocked(relayCore.registerEndpoint)).toHaveBeenCalledWith('relay.agent.new');
    });

    it('returns 400 for missing subject', async () => {
      const res = await request(app).post('/api/relay/endpoints').send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 422 when registration fails', async () => {
      vi.mocked(relayCore.registerEndpoint).mockRejectedValue(new Error('Duplicate endpoint'));

      const res = await request(app)
        .post('/api/relay/endpoints')
        .send({ subject: 'relay.agent.dup' });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('Duplicate endpoint');
    });
  });

  describe('DELETE /api/relay/endpoints/:subject', () => {
    it('removes an endpoint', async () => {
      const res = await request(app).delete('/api/relay/endpoints/relay.agent.old');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 404 when endpoint not found', async () => {
      vi.mocked(relayCore.unregisterEndpoint).mockResolvedValue(false);

      const res = await request(app).delete('/api/relay/endpoints/relay.agent.nope');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Endpoint not found');
    });
  });

  describe('GET /api/relay/endpoints/:subject/inbox', () => {
    it('returns inbox messages', async () => {
      vi.mocked(relayCore.readInbox).mockReturnValue({
        messages: [
          {
            id: 'msg-1',
            subject: 'relay.test',
            sender: 'agent-a',
            endpointHash: 'h1',
            status: 'new',
            createdAt: '2026-02-24T00:00:00Z',
            ttl: Date.now() + 60000,
          },
        ],
      });

      const res = await request(app).get('/api/relay/endpoints/relay.test/inbox');

      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(1);
    });

    it('returns 404 when endpoint not found', async () => {
      const error = new Error('Endpoint not found: relay.nope');
      (error as Error & { code: string }).code = 'ENDPOINT_NOT_FOUND';
      vi.mocked(relayCore.readInbox).mockImplementation(() => {
        throw error;
      });

      const res = await request(app).get('/api/relay/endpoints/relay.nope/inbox');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Endpoint not found');
    });
  });

  describe('GET /api/relay/dead-letters', () => {
    it('returns dead letters', async () => {
      vi.mocked(relayCore.getDeadLetters).mockResolvedValue([
        {
          endpointHash: 'h1',
          messageId: 'msg-1',
          reason: 'no matching endpoints',
          envelope: {} as never,
          failedAt: '2026-02-24T00:00:00Z',
        },
      ]);

      const res = await request(app).get('/api/relay/dead-letters');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it('passes endpointHash filter', async () => {
      await request(app).get('/api/relay/dead-letters?endpointHash=abc123');

      expect(vi.mocked(relayCore.getDeadLetters)).toHaveBeenCalledWith({ endpointHash: 'abc123' });
    });
  });

  describe('GET /api/relay/metrics', () => {
    it('returns metrics', async () => {
      vi.mocked(relayCore.getMetrics).mockReturnValue({
        totalMessages: 42,
        byStatus: { new: 10, cur: 30, failed: 2 },
        bySubject: [{ subject: 'relay.test', count: 42 }],
      });

      const res = await request(app).get('/api/relay/metrics');

      expect(res.status).toBe(200);
      expect(res.body.totalMessages).toBe(42);
      expect(res.body.byStatus.new).toBe(10);
    });
  });
});

// --- Adapter Route Tests ---

/** Create a mock AdapterManager for route testing. */
function createMockAdapterManager(): AdapterManager & { _mockWebhookAdapter: WebhookAdapter } {
  const mockWebhookAdapter = {
    id: 'wh-github',
    subjectPrefix: 'relay.webhook.github',
    displayName: 'Webhook (wh-github)',
    start: vi.fn(),
    stop: vi.fn(),
    deliver: vi.fn(),
    getStatus: vi.fn().mockReturnValue({
      state: 'connected',
      messageCount: { inbound: 5, outbound: 3 },
      errorCount: 0,
    }),
    handleInbound: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as WebhookAdapter;

  const mockRegistry = {
    get: vi.fn((id: string) => (id === 'wh-github' ? mockWebhookAdapter : undefined)),
  } as unknown as AdapterRegistry;

  return {
    listAdapters: vi.fn().mockReturnValue([
      {
        config: { id: 'tg-main', type: 'telegram', enabled: true, config: { token: 'x', mode: 'polling' } },
        status: { state: 'connected', messageCount: { inbound: 10, outbound: 5 }, errorCount: 0 },
      },
      {
        config: {
          id: 'wh-github',
          type: 'webhook',
          enabled: true,
          config: {
            inbound: { subject: 'relay.webhook.github', secret: 'a-very-long-secret-16' },
            outbound: { url: 'https://example.com/hook', secret: 'another-long-secret-16' },
          },
        },
        status: { state: 'connected', messageCount: { inbound: 5, outbound: 3 }, errorCount: 0 },
      },
    ]),
    getAdapter: vi.fn((id: string) => {
      if (id === 'tg-main') {
        return {
          config: { id: 'tg-main', type: 'telegram', enabled: true, config: { token: 'x', mode: 'polling' } },
          status: { state: 'connected', messageCount: { inbound: 10, outbound: 5 }, errorCount: 0 },
        };
      }
      if (id === 'wh-github') {
        return {
          config: {
            id: 'wh-github',
            type: 'webhook',
            enabled: true,
            config: {
              inbound: { subject: 'relay.webhook.github', secret: 'a-very-long-secret-16' },
              outbound: { url: 'https://example.com/hook', secret: 'another-long-secret-16' },
            },
          },
          status: { state: 'connected', messageCount: { inbound: 5, outbound: 3 }, errorCount: 0 },
        };
      }
      return undefined;
    }),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    getRegistry: vi.fn().mockReturnValue(mockRegistry),
    getCatalog: vi.fn().mockReturnValue([
      {
        manifest: {
          type: 'telegram',
          displayName: 'Telegram',
          description: 'Telegram bot adapter',
          category: 'messaging',
          builtin: true,
          configFields: [],
        },
        instances: [
          {
            config: { id: 'tg-main', type: 'telegram', enabled: true, config: { token: '***', mode: 'polling' } },
            status: { state: 'connected', messageCount: { inbound: 10, outbound: 5 }, errorCount: 0 },
          },
        ],
      },
    ]),
    addAdapter: vi.fn().mockResolvedValue(undefined),
    removeAdapter: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
    getBindingStore: vi.fn().mockReturnValue(undefined),
    getBindingRouter: vi.fn().mockReturnValue(undefined),
    _mockWebhookAdapter: mockWebhookAdapter,
  } as unknown as AdapterManager & { _mockWebhookAdapter: WebhookAdapter };
}

describe('Adapter routes', () => {
  let app: express.Application;
  let relayCore: ReturnType<typeof createMockRelayCore>;
  let adapterManager: ReturnType<typeof createMockAdapterManager>;

  beforeEach(() => {
    relayCore = createMockRelayCore();
    adapterManager = createMockAdapterManager();
    app = express();
    app.use(express.json());
    app.use(
      '/api/relay',
      createRelayRouter(relayCore as unknown as RelayCore, adapterManager as unknown as AdapterManager),
    );
    app.use(
      (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err.message });
      },
    );
  });

  describe('GET /api/relay/adapters/catalog', () => {
    it('returns 200 with catalog entries array', async () => {
      const res = await request(app).get('/api/relay/adapters/catalog');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].manifest.type).toBe('telegram');
      expect(res.body[0].instances).toHaveLength(1);
      expect(res.body[0].instances[0].config.id).toBe('tg-main');
    });

    it('includes masked password fields for instances', async () => {
      const res = await request(app).get('/api/relay/adapters/catalog');

      expect(res.status).toBe(200);
      // Token should be masked by getCatalog
      expect(res.body[0].instances[0].config.config.token).toBe('***');
    });

    it('returns 500 when getCatalog throws', async () => {
      vi.mocked(adapterManager.getCatalog).mockImplementation(() => {
        throw new Error('Catalog build failed');
      });

      const res = await request(app).get('/api/relay/adapters/catalog');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Catalog build failed');
    });
  });

  describe('GET /api/relay/adapters', () => {
    it('returns list of adapter statuses', async () => {
      const res = await request(app).get('/api/relay/adapters');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].config.id).toBe('tg-main');
      expect(res.body[0].status.state).toBe('connected');
      expect(res.body[1].config.id).toBe('wh-github');
    });
  });

  describe('GET /api/relay/adapters/:id', () => {
    it('returns single adapter status', async () => {
      const res = await request(app).get('/api/relay/adapters/tg-main');

      expect(res.status).toBe(200);
      expect(res.body.config.id).toBe('tg-main');
      expect(res.body.status.state).toBe('connected');
    });

    it('returns 404 for unknown adapter', async () => {
      const res = await request(app).get('/api/relay/adapters/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Adapter not found');
    });
  });

  describe('POST /api/relay/adapters/:id/enable', () => {
    it('enables adapter and returns ok', async () => {
      const res = await request(app).post('/api/relay/adapters/tg-main/enable');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(vi.mocked(adapterManager.enable)).toHaveBeenCalledWith('tg-main');
    });

    it('returns 400 when enable fails', async () => {
      vi.mocked(adapterManager.enable).mockRejectedValue(new Error('Adapter not found: missing'));

      const res = await request(app).post('/api/relay/adapters/missing/enable');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Adapter not found');
    });
  });

  describe('POST /api/relay/adapters/:id/disable', () => {
    it('disables adapter and returns ok', async () => {
      const res = await request(app).post('/api/relay/adapters/tg-main/disable');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(vi.mocked(adapterManager.disable)).toHaveBeenCalledWith('tg-main');
    });

    it('returns 400 when disable fails', async () => {
      vi.mocked(adapterManager.disable).mockRejectedValue(new Error('Adapter not found: missing'));

      const res = await request(app).post('/api/relay/adapters/missing/disable');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Adapter not found');
    });
  });

  describe('POST /api/relay/adapters/reload', () => {
    it('triggers config reload and returns ok', async () => {
      const res = await request(app).post('/api/relay/adapters/reload');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(vi.mocked(adapterManager.reload)).toHaveBeenCalledOnce();
    });

    it('returns 500 when reload fails', async () => {
      vi.mocked(adapterManager.reload).mockRejectedValue(new Error('Config parse error'));

      const res = await request(app).post('/api/relay/adapters/reload');

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Config parse error');
    });
  });

  describe('POST /api/relay/webhooks/:adapterId', () => {
    it('routes valid webhook to adapter handleInbound and returns 200', async () => {
      const body = JSON.stringify({ event: 'push', repo: 'test' });

      const res = await request(app)
        .post('/api/relay/webhooks/wh-github')
        .set('Content-Type', 'application/json')
        .set('X-Signature', 'test-sig')
        .set('X-Timestamp', String(Math.floor(Date.now() / 1000)))
        .set('X-Nonce', 'test-nonce')
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const mockAdapter = (adapterManager as unknown as { _mockWebhookAdapter: WebhookAdapter })
        ._mockWebhookAdapter;
      expect(vi.mocked(mockAdapter as unknown as { handleInbound: ReturnType<typeof vi.fn> }).handleInbound).toHaveBeenCalled();
    });

    it('returns 404 for unknown webhook adapter', async () => {
      const res = await request(app)
        .post('/api/relay/webhooks/unknown')
        .set('Content-Type', 'application/json')
        .send('{}');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Webhook adapter not found');
    });

    it('returns 404 for non-webhook adapter type', async () => {
      // tg-main is a telegram adapter, not webhook
      const res = await request(app)
        .post('/api/relay/webhooks/tg-main')
        .set('Content-Type', 'application/json')
        .send('{}');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Webhook adapter not found');
    });

    it('returns 401 when signature verification fails', async () => {
      const mockAdapter = (adapterManager as unknown as { _mockWebhookAdapter: WebhookAdapter })
        ._mockWebhookAdapter;
      vi.mocked(mockAdapter as unknown as { handleInbound: ReturnType<typeof vi.fn> }).handleInbound
        .mockResolvedValue({ ok: false, error: 'Invalid signature' });

      const res = await request(app)
        .post('/api/relay/webhooks/wh-github')
        .set('Content-Type', 'application/json')
        .send('{}');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid signature');
    });
  });

  describe('POST /api/relay/adapters', () => {
    it('returns 201 on success', async () => {
      const res = await request(app)
        .post('/api/relay/adapters')
        .send({ type: 'webhook', id: 'wh-new', config: { inbound: { subject: 'relay.webhook.new', secret: 'secret-long-enough' } } });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true, id: 'wh-new' });
      expect(vi.mocked(adapterManager.addAdapter)).toHaveBeenCalledWith(
        'webhook',
        'wh-new',
        { inbound: { subject: 'relay.webhook.new', secret: 'secret-long-enough' } },
        undefined,
      );
    });

    it('returns 400 when body missing required fields', async () => {
      const res = await request(app)
        .post('/api/relay/adapters')
        .send({ type: 'webhook' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('returns 409 when ID already exists (DUPLICATE_ID)', async () => {
      vi.mocked(adapterManager.addAdapter).mockRejectedValue(
        new AdapterError("Adapter with ID 'tg-main' already exists", 'DUPLICATE_ID'),
      );

      const res = await request(app)
        .post('/api/relay/adapters')
        .send({ type: 'telegram', id: 'tg-main', config: { token: 'x', mode: 'polling' } });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DUPLICATE_ID');
    });

    it('returns 400 for UNKNOWN_TYPE', async () => {
      vi.mocked(adapterManager.addAdapter).mockRejectedValue(
        new AdapterError('Unknown adapter type: foobar', 'UNKNOWN_TYPE'),
      );

      const res = await request(app)
        .post('/api/relay/adapters')
        .send({ type: 'foobar', id: 'fb-1', config: {} });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNKNOWN_TYPE');
    });

    it('returns 400 for MULTI_INSTANCE_DENIED', async () => {
      vi.mocked(adapterManager.addAdapter).mockRejectedValue(
        new AdapterError("Adapter type 'claude-code' does not support multiple instances", 'MULTI_INSTANCE_DENIED'),
      );

      const res = await request(app)
        .post('/api/relay/adapters')
        .send({ type: 'claude-code', id: 'cc-2', config: {} });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MULTI_INSTANCE_DENIED');
    });
  });

  describe('DELETE /api/relay/adapters/:id', () => {
    it('returns 200 on success', async () => {
      const res = await request(app).delete('/api/relay/adapters/wh-github');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(vi.mocked(adapterManager.removeAdapter)).toHaveBeenCalledWith('wh-github');
    });

    it('returns 404 when not found', async () => {
      vi.mocked(adapterManager.removeAdapter).mockRejectedValue(
        new AdapterError("Adapter 'nonexistent' not found", 'NOT_FOUND'),
      );

      const res = await request(app).delete('/api/relay/adapters/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('returns 400 for built-in claude-code', async () => {
      vi.mocked(adapterManager.removeAdapter).mockRejectedValue(
        new AdapterError('Cannot remove the built-in claude-code adapter', 'REMOVE_BUILTIN_DENIED'),
      );

      const res = await request(app).delete('/api/relay/adapters/claude-code');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('REMOVE_BUILTIN_DENIED');
    });
  });

  describe('PATCH /api/relay/adapters/:id/config', () => {
    it('returns 200 on success', async () => {
      const res = await request(app)
        .patch('/api/relay/adapters/tg-main/config')
        .send({ config: { token: 'new-token', mode: 'webhook' } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(vi.mocked(adapterManager.updateConfig)).toHaveBeenCalledWith(
        'tg-main',
        { token: 'new-token', mode: 'webhook' },
      );
    });

    it('returns 404 when not found', async () => {
      vi.mocked(adapterManager.updateConfig).mockRejectedValue(
        new AdapterError("Adapter 'nonexistent' not found", 'NOT_FOUND'),
      );

      const res = await request(app)
        .patch('/api/relay/adapters/nonexistent/config')
        .send({ config: { token: 'x' } });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('returns 400 when config missing', async () => {
      const res = await request(app)
        .patch('/api/relay/adapters/tg-main/config')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required field: config');
    });
  });

  describe('POST /api/relay/adapters/test', () => {
    it('returns 200 with { ok: true } on success', async () => {
      const res = await request(app)
        .post('/api/relay/adapters/test')
        .send({ type: 'telegram', config: { token: 'test-token', mode: 'polling' } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(vi.mocked(adapterManager.testConnection)).toHaveBeenCalledWith(
        'telegram',
        { token: 'test-token', mode: 'polling' },
      );
    });

    it('returns 200 with { ok: false, error } on failure', async () => {
      vi.mocked(adapterManager.testConnection).mockResolvedValue({
        ok: false,
        error: 'Connection refused',
      });

      const res = await request(app)
        .post('/api/relay/adapters/test')
        .send({ type: 'telegram', config: { token: 'bad-token', mode: 'polling' } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, error: 'Connection refused' });
    });

    it('returns 400 when body missing required fields', async () => {
      const res = await request(app)
        .post('/api/relay/adapters/test')
        .send({ type: 'telegram' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('returns 500 when testConnection throws', async () => {
      vi.mocked(adapterManager.testConnection).mockRejectedValue(new Error('Unexpected failure'));

      const res = await request(app)
        .post('/api/relay/adapters/test')
        .send({ type: 'telegram', config: { token: 'x' } });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Unexpected failure');
    });
  });

  describe('routes without adapterManager', () => {
    it('adapter routes are not mounted when adapterManager is undefined', async () => {
      const appNoAdapters = express();
      appNoAdapters.use(express.json());
      appNoAdapters.use('/api/relay', createRelayRouter(relayCore as unknown as RelayCore));

      const res = await request(appNoAdapters).get('/api/relay/adapters');

      expect(res.status).toBe(404);
    });
  });

  describe('Binding routes', () => {
    const mockBinding = {
      id: 'b-1',
      adapterId: 'tg-main',
      agentId: 'agent-1',
      agentDir: '/agents/a',
      sessionStrategy: 'per-chat' as const,
      label: 'Test binding',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    function createMockBindingStore() {
      return {
        getAll: vi.fn().mockReturnValue([mockBinding]),
        getById: vi.fn((id: string) => (id === 'b-1' ? mockBinding : undefined)),
        create: vi.fn().mockResolvedValue(mockBinding),
        delete: vi.fn().mockResolvedValue(true),
      };
    }

    describe('GET /api/relay/bindings', () => {
      it('returns 503 when binding store not available', async () => {
        const res = await request(app).get('/api/relay/bindings');
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('Binding subsystem not available');
      });

      it('returns 200 with bindings array', async () => {
        const mockStore = createMockBindingStore();
        vi.mocked(adapterManager.getBindingStore).mockReturnValue(mockStore as never);

        const res = await request(app).get('/api/relay/bindings');
        expect(res.status).toBe(200);
        expect(res.body.bindings).toHaveLength(1);
        expect(res.body.bindings[0].id).toBe('b-1');
      });
    });

    describe('GET /api/relay/bindings/:id', () => {
      it('returns 404 when binding not found', async () => {
        const mockStore = createMockBindingStore();
        vi.mocked(adapterManager.getBindingStore).mockReturnValue(mockStore as never);

        const res = await request(app).get('/api/relay/bindings/nonexistent');
        expect(res.status).toBe(404);
      });

      it('returns 200 with binding', async () => {
        const mockStore = createMockBindingStore();
        vi.mocked(adapterManager.getBindingStore).mockReturnValue(mockStore as never);

        const res = await request(app).get('/api/relay/bindings/b-1');
        expect(res.status).toBe(200);
        expect(res.body.binding.id).toBe('b-1');
      });
    });

    describe('POST /api/relay/bindings', () => {
      it('returns 400 for invalid input', async () => {
        const mockStore = createMockBindingStore();
        vi.mocked(adapterManager.getBindingStore).mockReturnValue(mockStore as never);

        const res = await request(app).post('/api/relay/bindings').send({});
        expect(res.status).toBe(400);
      });

      it('returns 201 with created binding', async () => {
        const mockStore = createMockBindingStore();
        vi.mocked(adapterManager.getBindingStore).mockReturnValue(mockStore as never);

        const res = await request(app).post('/api/relay/bindings').send({
          adapterId: 'tg-main',
          agentId: 'agent-1',
          agentDir: '/agents/a',
        });
        expect(res.status).toBe(201);
        expect(res.body.binding.id).toBe('b-1');
      });
    });

    describe('DELETE /api/relay/bindings/:id', () => {
      it('returns 404 when binding not found', async () => {
        const mockStore = createMockBindingStore();
        mockStore.delete.mockResolvedValue(false);
        vi.mocked(adapterManager.getBindingStore).mockReturnValue(mockStore as never);

        const res = await request(app).delete('/api/relay/bindings/nonexistent');
        expect(res.status).toBe(404);
      });

      it('returns 200 on successful delete', async () => {
        const mockStore = createMockBindingStore();
        vi.mocked(adapterManager.getBindingStore).mockReturnValue(mockStore as never);

        const res = await request(app).delete('/api/relay/bindings/b-1');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
      });
    });
  });
});
