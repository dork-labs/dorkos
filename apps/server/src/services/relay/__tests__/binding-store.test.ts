import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BindingStore } from '../binding-store.js';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';

vi.mock('node:fs/promises');
vi.mock('chokidar', () => ({
  default: { watch: () => ({ on: vi.fn(), close: vi.fn() }) },
}));

describe('BindingStore', () => {
  let store: BindingStore;

  beforeEach(async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue();
    vi.mocked(rename).mockResolvedValue();
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
        agentDir: '/agents/a',
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
        agentDir: '/agents/a',
      });
      expect(binding.sessionStrategy).toBe('per-chat');
      expect(binding.label).toBe('');
    });

    it('deletes a binding and returns true', async () => {
      const binding = await store.create({
        adapterId: 'telegram-1',
        agentId: 'agent-a',
        agentDir: '/agents/a',
      });
      expect(await store.delete(binding.id)).toBe(true);
      expect(store.getById(binding.id)).toBeUndefined();
    });

    it('returns false when deleting non-existent binding', async () => {
      expect(await store.delete('non-existent')).toBe(false);
    });

    it('filters by adapterId', async () => {
      await store.create({ adapterId: 'tg-1', agentId: 'a', agentDir: '/a' });
      await store.create({ adapterId: 'tg-2', agentId: 'b', agentDir: '/b' });
      await store.create({ adapterId: 'tg-1', agentId: 'c', agentDir: '/c' });
      expect(store.getByAdapterId('tg-1')).toHaveLength(2);
      expect(store.getByAdapterId('tg-2')).toHaveLength(1);
      expect(store.getByAdapterId('tg-3')).toHaveLength(0);
    });

    it('persists to disk on create', async () => {
      await store.create({
        adapterId: 'tg-1',
        agentId: 'a',
        agentDir: '/a',
      });
      expect(writeFile).toHaveBeenCalled();
      expect(rename).toHaveBeenCalled();
    });

    it('persists to disk on delete', async () => {
      const binding = await store.create({
        adapterId: 'tg-1',
        agentId: 'a',
        agentDir: '/a',
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

  describe('resolve()', () => {
    it('returns undefined when no bindings exist for adapterId', () => {
      expect(store.resolve('unknown')).toBeUndefined();
    });

    it('matches wildcard binding (adapterId only)', async () => {
      const b = await store.create({ adapterId: 'tg', agentId: 'a', agentDir: '/a' });
      expect(store.resolve('tg', '12345')?.id).toBe(b.id);
    });

    it('matches wildcard binding without chatId', async () => {
      const b = await store.create({ adapterId: 'tg', agentId: 'a', agentDir: '/a' });
      expect(store.resolve('tg')?.id).toBe(b.id);
    });

    it('prefers chatId match over wildcard', async () => {
      const wildcard = await store.create({ adapterId: 'tg', agentId: 'a', agentDir: '/a' });
      const specific = await store.create({
        adapterId: 'tg',
        agentId: 'b',
        agentDir: '/b',
        chatId: '123',
      });
      expect(store.resolve('tg', '123')?.id).toBe(specific.id);
      expect(store.resolve('tg', '999')?.id).toBe(wildcard.id);
    });

    it('prefers channelType match over wildcard', async () => {
      const wildcard = await store.create({ adapterId: 'tg', agentId: 'a', agentDir: '/a' });
      const channelSpecific = await store.create({
        adapterId: 'tg',
        agentId: 'b',
        agentDir: '/b',
        channelType: 'dm',
      });
      expect(store.resolve('tg', '123', 'dm')?.id).toBe(channelSpecific.id);
      expect(store.resolve('tg', '123', 'group')?.id).toBe(wildcard.id);
    });

    it('prefers chatId+channelType over chatId alone', async () => {
      const chatOnly = await store.create({
        adapterId: 'tg',
        agentId: 'a',
        agentDir: '/a',
        chatId: '123',
      });
      const chatAndChannel = await store.create({
        adapterId: 'tg',
        agentId: 'b',
        agentDir: '/b',
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
        agentDir: '/a',
        chatId: '123',
      });
      // No wildcard binding exists, so mismatch yields no result
      expect(store.resolve('tg', '999')).toBeUndefined();
    });

    it('returns 0 score on explicit channelType mismatch', async () => {
      await store.create({
        adapterId: 'tg',
        agentId: 'a',
        agentDir: '/a',
        channelType: 'dm',
      });
      // No wildcard binding exists, so mismatch yields no result
      expect(store.resolve('tg', '123', 'group')).toBeUndefined();
    });

    it('handles multiple bindings with correct priority ordering', async () => {
      const wildcard = await store.create({
        adapterId: 'tg',
        agentId: 'agent-wild',
        agentDir: '/w',
      });
      const channelOnly = await store.create({
        adapterId: 'tg',
        agentId: 'agent-channel',
        agentDir: '/c',
        channelType: 'dm',
      });
      const chatOnly = await store.create({
        adapterId: 'tg',
        agentId: 'agent-chat',
        agentDir: '/ch',
        chatId: '123',
      });
      const exact = await store.create({
        adapterId: 'tg',
        agentId: 'agent-exact',
        agentDir: '/e',
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
      await store.create({ adapterId: 'known-1', agentId: 'a', agentDir: '/a' });
      await store.create({ adapterId: 'unknown-1', agentId: 'b', agentDir: '/b' });
      const orphaned = store.getOrphaned(['known-1']);
      expect(orphaned).toHaveLength(1);
      expect(orphaned[0].adapterId).toBe('unknown-1');
    });

    it('returns empty array when all adapters are known', async () => {
      await store.create({ adapterId: 'known-1', agentId: 'a', agentDir: '/a' });
      expect(store.getOrphaned(['known-1'])).toHaveLength(0);
    });

    it('returns all bindings when no adapters are known', async () => {
      await store.create({ adapterId: 'tg-1', agentId: 'a', agentDir: '/a' });
      await store.create({ adapterId: 'tg-2', agentId: 'b', agentDir: '/b' });
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
            agentDir: '/agents/alpha',
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
        'telegram-main',
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
  });

  describe('shutdown()', () => {
    it('clears all bindings on shutdown', async () => {
      await store.create({ adapterId: 'tg', agentId: 'a', agentDir: '/a' });
      expect(store.getAll()).toHaveLength(1);
      await store.shutdown();
      expect(store.getAll()).toEqual([]);
    });
  });
});
