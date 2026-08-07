/**
 * Refresh coordination for managed-MCP OAuth (DOR-986): who is allowed to talk to
 * a server's token endpoint, when, and how a failure is judged.
 *
 * Two problems live here, and both are about a token endpoint being called more
 * or less often than it should be.
 *
 * **Never twice at once.** Sign-in and the background refresh timer both drive
 * the SDK's `auth()`, and both may present the same refresh token. An issuer that
 * rotates refresh tokens treats the second presentation as a replay and can
 * revoke the whole grant family — so every token operation for one
 * `(agentId, serverName)` is serialized here, and two concurrent refreshes share
 * one in-flight attempt instead of racing.
 *
 * **Not once too few.** A single failed refresh used to evict the token
 * permanently, so a laptop that woke up offline lost every OAuth server until the
 * process restarted. A refresh that failed for a transport reason is retried with
 * bounded exponential backoff; a refresh the OAuth server *answered* with a
 * terminal verdict (the grant is gone) is not retried at all, because retrying a
 * revoked grant is just noise.
 *
 * @module services/mesh/agent-mcp-token-refresher
 */
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Logger } from '@dorkos/shared/logger';

import type { CachedToken } from './agent-mcp-access-token-cache.js';
import type { StoredMcpTokens } from './agent-mcp-oauth-provider.js';

/** How many times a transport-failed refresh is attempted before the token is dropped. */
const MAX_REFRESH_ATTEMPTS = 3;

/** Backoff before the second attempt; doubled for each attempt after that. */
const REFRESH_BACKOFF_BASE_MS = 1000;

/** What one refresh attempt concluded — the input to "retry, or give up?". */
export type RefreshAttemptOutcome =
  /** A fresh token was obtained and persisted. */
  | { kind: 'ok'; token: CachedToken }
  /**
   * The OAuth server gave a definitive no (the grant is revoked, the client
   * registration is gone, or there is nothing left to refresh). Retrying cannot
   * change the answer; the operator has to sign in again.
   */
  | { kind: 'terminal'; reason: string }
  /** The attempt failed for a reason that may not recur — offline, DNS, 5xx. */
  | { kind: 'transient'; reason: string };

/** Constructor seams for {@link McpTokenRefresher} (production uses the defaults). */
export interface McpTokenRefresherDeps {
  /** Delay seam for the backoff (defaults to `setTimeout`); injected so tests never wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Diagnostic sink; defaults to `console`. */
  logger?: Pick<Logger, 'warn'>;
}

/** Default delay: an unref'd timer, so a pending backoff never holds the process open. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
}

/**
 * Serializes and retries the token operations for managed-MCP OAuth targets. One
 * instance per OAuth service; every method is keyed by a caller-chosen string
 * that identifies one `(agentId, serverName)` target.
 */
export class McpTokenRefresher {
  /** The tail of each key's operation chain — everything queued runs after it. */
  private readonly chain = new Map<string, Promise<unknown>>();
  /** In-flight refreshes, so a second caller joins rather than starting its own. */
  private readonly inFlight = new Map<string, Promise<CachedToken | null>>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Pick<Logger, 'warn'>;

  constructor(deps: McpTokenRefresherDeps = {}) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.logger = deps.logger ?? console;
  }

  /**
   * Run an operation with exclusive use of a target's token endpoint: it starts
   * only once everything already queued for that key has settled, and anything
   * queued after it waits for it in turn.
   *
   * @param key - The target key to serialize on.
   * @param run - The operation to run once the key is free.
   */
  exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    const prior = this.chain.get(key) ?? Promise.resolve();
    // A rejected predecessor must not reject its successors — it only ordered them.
    const next = prior.then(run, run);
    const settled = next.then(
      () => {},
      () => {}
    );
    this.chain.set(key, settled);
    void settled.then(() => {
      if (this.chain.get(key) === settled) this.chain.delete(key);
    });
    return next;
  }

  /**
   * Refresh a target's access token: joins an already-running refresh for the same
   * key, otherwise queues one behind any other operation and retries a transient
   * failure with bounded exponential backoff.
   *
   * @param key - The target key.
   * @param attempt - Performs one refresh attempt and classifies the result.
   * @returns The fresh token, or `null` when the caller should drop this target.
   */
  refresh(key: string, attempt: () => Promise<RefreshAttemptOutcome>): Promise<CachedToken | null> {
    const joined = this.inFlight.get(key);
    if (joined) return joined;

    // The entry is cleared inside the operation body, not in a `.then` chained
    // onto it: a caller awaiting this refresh must find the key free the instant
    // it resumes, or the next refresh would join an attempt that already settled
    // and the token would be refreshed exactly once per process. `run` is always
    // assigned before the body executes — `exclusive` defers by at least a
    // microtask, and the assignment below is synchronous.
    const run: Promise<CachedToken | null> = this.exclusive(key, async () => {
      try {
        return await this.attemptWithBackoff(key, attempt);
      } finally {
        if (this.inFlight.get(key) === run) this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, run);
    return run;
  }

  /** Try `attempt` until it succeeds, returns terminal, or the attempt budget runs out. */
  private async attemptWithBackoff(
    key: string,
    attempt: () => Promise<RefreshAttemptOutcome>
  ): Promise<CachedToken | null> {
    for (let tries = 1; tries <= MAX_REFRESH_ATTEMPTS; tries++) {
      const outcome = await attempt();
      if (outcome.kind === 'ok') return outcome.token;
      if (outcome.kind === 'terminal') {
        this.logger.warn(`[mcp-oauth] refresh gave up for ${key}: ${outcome.reason}`);
        return null;
      }
      if (tries === MAX_REFRESH_ATTEMPTS) {
        this.logger.warn(
          `[mcp-oauth] refresh failed for ${key} after ${tries} attempts: ${outcome.reason}`
        );
        return null;
      }
      await this.sleep(REFRESH_BACKOFF_BASE_MS * 2 ** (tries - 1));
    }
    return null;
  }
}

/**
 * Convert a persisted token set into the cache's {@link CachedToken}, trusting the
 * ABSOLUTE `expiresAt` stamped at save time — never recomputing from the relative
 * `expires_in`, which is meaningless after a restart (DOR-942). No stored
 * `expiresAt` means no declared lifetime, so it never expires on our clock; the
 * cache refreshes such a token on a period instead of letting it drift forever.
 *
 * @param stored - The persisted token set.
 */
export function toCachedToken(stored: StoredMcpTokens): CachedToken {
  return {
    accessToken: stored.access_token,
    expiresAt: stored.expiresAt ?? Number.POSITIVE_INFINITY,
    refreshable: Boolean(stored.refresh_token),
    serverUrl: stored.serverUrl,
  };
}

/** What one refresh attempt needs to run, and to judge its own result. */
export interface TokenRefreshAttempt {
  /** The provider bound to the target, whose `state` must belong to no live sign-in flow. */
  provider: OAuthClientProvider;
  /** The MCP server URL being refreshed against. */
  serverUrl: string;
  /** The `fetch` seam for the OAuth calls. */
  fetchImpl: typeof fetch;
  /** Re-read the persisted token set — the evidence the verdict is based on. */
  loadTokens: () => Promise<StoredMcpTokens | undefined>;
}

/**
 * Attempt one refresh through the SDK's `auth()` — the same entry point sign-in
 * uses, so the RFC 8707 `resource` parameter, the negotiated scope, and the
 * invalidate-and-retry recovery all apply. The hand-rolled `refreshAuthorization`
 * call this replaced omitted `resource` and mis-audienced every refreshed token
 * (DOR-986).
 *
 * `auth()` cannot open a browser from here: the provider's `redirectToAuthorization`
 * only records a URL against a live sign-in flow, and a refresh provider's state
 * belongs to none. So a `REDIRECT` result means only "no token came back" — and it
 * is deliberately ambiguous, because the SDK swallows a transport failure during
 * the refresh and falls through to a new authorization exactly as it does after
 * the server rejects our credentials. The stored token set is what tells them
 * apart: a rejected grant was deleted by `invalidateCredentials`, an unreachable
 * server left it untouched.
 *
 * @param attempt - The provider, target URL, fetch seam, and token reader.
 */
export async function attemptTokenRefresh(
  attempt: TokenRefreshAttempt
): Promise<RefreshAttemptOutcome> {
  const { provider, serverUrl, fetchImpl, loadTokens } = attempt;
  const before = await loadTokens();
  if (!before?.refresh_token) {
    return { kind: 'terminal', reason: 'there is no refresh token stored' };
  }
  try {
    const result = await auth(provider, { serverUrl, fetchFn: fetchImpl });
    if (result === 'AUTHORIZED') {
      const stored = await loadTokens();
      return stored
        ? { kind: 'ok', token: toCachedToken(stored) }
        : { kind: 'terminal', reason: 'the refreshed token was not stored' };
    }
    const after = await loadTokens();
    return after?.refresh_token
      ? { kind: 'transient', reason: 'the refresh did not complete' }
      : { kind: 'terminal', reason: 'the stored sign-in was rejected' };
  } catch (err) {
    // An OAuth error is the server's own verdict on our credentials and will not
    // change on a retry. A `ServerError` (5xx) or anything non-OAuth — offline,
    // DNS, timeout — may well change, so it is worth retrying.
    if (err instanceof OAuthError && !(err instanceof ServerError)) {
      return { kind: 'terminal', reason: err.message };
    }
    return { kind: 'transient', reason: err instanceof Error ? err.message : String(err) };
  }
}
