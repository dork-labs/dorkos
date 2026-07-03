/**
 * CredentialProvider port tests (ADR-0315, effortless-runtime-switching T1 2.1).
 *
 * Exercises reference resolution across all three schemes (keychain/env/file),
 * the honest typed failures (a dangling reference resolves to a typed
 * `unresolved`, never a silent empty string), and the load-bearing security
 * properties: a secret never appears in the serialized `config.json`, never in
 * a resolution failure message, and never as plaintext in the encrypted store
 * file on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetKeyCache } from '@dorkos/shared/extension-secrets';
import {
  DefaultCredentialProvider,
  EncryptedFileCredentialStore,
  MacOsKeychainAccessor,
  initCredentialProvider,
  credentialStore,
  type KeychainAccessor,
} from '../credential-provider.js';
import { initConfigManager, configManager } from '../config-manager.js';

const SECRET = 'sk-super-secret-value-9f3a';

/** In-memory keychain stand-in — never touches the real OS keychain. */
class FakeKeychain implements KeychainAccessor {
  constructor(
    private available: boolean,
    private entries: Record<string, string> = {}
  ) {}
  isAvailable(): boolean {
    return this.available;
  }
  async get(id: string): Promise<string | null> {
    return this.entries[id] ?? null;
  }
}

describe('DefaultCredentialProvider', () => {
  let dorkHome: string;

  beforeEach(() => {
    dorkHome = mkdtempSync(join(tmpdir(), 'cred-provider-'));
    resetKeyCache();
  });

  afterEach(() => {
    rmSync(dorkHome, { recursive: true, force: true });
    resetKeyCache();
  });

  describe('env: scheme', () => {
    it('resolves an env var reference to its value', async () => {
      const provider = new DefaultCredentialProvider({
        store: new EncryptedFileCredentialStore(dorkHome),
        keychain: new FakeKeychain(false),
        env: { MY_KEY: SECRET },
      });

      await expect(provider.resolve('env:MY_KEY')).resolves.toEqual({ ok: true, secret: SECRET });
    });

    it('surfaces a dangling env reference as a typed unresolved failure (never empty string)', async () => {
      const provider = new DefaultCredentialProvider({
        store: new EncryptedFileCredentialStore(dorkHome),
        keychain: new FakeKeychain(false),
        env: {},
      });

      const result = await provider.resolve('env:MISSING_KEY');
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ reason: 'unresolved', ref: 'env:MISSING_KEY' });
    });

    it('treats an empty-string env value as unresolved, not a valid secret', async () => {
      const provider = new DefaultCredentialProvider({
        store: new EncryptedFileCredentialStore(dorkHome),
        keychain: new FakeKeychain(false),
        env: { EMPTY: '' },
      });

      const result = await provider.resolve('env:EMPTY');
      expect(result).toMatchObject({ ok: false, reason: 'unresolved' });
    });
  });

  describe('file: scheme', () => {
    it('resolves a file reference from the encrypted store', async () => {
      const store = new EncryptedFileCredentialStore(dorkHome);
      const ref = await store.put('openrouter', SECRET);
      expect(ref).toBe('file:openrouter');

      const provider = new DefaultCredentialProvider({ store, keychain: new FakeKeychain(false) });
      await expect(provider.resolve(ref)).resolves.toEqual({ ok: true, secret: SECRET });
    });

    it('surfaces a dangling file reference as a typed unresolved failure', async () => {
      const provider = new DefaultCredentialProvider({
        store: new EncryptedFileCredentialStore(dorkHome),
        keychain: new FakeKeychain(false),
      });

      const result = await provider.resolve('file:never-stored');
      expect(result).toMatchObject({ ok: false, reason: 'unresolved', ref: 'file:never-stored' });
    });
  });

  describe('keychain: scheme', () => {
    it('resolves a keychain reference when available and present', async () => {
      const provider = new DefaultCredentialProvider({
        store: new EncryptedFileCredentialStore(dorkHome),
        keychain: new FakeKeychain(true, { anthropic: SECRET }),
      });

      await expect(provider.resolve('keychain:anthropic')).resolves.toEqual({
        ok: true,
        secret: SECRET,
      });
    });

    it('surfaces a present-but-missing keychain entry as unresolved', async () => {
      const provider = new DefaultCredentialProvider({
        store: new EncryptedFileCredentialStore(dorkHome),
        keychain: new FakeKeychain(true, {}),
      });

      const result = await provider.resolve('keychain:anthropic');
      expect(result).toMatchObject({ ok: false, reason: 'unresolved' });
    });

    it('falls back honestly to unavailable when no keychain backend exists', async () => {
      const provider = new DefaultCredentialProvider({
        store: new EncryptedFileCredentialStore(dorkHome),
        keychain: new FakeKeychain(false),
      });

      const result = await provider.resolve('keychain:anthropic');
      expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    });
  });

  describe('malformed references', () => {
    it.each([
      ['plaintext-no-scheme', 'plaintext'],
      ['unknown scheme', 'vault:anthropic'],
      ['empty value', 'env:'],
      ['raw secret masquerading', 'sk-ant-1234567890'],
    ])('rejects %s as a typed malformed failure (never throws)', async (_label, ref) => {
      const provider = new DefaultCredentialProvider({
        store: new EncryptedFileCredentialStore(dorkHome),
        keychain: new FakeKeychain(true, {}),
      });

      const result = await provider.resolve(ref);
      expect(result).toMatchObject({ ok: false, reason: 'malformed', ref });
    });
  });

  describe('security: no secret leakage', () => {
    it('never includes the secret in any failure message', async () => {
      // The provider only ever fails when there is NO secret to resolve, but
      // assert defensively that no failure branch echoes a value.
      const provider = new DefaultCredentialProvider({
        store: new EncryptedFileCredentialStore(dorkHome),
        keychain: new FakeKeychain(false),
        env: {},
      });

      for (const ref of ['env:MISSING', 'file:missing', 'keychain:missing', 'bogus']) {
        const result = await provider.resolve(ref);
        if (!result.ok) expect(result.message).not.toContain(SECRET);
      }
    });

    it('stores file secrets encrypted — plaintext never hits the store file on disk', async () => {
      const store = new EncryptedFileCredentialStore(dorkHome);
      await store.put('anthropic', SECRET);

      const onDisk = readFileSync(
        join(dorkHome, 'extension-secrets', 'runtime-credentials.json'),
        'utf-8'
      );
      expect(onDisk).not.toContain(SECRET);
    });

    it('persists only the reference in config.json — never the secret', async () => {
      // Store the secret via the port's write companion, then persist ONLY the
      // reference in config — exactly what the connect endpoints (2.3) will do.
      initCredentialProvider(dorkHome);
      const ref = await credentialStore.put('anthropic', SECRET);

      initConfigManager(dorkHome);
      configManager.set('providers', { anthropic: ref });

      const configJson = readFileSync(join(dorkHome, 'config.json'), 'utf-8');
      expect(configJson).toContain('file:anthropic');
      expect(configJson).not.toContain(SECRET);
    });
  });
});

describe('MacOsKeychainAccessor', () => {
  it('reports availability strictly from the platform (no real keychain access)', () => {
    const accessor = new MacOsKeychainAccessor();
    expect(accessor.isAvailable()).toBe(process.platform === 'darwin');
  });

  it('returns null without spawning when the platform has no keychain backend', async () => {
    const accessor = new MacOsKeychainAccessor();
    if (accessor.isAvailable()) return; // darwin has a real backend — skip the negative probe
    await expect(accessor.get('anything')).resolves.toBeNull();
  });
});
