import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BindingStore } from '../binding-store.js';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';

vi.mock('node:fs/promises');
/** Captured chokidar 'change' handler so tests can fire it manually. */
let chokidarChangeHandler: (() => Promise<void>) | undefined;

vi.mock('chokidar', () => ({
  default: {
    watch: () => ({
      on: vi.fn((event: string, handler: () => Promise<void>) => {
        if (event === 'change') chokidarChangeHandler = handler;
      }),
      close: vi.fn(),
    }),
  },
}));

describe('BindingStore', () => {
  let store: BindingStore;
  /** Auto-incrementing mtime so each save() gets a unique value. */
  let nextMtime: number;

  beforeEach(async () => {
    chokidarChangeHandler = undefined;
    nextMtime = 1000;
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue();
    vi.mocked(rename).mockResolvedValue();
    vi.mocked(stat).mockImplementation(async () => {
      const mtime = nextMtime++;
      return { mtimeMs: mtime } as Awaited<ReturnType<typeof stat>>;
    });
    store = new BindingStore('/tmp/relay');
    await store.init();
  });

  afterEach(async () => {
    await store.shutdown();
    vi.restoreAllMocks();
  });

  describe('CRUD', () => {
    it('starts empty when no file exists', () => {
      expect(store.getAll()).toEqual([]);
    });

    it('creates a binding with generated id and timestamps', async () => {
      const binding = await store.create({
        adapterId: 'telegram-1',
        agentId: 'agent-a',
        sessionStrategy: 'per-chat',
        label: 'Test',
      });
      expect(binding.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(binding.createdAt).toBeDefined();
      expect(binding.updatedAt).toBeDefined();
      expect(binding.adapterId).toBe('telegram-1');
      expect(binding.label).toBe('Test');
      expect(store.getById(binding.id)).toEqual(binding);
    });

    it('creates a binding with default sessionStrategy and label', async () => {
      const binding = await store.create({
        adapterId: 'telegram-1',
        agentId: 'agent-a',
      });
      expect(binding.sessionStrategy).toBe('per-chat');
      expect(binding.label).toBe('');
    });

    it('deletes a binding and returns true', async () => {
      const binding = await store.create({
        adapterId: 'telegram-1',
        agentId: 'agent-a',
      });
      expect(await store.delete(binding.id)).toBe(true);
      expect(store.getById(binding.id)).toBeUndefined();
    });

    it('returns false when deleting non-existent binding', async () => {
      expect(await store.delete('non-existent')).toBe(false);
    });

    it('filters by adapterId', async () => {
      await store.create({ adapterId: 'tg-1', agentId: 'a' });
      await store.create({ adapterId: 'tg-2', agentId: 'b' });
      await store.create({ adapterId: 'tg-1', agentId: 'c' });
      expect(store.getByAdapterId('tg-1')).toHaveLength(2);
      expect(store.getByAdapterId('tg-2')).toHaveLength(1);
      expect(store.getByAdapterId('tg-3')).toHaveLength(0);
    });

    it('persists to disk on create', async () => {
      await store.create({
        adapterId: 'tg-1',
        agentId: 'a',
      });
      expect(writeFile).toHaveBeenCalled();
      expect(rename).toHaveBeenCalled();
    });

    it('persists to disk on delete', async () => {
      const binding = await store.create({
        adapterId: 'tg-1',
        agentId: 'a',
      });
      vi.mocked(writeFile).mockClear();
      vi.mocked(rename).mockClear();
      await store.delete(binding.id);
      expect(writeFile).toHaveBeenCalled();
      expect(rename).toHaveBeenCalled();
    });

    it('does not persist on failed delete', async () => {
      vi.mocked(writeFile).mockClear();
      vi.mocked(rename).mockClear();
      await store.delete('non-existent');
      expect(writeFile).not.toHaveBeenCalled();
    });
  });

  describe('update()', () => {
    it('updates mutable fields and preserves immutable fields', async () => {
      const binding = await store.create({
        adapterId: 'telegram-1',
        agentId: 'agent-1',
        sessionStrategy: 'per-chat',
      });
      const updated = await store.update(binding.id, {
        sessionStrategy: 'stateless',
        label: 'test-label',
      });
      expect(updated).toBeDefined();
      expect(updated!.sessionStrategy).toBe('stateless');
      expect(updated!.label).toBe('test-label');
      // updatedAt is refreshed (ISO 8601 format)
      expect(typeof updated!.updatedAt).toBe('string');
      expect(new Date(updated!.updatedAt).toISOString()).toBe(updated!.updatedAt);
      // Original immutable fields preserved
      expect(updated!.adapterId).toBe('telegram-1');
      expect(updated!.agentId).toBe('agent-1');
      expect(updated!.id).toBe(binding.id);
      expect(updated!.createdAt).toBe(binding.createdAt);
    });

    it('returns undefined for non-existent binding', async () => {
      const result = await store.update('nonexistent-id', { label: 'test' });
      expect(result).toBeUndefined();
    });

    it('persists updates to disk', async () => {
      const binding = await store.create({
        adapterId: 'telegram-1',
        agentId: 'agent-1',
      });
      vi.mocked(writeFile).mockClear();
      vi.mocked(rename).mockClear();
      await store.update(binding.id, { label: 'persisted-label' });
      expect(writeFile).toHaveBeenCalled();
      expect(rename).toHaveBeenCalled();
    });

    it('does not persist when binding not found', async () => {
      vi.mocked(writeFile).mockClear();
      vi.mocked(rename).mockClear();
      await store.update('non-existent', { label: 'test' });
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('updates chatId and channelType fields', async () => {
      const binding = await store.create({
        adapterId: 'telegram-1',
        agentId: 'agent-1',
      });
      const updated = await store.update(binding.id, {
        chatId: '12345',
        channelType: 'dm',
      });
      expect(updated!.chatId).toBe('12345');
      expect(updated!.channelType).toBe('dm');
    });

    it('reflects update in getById', async () => {
      const binding = await store.create({
        adapterId: 'telegram-1',
        agentId: 'agent-1',
        label: 'old',
      });
      await store.update(binding.id, { label: 'new' });
      expect(store.getById(binding.id)?.label).toBe('new');
    });
  });

  describe('resolve()', () => {
    it('returns undefined when no bindings exist for adapterId', () => {
      expect(store.resolve('unknown')).toBeUndefined();
    });

    it('matches wildcard binding (adapterId only)', async () => {
      const b = await store.create({ adapterId: 'tg', agentId: 'a' });
      expect(store.resolve('tg', '12345')?.id).toBe(b.id);
    });

    it('matches wildcard binding without chatId', async () => {
      const b = await store.create({ adapterId: 'tg', agentId: 'a' });
      expect(store.resolve('tg')?.id).toBe(b.id);
    });

    it('prefers chatId match over wildcard', async () => {
      const wildcard = await store.create({ adapterId: 'tg', agentId: 'a' });
      const specific = await store.create({
        adapterId: 'tg',
        agentId: 'b',
        chatId: '123',
      });
      expect(store.resolve('tg', '123')?.id).toBe(specific.id);
      expect(store.resolve('tg', '999')?.id).toBe(wildcard.id);
    });

    it('prefers channelType match over wildcard', async () => {
      const wildcard = await store.create({ adapterId: 'tg', agentId: 'a' });
      const channelSpecific = await store.create({
        adapterId: 'tg',
        agentId: 'b',
        channelType: 'dm',
      });
      expect(store.resolve('tg', '123', 'dm')?.id).toBe(channelSpecific.id);
      expect(store.resolve('tg', '123', 'group')?.id).toBe(wildcard.id);
    });

    it('prefers chatId+channelType over chatId alone', async () => {
      const chatOnly = await store.create({
        adapterId: 'tg',
        agentId: 'a',
        chatId: '123',
      });
      const chatAndChannel = await store.create({
        adapterId: 'tg',
        agentId: 'b',
        chatId: '123',
        channelType: 'dm',
      });
      expect(store.resolve('tg', '123', 'dm')?.id).toBe(chatAndChannel.id);
      expect(store.resolve('tg', '123', 'group')?.id).toBe(chatOnly.id);
    });

    it('returns 0 score (no match) on explicit chatId mismatch', async () => {
      await store.create({
        adapterId: 'tg',
        agentId: 'a',
        chatId: '123',
      });
      // No wildcard binding exists, so mismatch yields no result
      expect(store.resolve('tg', '999')).toBeUndefined();
    });

    it('returns 0 score on explicit channelType mismatch', async () => {
      await store.create({
        adapterId: 'tg',
        agentId: 'a',
        channelType: 'dm',
      });
      // No wildcard binding exists, so mismatch yields no result
      expect(store.resolve('tg', '123', 'group')).toBeUndefined();
    });

    it('handles multiple bindings with correct priority ordering', async () => {
      const wildcard = await store.create({
        adapterId: 'tg',
        agentId: 'agent-wild',
      });
      const channelOnly = await store.create({
        adapterId: 'tg',
        agentId: 'agent-channel',
        channelType: 'dm',
      });
      const chatOnly = await store.create({
        adapterId: 'tg',
        agentId: 'agent-chat',
        chatId: '123',
      });
      const exact = await store.create({
        adapterId: 'tg',
        agentId: 'agent-exact',
        chatId: '123',
        channelType: 'dm',
      });

      // Exact match: score 7
      expect(store.resolve('tg', '123', 'dm')?.id).toBe(exact.id);
      // Chat only match: score 5
      expect(store.resolve('tg', '123', 'group')?.id).toBe(chatOnly.id);
      // Channel only match: score 3
      expect(store.resolve('tg', '999', 'dm')?.id).toBe(channelOnly.id);
      // Wildcard: score 1
      expect(store.resolve('tg', '999', 'group')?.id).toBe(wildcard.id);
    });
  });

  describe('getOrphaned()', () => {
    it('returns bindings with unknown adapter IDs', async () => {
      await store.create({ adapterId: 'known-1', agentId: 'a' });
      await store.create({ adapterId: 'unknown-1', agentId: 'b' });
      const orphaned = store.getOrphaned(['known-1']);
      expect(orphaned).toHaveLength(1);
      expect(orphaned[0].adapterId).toBe('unknown-1');
    });

    it('returns empty array when all adapters are known', async () => {
      await store.create({ adapterId: 'known-1', agentId: 'a' });
      expect(store.getOrphaned(['known-1'])).toHaveLength(0);
    });

    it('returns all bindings when no adapters are known', async () => {
      await store.create({ adapterId: 'tg-1', agentId: 'a' });
      await store.create({ adapterId: 'tg-2', agentId: 'b' });
      expect(store.getOrphaned([])).toHaveLength(2);
    });
  });

  describe('load from disk', () => {
    it('loads existing bindings from file', async () => {
      const existingData = {
        bindings: [
          {
            id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
            adapterId: 'telegram-main',
            agentId: 'agent-1',
            sessionStrategy: 'per-chat',
            label: 'Test',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(existingData));

      const freshStore = new BindingStore('/tmp/relay');
      await freshStore.init();

      expect(freshStore.getAll()).toHaveLength(1);
      expect(freshStore.getById('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBeDefined();
      expect(freshStore.getById('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')?.adapterId).toBe(
        'telegram-main'
      );

      await freshStore.shutdown();
    });

    it('handles malformed JSON gracefully', async () => {
      vi.mocked(readFile).mockResolvedValue('not-valid-json');

      const freshStore = new BindingStore('/tmp/relay');
      await freshStore.init();

      expect(freshStore.getAll()).toEqual([]);
      await freshStore.shutdown();
    });

    it('strips legacy projectPath and agentDir fields on load', async () => {
      const legacyData = {
        bindings: [
          {
            id: 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
            adapterId: 'telegram-main',
            agentId: 'agent-2',
            projectPath: '/legacy/path',
            agentDir: '/legacy/agent/dir',
            sessionStrategy: 'per-chat',
            label: 'Legacy',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(legacyData));

      const freshStore = new BindingStore('/tmp/relay');
      await freshStore.init();

      const loaded = freshStore.getById('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22');
      expect(loaded).toBeDefined();
      expect(loaded).not.toHaveProperty('projectPath');
      expect(loaded).not.toHaveProperty('agentDir');
      expect(loaded?.agentId).toBe('agent-2');

      await freshStore.shutdown();
    });
  });

  describe('shutdown()', () => {
    it('clears all bindings on shutdown', async () => {
      await store.create({ adapterId: 'tg', agentId: 'a' });
      expect(store.getAll()).toHaveLength(1);
      await store.shutdown();
      expect(store.getAll()).toEqual([]);
    });
  });

  describe('mtime-based self-write suppression', () => {
    it('suppresses chokidar change when mtime matches our last write', async () => {
      // save() calls stat() after writing — returns mtime 1000.
      // When chokidar fires, stat() in the handler returns the same mtime → suppressed.
      const writeMtime = nextMtime; // will be used by save()
      await store.create({ adapterId: 'tg', agentId: 'a' });

      const readFileSpy = vi.mocked(readFile);
      readFileSpy.mockClear();

      // Simulate chokidar returning the same mtime as our write
      vi.mocked(stat).mockResolvedValueOnce({
        mtimeMs: writeMtime,
      } as Awaited<ReturnType<typeof stat>>);

      await chokidarChangeHandler?.();

      expect(readFileSpy).not.toHaveBeenCalled();
    });

    it('suppresses only once — second event with same mtime triggers reload', async () => {
      const writeMtime = nextMtime;
      await store.create({ adapterId: 'tg', agentId: 'a' });

      const readFileSpy = vi.mocked(readFile);
      readFileSpy.mockClear();

      // First chokidar event: same mtime as our write → absorbed, clears lastWriteMtime
      vi.mocked(stat).mockResolvedValueOnce({
        mtimeMs: writeMtime,
      } as Awaited<ReturnType<typeof stat>>);
      await chokidarChangeHandler?.();
      expect(readFileSpy).not.toHaveBeenCalled();

      // Second event: same mtime but lastWriteMtime is now null → external change
      vi.mocked(stat).mockResolvedValueOnce({
        mtimeMs: writeMtime,
      } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          bindings: [
            {
              id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
              adapterId: 'external',
              agentId: 'ext-agent',
              sessionStrategy: 'per-chat',
              label: '',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        })
      );

      await chokidarChangeHandler?.();

      expect(readFileSpy).toHaveBeenCalledTimes(1);
      expect(store.getAll()).toHaveLength(1);
      expect(store.getAll()[0].adapterId).toBe('external');
    });

    it('triggers reload when mtime differs from our last write', async () => {
      await store.create({ adapterId: 'tg', agentId: 'a' });

      const readFileSpy = vi.mocked(readFile);
      readFileSpy.mockClear();

      // Chokidar fires with a different mtime (external editor changed the file)
      vi.mocked(stat).mockResolvedValueOnce({
        mtimeMs: 99999,
      } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          bindings: [
            {
              id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
              adapterId: 'external',
              agentId: 'ext-agent',
              sessionStrategy: 'per-chat',
              label: '',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        })
      );

      await chokidarChangeHandler?.();

      expect(readFileSpy).toHaveBeenCalledTimes(1);
      expect(store.getAll()).toHaveLength(1);
      expect(store.getAll()[0].adapterId).toBe('external');
    });
  });
});
