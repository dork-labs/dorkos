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
 * A third, credential-free path lives here too: {@link fetchOpenRouterCatalog}
 * reads OpenRouter's PUBLIC model list (`GET /api/v1/models`, no key) so the
 * model picker can be honest about what OpenRouter actually serves today and
 * what each of those models can do. A short-TTL cache fronts it so repeated
 * picker opens do not re-fetch, and a FAILED probe is cached too so a
 * write-path caller never re-pays a timeout it has just paid. Every network
 * call here is bounded so a slow/unreachable OpenRouter degrades fast instead
 * of hanging — for the catalog the bound covers the body read as well as the
 * headers, because that response is ~700KB and a stalled body is just as much
 * of a hang as a stalled connection.
 *
 * OAuth-PKCE contract (verified against OpenRouter's app-integration docs,
 * 2026-07): authorize at `https://openrouter.ai/auth?callback_url&code_challenge&
 * code_challenge_method=S256`; exchange at `POST /api/v1/auth/keys` with
 * `{ code, code_verifier, code_challenge_method }` → `{ key, user_id }`; validate
 * a key with `GET /api/v1/key` (bearer). See the batch report for the residual
 * open items flagged for live re-verification.
 *
 * @module services/runtimes/opencode/providers/openrouter
 */
import { createHash, randomBytes } from 'node:crypto';
import type { UserConfig } from '@dorkos/shared/config-schema';
import type { OpenRouterOAuthStatus, StoreCredentialResult } from '@dorkos/shared/runtime-connect';
import { type CredentialStore } from '../../../core/credential-provider.js';
import { persistProviderCredential } from '../../connect/credentials.js';
import { logger } from '../../../../lib/logger.js';

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

/**
 * How long a fetched public model catalog is served from cache before a
 * re-fetch. Five minutes: long enough that opening the picker repeatedly costs
 * one request, short enough that a model added upstream shows up the same
 * session.
 */
const OPENROUTER_CATALOG_TTL_MS = 5 * 60_000;

/**
 * How long a FAILED catalog probe is remembered before another is attempted.
 *
 * Failures are cached, not just successes, and that is the whole point. This
 * probe sits behind `getSupportedModels()`, which the model-write path calls on
 * every model change — so an OpenRouter that is unreachable (a plane, a
 * firewall that blackholes the host) would otherwise make every single model
 * change pay the full {@link OPENROUTER_CATALOG_PROBE_TIMEOUT_MS} again. The
 * sibling Ollama probe caches every result for exactly this reason
 * (`ollama.ts`), and caching only successes was half of that pattern.
 *
 * Fifteen seconds, much shorter than the success TTL: a transient outage still
 * self-heals within one picker open, while a sustained one is paid for once.
 */
const OPENROUTER_CATALOG_FAILURE_TTL_MS = 15_000;

/**
 * Bound on the public catalog probe — deliberately much tighter than
 * {@link OPENROUTER_FETCH_TIMEOUT_MS}.
 *
 * The auth calls are user-initiated: someone pressed "Connect" and is watching,
 * so ten seconds of patience is worth it. This probe is the opposite — nobody
 * asked for it, it only ENRICHES a menu that works without it, and it runs on
 * the write path. When it cannot answer quickly the honest move is to give up
 * and show the sidecar's own catalog.
 */
const OPENROUTER_CATALOG_PROBE_TIMEOUT_MS = 4_000;

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
    throw new OpenRouterError('Could not reach OpenRouter. Check your network and try again.');
  } finally {
    clearTimeout(timer);
  }
}

// --- Public model catalog --------------------------------------------------

/**
 * What OpenRouter says one of its models can do (the fields the picker needs).
 *
 * Every field is TRI-STATE, exactly like the sidecar-side projection: `undefined`
 * means OpenRouter did not tell us, and a caller must keep whatever it already
 * believed rather than reading absence as `false`. This matters more here than
 * it looks. These fields are read out of untyped JSON whose shape OpenRouter
 * does not guarantee, so a renamed or dropped `supported_parameters` would, if
 * absence collapsed to `false`, silently mark EVERY OpenRouter model as unable
 * to do agent work — a total menu wipe dressed up as a successful probe.
 */
export interface OpenRouterCatalogEntry {
  /** Whether the model accepts tool definitions — an agent turn is impossible without it. */
  supportsTools?: boolean;
  /** Whether the model accepts images as input. */
  supportsVision?: boolean;
  /** Whether the model answers with generated images rather than only text. */
  supportsImageOutput?: boolean;
}

/** The live OpenRouter model catalog, keyed by model id (e.g. `anthropic/claude-opus-5`). */
export type OpenRouterCatalog = ReadonlyMap<string, OpenRouterCatalogEntry>;

/** The slice of `GET /api/v1/models` this module reads (verified live 2026-09-01). */
interface OpenRouterModelsResponse {
  data?: Array<{
    id?: unknown;
    supported_parameters?: unknown;
    architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  }>;
}

interface CatalogCache {
  /** The catalog, or `null` when the probe failed (failures are cached too). */
  catalog: OpenRouterCatalog | null;
  fetchedAt: number;
}
let catalogCache: CatalogCache | null = null;

/** Reset the public-catalog cache — test-only seam (mirrors `resetOllamaCache`). */
export function resetOpenRouterCatalogCache(): void {
  catalogCache = null;
}

/**
 * Whether an untyped JSON field says it contains `needle`.
 *
 * Tri-state on purpose: a value that is not an array is not a model that lacks
 * the capability, it is OpenRouter not answering the question, and the two must
 * never be confused. See {@link OpenRouterCatalogEntry}.
 *
 * @param value - The raw field from the response.
 * @param needle - The member whose presence is the capability.
 */
function listIncludes(value: unknown, needle: string): boolean | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.includes(needle);
}

/**
 * Fetch OpenRouter's PUBLIC model catalog — what it actually serves right now,
 * and what each of those models can do.
 *
 * Credential-free (`GET /api/v1/models` needs no key), bounded, and throw-free:
 * any failure — unreachable, non-2xx, unparseable, or an empty list — resolves
 * to `null`, which every caller must read as "unknown", NOT as "nothing is
 * available". A probe failure must never empty the model menu.
 *
 * Successes are cached for {@link OPENROUTER_CATALOG_TTL_MS} and FAILURES for
 * {@link OPENROUTER_CATALOG_FAILURE_TTL_MS} — the short negative TTL is what
 * stops a write-path caller re-paying a timeout it has already paid, while
 * still letting a transient outage heal within one picker open.
 *
 * @param deps - Injectable `fetch` seam.
 */
export async function fetchOpenRouterCatalog(
  deps: OpenRouterFetchDeps = {}
): Promise<OpenRouterCatalog | null> {
  if (catalogCache) {
    const ttl = catalogCache.catalog
      ? OPENROUTER_CATALOG_TTL_MS
      : OPENROUTER_CATALOG_FAILURE_TTL_MS;
    if (Date.now() - catalogCache.fetchedAt < ttl) return catalogCache.catalog;
  }
  const catalog = await probeOpenRouterCatalog(deps.fetchImpl ?? fetch);
  catalogCache = { catalog, fetchedAt: Date.now() };
  return catalog;
}

/**
 * One bounded, throw-free catalog probe. `null` on any failure (see the caller's
 * contract).
 *
 * Owns its own {@link AbortController} rather than reusing {@link boundedFetch},
 * because that helper releases its timer once the RESPONSE resolves — correct
 * for the small auth bodies it was written for, but this body is ~700KB and a
 * stall part-way through it would otherwise fall through to undici's own
 * multi-minute default. Here one signal covers the request and the body read.
 */
async function probeOpenRouterCatalog(fetchImpl: FetchFn): Promise<OpenRouterCatalog | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_CATALOG_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(OPENROUTER_MODELS_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as OpenRouterModelsResponse;
    const entries = new Map<string, OpenRouterCatalogEntry>();
    for (const model of body.data ?? []) {
      if (typeof model?.id !== 'string' || model.id.length === 0) continue;
      const tools = listIncludes(model.supported_parameters, 'tools');
      const vision = listIncludes(model.architecture?.input_modalities, 'image');
      const imageOutput = listIncludes(model.architecture?.output_modalities, 'image');
      entries.set(model.id, {
        ...(tools !== undefined ? { supportsTools: tools } : {}),
        ...(vision !== undefined ? { supportsVision: vision } : {}),
        ...(imageOutput !== undefined ? { supportsImageOutput: imageOutput } : {}),
      });
    }
    // An empty list is a broken answer, not an honest "OpenRouter serves
    // nothing" — reading it as truth would empty the menu, the exact failure
    // this whole path exists to avoid. A SHORT-but-non-empty list is caught
    // further on, by the coverage floor in the projection.
    if (entries.size === 0) return null;
    return entries;
  } catch {
    logger.debug('[OpenRouter] public model catalog unavailable');
    return null;
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
