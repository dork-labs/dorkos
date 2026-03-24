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
          { key: 'b1:chat:12345', chatId: '12345', sessionId: 'session-aaa' },
          { key: 'b1:chat:67890', chatId: '67890', sessionId: 'session-bbb' },
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
          { key: 'b1:chat:12345', bindingId: 'b1', chatId: '12345', sessionId: 'session-aaa' },
          { key: 'b1:chat:67890', bindingId: 'b1', chatId: '67890', sessionId: 'session-bbb' },
          { key: 'b2:chat:11111', bindingId: 'b2', chatId: '11111', sessionId: 'session-ccc' },
          { key: 'b2:user:alice', bindingId: 'b2', chatId: 'alice', sessionId: 'session-ddd' },
        ])
      );
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
        { key: 'b3:chat:foo:bar:baz', chatId: 'foo:bar:baz', sessionId: 'session-colon' },
      ]);

      const all = colonRouter.getAllSessions();
      expect(all).toEqual([
        {
          key: 'b3:chat:foo:bar:baz',
          bindingId: 'b3',
          chatId: 'foo:bar:baz',
          sessionId: 'session-colon',
        },
      ]);

      await colonRouter.shutdown();
    });
  });
});
