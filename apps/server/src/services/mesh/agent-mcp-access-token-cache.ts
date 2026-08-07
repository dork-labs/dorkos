/**
 * The synchronous in-memory access-token cache for managed-MCP OAuth (DOR-942).
 *
 * The core risk this solves (spec §"The core risk: sync injection vs async
 * store"): session injection reads managed servers **synchronously**
 * (`readEnabledServersSync`), but the encrypted token store and token refresh are
 * **async**. So the current access token has to be readable without awaiting.
 * This cache holds decrypted access tokens keyed by `(agentId, serverName)`,
 * warmed on boot/sign-in and **refreshed in the background before expiry**, so the
 * injection read path stays a plain synchronous map lookup.
 *
 * Every cached token carries an **absolute** `expiresAt` (epoch ms), never a
 * relative lifetime — so a token loaded from disk after a restart is judged by
 * when it was actually issued, not by when the process came back up (DOR-942, the
 * restart-staleness fix). A token is returned only while it is live
 * (`now < expiresAt`); an expired entry reads as absent so injection withholds the
 * header — the safe default. Background refresh replaces the token ahead of that
 * boundary; a failed refresh evicts the entry so the row falls back to needs-auth
 * rather than injecting a stale token.
 *
 * @module services/mesh/agent-mcp-access-token-cache
 */

/** Refresh this many ms before a token's expiry, so injection never races the clock. */
const REFRESH_SKEW_MS = 60_000;

/**
 * How often to refresh a refreshable token whose issuer declared no lifetime.
 * `expires_in` is optional in RFC 6749, and a token with no declared expiry is
 * not a token that lives forever — it is a token whose expiry we cannot see. An
 * hour is short enough that a rotated-out token is replaced soon after it lapses,
 * and long enough not to hammer the issuer.
 */
const UNDECLARED_LIFETIME_REFRESH_MS = 60 * 60_000;

/** A cache key `(agentId, serverName)` joined by NUL, which no agent id or server name contains. */
function cacheKey(agentId: string, serverName: string): string {
  return `${agentId}\0${serverName}`;
}

/**
 * A cached access token with an ABSOLUTE expiry — the shape both sign-in/warm and
 * background refresh hand the cache, so expiry is judged consistently regardless
 * of when the token was minted.
 */
export interface CachedToken {
  /** The bearer access token. */
  accessToken: string;
  /** Absolute expiry (epoch ms); `Number.POSITIVE_INFINITY` = never expires on our clock. */
  expiresAt: number;
  /** Whether a background refresh can be scheduled (a refresh token exists). */
  refreshable: boolean;
  /**
   * The MCP server URL this token was minted for. Reads must present the same
   * URL or the token is withheld — see {@link McpAccessTokenCache.getAccessToken}.
   * `undefined` for a token stored before the binding existed, which never matches.
   */
  serverUrl: string | undefined;
}

/** Injectable timer seam so tests drive scheduling without the platform clock. */
export interface TimerScheduler {
  /** Schedule `fn` after `delayMs`; the returned handle can be cleared. */
  set(fn: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  /** Cancel a scheduled callback. */
  clear(handle: ReturnType<typeof setTimeout>): void;
}

/** Default scheduler: `setTimeout`, unref'd so a pending refresh never holds the process open. */
const defaultScheduler: TimerScheduler = {
  set(fn, delayMs) {
    const handle = setTimeout(fn, delayMs);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle);
  },
};

/** One cached, live access token plus the machinery to refresh it before expiry. */
interface CacheEntry {
  accessToken: string;
  expiresAt: number;
  /** The server URL the token was minted for; a read presenting a different one is refused. */
  serverUrl: string | undefined;
  /** Obtain a fresh cached token, or `null` on failure (which evicts the entry). */
  refresh: () => Promise<CachedToken | null>;
  timer?: ReturnType<typeof setTimeout>;
}

/** Constructor seams for {@link McpAccessTokenCache} (production uses the defaults). */
export interface McpAccessTokenCacheDeps {
  /** Epoch-ms clock (defaults to `Date.now`); injected so expiry is testable. */
  now?: () => number;
  /** Timer seam (defaults to unref'd `setTimeout`); injected so scheduling is testable. */
  scheduler?: TimerScheduler;
}

/**
 * A process-lifetime cache of live managed-MCP access tokens, read synchronously
 * at injection time and refreshed in the background before expiry.
 */
export class McpAccessTokenCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly scheduler: TimerScheduler;

  constructor(deps: McpAccessTokenCacheDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.scheduler = deps.scheduler ?? defaultScheduler;
  }

  /**
   * The live access token for `(agentId, serverName)` at `serverUrl`, or
   * `undefined` when none is cached, the cached one has expired, or it was minted
   * for a different URL. Synchronous by design — this is the exact call the
   * injection read path makes.
   *
   * The URL check is the re-pointed-server guard (DOR-986): a managed server can
   * be removed and re-added, or updated, under the same name at a different URL,
   * and the key alone cannot tell those apart. A mismatch evicts the entry rather
   * than just withholding it, so the stale token stops being refreshed too.
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   * @param serverUrl - The URL the caller is about to send the token to.
   */
  getAccessToken(agentId: string, serverName: string, serverUrl: string): string | undefined {
    const entry = this.entries.get(cacheKey(agentId, serverName));
    if (!entry) return undefined;
    if (entry.serverUrl !== serverUrl) {
      this.evict(agentId, serverName);
      return undefined;
    }
    return this.now() < entry.expiresAt ? entry.accessToken : undefined;
  }

  /**
   * Store a token for `(agentId, serverName)` and (re)schedule its background
   * refresh from the token's ABSOLUTE `expiresAt`. Replaces any prior entry,
   * cancelling its pending refresh first.
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   * @param token - The cached token (access token + absolute expiry + refreshability).
   * @param refresh - Produces the next cached token when the timer fires, or `null` on failure.
   */
  store(
    agentId: string,
    serverName: string,
    token: CachedToken,
    refresh: () => Promise<CachedToken | null>
  ): void {
    const key = cacheKey(agentId, serverName);
    const previous = this.entries.get(key);
    if (previous?.timer) this.scheduler.clear(previous.timer);

    const entry: CacheEntry = {
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      serverUrl: token.serverUrl,
      refresh,
    };
    this.entries.set(key, entry);

    if (!token.refreshable) return;
    // A declared expiry sets the deadline; without one there is no deadline to
    // aim at, so fall back to a conservative period rather than never refreshing.
    const delay =
      token.expiresAt === Number.POSITIVE_INFINITY
        ? UNDECLARED_LIFETIME_REFRESH_MS
        : Math.max(0, token.expiresAt - REFRESH_SKEW_MS - this.now());
    entry.timer = this.scheduler.set(
      () => void this.refreshNow(agentId, serverName).catch(() => {}),
      delay
    );
  }

  /**
   * Run the refresh for `(agentId, serverName)` now: fetch the next cached token
   * and either replace the entry (rescheduling) or evict it on failure. Also
   * invoked by the scheduled timer.
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   * @returns `true` when a fresh token replaced the entry, `false` when it was evicted.
   * @internal Exercised directly by tests; production also reaches it via the timer.
   */
  async refreshNow(agentId: string, serverName: string): Promise<boolean> {
    const key = cacheKey(agentId, serverName);
    const entry = this.entries.get(key);
    if (!entry) return false;
    const next = await entry.refresh().catch(() => null);
    // The entry may have been evicted/replaced while awaiting; only act if ours stands.
    if (this.entries.get(key) !== entry) return this.entries.has(key);
    if (!next) {
      this.evict(agentId, serverName);
      return false;
    }
    this.store(agentId, serverName, next, entry.refresh);
    return true;
  }

  /**
   * Drop the cached token for `(agentId, serverName)`, cancelling any pending
   * refresh. The next injection withholds the header (needs-auth).
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   */
  evict(agentId: string, serverName: string): void {
    const key = cacheKey(agentId, serverName);
    const entry = this.entries.get(key);
    if (entry?.timer) this.scheduler.clear(entry.timer);
    this.entries.delete(key);
  }

  /**
   * Drop every cached token belonging to one agent, cancelling their pending
   * refreshes — the deleted-agent cascade, which cannot name the agent's servers
   * because its manifest is already gone by then.
   *
   * @param agentId - The agent whose cached tokens are being dropped.
   */
  evictAgent(agentId: string): void {
    const prefix = `${agentId}\0`;
    for (const key of [...this.entries.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const entry = this.entries.get(key);
      if (entry?.timer) this.scheduler.clear(entry.timer);
      this.entries.delete(key);
    }
  }

  /** Cancel every pending refresh and empty the cache (shutdown). */
  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) this.scheduler.clear(entry.timer);
    }
    this.entries.clear();
  }
}
