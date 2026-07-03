/**
 * CredentialProvider port — resolves a stored credential REFERENCE to a secret
 * at the runtime env-injection seam (ADR-0315, effortless-runtime-switching T1).
 *
 * A credential is never persisted as plaintext: config holds a reference using
 * the `keychain:<id>` / `env:<VAR>` / `file:<name>` scheme (see
 * `@dorkos/shared/config-schema`), and this port resolves it just-in-time when
 * a runtime assembles its subprocess env. The secret is never logged, never
 * cached as plaintext, and never echoed by any endpoint.
 *
 * Resolution returns a discriminated {@link CredentialResolution}: a success
 * carries the secret, a failure carries a typed reason (a dangling reference
 * surfaces honestly as `unresolved`, never as an empty string). `resolve` never
 * throws — every backend error is caught and mapped to a typed failure — so a
 * secret can never leak through an exception message.
 *
 * The `file:` scheme reuses the never-echo, write-only secret pattern
 * ({@link EncryptedFileCredentialStore} wraps `ExtensionSecretStore`), so
 * file-backed secrets are AES-256-GCM encrypted on disk under `{dorkHome}`.
 *
 * @module services/core/credential-provider
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';
import { parseCredentialReference } from '@dorkos/shared/config-schema';

const execFileAsync = promisify(execFile);

/** Fixed store id for the encrypted file-scheme secret store (one JSON file under `{dorkHome}/extension-secrets/`). */
const CREDENTIAL_STORE_ID = 'runtime-credentials';

/** macOS keychain service under which file-less keychain secrets are stored/read. */
const KEYCHAIN_SERVICE = 'dorkos';

/** Upper bound on a keychain lookup so a stalled `security` invocation can never hang a spawn. */
const KEYCHAIN_TIMEOUT_MS = 5_000;

/** Why a credential reference failed to resolve (a secret is never carried on any failure). */
export type CredentialFailureReason =
  /** The string is not a well-formed `<scheme>:<value>` reference. */
  | 'malformed'
  /** A recognized scheme with a value, but the underlying secret is absent (a dangling reference). */
  | 'unresolved'
  /** The backend for this scheme is not available in this environment (e.g. no OS keychain). */
  | 'unavailable';

/**
 * Discriminated result of resolving a credential reference. Success carries the
 * secret; failure carries a typed reason and an honest, secret-free message.
 */
export type CredentialResolution =
  | { ok: true; secret: string }
  | { ok: false; reason: CredentialFailureReason; ref: string; message: string };

/** Narrow read port injected at each runtime's env-injection seam. */
export interface CredentialProvider {
  /**
   * Resolve a credential reference to its secret, or a typed failure. Never
   * throws; a dangling reference resolves to `{ ok: false, reason: 'unresolved' }`.
   *
   * @param ref - A stored reference (`keychain:`/`env:`/`file:`).
   */
  resolve(ref: string): Promise<CredentialResolution>;
}

/**
 * Write-only, never-echo secret store backing the `file:` scheme. A companion
 * to the read port: the connect endpoints (T1, task 2.3) write a secret here
 * and persist the returned `file:<name>` reference in config.
 */
export interface CredentialStore {
  /**
   * Encrypt and store `secret` under `name`, returning its `file:<name>`
   * reference. The secret is never echoed back.
   *
   * @param name - Stable key for the secret (becomes the reference's value).
   * @param secret - The plaintext secret to encrypt at rest.
   */
  put(name: string, secret: string): Promise<string>;
  /**
   * Read a stored secret by name, or `null` when absent. Used by the provider
   * to resolve a `file:` reference; not exposed to any endpoint.
   *
   * @param name - The key the secret was stored under.
   */
  get(name: string): Promise<string | null>;
  /**
   * Remove a stored secret. Safe to call when the name is absent.
   *
   * @param name - The key to delete.
   */
  delete(name: string): Promise<void>;
}

/** Reads a secret from the OS keychain, guarding platform availability. */
export interface KeychainAccessor {
  /** Whether an OS keychain backend is usable in this environment. */
  isAvailable(): boolean;
  /**
   * Read a keychain secret by id, or `null` when absent. Must never throw a
   * secret; treats any backend error as "not found".
   *
   * @param id - The keychain entry id (the reference's value).
   */
  get(id: string): Promise<string | null>;
}

/**
 * File-backed {@link CredentialStore} using the encrypted, never-echo
 * {@link ExtensionSecretStore} pattern (AES-256-GCM under `{dorkHome}`), scoped
 * to a single {@link CREDENTIAL_STORE_ID} store. Plaintext is only ever held in
 * memory transiently; on disk the value is ciphertext.
 */
export class EncryptedFileCredentialStore implements CredentialStore {
  private readonly store: ExtensionSecretStore;

  /**
   * Construct the store scoped to the given data directory.
   *
   * @param dorkHome - The resolved DorkOS data directory (never `os.homedir()`;
   *   see `lib/dork-home.ts`).
   */
  constructor(dorkHome: string) {
    this.store = new ExtensionSecretStore(CREDENTIAL_STORE_ID, dorkHome);
  }

  async put(name: string, secret: string): Promise<string> {
    await this.store.set(name, secret);
    return `file:${name}`;
  }

  async get(name: string): Promise<string | null> {
    return this.store.get(name);
  }

  async delete(name: string): Promise<void> {
    await this.store.delete(name);
  }
}

/**
 * macOS keychain accessor via the `security` CLI. Available only on darwin
 * (where `security` ships); every other platform reports unavailable so a
 * `keychain:` reference fails honestly rather than pretending. A lookup is
 * time-bounded so a stalled keychain can never hang a runtime spawn, and any
 * error (including "item not found", exit 44) maps to `null`.
 */
export class MacOsKeychainAccessor implements KeychainAccessor {
  isAvailable(): boolean {
    return process.platform === 'darwin';
  }

  async get(id: string): Promise<string | null> {
    if (!this.isAvailable()) return null;
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', id, '-w'],
        { timeout: KEYCHAIN_TIMEOUT_MS, killSignal: 'SIGKILL' }
      );
      // `-w` prints the raw password on stdout with a trailing newline.
      const secret = stdout.replace(/\n$/, '');
      return secret.length > 0 ? secret : null;
    } catch {
      // Not found (exit 44), timeout, or any other `security` error — the entry
      // is not resolvable. Never surface the error (it may echo context).
      return null;
    }
  }
}

/**
 * Default {@link CredentialProvider}: dispatches on the reference scheme.
 * `env:` reads an arbitrary process env var, `file:` reads the encrypted store,
 * `keychain:` reads the OS keychain (guarded). Every path is failure-typed and
 * throw-free.
 */
export class DefaultCredentialProvider implements CredentialProvider {
  private readonly store: CredentialStore;
  private readonly keychain: KeychainAccessor;
  private readonly env: NodeJS.ProcessEnv;

  /**
   * Construct the provider from its per-scheme backends.
   *
   * @param deps.store - Backing store for the `file:` scheme.
   * @param deps.keychain - Keychain accessor for the `keychain:` scheme
   *   (defaults to the macOS `security`-backed accessor).
   * @param deps.env - Env source for the `env:` scheme (defaults to
   *   `process.env`; injectable for tests).
   */
  constructor(deps: {
    store: CredentialStore;
    keychain?: KeychainAccessor;
    env?: NodeJS.ProcessEnv;
  }) {
    this.store = deps.store;
    this.keychain = deps.keychain ?? new MacOsKeychainAccessor();
    // eslint-disable-next-line no-restricted-syntax -- the env: scheme resolves an arbitrary user-named var that env.ts cannot enumerate
    this.env = deps.env ?? process.env;
  }

  async resolve(ref: string): Promise<CredentialResolution> {
    const parsed = parseCredentialReference(ref);
    if (!parsed) {
      return {
        ok: false,
        reason: 'malformed',
        ref,
        message: 'Not a valid credential reference (expected keychain:, env:, or file:).',
      };
    }

    const { scheme, value } = parsed;
    switch (scheme) {
      case 'env': {
        const secret = this.env[value];
        if (secret == null || secret === '') {
          return {
            ok: false,
            reason: 'unresolved',
            ref,
            message: `Environment variable ${value} is not set.`,
          };
        }
        return { ok: true, secret };
      }
      case 'file': {
        const secret = await this.store.get(value);
        if (secret == null) {
          return {
            ok: false,
            reason: 'unresolved',
            ref,
            message: `No stored credential named "${value}".`,
          };
        }
        return { ok: true, secret };
      }
      case 'keychain': {
        if (!this.keychain.isAvailable()) {
          return {
            ok: false,
            reason: 'unavailable',
            ref,
            message: 'The OS keychain is not available on this platform.',
          };
        }
        const secret = await this.keychain.get(value);
        if (secret == null) {
          return {
            ok: false,
            reason: 'unresolved',
            ref,
            message: `Keychain entry "${value}" was not found.`,
          };
        }
        return { ok: true, secret };
      }
    }
  }
}

/**
 * Module singleton for the encrypted file-scheme store (the write companion,
 * consumed by the connect endpoints in T1 task 2.3). Set by
 * {@link initCredentialProvider}.
 */
export let credentialStore: CredentialStore;

/**
 * Module singleton for the credential read port, injected at each runtime's
 * env-injection seam. Set by {@link initCredentialProvider}.
 */
export let credentialProvider: CredentialProvider;

/**
 * Initialize the credential singletons for the given data directory. Called
 * once at server startup (after {@link initConfigManager}), mirroring how the
 * config manager is wired.
 *
 * @param dorkHome - The resolved DorkOS data directory (`lib/dork-home.ts`).
 */
export function initCredentialProvider(dorkHome: string): CredentialProvider {
  credentialStore = new EncryptedFileCredentialStore(dorkHome);
  credentialProvider = new DefaultCredentialProvider({ store: credentialStore });
  return credentialProvider;
}
