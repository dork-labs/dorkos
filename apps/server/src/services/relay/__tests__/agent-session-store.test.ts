import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentSessionStore } from '../agent-session-store.js';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';

vi.mock('node:fs/promises');

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('AgentSessionStore', () => {
  let store: AgentSessionStore;

  beforeEach(async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(rename).mockResolvedValue(undefined);

    store = new AgentSessionStore('/tmp/relay');
    await store.init();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('init()', () => {
    it('starts with empty state when file does not exist (ENOENT)', () => {
      expect(store.get('any-agent')).toBeUndefined();
    });

    it('loads existing mappings from disk', async () => {
      const existingData = {
        'agent-ulid-1': {
          sdkSessionId: 'sdk-uuid-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        'agent-ulid-2': {
          sdkSessionId: 'sdk-uuid-2',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      };
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(existingData));

      const freshStore = new AgentSessionStore('/tmp/relay');
      await freshStore.init();

      expect(freshStore.get('agent-ulid-1')).toBe('sdk-uuid-1');
      expect(freshStore.get('agent-ulid-2')).toBe('sdk-uuid-2');
    });

    it('handles corrupt JSON gracefully — starts with empty state', async () => {
      vi.mocked(readFile).mockResolvedValueOnce('not-valid-json');

      const freshStore = new AgentSessionStore('/tmp/relay');
      await freshStore.init();

      expect(freshStore.get('any-agent')).toBeUndefined();
    });

    it('handles unexpected read errors gracefully — starts with empty state', async () => {
      vi.mocked(readFile).mockRejectedValueOnce(new Error('permission denied'));

      const freshStore = new AgentSessionStore('/tmp/relay');
      await freshStore.init();

      expect(freshStore.get('any-agent')).toBeUndefined();
    });
  });

  describe('get()', () => {
    it('returns undefined for an unknown agentId', () => {
      expect(store.get('unknown-agent')).toBeUndefined();
    });

    it('returns the sdkSessionId after a set()', () => {
      store.set('agent-a', 'sdk-session-123');
      expect(store.get('agent-a')).toBe('sdk-session-123');
    });

    it('returns updated value after multiple set() calls', () => {
      store.set('agent-a', 'sdk-session-v1');
      store.set('agent-a', 'sdk-session-v2');
      expect(store.get('agent-a')).toBe('sdk-session-v2');
    });

    it('returns undefined after delete()', () => {
      store.set('agent-a', 'sdk-session-123');
      store.delete('agent-a');
      expect(store.get('agent-a')).toBeUndefined();
    });
  });

  describe('set()', () => {
    it('persists to disk after setting a mapping', async () => {
      store.set('agent-a', 'sdk-uuid-a');

      // Allow async persist to fire
      await vi.waitFor(() => {
        expect(vi.mocked(writeFile)).toHaveBeenCalled();
        expect(vi.mocked(rename)).toHaveBeenCalled();
      });
    });

    it('writes the mapping in correct JSON format', async () => {
      store.set('agent-x', 'sdk-uuid-x');

      await vi.waitFor(() => {
        expect(vi.mocked(writeFile)).toHaveBeenCalled();
      });

      const writtenJson = vi.mocked(writeFile).mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenJson);
      expect(parsed['agent-x']).toBeDefined();
      expect(parsed['agent-x'].sdkSessionId).toBe('sdk-uuid-x');
      expect(parsed['agent-x'].createdAt).toBeDefined();
      expect(parsed['agent-x'].updatedAt).toBeDefined();
    });

    it('preserves createdAt when updating an existing mapping', async () => {
      store.set('agent-b', 'sdk-uuid-b-v1');

      await vi.waitFor(() => {
        expect(vi.mocked(writeFile)).toHaveBeenCalled();
      });

      const firstWritten = vi.mocked(writeFile).mock.calls[0][1] as string;
      const firstParsed = JSON.parse(firstWritten);
      const originalCreatedAt = firstParsed['agent-b'].createdAt;

      vi.mocked(writeFile).mockClear();
      vi.mocked(rename).mockClear();

      store.set('agent-b', 'sdk-uuid-b-v2');

      await vi.waitFor(() => {
        expect(vi.mocked(writeFile)).toHaveBeenCalled();
      });

      const secondWritten = vi.mocked(writeFile).mock.calls[0][1] as string;
      const secondParsed = JSON.parse(secondWritten);
      expect(secondParsed['agent-b'].createdAt).toBe(originalCreatedAt);
      expect(secondParsed['agent-b'].sdkSessionId).toBe('sdk-uuid-b-v2');
    });

    it('creates parent directory before writing', async () => {
      store.set('agent-c', 'sdk-uuid-c');

      await vi.waitFor(() => {
        expect(vi.mocked(mkdir)).toHaveBeenCalledWith(expect.stringContaining('relay'), {
          recursive: true,
        });
      });
    });

    it('writes to tmp file then renames atomically', async () => {
      store.set('agent-d', 'sdk-uuid-d');

      await vi.waitFor(() => {
        expect(vi.mocked(rename)).toHaveBeenCalled();
      });

      const tmpPath = vi.mocked(writeFile).mock.calls[0][0] as string;
      const finalPath = vi.mocked(rename).mock.calls[0][1] as string;
      expect(tmpPath).toMatch(/\.tmp$/);
      expect(finalPath).not.toMatch(/\.tmp$/);
      expect(finalPath).toMatch(/agent-sessions\.json$/);
    });

    it('does not throw when persist fails', async () => {
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));

      // set() is synchronous and should not throw even if persist fails
      expect(() => store.set('agent-e', 'sdk-uuid-e')).not.toThrow();

      // In-memory state should still be updated
      expect(store.get('agent-e')).toBe('sdk-uuid-e');
    });
  });

  describe('delete()', () => {
    it('removes the mapping from in-memory state', () => {
      store.set('agent-a', 'sdk-uuid-a');
      store.delete('agent-a');
      expect(store.get('agent-a')).toBeUndefined();
    });

    it('is a no-op for unknown agentId', () => {
      expect(() => store.delete('non-existent')).not.toThrow();
    });

    it('persists after delete', async () => {
      store.set('agent-a', 'sdk-uuid-a');

      await vi.waitFor(() => {
        expect(vi.mocked(writeFile)).toHaveBeenCalled();
      });

      vi.mocked(writeFile).mockClear();
      vi.mocked(rename).mockClear();

      store.delete('agent-a');

      await vi.waitFor(() => {
        expect(vi.mocked(writeFile)).toHaveBeenCalled();
        expect(vi.mocked(rename)).toHaveBeenCalled();
      });
    });

    it('does not throw when persist after delete fails', () => {
      store.set('agent-a', 'sdk-uuid-a');
      vi.mocked(writeFile).mockRejectedValue(new Error('disk full'));

      expect(() => store.delete('agent-a')).not.toThrow();
    });

    it('deleted mapping is absent from persisted JSON', async () => {
      store.set('agent-a', 'sdk-uuid-a');
      store.set('agent-b', 'sdk-uuid-b');

      await vi.waitFor(() => {
        expect(vi.mocked(writeFile)).toHaveBeenCalled();
      });

      vi.mocked(writeFile).mockClear();

      store.delete('agent-a');

      await vi.waitFor(() => {
        expect(vi.mocked(writeFile)).toHaveBeenCalled();
      });

      const writtenJson = vi.mocked(writeFile).mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenJson);
      expect(parsed['agent-a']).toBeUndefined();
      expect(parsed['agent-b']).toBeDefined();
    });
  });

  describe('AgentSessionStoreLike interface', () => {
    it('satisfies the get/set interface consumed by ClaudeCodeAdapter', () => {
      // Verify the store conforms to the minimal interface
      const storeLike: {
        get: (id: string) => string | undefined;
        set: (id: string, sessionId: string) => void;
      } = store;
      storeLike.set('iface-agent', 'iface-sdk-uuid');
      expect(storeLike.get('iface-agent')).toBe('iface-sdk-uuid');
    });
  });
});
