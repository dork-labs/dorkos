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
      source: 'https://github.com/dorkos/marketplace',
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
});
