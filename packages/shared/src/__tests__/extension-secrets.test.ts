import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs/promises';
import { statSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { ExtensionSecretStore, resetKeyCache } from '../extension-secrets.js';
import { InvalidExtensionIdError } from '../extension-id.js';

// === Helpers ===

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-secrets-test-'));
  tempDirs.push(dir);
  return dir;
}

// === Setup / Teardown ===

beforeEach(() => {
  resetKeyCache();
});

afterEach(async () => {
  resetKeyCache();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// === Tests ===

describe('ExtensionSecretStore', () => {
  describe('encrypt/decrypt roundtrip', () => {
    it('returns the original value after set then get', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      await store.set('api-key', 'sk-test-12345');
      const result = await store.get('api-key');

      expect(result).toBe('sk-test-12345');
    });

    it('handles empty string values', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      await store.set('empty', '');
      const result = await store.get('empty');

      expect(result).toBe('');
    });

    it('handles values with special characters', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      const specialValue = "p@$$w0rd!#%^&*()_+{}|:<>?~`-=[]\\;',./";
      await store.set('special', specialValue);
      const result = await store.get('special');

      expect(result).toBe(specialValue);
    });

    it('handles unicode values', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      const unicode = '\u{1F916}\u{1F4BB}\u{1F680}';
      await store.set('emoji', unicode);
      const result = await store.get('emoji');

      expect(result).toBe(unicode);
    });
  });

  describe('missing key', () => {
    it('returns null for a key that was never set', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      const result = await store.get('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('has()', () => {
    it('returns true after set', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      await store.set('key', 'value');

      expect(await store.has('key')).toBe(true);
    });

    it('returns false after delete', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      await store.set('key', 'value');
      await store.delete('key');

      expect(await store.has('key')).toBe(false);
    });

    it('returns false for a key that was never set', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      expect(await store.has('missing')).toBe(false);
    });
  });

  describe('delete()', () => {
    it('removes a previously set secret', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      await store.set('key', 'value');
      await store.delete('key');
      const result = await store.get('key');

      expect(result).toBeNull();
    });

    it('is a no-op when key does not exist', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      // Should not throw
      await store.delete('nonexistent');
    });
  });

  describe('per-extension isolation', () => {
    it('stores secrets in separate files per extension', async () => {
      const dorkHome = await makeTempDir();
      const storeA = new ExtensionSecretStore('extension-a', dorkHome);
      const storeB = new ExtensionSecretStore('extension-b', dorkHome);

      await storeA.set('shared-key', 'value-a');
      await storeB.set('shared-key', 'value-b');

      expect(await storeA.get('shared-key')).toBe('value-a');
      expect(await storeB.get('shared-key')).toBe('value-b');
    });

    it('creates separate JSON files for each extension', async () => {
      const dorkHome = await makeTempDir();
      const storeA = new ExtensionSecretStore('extension-a', dorkHome);
      const storeB = new ExtensionSecretStore('extension-b', dorkHome);

      await storeA.set('key', 'a');
      await storeB.set('key', 'b');

      const secretsDir = path.join(dorkHome, 'extension-secrets');
      const files = await fs.readdir(secretsDir);
      expect(files.sort()).toEqual(['extension-a.json', 'extension-b.json']);
    });

    it('cannot read secrets from another extension', async () => {
      const dorkHome = await makeTempDir();
      const storeA = new ExtensionSecretStore('extension-a', dorkHome);
      const storeB = new ExtensionSecretStore('extension-b', dorkHome);

      await storeA.set('private-key', 'secret-value');

      expect(await storeB.get('private-key')).toBeNull();
    });
  });

  describe('host key generation', () => {
    it('creates host.key on first access in a fresh dorkHome', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      const keyPath = path.join(dorkHome, 'host.key');
      expect(existsSync(keyPath)).toBe(false);

      await store.set('trigger', 'value');

      expect(existsSync(keyPath)).toBe(true);
    });

    it('creates host.key with mode 0o600 (owner read/write only)', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      await store.set('trigger', 'value');

      const keyPath = path.join(dorkHome, 'host.key');
      const stat = statSync(keyPath);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('reuses an existing host.key across stores', async () => {
      const dorkHome = await makeTempDir();
      const store1 = new ExtensionSecretStore('ext-1', dorkHome);
      await store1.set('key', 'val1');

      const keyBefore = await fs.readFile(path.join(dorkHome, 'host.key'));

      // Reset cache so a new store re-reads the key from disk
      resetKeyCache();
      const store2 = new ExtensionSecretStore('ext-2', dorkHome);
      await store2.set('key', 'val2');

      const keyAfter = await fs.readFile(path.join(dorkHome, 'host.key'));
      expect(keyBefore).toEqual(keyAfter);
    });
  });

  describe('corrupted data handling', () => {
    it('returns null instead of throwing for tampered encrypted value', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      await store.set('key', 'value');

      // Tamper with the stored data directly
      const secretsPath = path.join(dorkHome, 'extension-secrets', 'test-ext.json');
      const data = JSON.parse(await fs.readFile(secretsPath, 'utf-8')) as Record<string, string>;
      data['key'] = 'corrupted-base64-data-that-is-not-valid-encryption';
      await fs.writeFile(secretsPath, JSON.stringify(data), 'utf-8');

      // Create a fresh store instance to bypass in-memory cache
      resetKeyCache();
      const freshStore = new ExtensionSecretStore('test-ext', dorkHome);
      const result = await freshStore.get('key');

      expect(result).toBeNull();
    });

    it('returns null for truncated ciphertext', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      await store.set('key', 'some-secret-value');

      // Truncate the encrypted value
      const secretsPath = path.join(dorkHome, 'extension-secrets', 'test-ext.json');
      const data = JSON.parse(await fs.readFile(secretsPath, 'utf-8')) as Record<string, string>;
      data['key'] = data['key']!.slice(0, 10); // Truncate to make it invalid
      await fs.writeFile(secretsPath, JSON.stringify(data), 'utf-8');

      resetKeyCache();
      const freshStore = new ExtensionSecretStore('test-ext', dorkHome);
      const result = await freshStore.get('key');

      expect(result).toBeNull();
    });
  });

  describe('atomic writes', () => {
    it('writes secrets file without leftover temp files', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      await store.set('key1', 'value1');
      await store.set('key2', 'value2');

      const secretsDir = path.join(dorkHome, 'extension-secrets');
      const files = await fs.readdir(secretsDir);
      // Should only have the final JSON file — no .tmp leftovers
      expect(files).toEqual(['test-ext.json']);
    });
  });

  describe('derived key caching', () => {
    it('caches the derived key across multiple operations', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      // Multiple operations should all work with the cached key
      await store.set('key1', 'value1');
      await store.set('key2', 'value2');
      await store.set('key3', 'value3');

      expect(await store.get('key1')).toBe('value1');
      expect(await store.get('key2')).toBe('value2');
      expect(await store.get('key3')).toBe('value3');
    });

    it('produces valid encrypted data that is base64-encoded', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);

      await store.set('key', 'value');

      const secretsPath = path.join(dorkHome, 'extension-secrets', 'test-ext.json');
      const data = JSON.parse(await fs.readFile(secretsPath, 'utf-8')) as Record<string, string>;
      const encrypted = data['key']!;

      // Verify it is valid base64
      expect(() => Buffer.from(encrypted, 'base64')).not.toThrow();
      // Verify the raw value is not stored in plaintext
      expect(encrypted).not.toBe('value');
      expect(encrypted).not.toContain('value');
    });
  });

  /**
   * A store instance outlives what wrote to it. An extension's `ctx.secrets` and
   * a dataProxy's store are built once, when the extension starts, and live for
   * as long as it runs; the settings routes that save a secret build their own
   * store and write to disk. So a store that answered once must not keep
   * answering with what it saw then (DOR-1336 review) — the person pastes an API
   * key, and the running extension has to see it.
   */
  describe('freshness against writes from elsewhere', () => {
    it('sees a secret written after this instance already read', async () => {
      const dorkHome = await makeTempDir();
      const running = new ExtensionSecretStore('test-ext', dorkHome);
      expect(await running.get('api-key')).toBeNull();

      // What `PUT /api/extensions/:id/secrets/:key` does: its own store, its own
      // write, no word to the one already running.
      await new ExtensionSecretStore('test-ext', dorkHome).set('api-key', 'sk-live-1');

      expect(await running.get('api-key')).toBe('sk-live-1');
      expect(await running.has('api-key')).toBe(true);
      expect(await running.keys()).toEqual(['api-key']);
    });

    it('sees a secret replaced after this instance already read', async () => {
      const dorkHome = await makeTempDir();
      await new ExtensionSecretStore('test-ext', dorkHome).set('api-key', 'sk-old');
      const running = new ExtensionSecretStore('test-ext', dorkHome);
      expect(await running.get('api-key')).toBe('sk-old');

      await new ExtensionSecretStore('test-ext', dorkHome).set('api-key', 'sk-new');

      expect(await running.get('api-key')).toBe('sk-new');
    });

    it('sees a secret deleted after this instance already read', async () => {
      const dorkHome = await makeTempDir();
      await new ExtensionSecretStore('test-ext', dorkHome).set('api-key', 'sk-old');
      const running = new ExtensionSecretStore('test-ext', dorkHome);
      expect(await running.get('api-key')).toBe('sk-old');

      await new ExtensionSecretStore('test-ext', dorkHome).delete('api-key');

      expect(await running.get('api-key')).toBeNull();
      expect(await running.has('api-key')).toBe(false);
      expect(await running.keys()).toEqual([]);
    });
  });

  describe('persistence across instances', () => {
    it('reads previously set secrets from a new store instance', async () => {
      const dorkHome = await makeTempDir();

      const store1 = new ExtensionSecretStore('test-ext', dorkHome);
      await store1.set('persistent-key', 'persistent-value');

      // Create a completely new instance (simulating a process restart)
      const store2 = new ExtensionSecretStore('test-ext', dorkHome);
      const result = await store2.get('persistent-key');

      expect(result).toBe('persistent-value');
    });
  });

  describe('keys', () => {
    it('lists the stored key names, and forgets them as they are deleted', async () => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore('test-ext', dorkHome);
      await store.set('agent-a:server:tokens', 'v1');
      await store.set('agent-b:server:tokens', 'v2');

      // The listing is what lets a caller delete a whole family of keys — every
      // secret one agent owns — without knowing each name in advance.
      expect((await store.keys()).sort()).toEqual([
        'agent-a:server:tokens',
        'agent-b:server:tokens',
      ]);

      await store.delete('agent-a:server:tokens');
      expect(await store.keys()).toEqual(['agent-b:server:tokens']);
    });

    it('returns nothing for a store that was never written', async () => {
      const dorkHome = await makeTempDir();
      expect(await new ExtensionSecretStore('never-used', dorkHome).keys()).toEqual([]);
    });
  });

  // DOR-697. Callers construct a store per request, so `set`/`delete` are a
  // read-modify-write over one shared file. Concurrency is the reproduction:
  // sequentially these cannot fail.
  describe('concurrent writes', () => {
    it('keeps every key when separate instances write at once', async () => {
      const dorkHome = await makeTempDir();
      const N = 25;

      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          new ExtensionSecretStore('test-ext', dorkHome).set(`key-${i}`, `value-${i}`)
        )
      );

      const reader = new ExtensionSecretStore('test-ext', dorkHome);
      const values = await Promise.all(Array.from({ length: N }, (_, i) => reader.get(`key-${i}`)));

      expect(values).toEqual(Array.from({ length: N }, (_, i) => `value-${i}`));
    });

    it('keeps the file parseable and free of leftover temp files', async () => {
      const dorkHome = await makeTempDir();

      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          new ExtensionSecretStore('test-ext', dorkHome).set(`key-${i}`, `value-${i}`)
        )
      );

      const dir = path.join(dorkHome, 'extension-secrets');
      expect((await fs.readdir(dir)).sort()).toEqual(['test-ext.json']);
      const parsed = JSON.parse(await fs.readFile(path.join(dir, 'test-ext.json'), 'utf-8'));
      expect(Object.keys(parsed as Record<string, string>)).toHaveLength(20);
    });

    it('does not let a concurrent write resurrect a deleted key', async () => {
      const dorkHome = await makeTempDir();
      const seed = new ExtensionSecretStore('test-ext', dorkHome);
      await seed.set('doomed', 'value');
      await seed.set('other', 'value');

      await Promise.all([
        new ExtensionSecretStore('test-ext', dorkHome).delete('doomed'),
        new ExtensionSecretStore('test-ext', dorkHome).set('fresh', 'value'),
      ]);

      const reader = new ExtensionSecretStore('test-ext', dorkHome);
      expect(await reader.has('doomed')).toBe(false);
      expect(await reader.has('other')).toBe(true);
      expect(await reader.has('fresh')).toBe(true);
    });

    it('writes for different extensions do not block each other', async () => {
      const dorkHome = await makeTempDir();

      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          new ExtensionSecretStore(`ext-${i}`, dorkHome).set('key', `value-${i}`)
        )
      );

      const values = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          new ExtensionSecretStore(`ext-${i}`, dorkHome).get('key')
        )
      );

      expect(values).toEqual(Array.from({ length: 10 }, (_, i) => `value-${i}`));
    });
  });
});

describe('ExtensionSecretStore — extension id containment', () => {
  const ESCAPING_IDS = ['../outside', '..', 'nested/deeper', 'UPPER', 'has space', '', '.hidden'];

  it.each(ESCAPING_IDS)('refuses the id %j', async (id) => {
    const dorkHome = await makeTempDir();
    expect(() => new ExtensionSecretStore(id, dorkHome)).toThrow(InvalidExtensionIdError);
  });

  it.each(['runtime-credentials', 'mcp-oauth', 'test-ext', 'ext1', '0abc'])(
    'accepts the real store id %j',
    async (id) => {
      const dorkHome = await makeTempDir();
      const store = new ExtensionSecretStore(id, dorkHome);
      await store.set('key', 'value');
      expect(await store.get('key')).toBe('value');
    }
  );
});
