import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BindingRouter,
  type RelayCoreLike,
  type AgentSessionCreator,
} from '../binding-router.js';
import type { BindingStore } from '../binding-store.js';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';

vi.mock('node:fs/promises');

describe('BindingRouter', () => {
  let router: BindingRouter;
  let mockRelayCore: RelayCoreLike;
  let mockAgentManager: AgentSessionCreator;
  let mockBindingStore: Partial<BindingStore>;
  let capturedHandler: ((envelope: Record<string, unknown>) => Promise<void>) | undefined;
  const mockUnsubscribe = vi.fn();

  beforeEach(async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue();
    vi.mocked(rename).mockResolvedValue();
    capturedHandler = undefined;

    mockRelayCore = {
      publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      subscribe: vi.fn((pattern: string, handler: unknown) => {
        capturedHandler = handler as typeof capturedHandler;
        return mockUnsubscribe;
      }),
    };

    mockAgentManager = {
      createSession: vi.fn().mockResolvedValue({ id: 'session-abc' }),
    };

    mockBindingStore = {
      resolve: vi.fn(),
    };

    router = new BindingRouter({
      bindingStore: mockBindingStore as BindingStore,
      relayCore: mockRelayCore,
      agentManager: mockAgentManager,
      relayDir: '/tmp/relay',
    });
    await router.init();
  });

  afterEach(async () => {
    await router.shutdown();
    vi.restoreAllMocks();
  });

  it('subscribes to relay.human.* on init', () => {
    expect(mockRelayCore.subscribe).toHaveBeenCalledWith(
      'relay.human.*',
      expect.any(Function),
    );
  });

  it('skips messages with unparseable subjects', async () => {
    const envelope = {
      id: 'msg-1',
      subject: 'relay.agent.xxx',
      payload: 'hi',
      from: 'tg',
      budget: { ttlMs: 60000, maxHops: 5, callBudget: 10 },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await capturedHandler!(envelope);
    expect(mockBindingStore.resolve).not.toHaveBeenCalled();
    expect(mockRelayCore.publish).not.toHaveBeenCalled();
  });

  it('skips when no binding matches', async () => {
    vi.mocked(mockBindingStore.resolve!).mockReturnValue(undefined);
    const envelope = {
      id: 'msg-1',
      subject: 'relay.human.telegram.123',
      payload: 'hi',
      from: 'tg',
      budget: { ttlMs: 60000, maxHops: 5, callBudget: 10 },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await capturedHandler!(envelope);
    expect(mockRelayCore.publish).not.toHaveBeenCalled();
  });

  it('routes to relay.agent.{sessionId} when binding matches', async () => {
    vi.mocked(mockBindingStore.resolve!).mockReturnValue({
      id: 'bind-1',
      adapterId: 'telegram',
      agentId: 'agent-a',
      agentDir: '/agents/a',
      sessionStrategy: 'per-chat',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const envelope = {
      id: 'msg-1',
      subject: 'relay.human.telegram.123',
      payload: { text: 'hello' },
      from: 'tg',
      budget: { ttlMs: 60000, maxHops: 5, callBudget: 10 },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await capturedHandler!(envelope);
    expect(mockAgentManager.createSession).toHaveBeenCalledWith('/agents/a');
    expect(mockRelayCore.publish).toHaveBeenCalledWith(
      'relay.agent.session-abc',
      { text: 'hello' },
      expect.objectContaining({ from: 'tg' }),
    );
  });

  it('resolves binding with adapterId and chatId from subject', async () => {
    vi.mocked(mockBindingStore.resolve!).mockReturnValue(undefined);
    const envelope = {
      id: 'msg-1',
      subject: 'relay.human.telegram.12345',
      payload: 'hi',
      from: 'tg',
      budget: { ttlMs: 60000, maxHops: 5, callBudget: 10 },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await capturedHandler!(envelope);
    expect(mockBindingStore.resolve).toHaveBeenCalledWith('telegram', '12345', undefined);
  });

  describe('session strategies', () => {
    const makeBinding = (strategy: string) => ({
      id: 'bind-1',
      adapterId: 'telegram',
      agentId: 'agent-a',
      agentDir: '/agents/a',
      sessionStrategy: strategy,
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const makeEnvelope = (chatId: string) => ({
      id: 'msg-1',
      subject: `relay.human.telegram.${chatId}`,
      payload: 'hi',
      from: 'tg',
      budget: { ttlMs: 60000, maxHops: 5, callBudget: 10 },
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    it('reuses session for per-chat strategy with same chatId', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding('per-chat'));
      const envelope = makeEnvelope('123');
      await capturedHandler!(envelope);
      await capturedHandler!(envelope); // second call
      // createSession should only be called once (reuse)
      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);
    });

    it('creates separate sessions for per-chat strategy with different chatIds', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding('per-chat'));
      await capturedHandler!(makeEnvelope('123'));
      await capturedHandler!(makeEnvelope('456'));
      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(2);
    });

    it('creates new session every time for stateless strategy', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding('stateless'));
      const envelope = makeEnvelope('123');
      await capturedHandler!(envelope);
      await capturedHandler!(envelope); // second call
      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(2);
    });

    it('reuses session for per-user strategy with same chatId', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding('per-user'));
      const envelope = makeEnvelope('123');
      await capturedHandler!(envelope);
      await capturedHandler!(envelope);
      // per-user falls back to chatId when no userId in metadata
      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('session persistence', () => {
    it('saves session map to disk after creating a session', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'telegram',
        agentId: 'agent-a',
        agentDir: '/agents/a',
        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await capturedHandler!({
        id: 'msg-1',
        subject: 'relay.human.telegram.123',
        payload: 'hi',
        from: 'tg',
        budget: { ttlMs: 60000, maxHops: 5, callBudget: 10 },
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect(writeFile).toHaveBeenCalled();
      expect(rename).toHaveBeenCalled();
    });

    it('loads session map from disk on init', async () => {
      const entries: [string, string][] = [['bind-1:chat:123', 'session-existing']];
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(entries));

      const freshRouter = new BindingRouter({
        bindingStore: mockBindingStore as BindingStore,
        relayCore: mockRelayCore,
        agentManager: mockAgentManager,
        relayDir: '/tmp/relay',
      });
      await freshRouter.init();

      // Now route a message to the same binding+chat — should reuse existing session
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'telegram',
        agentId: 'agent-a',
        agentDir: '/agents/a',
        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      // Get the handler registered by the fresh router
      const freshHandler = (mockRelayCore.subscribe as ReturnType<typeof vi.fn>).mock.calls.at(
        -1,
      )?.[1] as typeof capturedHandler;

      await freshHandler!({
        id: 'msg-1',
        subject: 'relay.human.telegram.123',
        payload: 'hi',
        from: 'tg',
        budget: { ttlMs: 60000, maxHops: 5, callBudget: 10 },
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      // Should NOT create a new session — reuses persisted one
      expect(mockAgentManager.createSession).not.toHaveBeenCalled();
      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        'relay.agent.session-existing',
        'hi',
        expect.any(Object),
      );

      await freshRouter.shutdown();
    });
  });

  describe('cleanupOrphanedSessions()', () => {
    it('removes session entries for deleted bindings', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'telegram',
        agentId: 'agent-a',
        agentDir: '/agents/a',
        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      // Create a session
      await capturedHandler!({
        id: 'msg-1',
        subject: 'relay.human.telegram.123',
        payload: 'hi',
        from: 'tg',
        budget: { ttlMs: 60000, maxHops: 5, callBudget: 10 },
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);

      // Clean up with empty active bindings — should remove the orphaned entry
      const removed = await router.cleanupOrphanedSessions(new Set());
      expect(removed).toBe(1);

      // Now route again — should create a NEW session since the old one was cleaned up
      await capturedHandler!({
        id: 'msg-2',
        subject: 'relay.human.telegram.123',
        payload: 'hi again',
        from: 'tg',
        budget: { ttlMs: 60000, maxHops: 5, callBudget: 10 },
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(2);
    });

    it('preserves session entries for active bindings', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'telegram',
        agentId: 'agent-a',
        agentDir: '/agents/a',
        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      await capturedHandler!({
        id: 'msg-1',
        subject: 'relay.human.telegram.123',
        payload: 'hi',
        from: 'tg',
        budget: { ttlMs: 60000, maxHops: 5, callBudget: 10 },
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      const removed = await router.cleanupOrphanedSessions(new Set(['bind-1']));
      expect(removed).toBe(0);
    });

    it('returns 0 when no orphaned sessions exist', async () => {
      const removed = await router.cleanupOrphanedSessions(new Set());
      expect(removed).toBe(0);
    });
  });

  describe('shutdown()', () => {
    it('calls unsubscribe on shutdown', async () => {
      await router.shutdown();
      expect(mockUnsubscribe).toHaveBeenCalled();
    });

    it('saves session map on shutdown', async () => {
      vi.mocked(writeFile).mockClear();
      vi.mocked(rename).mockClear();
      await router.shutdown();
      expect(writeFile).toHaveBeenCalled();
    });
  });
});
