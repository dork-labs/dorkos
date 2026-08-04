import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BindingRouter, type RelayCoreLike, type AgentSessionCreator } from '../binding-router.js';
import type { BindingStore } from '../binding-store.js';
import type { AdapterMeshCoreLike } from '../adapter-manager.js';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';

vi.mock('node:fs/promises');

describe('BindingRouter getters', () => {
  let router: BindingRouter;
  let mockRelayCore: RelayCoreLike;
  let mockAgentManager: AgentSessionCreator;
  let mockMeshCore: AdapterMeshCoreLike;
  let mockBindingStore: Partial<BindingStore>;

  /** Seed entries loaded via sessions.json on init(). */
  const seedEntries: [string, string][] = [
    ['b1:chat:12345', 'session-aaa'],
    ['b1:chat:67890', 'session-bbb'],
    ['b2:chat:11111', 'session-ccc'],
    ['b2:user:alice', 'session-ddd'],
  ];

  beforeEach(async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(seedEntries));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue();
    vi.mocked(rename).mockResolvedValue();

    mockRelayCore = {
      publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      subscribe: vi.fn(() => vi.fn()),
    };

    mockAgentManager = {
      createSession: vi.fn().mockResolvedValue({ id: 'session-new' }),
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

  describe('getSessionsByBinding()', () => {
    it('returns only sessions matching the binding ID', () => {
      const results = router.getSessionsByBinding('b1');
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.key.startsWith('b1:'))).toBe(true);
      expect(results).toEqual(
        expect.arrayContaining([
          {
            key: 'b1:chat:12345',
            scope: 'chat',
            chatId: '12345',
            sessionId: 'session-aaa',
            lastActivityAt: 0,
          },
          {
            key: 'b1:chat:67890',
            scope: 'chat',
            chatId: '67890',
            sessionId: 'session-bbb',
            lastActivityAt: 0,
          },
        ])
      );
    });

    it('returns empty array for unknown binding', () => {
      const results = router.getSessionsByBinding('nonexistent');
      expect(results).toEqual([]);
    });

    it('correctly parses chatId from colon-delimited key', () => {
      const results = router.getSessionsByBinding('b1');
      const entry = results.find((r) => r.key === 'b1:chat:12345');
      expect(entry).toBeDefined();
      expect(entry!.chatId).toBe('12345');
    });
  });

  describe('getAllSessions()', () => {
    it('returns all sessions with bindingId extracted', () => {
      const results = router.getAllSessions();
      expect(results).toHaveLength(seedEntries.length);
      expect(results).toEqual(
        expect.arrayContaining([
          {
            key: 'b1:chat:12345',
            bindingId: 'b1',
            scope: 'chat',
            chatId: '12345',
            sessionId: 'session-aaa',
            lastActivityAt: 0,
          },
          {
            key: 'b1:chat:67890',
            bindingId: 'b1',
            scope: 'chat',
            chatId: '67890',
            sessionId: 'session-bbb',
            lastActivityAt: 0,
          },
          {
            key: 'b2:chat:11111',
            bindingId: 'b2',
            scope: 'chat',
            chatId: '11111',
            sessionId: 'session-ccc',
            lastActivityAt: 0,
          },
          // A per-user key names a PERSON. Reported as a chat id (which is what
          // this test used to assert), it addressed the wrong conversation.
          {
            key: 'b2:user:alice',
            bindingId: 'b2',
            scope: 'user',
            userId: 'alice',
            sessionId: 'session-ddd',
            lastActivityAt: 0,
          },
        ])
      );
    });
  });

  describe('takeChatSession (chats-as-channels §7.2/§7.3 migration off sessionMap)', () => {
    it('takes and removes the single {bindingId}:chat:{chatId} entry, persisting the map', async () => {
      const taken = await router.takeChatSession('b1', '12345');
      expect(taken).toEqual({ sessionId: 'session-aaa' });
      // Gone from the map afterwards — a bridged binding vacates sessionMap.
      expect(router.getSessionsByBinding('b1').map((s) => s.key)).not.toContain('b1:chat:12345');
      expect(router.getSessionsByBinding('b1')).toHaveLength(1);
      // Persisted (the atomic rename ran once for the removal).
      expect(vi.mocked(writeFile)).toHaveBeenCalled();
    });

    it('returns undefined when there is no chat entry for the pair', async () => {
      expect(await router.takeChatSession('b1', 'nonexistent')).toBeUndefined();
    });

    it('never takes a per-user session — the key identifies the conversation, not the person', async () => {
      // b2 has a `:user:alice` session but no `:chat:alice` one, so a chat-keyed
      // take finds nothing and the caller starts fresh.
      expect(await router.takeChatSession('b2', 'alice')).toBeUndefined();
      expect(router.getSessionsByBinding('b2').map((s) => s.key)).toContain('b2:user:alice');
    });
  });

  describe('return value isolation', () => {
    it('getSessionsByBinding returns a copy — mutations do not affect internal state', () => {
      const first = router.getSessionsByBinding('b1');
      first.length = 0; // mutate the returned array

      const second = router.getSessionsByBinding('b1');
      expect(second).toHaveLength(2);
    });

    it('getAllSessions returns a copy — mutations do not affect internal state', () => {
      const first = router.getAllSessions();
      first.length = 0; // mutate the returned array

      const second = router.getAllSessions();
      expect(second).toHaveLength(seedEntries.length);
    });
  });

  describe('chat IDs with colons (edge case)', () => {
    it('handles chatId containing colons by joining remaining parts', async () => {
      // Load a session map entry whose chatId portion contains colons
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify([['b3:chat:foo:bar:baz', 'session-colon']])
      );

      const colonRouter = new BindingRouter({
        bindingStore: mockBindingStore as BindingStore,
        relayCore: mockRelayCore,
        agentManager: mockAgentManager,
        meshCore: mockMeshCore,
        relayDir: '/tmp/relay',
      });
      await colonRouter.init();

      const byBinding = colonRouter.getSessionsByBinding('b3');
      expect(byBinding).toEqual([
        {
          key: 'b3:chat:foo:bar:baz',
          scope: 'chat',
          chatId: 'foo:bar:baz',
          sessionId: 'session-colon',
          lastActivityAt: 0,
        },
      ]);

      const all = colonRouter.getAllSessions();
      expect(all).toEqual([
        {
          key: 'b3:chat:foo:bar:baz',
          bindingId: 'b3',
          scope: 'chat',
          chatId: 'foo:bar:baz',
          sessionId: 'session-colon',
          lastActivityAt: 0,
        },
      ]);

      await colonRouter.shutdown();
    });
  });
});
