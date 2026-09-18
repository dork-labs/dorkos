/**
 * The ONE way to persist an OpenCode provider credential (ADR-0318 task 2.8,
 * ADR-0315 for the sidecar recycle).
 *
 * It lives in its own module so the two callers that need it — the Direct
 * "your own key" path and the OpenRouter cloud path — can share it without the
 * import graph doubling back on itself. Before this split, the pre-save key
 * check imported OpenRouter's validator, OpenRouter imported this function from
 * the credential module, and the credential module imported the check: a cycle
 * that worked only because every use was lazy. A single audited persist path is
 * worth keeping; a cycle guarding it is not.
 *
 * Nothing here validates its input — callers validate first — and nothing here
 * returns or logs the secret.
 *
 * @module services/runtimes/connect/persist-provider-credential
 */
import type { UserConfig } from '@dorkos/shared/config-schema';
import type { StoreCredentialResult } from '@dorkos/shared/runtime-connect';
import { credentialStore, type CredentialStore } from '../../core/credential-provider.js';
import { configManager } from '../../core/config-manager.js';
import { openCodeServerManager } from '../opencode/server-manager.js';

/** Minimal read/write surface of the config manager (injectable for tests). */
export interface ConfigReadWrite {
  get<K extends keyof UserConfig>(key: K): UserConfig[K];
  set<K extends keyof UserConfig>(key: K, value: UserConfig[K]): void;
}

/** Store/config seams for persisting a provider credential (production defaults resolve singletons). */
export interface PersistProviderDeps {
  /** Encrypted secret store (defaults to the module singleton). */
  store?: CredentialStore;
  /** Config reader/writer (defaults to the module singleton). */
  config?: ConfigReadWrite;
  /**
   * Recycle the OpenCode sidecar so a first-ever credential reaches it (defaults
   * to the sidecar manager's `recycle`). Injected in tests to assert the reboot
   * without spawning a process.
   */
  recycleSidecar?: () => Promise<void> | void;
}

/** A provider id + secret (+ optional base URL) to persist for OpenCode. */
export interface ProviderCredentialInput {
  /** OpenAI-compatible provider id, e.g. `openai` or `openrouter`. */
  providerId: string;
  /**
   * The raw provider API key — stored encrypted, never returned or logged — or
   * `null` to KEEP the reference already recorded for this provider id. `null`
   * is how "I only changed the base URL" is expressed: the person should not have
   * to re-paste a key DorkOS already holds just to move it to another address.
   */
  secret: string | null;
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
  deps: PersistProviderDeps = {}
): Promise<StoreCredentialResult> {
  const store = deps.store ?? credentialStore;
  const config = deps.config ?? configManager;
  const providers = config.get('providers');
  // A `null` secret keeps whatever reference is already recorded — deliberately
  // WITHOUT re-storing it, so a key held in the OS keychain or an env var is not
  // silently copied into the encrypted file store by a base-URL edit.
  const ref =
    input.secret === null
      ? (providers[input.providerId] ?? null)
      : await store.put(input.providerId, input.secret);
  if (ref !== null) {
    config.set('providers', { ...providers, [input.providerId]: ref });
  }
  const runtimes = config.get('runtimes');
  const opencode = { ...runtimes.opencode, provider: input.providerId };
  if (input.baseURL !== undefined) {
    opencode.baseURL = input.baseURL;
  }
  config.set('runtimes', { ...runtimes, opencode });
  // Recycle the sidecar so it re-reads the stored credential env on next use
  // (ADR-0315). This fires on EVERY provider-credential persist: on a first-ever
  // connect it is a no-op (no sidecar running yet, so the next boot already picks
  // the key up); when one is already running it reboots to apply the new env.
  // Deliberate trade-off: if a key is stored while a turn is in flight, that turn
  // is aborted by the restart. We accept it — a person storing a credential is a
  // deliberate connect action, and fresh credentials winning over a rare in-flight
  // turn is the honest behavior (no fragile skip-when-serving logic). Fire-and-
  // forget: recycle flips the manager's state synchronously, so the next
  // getClient() reboots even before the teardown settles, and a stored key never
  // fails on a teardown hiccup.
  const recycle = deps.recycleSidecar ?? (() => openCodeServerManager.recycle());
  void Promise.resolve(recycle()).catch(() => {});
  return { ref };
}
