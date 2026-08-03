import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BindingStore } from '../binding-store.js';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { logger } from '../../../lib/logger.js';

vi.mock('node:fs/promises');
/** Captured chokidar 'change' handler so tests can fire it manually. */
let chokidarChangeHandler: (() => Promise<void>) | undefined;
/** Captured chokidar 'error' handler so tests can fire it manually. */
let chokidarErrorHandler: ((err: unknown) => void) | undefined;

vi.mock('chokidar', () => ({
  default: {
    watch: () => ({
      on: vi.fn((event: string, handler: (arg?: unknown) => unknown) => {
        if (event === 'change') chokidarChangeHandler = handler as () => Promise<void>;
        if (event === 'error') chokidarErrorHandler = handler as (err: unknown) => void;
      }),
      close: vi.fn(),
    }),
  },
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  // `load()` passes its caught error through this helper, so the mock must
  // carry it too — a mock missing it fails the module's own error path.
  logError: (err: unknown) =>
    err instanceof Error ? { error: err.message, stack: err.stack } : { error: String(err) },
}));

describe('BindingStore', () => {
  let store: BindingStore;
  /** Auto-incrementing mtime so each save() gets a unique value. */
  let nextMtime: number;

  beforeEach(async () => {
    chokidarChangeHandler = undefined;
    chokidarErrorHandler = undefined;
    vi.mocked(logger.error).mockClear();
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

    // MAJOR-2 (adversarial review, DOR-865): `update()` used to spread the
    // merge with no schema check at all, while `load()` silently DISCARDS an
    // entry that fails `AdapterBindingSchema` on the next restart. So an
    // in-process caller that reached `update` directly — never through the
    // route, which has its own merged-state check — could write
    // `bridge: 'room'` onto a chatId-less binding, have it persist and work
    // fine for the rest of this process's life, and then have `load()` throw
    // it away on the next restart: a binding that looked alive vanishing with
    // no error anywhere. `update()` now validates the MERGED result itself, so
    // this is unreachable from ANY boundary, not just the route's.
    it('rejects an in-process update that would merge into an invalid binding, bypassing the route entirely', async () => {
      const binding = await store.create({
        adapterId: 'telegram-1',
        agentId: 'agent-1',
        // No chatId — bridge: 'room' is invalid on this binding.
      });

      await expect(store.update(binding.id, { bridge: 'room' })).rejects.toThrow(
        'one room cannot honestly be the channel'
      );

      // Rejected before ever touching memory or disk: getById still reports
      // the pre-update binding, and no save was attempted for this call.
      expect(store.getById(binding.id)?.bridge).toBe('off');
    });

    it('never lets the invalid merge reach disk — a fresh load after the rejected update sees the pre-update binding, not a discarded one', async () => {
      const binding = await store.create({
        adapterId: 'telegram-1',
        agentId: 'agent-1',
      });
      // Capture exactly what `create()` wrote — this is "disk" for this test.
      const lastWrite = vi.mocked(writeFile).mock.calls.at(-1)?.[1] as string;
      expect(lastWrite).toBeDefined();

      await expect(store.update(binding.id, { bridge: 'room' })).rejects.toThrow();

      // Simulate a restart: a fresh store loads whatever was actually
      // written to disk before the rejected update — never anything the
      // rejected update might have produced, because it never wrote.
      vi.mocked(readFile).mockResolvedValueOnce(lastWrite);
      const restarted = new BindingStore('/tmp/relay');
      await restarted.init();

      // The binding survived the restart intact — `load()` never had an
      // invalid entry to discard, because `update()` never let one reach
      // disk in the first place.
      const reloaded = restarted.getById(binding.id);
      expect(reloaded).toBeDefined();
      expect(reloaded?.bridge).toBe('off');
      expect(reloaded?.adapterId).toBe('telegram-1');

      await restarted.shutdown();
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

    it('rejects a second binding on the same (adapterId, chatId), even differing only by channelType', async () => {
      // This used to be legal and was exactly the audited "one chat, one
      // agent" bug (connection-scoping spec §Part 2): two bindings tied at
      // the same chatId, one shadowing the other by creation order. Now it's
      // a conflict at creation time, regardless of channelType.
      const chatOnly = await store.create({
        adapterId: 'tg',
        agentId: 'a',
        chatId: '123',
      });
      await expect(
        store.create({ adapterId: 'tg', agentId: 'b', chatId: '123', channelType: 'dm' })
      ).rejects.toMatchObject({ conflict: { id: chatOnly.id, agentId: 'a' } });
      expect(store.resolve('tg', '123', 'dm')?.id).toBe(chatOnly.id);
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

      // Chat match beats channel-only and wildcard regardless of channelType
      // agreement — chatId '123' has exactly one binding (§Part 2 uniqueness).
      expect(store.resolve('tg', '123', 'dm')?.id).toBe(chatOnly.id);
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

    it('loads only valid entries and auto-saves when mix of valid and invalid', async () => {
      const mixedData = {
        bindings: [
          {
            id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
            adapterId: 'telegram-main',
            agentId: 'agent-1',
            sessionStrategy: 'per-chat',
            label: 'Valid',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
            adapterId: 'telegram-main',
            agentId: '', // invalid: empty agentId
            sessionStrategy: 'per-chat',
            label: 'Empty AgentId',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
            adapterId: '', // invalid: empty adapterId
            agentId: 'agent-2',
            sessionStrategy: 'per-chat',
            label: 'Empty AdapterId',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(mixedData));
      vi.mocked(writeFile).mockClear();
      vi.mocked(rename).mockClear();

      const freshStore = new BindingStore('/tmp/relay');
      await freshStore.init();

      expect(freshStore.getAll()).toHaveLength(1);
      expect(freshStore.getById('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBeDefined();
      expect(freshStore.getById('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22')).toBeUndefined();
      expect(freshStore.getById('c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33')).toBeUndefined();
      // Auto-saved the cleaned file
      expect(writeFile).toHaveBeenCalled();
      expect(rename).toHaveBeenCalled();

      await freshStore.shutdown();
    });

    it('loads all entries without re-saving when all are valid', async () => {
      const validData = {
        bindings: [
          {
            id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
            adapterId: 'telegram-main',
            agentId: 'agent-1',
            sessionStrategy: 'per-chat',
            label: 'First',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
            adapterId: 'slack-main',
            agentId: 'agent-2',
            sessionStrategy: 'stateless',
            label: 'Second',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(validData));
      vi.mocked(writeFile).mockClear();
      vi.mocked(rename).mockClear();

      const freshStore = new BindingStore('/tmp/relay');
      await freshStore.init();

      expect(freshStore.getAll()).toHaveLength(2);
      // No re-save when all entries are valid
      expect(writeFile).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();

      await freshStore.shutdown();
    });

    it('handles file with invalid top-level structure gracefully', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ notBindings: [] }));

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

    it('loads a fixture written before bridge/roomId existed, defaulting to off/null and routing as before (A11.2)', async () => {
      const preBridgeData = {
        bindings: [
          {
            id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
            adapterId: 'telegram-main',
            agentId: 'agent-1',
            chatId: '555',
            sessionStrategy: 'per-chat',
            label: 'Pre-bridge binding',
            canInitiate: true,
            canReply: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(preBridgeData));

      const freshStore = new BindingStore('/tmp/relay');
      await freshStore.init();

      const loaded = freshStore.getById('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
      expect(loaded).toBeDefined();
      expect(loaded?.bridge).toBe('off');
      expect(loaded?.roomId).toBeNull();
      // Nothing else about the binding moved — it routes exactly as it did
      // before this field existed.
      expect(loaded?.chatId).toBe('555');
      expect(loaded?.canInitiate).toBe(true);
      expect(loaded?.canReply).toBe(true);

      await freshStore.shutdown();
    });

    it('AC2.6 (revised — see design-decisions.md D3-addendum): a legacy chatId collision is reconciled by DISABLING the loser, never deleting it, and backing it up to a sidecar', async () => {
      // This is the deliberately-preserved successor to a prior version of
      // this test ('prefers chatId+channelType over chatId alone', deleted
      // when the FIRST cut of dedup shipped) — that older test proved main
      // deliberately supports two bindings on one chatId differentiated only
      // by channelType. The first dedup implementation silently deleted one
      // of them on load, which was reversible-in-theory but destroyed real
      // configuration data with no recovery path. This pins the fix: nothing
      // is ever deleted here.
      const OLDER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const NEWER_ID = 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
      const collidingData = {
        bindings: [
          {
            id: OLDER_ID,
            adapterId: 'telegram-main',
            agentId: 'agent-older',
            chatId: '123',
            sessionStrategy: 'per-chat',
            label: 'Older',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: NEWER_ID,
            adapterId: 'telegram-main',
            agentId: 'agent-newer',
            chatId: '123',
            sessionStrategy: 'per-chat',
            label: 'Newer',
            createdAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      };
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(collidingData));
      vi.mocked(writeFile).mockClear();

      const freshStore = new BindingStore('/tmp/relay');
      await freshStore.init();

      // Both rows survive — nothing was deleted.
      expect(freshStore.getAll()).toHaveLength(2);
      const older = freshStore.getById(OLDER_ID);
      const newer = freshStore.getById(NEWER_ID);
      expect(older).toBeDefined();
      expect(newer).toBeDefined();
      // Every other field on the loser is untouched — only `enabled` moved.
      expect(newer).toMatchObject({
        id: NEWER_ID,
        agentId: 'agent-newer',
        chatId: '123',
        label: 'Newer',
        enabled: false,
      });
      expect(older?.enabled).not.toBe(false);

      // resolve() only ever returns the one enabled binding for this chat.
      expect(freshStore.resolve('telegram-main', '123')?.id).toBe(OLDER_ID);

      // Backed up to a recoverable sidecar file, full row, before the
      // reconciled bindings.json was re-saved.
      const sidecarCall = vi
        .mocked(writeFile)
        .mock.calls.find(
          ([path]) => typeof path === 'string' && path.includes('bindings.discarded-')
        );
      expect(sidecarCall).toBeDefined();
      const sidecarBody = JSON.parse(sidecarCall![1] as string) as {
        bindings: Array<{ id: string }>;
      };
      expect(sidecarBody.bindings.map((b) => b.id)).toEqual([NEWER_ID]);

      // The bindings.json write from THIS load (not the sidecar) — what a
      // real restart would read back next time.
      const reconciledWrite = vi
        .mocked(writeFile)
        .mock.calls.find(
          ([path]) => typeof path === 'string' && !path.includes('bindings.discarded-')
        );
      expect(reconciledWrite).toBeDefined();
      const reconciledBody = reconciledWrite![1] as string;

      await freshStore.shutdown();

      // Verification-round fix: a SECOND load of the already-reconciled file
      // must be a no-op — `losers` recomputes on every load (the same
      // already-disabled row still collides on chatId), so without filtering
      // out rows that are ALREADY disabled, every server restart would
      // re-write a fresh sidecar, re-save bindings.json, and re-log
      // "auto-disabled" forever. Pin: no new sidecar, no re-save, same two
      // rows in the same state.
      vi.mocked(readFile).mockResolvedValue(reconciledBody);
      vi.mocked(writeFile).mockClear();

      const secondLoadStore = new BindingStore('/tmp/relay');
      await secondLoadStore.init();

      expect(writeFile).not.toHaveBeenCalled();
      expect(secondLoadStore.getAll()).toHaveLength(2);
      expect(secondLoadStore.getById(OLDER_ID)?.enabled).not.toBe(false);
      expect(secondLoadStore.getById(NEWER_ID)?.enabled).toBe(false);

      await secondLoadStore.shutdown();
    });
  });

  describe('one chat, one agent (connection-scoping spec §Part 2)', () => {
    it('AC2.1: create() throws BindingConflictError on a (adapterId, chatId) collision, carrying the conflicting binding', async () => {
      const first = await store.create({ adapterId: 'tg', agentId: 'agent-a', chatId: '123' });
      await expect(
        store.create({ adapterId: 'tg', agentId: 'agent-b', chatId: '123' })
      ).rejects.toMatchObject({
        name: 'BindingConflictError',
        conflict: { id: first.id, agentId: 'agent-a', chatId: '123' },
      });
      expect(store.getAll()).toHaveLength(1);
    });

    it('a conflict check ignores channelType — colliding on chatId alone is enough (design-decisions.md D3)', async () => {
      await store.create({ adapterId: 'tg', agentId: 'agent-a', chatId: '123' });
      await expect(
        store.create({
          adapterId: 'tg',
          agentId: 'agent-b',
          chatId: '123',
          channelType: 'group',
        })
      ).rejects.toThrow('already bound');
    });

    it('wildcard bindings (no chatId) are exempt from the uniqueness check', async () => {
      await store.create({ adapterId: 'tg', agentId: 'agent-a' });
      const second = await store.create({ adapterId: 'tg', agentId: 'agent-b' });
      expect(second).toBeDefined();
      expect(store.getAll()).toHaveLength(2);
    });

    it('a collision on a DIFFERENT adapterId is not a conflict', async () => {
      await store.create({ adapterId: 'tg', agentId: 'agent-a', chatId: '123' });
      const other = await store.create({ adapterId: 'slack', agentId: 'agent-b', chatId: '123' });
      expect(other).toBeDefined();
    });

    it('AC2.2: update() throws the same conflict when chatId changes onto a taken value', async () => {
      const owner = await store.create({ adapterId: 'tg', agentId: 'agent-a', chatId: '123' });
      const other = await store.create({ adapterId: 'tg', agentId: 'agent-b', chatId: '456' });
      await expect(store.update(other.id, { chatId: '123' })).rejects.toMatchObject({
        name: 'BindingConflictError',
        conflict: { id: owner.id },
      });
      // The other binding kept its original chatId.
      expect(store.getById(other.id)?.chatId).toBe('456');
    });

    it('update() does not conflict with itself when chatId is unchanged', async () => {
      const binding = await store.create({ adapterId: 'tg', agentId: 'agent-a', chatId: '123' });
      const updated = await store.update(binding.id, { label: 'renamed' });
      expect(updated?.label).toBe('renamed');
    });

    describe('moveToAgent()', () => {
      it('AC2.3: re-points agentId on the SAME binding id, in place', async () => {
        const binding = await store.create({ adapterId: 'tg', agentId: 'agent-a', chatId: '123' });
        const moved = await store.moveToAgent(binding.id, 'agent-b');
        expect(moved).toMatchObject({ id: binding.id, agentId: 'agent-b', chatId: '123' });
        expect(store.getAll()).toHaveLength(1);
        expect(store.getById(binding.id)?.agentId).toBe('agent-b');
      });

      it('returns undefined for an unknown binding id', async () => {
        expect(await store.moveToAgent('does-not-exist', 'agent-b')).toBeUndefined();
      });
    });

    describe('resolve() vs resolveIncludingDisabled()', () => {
      it('AC2.4: a disabled specific binding never wins resolve() over an enabled wildcard — the fallback wins', async () => {
        const wildcard = await store.create({ adapterId: 'tg', agentId: 'agent-wild' });
        const specific = await store.create({
          adapterId: 'tg',
          agentId: 'agent-specific',
          chatId: '123',
        });
        await store.update(specific.id, { enabled: false });

        // Negative control: without the enabled filter, the disabled specific
        // binding would score higher (5 > 1) and win — proving this isn't
        // vacuously true because nothing else could match.
        expect(store.resolveIncludingDisabled('tg', '123')?.id).toBe(specific.id);

        expect(store.resolve('tg', '123')?.id).toBe(wildcard.id);
      });

      it('AC2.5: when the only candidate for a chat is disabled, resolve() misses but resolveIncludingDisabled() finds it', async () => {
        const specific = await store.create({
          adapterId: 'tg',
          agentId: 'agent-specific',
          chatId: '123',
        });
        await store.update(specific.id, { enabled: false });

        expect(store.resolve('tg', '123')).toBeUndefined();
        expect(store.resolveIncludingDisabled('tg', '123')?.id).toBe(specific.id);
      });

      it('resolve() returns an enabled binding normally (no fallback needed)', async () => {
        const binding = await store.create({ adapterId: 'tg', agentId: 'agent-a', chatId: '123' });
        expect(store.resolve('tg', '123')?.id).toBe(binding.id);
      });
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

  describe('watcher error handling', () => {
    it('logs a watcher error naming bindings.json, and existing bindings stay usable', async () => {
      await store.create({ adapterId: 'tg', agentId: 'a' });

      const err = Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      // No `?.` here on purpose: if the production `.on('error', ...)` wiring is
      // ever removed, this must fail via the resulting TypeError (calling
      // undefined), not silently no-op and fail later at the assertion.
      chokidarErrorHandler!(err);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/^\[watcher-error\] BindingStore: .*bindings\.json/),
        expect.objectContaining({
          code: 'EMFILE',
          message: 'EMFILE: too many open files',
          stack: err.stack,
          suppressingFurtherErrors: true,
        })
      );
      // Already-loaded bindings keep resolving — only hot-reload is degraded.
      expect(store.resolve('tg')).toBeDefined();
    });

    it('says further errors of that code are suppressed, so an operator knows the silence is by design', () => {
      chokidarErrorHandler!(Object.assign(new Error('EMFILE'), { code: 'EMFILE' }));

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('further EMFILE errors from this watcher are suppressed'),
        expect.objectContaining({ suppressingFurtherErrors: true })
      );
    });

    // A single fd-exhaustion episode can make chokidar fire 'error' many times
    // for one dead watcher. The handler must latch: log the first, drop repeats
    // of the same code.
    it('logs only the first of many errors carrying the same code', () => {
      chokidarErrorHandler!(Object.assign(new Error('EMFILE 1'), { code: 'EMFILE' }));
      chokidarErrorHandler!(Object.assign(new Error('EMFILE 2'), { code: 'EMFILE' }));
      chokidarErrorHandler!(Object.assign(new Error('EMFILE 3'), { code: 'EMFILE' }));

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: 'EMFILE', message: 'EMFILE 1' })
      );
    });

    // The masking bug: a latch keyed on "any error at all" would let one benign
    // EACCES hide a real EMFILE storm that follows it. Keying on `code` means a
    // NEW code always gets its own line.
    it('logs a separate line for each distinct error code', () => {
      chokidarErrorHandler!(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
      chokidarErrorHandler!(Object.assign(new Error('too many open files'), { code: 'EMFILE' }));

      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: 'EACCES' })
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: 'EMFILE' })
      );
    });

    // Regression guard: if the latch were ever hoisted out of the per-instance
    // closure to module scope, one store's first error would wrongly suppress a
    // second store's first error too.
    it('scopes the latch per store — a second store logs its own first error', async () => {
      const firstOnError = chokidarErrorHandler!;
      const otherStore = new BindingStore('/tmp/relay-other');
      await otherStore.init();
      const secondOnError = chokidarErrorHandler!;
      expect(secondOnError).not.toBe(firstOnError);
      try {
        firstOnError(Object.assign(new Error('EMFILE A'), { code: 'EMFILE' }));
        secondOnError(Object.assign(new Error('EMFILE B'), { code: 'EMFILE' }));

        expect(logger.error).toHaveBeenCalledTimes(2);
      } finally {
        await otherStore.shutdown();
      }
    });
  });
});
