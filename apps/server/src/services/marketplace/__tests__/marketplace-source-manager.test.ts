import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketplaceSourceManager } from '../marketplace-source-manager.js';

describe('MarketplaceSourceManager', () => {
  let dorkHome: string;
  let manager: MarketplaceSourceManager;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'marketplace-source-manager-'));
    manager = new MarketplaceSourceManager(dorkHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('seeds default sources on first list() when file is missing', async () => {
    const sources = await manager.list();

    expect(sources).toHaveLength(2);
    const names = sources.map((s) => s.name).sort();
    expect(names).toEqual(['claude-plugins-official', 'dorkos-community']);

    const community = sources.find((s) => s.name === 'dorkos-community');
    expect(community).toMatchObject({
      name: 'dorkos-community',
      source: 'https://github.com/dork-labs/marketplace',
      enabled: true,
    });
    expect(typeof community?.addedAt).toBe('string');

    // File should now exist on disk with the seeded sources
    const filePath = join(dorkHome, 'marketplaces.json');
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { version: number; sources: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.sources).toHaveLength(2);
  });

  it('add() persists a new source to disk', async () => {
    await manager.list(); // Seed defaults first

    const added = await manager.add({
      name: 'my-marketplace',
      source: 'https://github.com/me/marketplace',
    });

    expect(added).toMatchObject({
      name: 'my-marketplace',
      source: 'https://github.com/me/marketplace',
      enabled: true,
    });
    expect(typeof added.addedAt).toBe('string');

    // Verify a fresh manager reads the same data from disk
    const fresh = new MarketplaceSourceManager(dorkHome);
    const all = await fresh.list();
    expect(all.find((s) => s.name === 'my-marketplace')).toMatchObject({
      name: 'my-marketplace',
      source: 'https://github.com/me/marketplace',
      enabled: true,
    });
  });

  it('add() throws when adding a duplicate name', async () => {
    await manager.list();

    await expect(
      manager.add({
        name: 'dorkos-community',
        source: 'https://example.com/other',
      })
    ).rejects.toThrow(/dorkos-community/);
  });

  it('remove() is idempotent when the name is absent', async () => {
    await manager.list();

    await expect(manager.remove('nonexistent')).resolves.toBeUndefined();

    await manager.remove('dorkos-community');
    const after = await manager.list();
    expect(after.find((s) => s.name === 'dorkos-community')).toBeUndefined();

    // Removing again should not throw
    await expect(manager.remove('dorkos-community')).resolves.toBeUndefined();
  });

  it('setEnabled() toggles the flag and persists', async () => {
    await manager.list();

    const disabled = await manager.setEnabled('dorkos-community', false);
    expect(disabled.enabled).toBe(false);

    const fresh = new MarketplaceSourceManager(dorkHome);
    const all = await fresh.list();
    expect(all.find((s) => s.name === 'dorkos-community')?.enabled).toBe(false);

    const enabled = await manager.setEnabled('dorkos-community', true);
    expect(enabled.enabled).toBe(true);
  });

  it('atomic write: original file remains intact when fs.rename throws mid-write', async () => {
    // Seed defaults so a stable file exists, using the unmocked manager
    await manager.list();
    const filePath = join(dorkHome, 'marketplaces.json');
    const original = await readFile(filePath, 'utf-8');

    // Re-load the module with rename mocked to simulate a crash. The other fs
    // functions stay real so seeding/reading still works against the temp dir.
    vi.resetModules();
    let renameCalls = 0;
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        rename: vi.fn(async () => {
          renameCalls += 1;
          throw new Error('simulated crash');
        }),
      };
    });

    const { MarketplaceSourceManager: ReloadedManager } =
      await import('../marketplace-source-manager.js');
    const crashingManager = new ReloadedManager(dorkHome);

    await expect(
      crashingManager.add({
        name: 'should-not-persist',
        source: 'https://example.com/x',
      })
    ).rejects.toThrow(/simulated crash/);

    expect(renameCalls).toBeGreaterThan(0);

    // Original file content should be unchanged
    const after = await readFile(filePath, 'utf-8');
    expect(after).toBe(original);

    // Reset mocks and confirm a fresh real manager still reads the original sources
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
    const { MarketplaceSourceManager: FreshManager } =
      await import('../marketplace-source-manager.js');
    const fresh = new FreshManager(dorkHome);
    const sources = await fresh.list();
    expect(sources.find((s) => s.name === 'should-not-persist')).toBeUndefined();
    expect(sources).toHaveLength(2);
  });

  it('throws a clear error when the file contains corrupt data', async () => {
    const filePath = join(dorkHome, 'marketplaces.json');
    await writeFile(filePath, '{"version": "wrong", "sources": "not-an-array"}', 'utf-8');

    await expect(manager.list()).rejects.toThrow();
  });

  it('get() returns a source by name and null when absent', async () => {
    await manager.list();

    const found = await manager.get('dorkos-community');
    expect(found?.name).toBe('dorkos-community');

    const missing = await manager.get('nonexistent');
    expect(missing).toBeNull();
  });

  it('does not call mkdir/access when the dorkHome already exists', async () => {
    // Confirm mkdir is robust against pre-existing dirs (recursive: true)
    await expect(access(dorkHome)).resolves.toBeUndefined();
    await expect(manager.list()).resolves.toHaveLength(2);
  });

  it('migrates legacy dorkos/marketplace URL to dork-labs/marketplace on read', async () => {
    // Simulate an existing install where the user's marketplaces.json was
    // seeded by an earlier build with the now-broken dorkos/marketplace URL.
    const filePath = join(dorkHome, 'marketplaces.json');
    const legacy = {
      version: 1,
      sources: [
        {
          name: 'dorkos-community',
          source: 'https://github.com/dorkos/marketplace',
          enabled: true,
          addedAt: '2026-04-08T23:47:26.969Z',
        },
        {
          name: 'my-custom',
          source: 'https://github.com/me/my-marketplace',
          enabled: true,
          addedAt: '2026-04-08T23:47:26.969Z',
        },
      ],
    };
    await writeFile(filePath, JSON.stringify(legacy, null, 2), 'utf-8');

    const sources = await manager.list();
    const community = sources.find((s) => s.name === 'dorkos-community');
    expect(community?.source).toBe('https://github.com/dork-labs/marketplace');

    // Custom sources should pass through untouched.
    const custom = sources.find((s) => s.name === 'my-custom');
    expect(custom?.source).toBe('https://github.com/me/my-marketplace');

    // Migration should be persisted so subsequent reads are no-ops.
    const persisted = JSON.parse(await readFile(filePath, 'utf-8')) as typeof legacy;
    expect(persisted.sources.find((s) => s.name === 'dorkos-community')?.source).toBe(
      'https://github.com/dork-labs/marketplace'
    );
  });

  // DOR-697. `add`/`remove`/`setEnabled` are read-modify-write over one file,
  // reachable concurrently from two cockpit tabs or a tab plus any marketplace
  // MCP tool. Serialising only the write is not enough: two mutators that both
  // read before either writes still each persist their own view and drop the
  // other's change. These must stay concurrent — sequentially they cannot fail.
  describe('concurrent mutations', () => {
    it('keeps every source when many add() calls land at once', async () => {
      await manager.list(); // Seed defaults first
      const N = 10;

      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          manager.add({ name: `src-${i}`, source: `https://github.com/me/m${i}` })
        )
      );

      const sources = await manager.list();
      expect(sources.filter((s) => s.name.startsWith('src-'))).toHaveLength(N);
    });

    it('a concurrent add() and setEnabled() both survive', async () => {
      await manager.list();
      await manager.add({ name: 'existing', source: 'https://github.com/me/existing' });

      await Promise.all([
        manager.setEnabled('existing', false),
        manager.add({ name: 'newcomer', source: 'https://github.com/me/newcomer' }),
      ]);

      const sources = await manager.list();
      expect(sources.find((s) => s.name === 'existing')?.enabled).toBe(false);
      expect(sources.find((s) => s.name === 'newcomer')).toBeDefined();
    });

    it('a concurrent remove() and add() both survive', async () => {
      await manager.list();
      await manager.add({ name: 'doomed', source: 'https://github.com/me/doomed' });

      await Promise.all([
        manager.remove('doomed'),
        manager.add({ name: 'fresh', source: 'https://github.com/me/fresh' }),
      ]);

      const sources = await manager.list();
      expect(sources.find((s) => s.name === 'doomed')).toBeUndefined();
      expect(sources.find((s) => s.name === 'fresh')).toBeDefined();
    });

    it('concurrent first-run list() calls seed exactly one valid file', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => new MarketplaceSourceManager(dorkHome).list())
      );

      for (const sources of results) expect(sources).toHaveLength(2);
      const raw = await readFile(join(dorkHome, 'marketplaces.json'), 'utf-8');
      expect((JSON.parse(raw) as { sources: unknown[] }).sources).toHaveLength(2);
    });
  });
});
