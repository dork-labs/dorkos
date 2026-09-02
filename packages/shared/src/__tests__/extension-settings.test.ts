import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtensionSettingsStore } from '../extension-settings.js';
import { InvalidExtensionIdError } from '../extension-id.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'dorkos-settings-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('ExtensionSettingsStore', () => {
  it('returns null for missing key', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    expect(await store.get('missing')).toBeNull();
  });

  it('stores and retrieves a string value', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await store.set('prefix', 'gh:');
    expect(await store.get('prefix')).toBe('gh:');
  });

  it('stores and retrieves a number value', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await store.set('interval', 300);
    expect(await store.get('interval')).toBe(300);
  });

  it('stores and retrieves a boolean value', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await store.set('enabled', true);
    expect(await store.get('enabled')).toBe(true);
  });

  it('stores and retrieves a false boolean value', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await store.set('enabled', false);
    expect(await store.get('enabled')).toBe(false);
  });

  it('overwrites existing value', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await store.set('key', 'old');
    await store.set('key', 'new');
    expect(await store.get('key')).toBe('new');
  });

  it('deletes a key', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await store.set('key', 'val');
    await store.delete('key');
    expect(await store.get('key')).toBeNull();
  });

  it('deleting a non-existent key does not throw', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await expect(store.delete('nonexistent')).resolves.toBeUndefined();
  });

  it('getAll returns all stored values', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await store.set('a', 1);
    await store.set('b', 'two');
    await store.set('c', true);
    expect(await store.getAll()).toEqual({ a: 1, b: 'two', c: true });
  });

  it('getAll returns empty object when no settings stored', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    expect(await store.getAll()).toEqual({});
  });

  it('isolates extensions by ID', async () => {
    const store1 = new ExtensionSettingsStore(tmpDir, 'ext-a');
    const store2 = new ExtensionSettingsStore(tmpDir, 'ext-b');
    await store1.set('key', 'a');
    await store2.set('key', 'b');
    expect(await store1.get('key')).toBe('a');
    expect(await store2.get('key')).toBe('b');
  });

  it('persists across store instances', async () => {
    const store1 = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await store1.set('persist', 'value');

    // New instance should read the same file
    const store2 = new ExtensionSettingsStore(tmpDir, 'test-ext');
    expect(await store2.get('persist')).toBe('value');
  });

  it('creates the extension-settings directory if it does not exist', async () => {
    const nested = join(tmpDir, 'deep', 'nested');
    const store = new ExtensionSettingsStore(nested, 'test-ext');
    await store.set('key', 'value');
    expect(await store.get('key')).toBe('value');
  });

  it('stores zero as a number correctly', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await store.set('count', 0);
    expect(await store.get('count')).toBe(0);
  });

  it('stores empty string correctly', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await store.set('prefix', '');
    expect(await store.get('prefix')).toBe('');
  });

  // DOR-697. `set` is a read-modify-write over one file, and the extension host
  // builds a store per context, so two settings saved at once used to drop one.
  describe('concurrent writes', () => {
    it('keeps every setting when many are saved at once', async () => {
      const N = 25;

      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          new ExtensionSettingsStore(tmpDir, 'test-ext').set(`key-${i}`, i)
        )
      );

      const all = await new ExtensionSettingsStore(tmpDir, 'test-ext').getAll();
      expect(Object.keys(all)).toHaveLength(N);
    });

    it('does not let a concurrent write resurrect a deleted setting', async () => {
      const seed = new ExtensionSettingsStore(tmpDir, 'test-ext');
      await seed.set('doomed', true);

      await Promise.all([
        new ExtensionSettingsStore(tmpDir, 'test-ext').delete('doomed'),
        new ExtensionSettingsStore(tmpDir, 'test-ext').set('fresh', true),
      ]);

      const all = await new ExtensionSettingsStore(tmpDir, 'test-ext').getAll();
      expect(all).toEqual({ fresh: true });
    });
  });
});

describe('ExtensionSettingsStore — extension id containment', () => {
  it.each(['../outside', '..', 'nested/deeper', 'UPPER', 'has space', '', '.hidden'])(
    'refuses the id %j',
    (id) => {
      expect(() => new ExtensionSettingsStore(tmpDir, id)).toThrow(InvalidExtensionIdError);
    }
  );

  it.each(['test-ext', 'ext-a', 'ext1', '0abc'])('accepts the id %j', async (id) => {
    const store = new ExtensionSettingsStore(tmpDir, id);
    await store.set('key', 'value');
    expect(await store.get('key')).toBe('value');
  });
});
