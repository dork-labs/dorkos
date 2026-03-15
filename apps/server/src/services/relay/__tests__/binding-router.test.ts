import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BindingRouter,
  type RelayCoreLike,
  type AgentSessionCreator,
} from '../binding-router.js';
import type { BindingStore } from '../binding-store.js';
import type { AdapterMeshCoreLike } from '../adapter-manager.js';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';

vi.mock('node:fs/promises');

describe('BindingRouter', () => {
  let router: BindingRouter;
  let mockRelayCore: RelayCoreLike;
  let mockAgentManager: AgentSessionCreator;
  let mockMeshCore: AdapterMeshCoreLike;
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

    mockMeshCore = {
      getProjectPath: vi.fn().mockReturnValue('/agents/a'),
    };

    mockBindingStore = {
      resolve: vi.fn(),
    };

    router = new BindingRouter({
      bindingStore: mockBindingStore as BindingStore,
      relayCore: mockRelayCore,
      agentManager: mockAgentManager,
      meshCore: mockMeshCore,
      relayDir: '/tmp/relay',
    });
    await router.init();
  });

  afterEach(async () => {
    await router.shutdown();
    vi.restoreAllMocks();
  });

  it('subscribes to relay.human.> on init', () => {
    expect(mockRelayCore.subscribe).toHaveBeenCalledWith(
      'relay.human.>',
      expect.any(Function),
    );
  });

  it('skips messages with unparseable subjects', async () => {
    const envelope = {
      id: 'msg-1',
      subject: 'relay.agent.xxx',
      payload: 'hi',
      from: 'tg',
      budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
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
      budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await capturedHandler!(envelope);
    expect(mockRelayCore.publish).not.toHaveBeenCalled();
  });

  it('skips envelopes originating from agents to prevent feedback loop', async () => {
    vi.mocked(mockBindingStore.resolve!).mockReturnValue({
      id: 'bind-1',
      adapterId: 'telegram',
      agentId: 'agent-a',

      sessionStrategy: 'per-chat',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await capturedHandler!({
      subject: 'relay.human.telegram.12345',
      from: 'agent:session-abc',
      replyTo: undefined,
      payload: { type: 'text_delta', data: { text: 'hello' } },
      budget: { hopCount: 1, maxHops: 10, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
      id: 'msg-response',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    // Should NOT have published — this is an agent response, not a human message
    expect(mockRelayCore.publish).not.toHaveBeenCalled();
    expect(mockBindingStore.resolve).not.toHaveBeenCalled();
  });

  it('routes human-originated messages normally', async () => {
    vi.mocked(mockBindingStore.resolve!).mockReturnValue({
      id: 'bind-1',
      adapterId: 'telegram',
      agentId: 'agent-a',

      sessionStrategy: 'per-chat',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await capturedHandler!({
      subject: 'relay.human.telegram.12345',
      from: 'relay.human.telegram.bot',
      replyTo: 'relay.human.telegram.12345',
      payload: { content: 'Hello from Telegram' },
      budget: { hopCount: 0, maxHops: 10, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
      id: 'msg-inbound',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(mockRelayCore.publish).toHaveBeenCalledWith(
      'relay.agent.session-abc',
      expect.anything(),
      expect.objectContaining({ from: 'relay.human.telegram.bot' }),
    );
  });

  it('routes to relay.agent.{sessionId} when binding matches', async () => {
    vi.mocked(mockBindingStore.resolve!).mockReturnValue({
      id: 'bind-1',
      adapterId: 'telegram',
      agentId: 'agent-a',

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
      budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await capturedHandler!(envelope);
    expect(mockAgentManager.createSession).toHaveBeenCalledWith('/agents/a');
    expect(mockRelayCore.publish).toHaveBeenCalledWith(
      'relay.agent.session-abc',
      expect.objectContaining({ text: 'hello', cwd: '/agents/a' }),
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
      budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
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
      budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
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
        budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
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
        meshCore: mockMeshCore,
        relayDir: '/tmp/relay',
      });
      await freshRouter.init();

      // Now route a message to the same binding+chat — should reuse existing session
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'telegram',
        agentId: 'agent-a',
  
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
        budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
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
        budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
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
        budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(2);
    });

    it('preserves session entries for active bindings', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'telegram',
        agentId: 'agent-a',
  
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
        budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
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

  describe('error handling (C2)', () => {
    it('catches and logs errors when publish() throws', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'telegram',
        agentId: 'agent-a',
  
        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      vi.mocked(mockRelayCore.publish).mockRejectedValue(new Error('publish failed'));

      // Should NOT throw — error is caught internally
      await expect(
        capturedHandler!({
          id: 'msg-1',
          subject: 'relay.human.telegram.123',
          payload: 'hi',
          from: 'tg',
          budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      ).resolves.toBeUndefined();
    });

    it('catches and logs errors when createSession() throws', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'telegram',
        agentId: 'agent-a',
  
        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      vi.mocked(mockAgentManager.createSession).mockRejectedValue(
        new Error('session creation failed'),
      );

      await expect(
        capturedHandler!({
          id: 'msg-1',
          subject: 'relay.human.telegram.123',
          payload: 'hi',
          from: 'tg',
          budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('concurrent session creation (C1)', () => {
    it('deduplicates concurrent calls for same key', async () => {
      // Make createSession slow so concurrent calls overlap
      let resolveSession!: (value: { id: string }) => void;
      vi.mocked(mockAgentManager.createSession).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSession = resolve;
          }),
      );

      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'telegram',
        agentId: 'agent-a',
  
        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const envelope = {
        id: 'msg-1',
        subject: 'relay.human.telegram.123',
        payload: 'hi',
        from: 'tg',
        budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
        createdAt: '2026-01-01T00:00:00.000Z',
      };

      // Fire two concurrent calls before the session resolves
      const p1 = capturedHandler!(envelope);
      const p2 = capturedHandler!(envelope);

      // Resolve the single session creation
      resolveSession({ id: 'session-deduped' });
      await p1;
      await p2;

      // createSession should only be called ONCE despite two concurrent requests
      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);
      // Both should publish to the same session
      expect(mockRelayCore.publish).toHaveBeenCalledTimes(2);
      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        'relay.agent.session-deduped',
        'hi',
        expect.any(Object),
      );
    });
  });

  describe('session map eviction (I6)', () => {
    it('evicts oldest entries when exceeding MAX_SESSIONS', async () => {
      // Pre-populate the session map via loading from disk
      const entries: [string, string][] = [];
      for (let i = 0; i < 10_000; i++) {
        entries.push([`bind-old:chat:${i}`, `session-${i}`]);
      }
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(entries));

      const evictionRouter = new BindingRouter({
        bindingStore: mockBindingStore as BindingStore,
        relayCore: mockRelayCore,
        agentManager: mockAgentManager,
        meshCore: mockMeshCore,
        relayDir: '/tmp/relay',
      });
      await evictionRouter.init();

      const evictionHandler = (mockRelayCore.subscribe as ReturnType<typeof vi.fn>).mock.calls.at(
        -1,
      )?.[1] as typeof capturedHandler;

      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-new',
        adapterId: 'telegram',
        agentId: 'agent-a',
  
        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      // This should trigger eviction of the oldest entry
      await evictionHandler!({
        id: 'msg-new',
        subject: 'relay.human.telegram.new-chat',
        payload: 'hi',
        from: 'tg',
        budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      // The session map should still be at MAX_SESSIONS (oldest evicted)
      // Verify by checking that routing to bind-old:chat:0 creates a new session
      // (it was evicted)
      vi.mocked(mockAgentManager.createSession).mockClear();
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-old',
        adapterId: 'telegram',
        agentId: 'agent-a',
  
        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      await evictionHandler!({
        id: 'msg-evicted',
        subject: 'relay.human.telegram.0',
        payload: 'hi',
        from: 'tg',
        budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      // Should create a new session because the old entry was evicted
      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);

      await evictionRouter.shutdown();
    });
  });

  describe('saveSessionMap error handling', () => {
    it('does not throw when saveSessionMap fails during session creation', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'telegram',
        agentId: 'agent-a',
  
        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      // Mock writeFile to reject — simulates disk full or permission error
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('ENOSPC: no space left'));

      // Should not throw — the session should still be created in memory
      await expect(
        capturedHandler!({
          id: 'msg-1',
          subject: 'relay.human.telegram.123',
          payload: 'hi',
          from: 'tg',
          budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      ).resolves.toBeUndefined();

      // Session was still created and routed successfully
      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);
      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        'relay.agent.session-abc',
        'hi',
        expect.any(Object),
      );
    });

    it('does not throw when saveSessionMap fails during cleanup', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'telegram',
        agentId: 'agent-a',
  
        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      // Create a session first
      await capturedHandler!({
        id: 'msg-1',
        subject: 'relay.human.telegram.123',
        payload: 'hi',
        from: 'tg',
        budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      // Mock writeFile to reject for the cleanup save
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('ENOSPC: no space left'));

      // Should not throw — cleanup should succeed even when persist fails
      await expect(
        router.cleanupOrphanedSessions(new Set()),
      ).resolves.toBe(1);
    });

    it('does not throw when saveSessionMap fails during shutdown', async () => {
      // Mock writeFile to reject
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('ENOSPC: no space left'));

      // Should not throw
      await expect(router.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('permission enforcement', () => {
    const makeEnvelope = (chatId = '123') => ({
      id: 'msg-1',
      subject: `relay.human.telegram.${chatId}`,
      payload: { content: 'hello' },
      from: 'tg',
      budget: { hopCount: 0, maxHops: 5, ttl: Date.now() + 60000, callBudgetRemaining: 10, ancestorChain: [] },
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const makeBinding = (overrides: Record<string, unknown> = {}) => ({
      id: 'bind-1',
      adapterId: 'telegram',
      agentId: 'agent-a',
      sessionStrategy: 'per-chat',
      label: '',
      canInitiate: false,
      canReply: true,
      canReceive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    });

    it('drops inbound messages when canReceive=false', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding({ canReceive: false }));
      await capturedHandler!(makeEnvelope());

      expect(mockRelayCore.publish).not.toHaveBeenCalled();
      expect(mockAgentManager.createSession).not.toHaveBeenCalled();
    });

    it('allows inbound messages when canReceive=true (default)', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding({ canReceive: true }));
      await capturedHandler!(makeEnvelope());

      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        expect.stringContaining('relay.agent.'),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('includes __bindingPermissions in enriched payload', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(
        makeBinding({ canReply: true, canInitiate: false }),
      );
      await capturedHandler!(makeEnvelope());

      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          __bindingPermissions: {
            canReply: true,
            canInitiate: false,
          },
        }),
        expect.any(Object),
      );
    });

    it('includes canReply=false in __bindingPermissions when set', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(
        makeBinding({ canReply: false }),
      );
      await capturedHandler!(makeEnvelope());

      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          __bindingPermissions: {
            canReply: false,
            canInitiate: false,
          },
        }),
        expect.any(Object),
      );
    });

    it('includes canInitiate=true in __bindingPermissions when set', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(
        makeBinding({ canInitiate: true }),
      );
      await capturedHandler!(makeEnvelope());

      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          __bindingPermissions: {
            canReply: true,
            canInitiate: true,
          },
        }),
        expect.any(Object),
      );
    });

    it('does not attach __bindingPermissions to non-object payloads', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding());
      await capturedHandler!({
        ...makeEnvelope(),
        payload: 'plain string',
      });

      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        expect.any(String),
        'plain string',
        expect.any(Object),
      );
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
