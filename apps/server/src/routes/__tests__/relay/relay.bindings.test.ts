import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import type { DeadLetterEntry, RelayCore } from '@dorkos/relay';
import { buildConversations } from '../../relay.js';
import {
  createMockAdapterManager,
  createMockRelayCore,
  relayApp,
  server,
  target,
  useLoginOffConfig,
  type MockAdapterManager,
} from './relay.fixtures.js';

useLoginOffConfig();

let relayCore: RelayCore;
let adapterManager: MockAdapterManager;

beforeEach(() => {
  relayCore = createMockRelayCore();
  adapterManager = createMockAdapterManager();
  target.mount(relayApp(relayCore, adapterManager));
});

describe('Binding routes', () => {
  const mockBinding = {
    id: 'b-1',
    adapterId: 'tg-main',
    agentId: 'agent-1',
    projectPath: '/agents/a',
    sessionStrategy: 'per-chat' as const,
    label: 'Test binding',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  function useBindingStore() {
    const store = {
      getAll: vi.fn().mockReturnValue([mockBinding]),
      getById: vi.fn((id: string) => (id === 'b-1' ? mockBinding : undefined)),
      create: vi.fn().mockResolvedValue(mockBinding),
      delete: vi.fn().mockResolvedValue(true),
      update: vi
        .fn()
        .mockImplementation((id: string, updates: Record<string, unknown>) =>
          Promise.resolve(
            id === 'b-1'
              ? { ...mockBinding, ...updates, updatedAt: '2026-01-02T00:00:00.000Z' }
              : undefined
          )
        ),
    };
    vi.mocked(adapterManager.getBindingStore).mockReturnValue(store as never);
    return store;
  }

  it.each([
    ['get', '/api/relay/bindings'],
    ['patch', '/api/relay/bindings/b-1'],
  ] as const)('%s %s answers 503 when the binding store is not available', async (verb, path) => {
    const res = await request(server)[verb](path).send({ label: 'Updated' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Binding subsystem not available');
  });

  it('reads one binding', async () => {
    useBindingStore();

    const res = await request(server).get('/api/relay/bindings/b-1');
    expect(res.status).toBe(200);
    expect(res.body.binding.id).toBe('b-1');
  });

  it('creates a binding', async () => {
    useBindingStore();

    const res = await request(server).post('/api/relay/bindings').send({
      adapterId: 'tg-main',
      agentId: 'agent-1',
      projectPath: '/agents/a',
    });
    expect(res.status).toBe(201);
    expect(res.body.binding.id).toBe('b-1');
  });

  describe('PATCH /api/relay/bindings/:id', () => {
    // A free change carries its "still narrows" check into the write (Security S5);
    // null clears an optional field.
    it.each([
      [{ sessionStrategy: 'stateless' }, { sessionStrategy: 'stateless' }],
      [{ label: 'New label' }, { label: 'New label' }],
      [{ chatId: null }, { chatId: undefined }],
    ])('writes %j as %j, carrying its check', async (body, written) => {
      const store = useBindingStore();

      const res = await request(server).patch('/api/relay/bindings/b-1').send(body);
      expect(res.status).toBe(200);
      expect(store.update).toHaveBeenCalledWith('b-1', written, expect.any(Function));
    });

    it('returns 400 for invalid session strategy value', async () => {
      useBindingStore();

      const res = await request(server)
        .patch('/api/relay/bindings/b-1')
        .send({ sessionStrategy: 'invalid' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    });
  });

  it('deletes a binding', async () => {
    useBindingStore();

    const res = await request(server).delete('/api/relay/bindings/b-1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Observed chats route', () => {
  function mountTraceStore(chats: unknown[] = []) {
    const traceStore = {
      getObservedChats: vi.fn().mockReturnValue(chats),
      getSpanByMessageId: vi.fn(),
      getTrace: vi.fn(),
      getMetrics: vi.fn(),
      getAdapterEvents: vi.fn(),
    };
    target.mount(relayApp(relayCore, adapterManager, traceStore as never));
    return traceStore;
  }

  it('returns the chats the trace store observed', async () => {
    mountTraceStore([{ chatId: '111' }, { chatId: '222' }]);

    const res = await request(server).get('/api/relay/adapters/telegram-1/chats');

    expect(res.status).toBe(200);
    expect(res.body.chats.map((c: { chatId: string }) => c.chatId)).toEqual(['111', '222']);
  });

  it.each([
    ['', 100],
    ['?limit=10', 10],
    ['?limit=9999', 500],
  ])('reads limit%s as %i', async (query, limit) => {
    const traceStore = mountTraceStore();

    await request(server).get(`/api/relay/adapters/telegram-1/chats${query}`).expect(200);

    expect(traceStore.getObservedChats).toHaveBeenCalledWith('telegram-1', limit);
  });

  it('returns 404 when trace store is unavailable', async () => {
    const res = await request(server).get('/api/relay/adapters/telegram-1/chats');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Tracing not available');
  });
});

describe('buildConversations', () => {
  it('builds a conversation from a request, its dead letter and its replies', () => {
    const messages = [
      {
        id: 'msg-1',
        subject: 'relay.agent.session-abc',
        status: 'failed',
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'msg-2',
        subject: 'relay.human.console.client-1',
        status: 'delivered',
        createdAt: '2026-01-01T00:01:00Z',
      },
    ];

    const deadLetters: DeadLetterEntry[] = [
      {
        messageId: 'msg-1',
        endpointHash: 'hash-1',
        reason: 'Handler timeout',
        failedAt: '2026-01-01T00:00:05Z',
        envelope: {
          id: 'msg-1',
          subject: 'relay.agent.session-abc',
          payload: { content: 'Hello agent' },
          from: 'relay.human.console.client-1',
          replyTo: 'relay.human.console.client-1',
          createdAt: '2026-01-01T00:00:00Z',
          budget: { hopCount: 1, maxHops: 5, ttl: 300000, callBudgetRemaining: 10 },
        },
      },
    ];

    const labelMap = new Map([
      ['relay.agent.session-abc', { label: 'Agent session-abc', raw: 'relay.agent.session-abc' }],
      [
        'relay.human.console.client-1',
        { label: 'Console client-1', raw: 'relay.human.console.client-1' },
      ],
    ]);

    const conversations = buildConversations(messages, deadLetters, labelMap);

    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      id: 'msg-1',
      status: 'failed',
      direction: 'outbound',
      sessionId: 'session-abc',
      failureReason: 'Handler timeout',
      preview: 'Hello agent',
      from: { label: 'Console client-1' },
      to: { label: 'Agent session-abc' },
      responseCount: 1, // msg-2 matches the from subject
      traceId: 'msg-1',
    });
  });

  it('returns empty array when no request messages exist', () => {
    const messages = [
      {
        id: 'msg-1',
        subject: 'relay.human.console.client-1',
        status: 'delivered',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    expect(buildConversations(messages, [], new Map())).toHaveLength(0);
  });

  it('handles messages without dead letters gracefully', () => {
    const messages = [
      {
        id: 'msg-1',
        subject: 'relay.agent.session-1',
        status: 'delivered',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const [conversation] = buildConversations(messages, [], new Map());
    expect(conversation.preview).toBe('');
    expect(conversation.failureReason).toBeUndefined();
    expect(conversation.from.label).toBe('Unknown');
  });

  it('infers from subject for system tasks messages', () => {
    const messages = [
      {
        id: 'msg-1',
        subject: 'relay.system.tasks.sched-1',
        status: 'delivered',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const [conversation] = buildConversations(messages, [], new Map());
    expect(conversation.from.raw).toBe('relay.system.console');
  });
});
