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
 * Every save here runs the key past its own service FIRST
 * ({@link checkRuntimeKey} / {@link checkProviderKey}) and stores nothing when
 * it comes back refused — the fix for keys that saved cleanly and then failed on
 * the first turn, far from the form that caused it (DOR-2123). The same module
 * answers the read side, {@link readOpenCodeDirectSetup} and
 * {@link readRuntimeKeyStatus}, so a reopened form shows what is already saved
 * with a last-4 hint and nothing more of the secret.
 *
 * Writing to disk is not done here: every path that persists a provider
 * credential goes through `persist-provider-credential.ts`, the ONE audited
 * write, which OpenRouter shares. This module is the validation, the check, and
 * the read-back around it.
 *
 * @module services/runtimes/connect/credentials
 */
import type {
  CredentialCheckResult,
  DelegatedLoginResult,
  OpenCodeDirectSetup,
  RuntimeKeyStatus,
  SavedKeyState,
  StoreCredentialResult,
} from '@dorkos/shared/runtime-connect';
import {
  credentialProvider,
  credentialStore,
  type CredentialProvider,
  type CredentialStore,
} from '../../core/credential-provider.js';
import { configManager } from '../../core/config-manager.js';
import { ANTHROPIC_PROVIDER_ID } from '../../core/credential-env.js';
import { resolveCodexBinaryPath } from '../codex/check-dependencies.js';
import { checkProviderKey, checkRuntimeKey, type FetchFn } from './check-credential.js';
import { ConnectError } from './connect-error.js';
import {
  persistProviderCredential,
  type ConfigReadWrite,
  type PersistProviderDeps,
  type ProviderCredentialInput,
} from './persist-provider-credential.js';
import { pipeSecretToChild, type SpawnFn } from './delegated-login.js';

/** Runtime types the native paste-key endpoint accepts. */
export const CREDENTIAL_RUNTIME_TYPES = ['claude-code', 'codex'] as const;

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
  /**
   * Try the key against its own service before anything is stored (defaults to
   * {@link checkRuntimeKey}). Injected in tests so a unit test never reaches the
   * network — and so a test can prove nothing persists when the check says no.
   */
  checkKey?: (type: string, secret: string) => Promise<CredentialCheckResult>;
  /**
   * `fetch` seam handed to the REAL key check when {@link checkKey} is not
   * given. Lets a test exercise the genuine check end to end with only the
   * network stubbed.
   */
  fetchImpl?: FetchFn;
  /**
   * Credential read port used to resolve a stored reference back to its secret
   * (defaults to the module singleton). Only ever used to compute a last-4 hint
   * or to re-check a key the person kept — the secret never leaves the server.
   */
  credentials?: CredentialProvider;
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

  // Check BEFORE anything is written. A key that the service itself refuses used
  // to save cleanly and then fail on the first turn, where nothing connected the
  // failure back to the form that caused it (DOR-2123).
  const check = await (deps.checkKey
    ? deps.checkKey(type, secret)
    : checkRuntimeKey(type, secret, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}));
  if (!check.ok) {
    throw new ConnectError(check.message, 400);
  }

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

/** Store/config/check seams for the OpenCode provider-credential path (production defaults resolve singletons). */
export type ProviderCredentialDeps = PersistProviderDeps & {
  /**
   * Try the key against its own service before anything is stored (defaults to
   * {@link checkProviderKey}). Injected in tests so a unit test never reaches
   * the network.
   */
  checkKey?: (input: {
    providerId: string;
    secret: string;
    baseURL?: string | null;
  }) => Promise<CredentialCheckResult>;
  /**
   * Credential read port used to resolve a stored reference back to its secret
   * (defaults to the module singleton), for the last-4 hint and for re-checking
   * a key the person chose to keep.
   */
  credentials?: CredentialProvider;
  /**
   * `fetch` seam handed to the REAL key check when {@link checkKey} is not
   * given. Lets a test exercise the genuine check end to end with only the
   * network stubbed.
   */
  fetchImpl?: FetchFn;
};

/**
 * The base URL as it should be STORED: trimmed, with a blank one recorded as
 * "no override" rather than as an address of `""`.
 *
 * `undefined` is passed through as `undefined`, which means "leave whatever is
 * saved alone" — a different instruction from "clear it", and the two must not
 * collapse into each other.
 *
 * Every provider id goes through this, listed or not. An id the list does not
 * serve is refused later, by the key check's allow-list — but "later" still
 * leaves this function running first, and an unlisted id that skipped the trim
 * could write `"   "` into `opencode.baseURL` on its way to that refusal.
 *
 * @param baseURL - The base URL as given: a string, `null` to clear it, or
 *   `undefined` to leave whatever is saved alone.
 */
function normalizeStoredBaseURL(baseURL: string | null | undefined): string | null | undefined {
  if (baseURL === undefined) return undefined;
  return baseURL?.trim() ? baseURL.trim() : null;
}

/**
 * Store an OpenCode Direct-provider key: validate inputs, try the key against
 * the service it belongs to, and only then persist via
 * {@link persistProviderCredential}. Backs `POST /api/runtimes/opencode/provider/credential`.
 *
 * An EMPTY secret means "keep the key you already have": the saved key is
 * resolved, re-checked, and the service is persisted without re-storing the
 * secret. On that path a caller-supplied base URL is IGNORED and the address
 * already saved for that key is used instead — moving a key to a new address
 * requires pasting the key, because otherwise naming an address would be enough
 * to have someone else's saved key delivered to it. With nothing saved, an empty
 * secret is still the 400 it always was.
 *
 * @param input - Provider id + secret (+ optional base URL).
 * @param deps - Injectable store/config/check seams (production defaults).
 * @returns The stored credential reference (never the secret).
 * @throws {ConnectError} 400 when the provider id is empty, when no key is
 *   given and none is saved, or when the key is not accepted. Nothing is
 *   persisted on any of those.
 */
export async function storeProviderCredential(
  input: ProviderCredentialInput,
  deps: ProviderCredentialDeps = {}
): Promise<StoreCredentialResult> {
  const providerId = input.providerId?.trim() ?? '';
  if (providerId.length === 0) {
    throw new ConnectError('A provider id is required.', 400);
  }
  const baseURL = normalizeStoredBaseURL(input.baseURL);

  const typed = input.secret?.trim() ? input.secret : null;
  const saved = typed === null ? await readSavedSecret(providerId, deps) : null;
  if (typed === null && saved === null) {
    throw new ConnectError('A non-empty API key is required.', 400);
  }

  // A key DorkOS already holds is only ever sent to the address DorkOS already
  // holds it for. A caller-named address is IGNORED on this path — otherwise
  // anyone who can reach this endpoint could name their own server and have the
  // saved key delivered to it, which is a credential-exfiltration primitive
  // dressed up as a settings change. Moving a key to a new address therefore
  // means pasting the key again, which is a person's own deliberate act.
  const target = typed === null ? savedKeyAddress(providerId, deps) : baseURL;

  const check = await runProviderCheck(
    { providerId, secret: typed ?? (saved as string), baseURL: target ?? null },
    deps
  );
  if (!check.ok) {
    throw new ConnectError(check.message, 400);
  }

  return persistProviderCredential({ ...input, providerId, secret: typed, baseURL: target }, deps);
}

/**
 * Try an OpenCode Direct-provider key without saving anything — the Test button,
 * and the same check every save runs. Backs
 * `POST /api/runtimes/opencode/provider/credential/check`.
 *
 * A `null` secret tries the key ALREADY saved for that service, which is what
 * "Test" means on a reopened form where the key field is deliberately empty.
 *
 * @param input - Service id, the key to try (or `null` for the saved one), and
 *   an optional base URL override.
 * @param deps - Injectable config/credential-read/check seams.
 * @returns Accepted, or an honest reason and a line a person can act on.
 * @throws {ConnectError} 400 when the service id is unknown, or when there is no
 *   key to try at all.
 */
export async function checkProviderCredential(
  input: { providerId: string; secret: string | null; baseURL?: string | null },
  deps: ProviderCredentialDeps = {}
): Promise<CredentialCheckResult> {
  const providerId = input.providerId?.trim() ?? '';
  if (providerId.length === 0) {
    throw new ConnectError('A provider id is required.', 400);
  }
  const baseURL = normalizeStoredBaseURL(input.baseURL);
  const typed = input.secret?.trim() ? input.secret : null;
  const secret = typed ?? (await readSavedSecret(providerId, deps));
  if (secret === null) {
    throw new ConnectError('Paste the key to check it.', 400);
  }
  // Same rule as the save: a saved key is only ever sent to the address it is
  // already saved for, never to one the caller named. A Test that honoured a
  // caller's address would be the exfiltration path the save refuses.
  const target = typed === null ? savedKeyAddress(providerId, deps) : baseURL;
  return runProviderCheck({ providerId, secret, baseURL: target ?? null }, deps);
}

/**
 * Try a runtime's own key without saving anything. Backs
 * `POST /api/runtimes/:type/credential/check`.
 *
 * A `null` secret tries the key already saved — which only Claude Code can do,
 * because Codex's key lives in Codex's own login store and DorkOS holds no copy
 * to try. Codex therefore asks for the key to be pasted.
 *
 * @param type - Runtime type (`'claude-code'` | `'codex'`).
 * @param secret - The key to try, or `null` to try the saved one.
 * @param deps - Injectable config/credential-read/check seams.
 * @returns Accepted, or an honest reason and a line a person can act on.
 * @throws {ConnectError} 400 when the runtime has no native key path, or when
 *   there is no key to try at all.
 */
export async function checkRuntimeCredential(
  type: string,
  secret: string | null,
  deps: StoreCredentialDeps = {}
): Promise<CredentialCheckResult> {
  if (!isCredentialRuntimeType(type)) {
    throw new ConnectError(`"${type}" does not support a native API key.`, 400);
  }
  let candidate = secret?.trim() ? secret : null;
  if (candidate === null && type === 'claude-code') {
    candidate = await readSavedSecret(ANTHROPIC_PROVIDER_ID, deps);
  }
  if (candidate === null) {
    throw new ConnectError('Paste the key to check it.', 400);
  }
  if (deps.checkKey) return deps.checkKey(type, candidate);
  return checkRuntimeKey(type, candidate, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
}

/**
 * Run the pre-save key check through the injected seam, or through the real
 * checker with the injected `fetch` when no seam is given. The two-step lets a
 * test drive the REAL check (stubbing only the network) instead of replacing it
 * with a stub that would agree with whatever the test expects.
 *
 * @param input - Service id, the key, and the address to check it at.
 * @param deps - Injectable check/`fetch` seams.
 */
function runProviderCheck(
  input: { providerId: string; secret: string; baseURL: string | null },
  deps: ProviderCredentialDeps
): Promise<CredentialCheckResult> {
  if (deps.checkKey) return deps.checkKey(input);
  return checkProviderKey(input, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
}

/**
 * The address DorkOS already associates with the key saved for `providerId`, or
 * `null` when it has none (in which case the service's own address is used).
 *
 * This is the ONLY address a saved key is ever sent to. It reads the selected
 * service's stored base URL, and answers `null` for any other service, so
 * switching to a service whose key is saved does not inherit the previous
 * service's address.
 *
 * @param providerId - The wire id whose saved key is about to be used.
 * @param deps - Injectable config seam (production defaults to the singleton).
 */
function savedKeyAddress(
  providerId: string,
  deps: Pick<ProviderCredentialDeps, 'config'>
): string | null {
  const opencode = (deps.config ?? configManager).get('runtimes').opencode;
  return opencode.provider === providerId ? (opencode.baseURL ?? null) : null;
}

/**
 * Resolve the secret behind the reference recorded for `providerId`, or `null`
 * when none is recorded or the reference no longer resolves. Used only to
 * re-check a key the person kept and to compute a last-4 hint; the plaintext
 * never leaves this module.
 *
 * @param providerId - The provider id whose reference to resolve.
 * @param deps - Injectable config/credential-read seams.
 */
async function readSavedSecret(
  providerId: string,
  deps: Pick<ProviderCredentialDeps, 'config' | 'credentials'>
): Promise<string | null> {
  const config = deps.config ?? configManager;
  const ref = config.get('providers')[providerId];
  if (!ref) return null;
  const resolved = await (deps.credentials ?? credentialProvider).resolve(ref);
  return resolved.ok ? resolved.secret : null;
}

/**
 * The last four characters of a saved key, or "nothing saved". Four characters
 * is the industry-standard masking a person recognizes their own key by; the
 * hint is computed at read time and never stored, so there is no second copy of
 * anything to keep in step.
 *
 * A key of four characters or fewer would be echoed WHOLE by a naive slice, so
 * it reports as saved with an empty hint rather than leaking itself. The bound
 * is strict for that reason: at exactly four, "the last four" is the key.
 *
 * @param secret - The resolved secret, or `null` when none is saved.
 */
function toSavedKeyState(secret: string | null): SavedKeyState {
  if (secret === null) return { saved: false };
  return { saved: true, last4: secret.length > 4 ? secret.slice(-4) : '' };
}

/**
 * What the OpenCode "your own key" form should show when it is reopened: the
 * saved service, its base URL, and whether a key is already saved (last four
 * characters only). Backs `GET /api/runtimes/opencode/provider`.
 *
 * Reopening the form used to show three empty fields, which reads as "nothing is
 * connected" even though something was (DOR-2123). Nothing here is a new stored
 * field — every value is read back from the config and credential store that
 * already held it.
 *
 * @param deps - Injectable config/credential-read seams (production defaults).
 */
export async function readOpenCodeDirectSetup(
  deps: Pick<ProviderCredentialDeps, 'config' | 'credentials'> = {}
): Promise<OpenCodeDirectSetup> {
  const config = deps.config ?? configManager;
  const opencode = config.get('runtimes').opencode;
  const providerId = opencode.provider ?? null;
  const baseURL = opencode.baseURL ?? null;
  if (providerId === null) {
    return { providerId: null, baseURL, key: { saved: false } };
  }
  return {
    providerId,
    baseURL,
    key: toSavedKeyState(await readSavedSecret(providerId, deps)),
  };
}

/**
 * Whether a runtime's own pasted key is already saved, for the key form's
 * "Saved · ends in …" hint. Backs `GET /api/runtimes/:type/credential`.
 *
 * Claude Code reads the shared `providers.anthropic` reference — the same one
 * its message-sender env seam resolves. Codex always reports nothing saved, and
 * that is the truth rather than a gap: its key is written to Codex's own login
 * store (`$CODEX_HOME/auth.json`) and DorkOS deliberately keeps no copy, so
 * there is no hint it could honestly show.
 *
 * @param type - Runtime type (`'claude-code'` | `'codex'`).
 * @param deps - Injectable config/credential-read seams (production defaults).
 * @throws {ConnectError} 400 when the runtime has no native key path.
 */
export async function readRuntimeKeyStatus(
  type: string,
  deps: Pick<ProviderCredentialDeps, 'config' | 'credentials'> = {}
): Promise<RuntimeKeyStatus> {
  if (!isCredentialRuntimeType(type)) {
    throw new ConnectError(`"${type}" does not support a native API key.`, 400);
  }
  if (type === 'codex') {
    return { key: { saved: false } };
  }
  return { key: toSavedKeyState(await readSavedSecret(ANTHROPIC_PROVIDER_ID, deps)) };
}
