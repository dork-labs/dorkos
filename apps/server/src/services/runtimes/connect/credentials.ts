/**
 * Runtime credential connect — the native paste-key path (ADR-0318,
 * effortless-runtime-switching T1, task 2.3a). Accepts a raw API key, encrypts it
 * at rest via the {@link CredentialStore}, persists only its REFERENCE in config,
 * and returns the reference — never the secret. No path logs the secret.
 *
 * The two runtimes differ in HOW the stored key reaches the runtime:
 * - Claude: the reference lives in the top-level `providers.anthropic` registry
 *   and is resolved to `ANTHROPIC_API_KEY` at the Claude message-sender env seam
 *   (task 2.2). Storing the reference is sufficient.
 * - Codex: the adapter never sets `CodexOptions.env` (codex/NOTES.md), so a
 *   reference is NOT resolved at an env seam. Instead the key is applied where
 *   `codex login` writes it — `$CODEX_HOME/auth.json` — via
 *   `codex login --with-api-key` (secret piped over stdin, never argv). The
 *   config `runtimes.codex.credentialRef` is then the record that Codex is
 *   connected via a native key; `codex login status` (the requirements probe)
 *   is the live source of truth.
 *
 * @module services/runtimes/connect/credentials
 */
import type { UserConfig } from '@dorkos/shared/config-schema';
import type { StoreCredentialResult, DelegatedLoginResult } from '@dorkos/shared/runtime-connect';
import { credentialStore, type CredentialStore } from '../../core/credential-provider.js';
import { configManager } from '../../core/config-manager.js';
import { resolveCodexBinaryPath } from '../codex/check-dependencies.js';
import { pipeSecretToChild, type SpawnFn } from './delegated-login.js';

/** Runtime types the native paste-key endpoint accepts. */
export const CREDENTIAL_RUNTIME_TYPES = ['claude-code', 'codex'] as const;

/** Minimal read/write surface of the config manager (injectable for tests). */
export interface ConfigReadWrite {
  get<K extends keyof UserConfig>(key: K): UserConfig[K];
  set<K extends keyof UserConfig>(key: K, value: UserConfig[K]): void;
}

/** Injectable dependencies for {@link storeRuntimeCredential} (production defaults resolve the singletons). */
export interface StoreCredentialDeps {
  /** Encrypted secret store (defaults to the module singleton). */
  store?: CredentialStore;
  /** Config reader/writer (defaults to the module singleton). */
  config?: ConfigReadWrite;
  /** Override the Codex key-apply step (tests inject to avoid spawning). */
  applyCodex?: (secret: string) => Promise<DelegatedLoginResult>;
  /** Spawn seam forwarded to the Codex apply (tests inject a fake). */
  spawn?: SpawnFn;
  /** Codex binary resolver (tests inject; defaults to the adapter resolver). */
  resolveCodexBinary?: () => Promise<string | null>;
}

/**
 * A connect failure with an HTTP status hint. Carries an honest, secret-free
 * message the route surfaces to the Connect UI.
 */
export class ConnectError extends Error {
  /** HTTP status the route should map this failure to. */
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ConnectError';
    this.status = status;
  }
}

/** Whether `type` is a runtime that supports the native paste-key path. */
export function isCredentialRuntimeType(
  type: string
): type is (typeof CREDENTIAL_RUNTIME_TYPES)[number] {
  return (CREDENTIAL_RUNTIME_TYPES as readonly string[]).includes(type);
}

/**
 * Store a runtime's native API key and persist only its reference.
 *
 * @param type - Runtime type (`'claude-code'` | `'codex'`).
 * @param secret - The raw API key. Stored encrypted; never returned or logged.
 * @param deps - Injectable store/config/apply seams (production defaults).
 * @returns The stored credential reference (never the secret).
 * @throws {ConnectError} When the type is unknown, the secret is empty, or the
 *   Codex apply step fails (the dangling reference is rolled back first).
 */
export async function storeRuntimeCredential(
  type: string,
  secret: string,
  deps: StoreCredentialDeps = {}
): Promise<StoreCredentialResult> {
  if (!isCredentialRuntimeType(type)) {
    throw new ConnectError(`"${type}" does not support a native API key.`, 400);
  }
  if (!secret || secret.trim().length === 0) {
    throw new ConnectError('A non-empty API key is required.', 400);
  }

  const store = deps.store ?? credentialStore;
  const config = deps.config ?? configManager;

  if (type === 'claude-code') {
    const ref = await store.put('anthropic', secret);
    config.set('providers', { ...config.get('providers'), anthropic: ref });
    return { ref };
  }

  // Codex: store the reference, then apply the key to Codex's own auth store.
  const ref = await store.put('codex', secret);
  const applied = deps.applyCodex
    ? await deps.applyCodex(secret)
    : await applyCodexApiKey(secret, deps);
  if (!applied.ok) {
    // The CLI rejected the key — roll back so config never records a dead reference.
    await store.delete('codex').catch(() => {});
    throw new ConnectError(applied.error ?? 'Could not save the Codex API key.', 502);
  }
  const runtimes = config.get('runtimes');
  config.set('runtimes', { ...runtimes, codex: { ...runtimes.codex, credentialRef: ref } });
  return { ref };
}

/**
 * Apply a Codex API key by writing it where `codex login` would
 * (`codex login --with-api-key`, secret piped over stdin). Returns an honest
 * not-found state when the Codex CLI is unresolvable.
 *
 * @param secret - The raw API key (piped to stdin, never on argv).
 * @param deps - Injectable spawn + binary resolver seams.
 */
export async function applyCodexApiKey(
  secret: string,
  deps: Pick<StoreCredentialDeps, 'spawn' | 'resolveCodexBinary'> = {}
): Promise<DelegatedLoginResult> {
  const resolveBinary = deps.resolveCodexBinary ?? resolveCodexBinaryPath;
  const binary = await resolveBinary();
  if (!binary) {
    return { ok: false, error: 'The Codex CLI is not available to save the API key.' };
  }
  return pipeSecretToChild(
    { binary, args: ['login', '--with-api-key'] },
    secret,
    deps.spawn ? { spawn: deps.spawn } : {}
  );
}
