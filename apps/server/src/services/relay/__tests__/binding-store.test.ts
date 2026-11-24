import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { BindingStore } from '../binding-store.js';
import { logger } from '../../../lib/logger.js';

vi.mock('node:fs/promises');

/** Captured chokidar handlers, so tests can fire them. */
let onChange: (() => Promise<void>) | undefined;
let onError: ((err: unknown) => void) | undefined;

vi.mock('chokidar', () => ({
  default: {
    watch: () => ({
      on: vi.fn((event: string, handler: (arg?: unknown) => unknown) => {
        if (event === 'change') onChange = handler as () => Promise<void>;
        if (event === 'error') onError = handler as (err: unknown) => void;
      }),
      close: vi.fn(),
    }),
  },
}));

/** Auto-incrementing mtime so each save() gets a unique value. */
let nextMtime = 1000;

/** A binding row as it sits in bindings.json. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    adapterId: 'telegram-main',
    agentId: 'agent-1',
    sessionStrategy: 'per-chat',
    label: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const SECOND_ID = 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';

/** Boot a store over a bindings.json holding `body`. */
async function loadFrom(body: string): Promise<BindingStore> {
  vi.mocked(readFile).mockResolvedValue(body);
  const fresh = new BindingStore('/tmp/relay');
  await fresh.init();
  return fresh;
}

/** What the last save wrote to bindings.json. */
const lastSave = () => vi.mocked(writeFile).mock.calls.at(-1)![1] as string;

let store: BindingStore;

beforeEach(async () => {
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  nextMtime = 1000;
  vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  vi.mocked(mkdir).mockResolvedValue(undefined);
  vi.mocked(writeFile).mockResolvedValue();
  vi.mocked(rename).mockResolvedValue();
  vi.mocked(stat).mockImplementation(
    async () => ({ mtimeMs: nextMtime++ }) as Awaited<ReturnType<typeof stat>>
  );
  store = new BindingStore('/tmp/relay');
  await store.init();
});

afterEach(async () => {
  await store.shutdown();
  vi.restoreAllMocks();
});

describe('BindingStore bindings', () => {
  it('creates a binding with an id and timestamps, and filters by adapter', async () => {
    const binding = await store.create({ adapterId: 'tg-1', agentId: 'a', label: 'Test' });
    await store.create({ adapterId: 'tg-2', agentId: 'b' });
    expect(binding.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.getById(binding.id)).toEqual(binding);
    expect(store.getByAdapterId('tg-1')).toEqual([binding]);
    expect(store.getOrphaned(['tg-1']).map((b) => b.adapterId)).toEqual(['tg-2']);
  });

  it('persists create, update and delete across a restart', async () => {
    const kept = await store.create({ adapterId: 'tg-1', agentId: 'a' });
    const dropped = await store.create({ adapterId: 'tg-1', agentId: 'b' });
    const updated = await store.update(kept.id, { label: 'persisted-label', chatId: '12345' });
    expect(updated).toMatchObject({ adapterId: 'tg-1', agentId: 'a', createdAt: kept.createdAt });
    expect(await store.delete(dropped.id)).toBe(true);
    const restarted = await loadFrom(lastSave());
    expect(restarted.getAll()).toEqual([
      expect.objectContaining({ id: kept.id, label: 'persisted-label' }),
    ]);
    await restarted.shutdown();
  });

  it('answers an unknown id with no write', async () => {
    vi.mocked(writeFile).mockClear();
    expect(await store.delete('non-existent')).toBe(false);
    expect(await store.update('non-existent', { label: 'test' })).toBeUndefined();
    expect(await store.moveToAgent('non-existent', 'agent-b')).toBeUndefined();
    expect(writeFile).not.toHaveBeenCalled();
  });

  // MAJOR-2 (DOR-865): load() discards an entry failing the schema, so an
  // invalid merge that reached disk would vanish on the next restart.
  it('rejects an update that merges into an invalid binding, before it reaches memory or disk', async () => {
    const binding = await store.create({ adapterId: 'telegram-1', agentId: 'agent-1' });
    const onDisk = lastSave();
    await expect(store.update(binding.id, { bridge: 'room' })).rejects.toThrow(
      'one room cannot honestly be the channel'
    );
    expect(store.getById(binding.id)?.bridge).toBe('off');
    const restarted = await loadFrom(onDisk);
    expect(restarted.getById(binding.id)?.bridge).toBe('off');
    await restarted.shutdown();
  });

  it('resolves the most specific binding: chat, then channel type, then wildcard', async () => {
    const wildcard = await store.create({ adapterId: 'tg', agentId: 'agent-wild' });
    const channelOnly = await store.create({
      adapterId: 'tg',
      agentId: 'agent-channel',
      channelType: 'dm',
    });
    const chatOnly = await store.create({ adapterId: 'tg', agentId: 'agent-chat', chatId: '123' });
    expect(store.resolve('tg', '123', 'group')?.id).toBe(chatOnly.id);
    expect(store.resolve('tg', '999', 'dm')?.id).toBe(channelOnly.id);
    expect(store.resolve('tg', '999', 'group')?.id).toBe(wildcard.id);
    expect(store.resolve('tg')?.id).toBe(wildcard.id);
    expect(store.resolve('unknown')).toBeUndefined();
  });

  it.each([
    ['chatId', { chatId: '123' }, ['999', undefined]],
    ['channelType', { channelType: 'dm' as const }, ['123', 'group' as const]],
  ])(
    'returns nothing on an explicit %s mismatch with no wildcard',
    async (_f, scope, [chatId, type]) => {
      await store.create({ adapterId: 'tg', agentId: 'a', ...scope });
      expect(store.resolve('tg', chatId, type)).toBeUndefined();
    }
  );

  describe('one chat, one agent (connection-scoping spec §Part 2)', () => {
    it('AC2.1: a second binding on one (adapterId, chatId) is a conflict, whatever its channelType', async () => {
      const first = await store.create({ adapterId: 'tg', agentId: 'agent-a', chatId: '123' });
      await expect(
        store.create({ adapterId: 'tg', agentId: 'agent-b', chatId: '123', channelType: 'dm' })
      ).rejects.toMatchObject({
        name: 'BindingConflictError',
        conflict: { id: first.id, agentId: 'agent-a', chatId: '123' },
      });
      // Wildcards and other adapters do not conflict.
      await store.create({ adapterId: 'tg', agentId: 'agent-b' });
      await store.create({ adapterId: 'tg', agentId: 'agent-c' });
      await store.create({ adapterId: 'slack', agentId: 'agent-b', chatId: '123' });
      expect(store.getAll()).toHaveLength(4);
    });

    it('AC2.2: update() conflicts when chatId moves onto a taken value, not onto its own', async () => {
      const owner = await store.create({ adapterId: 'tg', agentId: 'agent-a', chatId: '123' });
      const other = await store.create({ adapterId: 'tg', agentId: 'agent-b', chatId: '456' });
      await expect(store.update(other.id, { chatId: '123' })).rejects.toMatchObject({
        name: 'BindingConflictError',
        conflict: { id: owner.id },
      });
      expect(store.getById(other.id)?.chatId).toBe('456');
      expect((await store.update(owner.id, { label: 'renamed' }))?.label).toBe('renamed');
    });

    it('AC2.3: moveToAgent re-points the SAME binding in place', async () => {
      const binding = await store.create({ adapterId: 'tg', agentId: 'agent-a', chatId: '123' });
      expect(await store.moveToAgent(binding.id, 'agent-b')).toMatchObject({
        id: binding.id,
        agentId: 'agent-b',
      });
      expect(store.getAll()).toHaveLength(1);
    });

    it('AC2.4/AC2.5: a disabled binding never wins resolve(), but resolveIncludingDisabled() finds it', async () => {
      const specific = await store.create({
        adapterId: 'tg',
        agentId: 'agent-specific',
        chatId: '123',
      });
      await store.update(specific.id, { enabled: false });
      expect(store.resolve('tg', '123')).toBeUndefined();
      const wildcard = await store.create({ adapterId: 'tg', agentId: 'agent-wild' });
      expect(store.resolve('tg', '123')?.id).toBe(wildcard.id);
      expect(store.resolveIncludingDisabled('tg', '123')?.id).toBe(specific.id);
    });
  });
});

describe('BindingStore on disk', () => {
  it.each([
    ['malformed JSON', 'not-valid-json'],
    ['an invalid top-level structure', JSON.stringify({ notBindings: [] })],
  ])('starts empty on %s', async (_label, body) => {
    const fresh = await loadFrom(body);
    expect(fresh.getAll()).toEqual([]);
    await fresh.shutdown();
  });

  it('keeps only valid entries, re-saving only when it dropped one', async () => {
    vi.mocked(writeFile).mockClear();
    const clean = await loadFrom(
      JSON.stringify({ bindings: [row(), row({ id: SECOND_ID, adapterId: 'slack' })] })
    );
    expect(clean.getAll()).toHaveLength(2);
    expect(writeFile).not.toHaveBeenCalled();
    await clean.shutdown();
    const mixed = await loadFrom(
      JSON.stringify({ bindings: [row({ label: 'Valid' }), row({ id: SECOND_ID, agentId: '' })] })
    );
    expect(mixed.getAll().map((b) => b.label)).toEqual(['Valid']);
    expect(writeFile).toHaveBeenCalled();
    await mixed.shutdown();
  });

  it('strips legacy path fields, and defaults bridge fields on a row written before them (A11.2)', async () => {
    const fresh = await loadFrom(
      JSON.stringify({
        bindings: [
          row({
            projectPath: '/legacy',
            agentDir: '/legacy/agent',
            chatId: '555',
            canInitiate: true,
          }),
        ],
      })
    );
    const loaded = fresh.getById(row().id as string);
    expect(loaded).toMatchObject({ chatId: '555', canInitiate: true, bridge: 'off', roomId: null });
    expect(loaded).not.toHaveProperty('projectPath');
    expect(loaded).not.toHaveProperty('agentDir');
    await fresh.shutdown();
  });

  it('AC2.6: reconciles a legacy chatId collision by DISABLING the loser, backed up, never deleting it', async () => {
    vi.mocked(writeFile).mockClear();
    const fresh = await loadFrom(
      JSON.stringify({
        bindings: [
          row({ agentId: 'agent-older', chatId: '123' }),
          row({
            id: SECOND_ID,
            agentId: 'agent-newer',
            chatId: '123',
            label: 'Newer',
            createdAt: '2026-01-02T00:00:00.000Z',
          }),
        ],
      })
    );
    expect(fresh.getAll()).toHaveLength(2);
    expect(fresh.getById(SECOND_ID)).toMatchObject({
      agentId: 'agent-newer',
      label: 'Newer',
      enabled: false,
    });
    expect(fresh.resolve('telegram-main', '123')?.id).toBe(row().id);
    const writes = vi.mocked(writeFile).mock.calls;
    const sidecar = writes.find(([p]) => String(p).includes('bindings.discarded-'));
    expect(JSON.parse(sidecar![1] as string).bindings.map((b: { id: string }) => b.id)).toEqual([
      SECOND_ID,
    ]);
    const reconciled = writes.find(
      ([p]) => !String(p).includes('bindings.discarded-')
    )![1] as string;
    await fresh.shutdown();
    // Loading the reconciled file again is a no-op: no new sidecar, no re-save.
    vi.mocked(writeFile).mockClear();
    const again = await loadFrom(reconciled);
    expect(writeFile).not.toHaveBeenCalled();
    expect(again.getById(SECOND_ID)?.enabled).toBe(false);
    await again.shutdown();
  });

  it('absorbs exactly one change event for its own write, and reloads on any other', async () => {
    const statAt = (mtimeMs: number) => ({ mtimeMs }) as Awaited<ReturnType<typeof stat>>;
    const ownMtime = nextMtime;
    await store.create({ adapterId: 'tg', agentId: 'a' });
    vi.mocked(readFile).mockClear();
    vi.mocked(stat).mockResolvedValueOnce(statAt(ownMtime));
    await onChange!();
    expect(readFile).not.toHaveBeenCalled();
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ bindings: [row({ adapterId: 'external' })] })
    );
    vi.mocked(stat).mockResolvedValueOnce(statAt(ownMtime));
    await onChange!();
    expect(store.getAll().map((b) => b.adapterId)).toEqual(['external']);
    vi.mocked(stat).mockResolvedValueOnce(statAt(99999));
    await onChange!();
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('keeps resolving loaded bindings after a watcher error', async () => {
    await store.create({ adapterId: 'tg', agentId: 'a' });
    onError!(Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }));
    expect(store.resolve('tg')).toBeDefined();
  });
});
