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
 *   reference is NOT resolved at an env seam — and nothing else reads one either.
 *   The key is applied where `codex login` writes it — `$CODEX_HOME/auth.json` —
 *   via `codex login --with-api-key` (secret piped over stdin, never argv).
 *   DorkOS therefore stores NOTHING at rest for Codex (an encrypted copy would be
 *   needless secret-at-rest); `codex login status` (the requirements probe) is the
 *   single source of truth, so the store result carries no reference (`ref: null`).
 *
 * This module also hosts the ONE way to persist an OpenCode provider credential
 * ({@link persistProviderCredential} / {@link storeProviderCredential}, task 2.8):
 * encrypt the secret to a reference, record it under `providers[providerId]`, and
 * select the provider for OpenCode. OpenRouter (task 2.6) reuses it so there is a
 * single audited credential-persistence path.
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
 * @returns The stored credential reference for Claude (`file:anthropic`), or
 *   `null` for Codex (whose key lives in `$CODEX_HOME/auth.json`, not DorkOS).
 * @throws {ConnectError} When the type is unknown, the secret is empty, or the
 *   Codex apply step fails (config is never mutated on failure).
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

  // Codex: apply the key to Codex's own auth store (codex login --with-api-key)
  // and store NOTHING at rest. Nothing reads a DorkOS-held Codex reference — the
  // adapter never sets a subprocess env var and `codex login status` is the live
  // source of truth — so an encrypted copy or a config credentialRef would be
  // needless secret-at-rest. On failure config is never touched (we throw before
  // any write), so no rollback is needed.
  const applied = deps.applyCodex
    ? await deps.applyCodex(secret)
    : await applyCodexApiKey(secret, deps);
  if (!applied.ok) {
    throw new ConnectError(applied.error ?? 'Could not save the Codex API key.', 502);
  }
  return { ref: null };
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

/** Store/config seams for the OpenCode provider-credential path (production defaults resolve singletons). */
export type ProviderCredentialDeps = Pick<StoreCredentialDeps, 'store' | 'config'>;

/** A provider id + secret (+ optional base URL) to persist for OpenCode. */
export interface ProviderCredentialInput {
  /** OpenAI-compatible provider id, e.g. `openai` or `openrouter`. */
  providerId: string;
  /** The raw provider API key. Stored encrypted; never returned or logged. */
  secret: string;
  /**
   * Optional OpenAI-compatible base URL. When present (a string OR `null`) it is
   * written to `runtimes.opencode.baseURL` — `null` clears a stale override; when
   * omitted, the base URL is left untouched.
   */
  baseURL?: string | null;
}

/**
 * Persist an OpenCode provider credential — the ONE way (shared by the Direct
 * path, task 2.8, and OpenRouter, task 2.6). Encrypts the secret to a reference,
 * records it under `providers[providerId]`, and selects the provider for OpenCode
 * (`runtimes.opencode.provider`), optionally setting `runtimes.opencode.baseURL`.
 * Performs NO input validation (callers validate first) and never returns or logs
 * the secret. The stored reference is picked up at the sidecar env seam by
 * `resolveOpenCodeProviderEnv`.
 *
 * @param input - Provider id + secret (+ optional base URL).
 * @param deps - Injectable store/config seams (production defaults).
 * @returns The stored credential reference (never the secret).
 */
export async function persistProviderCredential(
  input: ProviderCredentialInput,
  deps: ProviderCredentialDeps = {}
): Promise<StoreCredentialResult> {
  const store = deps.store ?? credentialStore;
  const config = deps.config ?? configManager;
  const ref = await store.put(input.providerId, input.secret);
  config.set('providers', { ...config.get('providers'), [input.providerId]: ref });
  const runtimes = config.get('runtimes');
  const opencode = { ...runtimes.opencode, provider: input.providerId };
  if (input.baseURL !== undefined) {
    opencode.baseURL = input.baseURL;
  }
  config.set('runtimes', { ...runtimes, opencode });
  return { ref };
}

/**
 * Store an OpenCode Direct-provider key: validate inputs, then persist via
 * {@link persistProviderCredential}. Backs `POST /api/runtimes/opencode/provider/credential`.
 *
 * @param input - Provider id + secret (+ optional base URL).
 * @param deps - Injectable store/config seams (production defaults).
 * @returns The stored credential reference (never the secret).
 * @throws {ConnectError} 400 when the provider id or secret is empty.
 */
export async function storeProviderCredential(
  input: ProviderCredentialInput,
  deps: ProviderCredentialDeps = {}
): Promise<StoreCredentialResult> {
  if (!input.providerId || input.providerId.trim().length === 0) {
    throw new ConnectError('A provider id is required.', 400);
  }
  if (!input.secret || input.secret.trim().length === 0) {
    throw new ConnectError('A non-empty API key is required.', 400);
  }
  return persistProviderCredential(input, deps);
}
