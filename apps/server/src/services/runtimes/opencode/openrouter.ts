/**
 * OpenRouter connect — the OpenCode Gateway path (ADR-0318,
 * effortless-runtime-switching T1, task 2.6). Two ways to obtain a key, both of
 * which persist only a REFERENCE (never plaintext) and set OpenCode's selected
 * provider to `openrouter`:
 *
 * 1. Paste-key (always available): validate the key against OpenRouter, then
 *    store it. {@link storeOpenRouterKeyReference}.
 * 2. OAuth-PKCE (fully-native, ToS-clean — OpenRouter is built for app
 *    integration): the server mints a `code_verifier` + `state`, the user
 *    authorizes in a browser, and a loopback callback exchanges the returned code
 *    for a user-scoped key. {@link OpenRouterOAuthStore} + {@link exchangeCodeForKey}.
 *
 * A short-TTL cache fronts the public model catalog so the client dropdown does
 * not re-fetch on every open. Every network call is bounded so a slow/unreachable
 * OpenRouter degrades fast instead of hanging.
 *
 * OAuth-PKCE contract (verified against OpenRouter's app-integration docs,
 * 2026-07): authorize at `https://openrouter.ai/auth?callback_url&code_challenge&
 * code_challenge_method=S256`; exchange at `POST /api/v1/auth/keys` with
 * `{ code, code_verifier, code_challenge_method }` → `{ key, user_id }`; validate
 * a key with `GET /api/v1/key` (bearer). See the batch report for the residual
 * open items flagged for live re-verification.
 *
 * @module services/runtimes/opencode/openrouter
 */
import { createHash, randomBytes } from 'node:crypto';
import type { UserConfig } from '@dorkos/shared/config-schema';
import type {
  OpenRouterModel,
  OpenRouterOAuthStatus,
  StoreCredentialResult,
} from '@dorkos/shared/runtime-connect';
import { type CredentialStore } from '../../core/credential-provider.js';
import { persistProviderCredential } from '../connect/credentials.js';
import { logger } from '../../../lib/logger.js';

/** OpenRouter API + auth origins (single source so tests and prod agree). */
const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const OPENROUTER_KEYS_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
const OPENROUTER_KEY_INFO_URL = 'https://openrouter.ai/api/v1/key';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** Provider id under which OpenRouter's key + selection are recorded. */
const OPENROUTER_PROVIDER_ID = 'openrouter';

/** Bound on each OpenRouter network call so a slow provider never hangs a request. */
const OPENROUTER_FETCH_TIMEOUT_MS = 10_000;

/** How long a started OAuth flow stays claimable before it is pruned. */
const OAUTH_FLOW_TTL_MS = 10 * 60_000;

/** How long the model catalog is served from cache before a re-fetch. */
const MODELS_CACHE_TTL_MS = 5 * 60_000;

/** Injectable `fetch` seam (defaults to global `fetch`); tests pass a mock. */
export type FetchFn = typeof fetch;

/** Minimal read/write surface of the config manager (injectable for tests). */
export interface ConfigReadWrite {
  get<K extends keyof UserConfig>(key: K): UserConfig[K];
  set<K extends keyof UserConfig>(key: K, value: UserConfig[K]): void;
}

/** Store + config seams for the credential-persisting paths (production defaults). */
export interface OpenRouterStoreDeps {
  store?: CredentialStore;
  config?: ConfigReadWrite;
}

/** `fetch`-bearing dependency bag for the network paths. */
export interface OpenRouterFetchDeps {
  fetchImpl?: FetchFn;
}

/**
 * A failure with an HTTP status hint and an honest, secret-free message. Mirrors
 * the connect module's error so the routes map both uniformly.
 */
export class OpenRouterError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
  }
}

/**
 * Run `fetch` bounded by {@link OPENROUTER_FETCH_TIMEOUT_MS}. Never leaks a
 * secret in the thrown error — only a generic, honest message.
 */
async function boundedFetch(
  fetchImpl: FetchFn,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    throw new OpenRouterError('Could not reach OpenRouter. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }
}

// --- PKCE ------------------------------------------------------------------

/** A PKCE verifier and its S256 challenge (`base64url(sha256(verifier))`). */
export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * Generate a PKCE verifier + S256 challenge. The verifier is 43 URL-safe chars
 * (RFC 7636 range) and the challenge is the base64url SHA-256 of it.
 */
export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Build the OpenRouter authorize URL for the browser step.
 *
 * @param callbackUrl - The loopback callback (with the flow `state` embedded, so
 *   OpenRouter round-trips it alongside the appended `code`).
 * @param challenge - The PKCE S256 challenge.
 */
export function buildAuthorizeUrl(callbackUrl: string, challenge: string): string {
  const params = new URLSearchParams({
    callback_url: callbackUrl,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${OPENROUTER_AUTH_URL}?${params.toString()}`;
}

// --- OAuth flow store ------------------------------------------------------

interface PendingFlow {
  /** The PKCE verifier, nulled once claimed so a replayed callback can't re-exchange it. */
  verifier: string | null;
  createdAt: number;
  status: OpenRouterOAuthStatus['status'];
  error?: string;
}

/**
 * In-memory registry of in-flight OAuth-PKCE flows, keyed by opaque `state`.
 * Holds the `code_verifier` server-side (it never reaches the client) and the
 * flow's terminal status for the client's poll. Entries expire after
 * {@link OAUTH_FLOW_TTL_MS}.
 */
export class OpenRouterOAuthStore {
  private readonly flows = new Map<string, PendingFlow>();

  /**
   * Start a flow: mint `state` + a PKCE pair, record it pending, and return the
   * `state` and `challenge` for the caller to build the authorize URL.
   */
  start(): { state: string; challenge: string } {
    this.prune();
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString('hex');
    this.flows.set(state, { verifier, createdAt: Date.now(), status: 'pending' });
    return { state, challenge };
  }

  /**
   * The verifier for a live, non-expired flow, or `null` when unknown/expired/
   * already claimed. One-shot: the verifier is consumed (nulled) on first claim
   * so a replayed callback cannot re-run the code→key exchange. The flow entry
   * itself survives (with its status) for the client's completion poll.
   */
  claimVerifier(state: string): string | null {
    this.prune();
    const flow = this.flows.get(state);
    if (!flow || flow.verifier === null) return null;
    const { verifier } = flow;
    flow.verifier = null;
    return verifier;
  }

  /** Mark a flow connected (the callback stored a key). */
  markConnected(state: string): void {
    const flow = this.flows.get(state);
    if (flow) flow.status = 'connected';
  }

  /** Mark a flow errored with an honest message. */
  markError(state: string, error: string): void {
    const flow = this.flows.get(state);
    if (flow) {
      flow.status = 'error';
      flow.error = error;
    }
  }

  /** The pollable status of a flow; unknown/expired ids read as an honest error. */
  status(state: string): OpenRouterOAuthStatus {
    this.prune();
    const flow = this.flows.get(state);
    if (!flow) return { status: 'error', error: 'This sign-in link expired. Please try again.' };
    return flow.error ? { status: flow.status, error: flow.error } : { status: flow.status };
  }

  private prune(): void {
    const cutoff = Date.now() - OAUTH_FLOW_TTL_MS;
    for (const [state, flow] of this.flows) {
      if (flow.createdAt < cutoff) this.flows.delete(state);
    }
  }
}

/** Process-wide OAuth flow store (start and callback run on separate requests). */
export const openRouterOAuthStore = new OpenRouterOAuthStore();

// --- Key exchange + validation ---------------------------------------------

/**
 * Exchange an authorization code for a user-scoped OpenRouter key
 * (`POST /api/v1/auth/keys`). Throws an {@link OpenRouterError} on any non-2xx
 * (e.g. 403 for a bad code / not-signed-in), never returning a partial result.
 *
 * @param args - The `code` from the callback and the flow's `verifier`.
 * @param deps - Injectable `fetch` seam.
 * @returns The scoped API key and (optional) user id.
 */
export async function exchangeCodeForKey(
  args: { code: string; verifier: string },
  deps: OpenRouterFetchDeps = {}
): Promise<{ key: string; userId: string | null }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await boundedFetch(fetchImpl, OPENROUTER_KEYS_EXCHANGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://dorkos.ai',
      'X-Title': 'DorkOS',
    },
    body: JSON.stringify({
      code: args.code,
      code_verifier: args.verifier,
      code_challenge_method: 'S256',
    }),
  });
  if (!res.ok) {
    throw new OpenRouterError('OpenRouter rejected the sign-in. Please try again.', 403);
  }
  const body = (await res.json().catch(() => null)) as { key?: string; user_id?: string } | null;
  if (!body?.key) {
    throw new OpenRouterError('OpenRouter did not return a key. Please try again.');
  }
  return { key: body.key, userId: body.user_id ?? null };
}

/**
 * Validate an OpenRouter key by fetching its metadata (`GET /api/v1/key`, bearer).
 * A 2xx means the key is live; any other status (401/403) means invalid.
 *
 * @param key - The raw key to validate (never logged).
 * @param deps - Injectable `fetch` seam.
 */
export async function validateOpenRouterKey(
  key: string,
  deps: OpenRouterFetchDeps = {}
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await boundedFetch(fetchImpl, OPENROUTER_KEY_INFO_URL, {
    headers: { Authorization: `Bearer ${key}` },
  });
  return res.ok;
}

/**
 * Validate + store an OpenRouter key as a reference and select OpenRouter as
 * OpenCode's provider. Rejects an invalid key without storing anything; on
 * success persists only the `file:openrouter` reference (never the key).
 *
 * @param key - The raw OpenRouter key.
 * @param deps - Injectable store/config/fetch seams.
 * @throws {OpenRouterError} When the key is empty or fails validation.
 */
export async function storeOpenRouterKeyReference(
  key: string,
  deps: OpenRouterStoreDeps & OpenRouterFetchDeps = {}
): Promise<StoreCredentialResult> {
  if (!key || key.trim().length === 0) {
    throw new OpenRouterError('A non-empty OpenRouter key is required.', 400);
  }
  const valid = await validateOpenRouterKey(key, deps);
  if (!valid) {
    throw new OpenRouterError('That OpenRouter key was not accepted. Check it and try again.', 400);
  }
  return persistOpenRouterKey(key, deps);
}

/**
 * Encrypt + store the key and select OpenRouter as OpenCode's provider (no
 * validation). Delegates to {@link persistProviderCredential} — the single,
 * audited way to persist an OpenCode provider credential — so paste-key and
 * OAuth share one path with the Direct provider.
 */
async function persistOpenRouterKey(
  key: string,
  deps: OpenRouterStoreDeps = {}
): Promise<StoreCredentialResult> {
  return persistProviderCredential({ providerId: OPENROUTER_PROVIDER_ID, secret: key }, deps);
}

/**
 * Handle the loopback OAuth callback: validate `state`, exchange the `code` for a
 * scoped key, and store it. Marks the flow connected on success or errored on any
 * failure (nothing is stored on failure). Never throws — returns a status for the
 * browser page.
 *
 * @param args - The `state` and `code` from the callback query.
 * @param deps - Injectable store/config/fetch/flow-store seams.
 */
export async function handleOpenRouterCallback(
  args: { state?: string; code?: string; error?: string },
  deps: OpenRouterStoreDeps & OpenRouterFetchDeps & { flowStore?: OpenRouterOAuthStore } = {}
): Promise<OpenRouterOAuthStatus> {
  const flowStore = deps.flowStore ?? openRouterOAuthStore;
  const { state, code, error } = args;

  if (!state) {
    return { status: 'error', error: 'Missing sign-in state. Please try again.' };
  }
  const verifier = flowStore.claimVerifier(state);
  if (!verifier) {
    return { status: 'error', error: 'This sign-in link expired. Please try again.' };
  }
  if (error || !code) {
    const msg = 'OpenRouter sign-in was cancelled.';
    flowStore.markError(state, msg);
    return { status: 'error', error: msg };
  }

  try {
    const { key } = await exchangeCodeForKey({ code, verifier }, deps);
    await persistOpenRouterKey(key, deps);
    flowStore.markConnected(state);
    return { status: 'connected' };
  } catch (err) {
    const message = err instanceof OpenRouterError ? err.message : 'OpenRouter sign-in failed.';
    logger.warn('[OpenRouter] OAuth callback failed', {
      reason: err instanceof OpenRouterError ? err.message : 'unknown',
    });
    flowStore.markError(state, message);
    return { status: 'error', error: message };
  }
}

// --- Model catalog ---------------------------------------------------------

interface ModelsCache {
  models: OpenRouterModel[];
  fetchedAt: number;
}
let modelsCache: ModelsCache | null = null;

/** Reset the model catalog cache — test-only seam. */
export function resetOpenRouterModelCache(): void {
  modelsCache = null;
}

/**
 * Fetch the OpenRouter model catalog, served from a short-TTL cache. A second
 * call within {@link MODELS_CACHE_TTL_MS} returns the cached list without a
 * network round-trip. Degrades to the last cache (or an empty list) if a refresh
 * fails, so the picker is never blocked by a slow provider.
 *
 * @param deps - Injectable `fetch` seam.
 */
export async function fetchOpenRouterModels(
  deps: OpenRouterFetchDeps = {}
): Promise<OpenRouterModel[]> {
  if (modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return modelsCache.models;
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await boundedFetch(fetchImpl, OPENROUTER_MODELS_URL);
    if (!res.ok) throw new OpenRouterError('catalog fetch failed');
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const models: OpenRouterModel[] = (body.data ?? []).map((m) => ({
      id: String(m.id ?? ''),
      name: String(m.name ?? m.id ?? ''),
      ...(typeof m.context_length === 'number' ? { contextLength: m.context_length } : {}),
    }));
    modelsCache = { models, fetchedAt: Date.now() };
    return models;
  } catch (err) {
    logger.warn('[OpenRouter] model catalog fetch failed', {
      reason: err instanceof Error ? err.message : 'unknown',
    });
    return modelsCache?.models ?? [];
  }
}
