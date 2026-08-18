/**
 * Encrypted per-extension secret store using AES-256-GCM.
 *
 * Secrets are stored in `{dorkHome}/extension-secrets/{extensionId}.json`.
 * The host key lives at `{dorkHome}/host.key` (mode 0o600).
 * Encryption format: base64(IV[16] || AuthTag[16] || Ciphertext).
 *
 * @module shared/extension-secrets
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { withFileLock } from './atomic-write.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT = 'dorkos-ext-secrets';

/** Per-process cache of the derived encryption key. */
let cachedDerivedKey: Buffer | null = null;
let cachedDorkHome: string | null = null;

/**
 * Reset the cached derived key. Exported for testing only.
 *
 * @internal
 */
export function resetKeyCache(): void {
  cachedDerivedKey = null;
  cachedDorkHome = null;
}

/**
 * Encrypted per-extension secret store using AES-256-GCM.
 *
 * Each extension gets its own JSON file under `{dorkHome}/extension-secrets/`.
 * A shared host key at `{dorkHome}/host.key` is used to derive the encryption
 * key via scrypt. The derived key is cached per-process to avoid repeated
 * key derivation; the secrets themselves are read from disk on every access, so
 * a store held by a running extension always sees what was last saved (see
 * {@link ExtensionSecretStore.loadSecrets}).
 */
export class ExtensionSecretStore {
  private readonly secretsFilePath: string;
  private readonly hostKeyPath: string;

  constructor(
    private readonly extensionId: string,
    private readonly dorkHome: string
  ) {
    this.secretsFilePath = join(dorkHome, 'extension-secrets', `${extensionId}.json`);
    this.hostKeyPath = join(dorkHome, 'host.key');
  }

  /** Get a secret value by key. Returns null if not set. */
  async get(key: string): Promise<string | null> {
    const secrets = await this.loadSecrets();
    const encrypted = secrets[key];
    if (!encrypted) return null;
    try {
      return this.decrypt(encrypted);
    } catch {
      // Corrupted data — treat as missing
      return null;
    }
  }

  /** Set a secret value. Writes through to disk immediately. */
  async set(key: string, value: string): Promise<void> {
    await this.mutate((secrets) => {
      secrets[key] = this.encrypt(value);
    });
  }

  /** Delete a secret. Writes through to disk immediately. */
  async delete(key: string): Promise<void> {
    await this.mutate((secrets) => {
      delete secrets[key];
    });
  }

  /** Check if a secret key is set (without decrypting). */
  async has(key: string): Promise<boolean> {
    const secrets = await this.loadSecrets();
    return key in secrets;
  }

  /**
   * Every key currently stored, names only — nothing is decrypted. Lets a caller
   * forget a whole family of secrets (every key an agent owns, say) without
   * having to know each name in advance.
   */
  async keys(): Promise<string[]> {
    return Object.keys(await this.loadSecrets());
  }

  private encrypt(plaintext: string): string {
    const key = this.getDerivedKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Format: IV[16] || AuthTag[16] || Ciphertext
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  }

  private decrypt(encoded: string): string {
    const key = this.getDerivedKey();
    const buf = Buffer.from(encoded, 'base64');
    const iv = buf.subarray(0, IV_LENGTH);
    const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  }

  private getDerivedKey(): Buffer {
    if (cachedDerivedKey && cachedDorkHome === this.dorkHome) {
      return cachedDerivedKey;
    }
    const hostKey = this.loadOrCreateHostKey();
    cachedDerivedKey = scryptSync(hostKey, SALT, KEY_LENGTH) as Buffer;
    cachedDorkHome = this.dorkHome;
    return cachedDerivedKey;
  }

  private loadOrCreateHostKey(): Buffer {
    const keyPath = this.hostKeyPath;
    if (existsSync(keyPath)) {
      return readFileSync(keyPath);
    }
    const key = randomBytes(KEY_LENGTH);
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, key, { mode: 0o600 });
    return key;
  }

  /**
   * Read the on-disk secrets. A missing or unreadable file is an empty store.
   *
   * Deliberately uncached. A store instance can outlive many writes to the file
   * it reads: an extension's `ctx.secrets` and a dataProxy's store are built
   * once, when the extension starts, while the settings routes that save a
   * secret build their own store and write straight to disk. An in-memory copy
   * taken at the first read therefore froze the running extension's view of its
   * own secrets — a key pasted in Settings never arrived, and only a server
   * restart fixed it (DOR-1336 review). Nothing here was ever a hot path: the
   * file is a small JSON object, reads are per proxied request or per credential
   * lookup, and the expensive part — the scrypt key derivation — is still cached
   * per process by {@link getDerivedKey}.
   */
  private async loadSecrets(): Promise<Record<string, string>> {
    try {
      const data = await readFile(this.secretsFilePath, 'utf-8');
      return JSON.parse(data) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /**
   * Apply `change` to the secrets file as one serialised read-modify-write.
   *
   * Every mutation re-reads from disk INSIDE the path lock: two callers setting
   * different keys would otherwise each save their own view and drop the other's
   * secret. The lock makes the read and the write one step, and
   * `runtime-credentials.json` is the file that cannot afford a lost update.
   *
   * @param change - Mutates the freshly-read secrets map in place.
   */
  private async mutate(change: (secrets: Record<string, string>) => void): Promise<void> {
    await withFileLock(this.secretsFilePath, async (write) => {
      const secrets = await this.loadSecrets();
      change(secrets);
      await write(JSON.stringify(secrets, null, 2));
    });
  }
}
