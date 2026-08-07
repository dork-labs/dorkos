/**
 * Managed-MCP OAuth engine (DOR-942): DorkOS owns the full OAuth lifecycle for an
 * agent's OAuth-protected MCP servers and injects the access token as a bearer
 * header at session-injection time.
 *
 * Why DorkOS owns it: the Agent SDK's `mcpServers` config is static-headers-only
 * (no `authProvider`), so the subprocess can never run OAuth itself. This service
 * drives the MCP SDK's `auth()` on the acquisition side — discover → dynamic
 * client registration → authorization-code + PKCE → token exchange → refresh —
 * persists the token set encrypted, and keeps the current access token in a
 * **synchronous** in-memory cache ({@link McpAccessTokenCache}) that the injection
 * read path can consult without awaiting.
 *
 * Sign-in and refresh both go through the same `auth()` entry point, so they get
 * the same behaviour for free: the RFC 8707 `resource` parameter, the negotiated
 * scope, and the credential-invalidation retry that makes a revoked grant
 * recoverable. Concurrency between them is arbitrated by {@link McpTokenRefresher}.
 *
 * Two surfaces call in: the `mcp.signin`/`mcp.poll_signin` capabilities
 * ({@link startSignin}, {@link pollSignin}) and the loopback callback route
 * ({@link handleCallback}). Injection calls {@link getAccessToken}. Boot calls
 * {@link warm} to re-prime the cache from disk after a restart. Removing a server
 * or deleting an agent calls {@link forgetServer}/{@link forgetAgent}, which is
 * what makes "you can remove the server anytime" true of the credential too.
 *
 * @module services/mesh/agent-mcp-oauth-service
 */
import { randomBytes } from 'node:crypto';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';
import type { Logger } from '@dorkos/shared/logger';

import {
  McpAccessTokenCache,
  type McpAccessTokenCacheDeps,
} from './agent-mcp-access-token-cache.js';
import { McpOAuthFlowStore, type McpSigninStatus } from './agent-mcp-oauth-flow-store.js';
import {
  McpOAuthClientProvider,
  McpOAuthSecretStore,
  type StoredMcpTokens,
  type McpOAuthProviderContext,
} from './agent-mcp-oauth-provider.js';
import {
  McpTokenRefresher,
  attemptTokenRefresh,
  toCachedToken,
  withRequestTimeout,
} from './agent-mcp-token-refresher.js';

/** The dedicated encrypted store id for managed-MCP OAuth material (tokens + DCR client info). */
const MCP_OAUTH_STORE_ID = 'mcp-oauth';

/** The loopback callback path (`redirect_uri`); the route in `routes/mcp-oauth.ts` mounts here. */
export const MCP_OAUTH_CALLBACK_PATH = '/api/agents/mcp-oauth/callback';

/** Injectable `fetch` seam (defaults to global `fetch`); tests pass a mock OAuth provider fetch. */
export type FetchFn = typeof fetch;

/** One `(agentId, serverName, serverUrl)` OAuth target — a managed server that expects a token. */
export interface McpOAuthTarget {
  /** The agent whose manifest owns the server. */
  agentId: string;
  /** The managed server's name (unique within the agent). */
  serverName: string;
  /** The MCP server URL the OAuth flow authorizes against. */
  serverUrl: string;
}

/** Constructor dependencies for {@link AgentMcpOAuthService}. */
export interface AgentMcpOAuthServiceDeps {
  /** The resolved DorkOS data directory (never `os.homedir()`; see `lib/dork-home.ts`). */
  dorkHome: string;
  /** Loopback base URL the browser can reach this server at, e.g. `http://127.0.0.1:4242`. */
  callbackBaseUrl: string;
  /** Diagnostic sink; defaults to `console`. */
  logger?: Pick<Logger, 'warn'>;
  /** `fetch` seam for the OAuth network calls (defaults to global `fetch`). */
  fetchImpl?: FetchFn;
  /** Clock/timer seams forwarded to the access-token cache (tests only). */
  cache?: McpAccessTokenCacheDeps;
  /** Delay seam for the refresh backoff (tests only); defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** The result `mcp.signin` needs: a sign-in link, or a note that the server is already connected. */
export interface StartSigninResult {
  /** The flow id the client polls with. */
  flowId: string;
  /** The sign-in link to open, absent when {@link alreadyConnected}. */
  authorizeUrl?: string;
  /** True when a live token already existed, so no browser step is needed. */
  alreadyConnected: boolean;
}

/**
 * The per-target lock key: `(agentId, serverName)` joined by NUL, which neither
 * part can contain. Every operation that reads-then-writes one server's token
 * store serializes on this.
 */
function lockKey(agentId: string, serverName: string): string {
  return `${agentId}\0${serverName}`;
}

/** {@link lockKey} for a whole target. */
function targetKey(target: McpOAuthTarget): string {
  return lockKey(target.agentId, target.serverName);
}

/**
 * The managed-MCP OAuth engine. One instance per server process; construct after
 * `dorkHome` resolves and the listen port is known.
 */
export class AgentMcpOAuthService {
  private readonly secrets: McpOAuthSecretStore;
  private readonly flows = new McpOAuthFlowStore();
  private readonly cache: McpAccessTokenCache;
  private readonly refresher: McpTokenRefresher;
  private readonly redirectUri: string;
  private readonly fetchImpl: FetchFn;
  private readonly logger: Pick<Logger, 'warn'>;

  constructor(deps: AgentMcpOAuthServiceDeps) {
    this.secrets = new McpOAuthSecretStore(
      new ExtensionSecretStore(MCP_OAUTH_STORE_ID, deps.dorkHome)
    );
    this.cache = new McpAccessTokenCache(deps.cache ?? {});
    this.logger = deps.logger ?? console;
    this.refresher = new McpTokenRefresher({
      logger: this.logger,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    this.redirectUri = new URL(MCP_OAUTH_CALLBACK_PATH, deps.callbackBaseUrl).toString();
    // Bounded at the seam, so every OAuth request — sign-in, callback exchange,
    // background refresh — inherits the ceiling that keeps a hung token endpoint
    // from wedging a target's lock.
    this.fetchImpl = withRequestTimeout(deps.fetchImpl ?? fetch);
  }

  /**
   * The live access token for `(agentId, serverName)` at `serverUrl`, or
   * `undefined`. Synchronous — this is the exact call the injection read path
   * makes to decide whether to merge the bearer header. A token minted for a
   * different URL is never handed out (DOR-986).
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   * @param serverUrl - The URL the caller is about to send the token to.
   */
  getAccessToken(agentId: string, serverName: string, serverUrl: string): string | undefined {
    return this.cache.getAccessToken(agentId, serverName, serverUrl);
  }

  /**
   * Begin a sign-in for a target: mint a flow, drive the SDK `auth()` orchestrator
   * (discovery → DCR → PKCE authorize URL), and return the link for the operator
   * to open. When a live token already exists, `auth()` refreshes it silently and
   * this reports `alreadyConnected` with no link. A failure drops the flow it
   * minted rather than parking it as `pending`: no link ever reached the operator,
   * so nothing can legitimately poll it, and a claimable `state` is one a stray
   * callback could still redeem.
   *
   * Serialized against the background refresh for the same target, so the two can
   * never present the same refresh token to a rotating issuer at once.
   *
   * @param target - The agent, server, and server URL to authorize.
   * @throws {Error} When `auth()` neither authorizes nor yields an authorize URL.
   */
  async startSignin(target: McpOAuthTarget): Promise<StartSigninResult> {
    return this.refresher.exclusive(targetKey(target), async () => {
      const state = randomBytes(16).toString('hex');
      this.flows.start(state, target);
      try {
        const provider = this.providerFor(target, state);
        const result = await auth(provider, {
          serverUrl: target.serverUrl,
          fetchFn: this.fetchImpl,
        });
        if (result === 'AUTHORIZED') {
          await this.primeFromStore(target);
          this.flows.markConnected(state);
          return { flowId: state, alreadyConnected: true };
        }

        const authorizeUrl = this.flows.authorizeUrl(state);
        if (!authorizeUrl) throw new Error('Could not build a sign-in link for this server.');
        return { flowId: state, authorizeUrl, alreadyConnected: false };
      } catch (err) {
        // No link ever reached the operator, so this flow can never be polled —
        // and a `state` left claimable is a `state` a stray callback could still
        // redeem. Drop it rather than leaving it parked as `pending` for its TTL.
        this.flows.drop(state);
        throw err;
      }
    });
  }

  /**
   * The pollable status of a sign-in flow (`pending` | `connected` | `failed`).
   *
   * @param flowId - The flow id from {@link startSignin}.
   */
  pollSignin(flowId: string): { status: McpSigninStatus; error?: string } {
    return this.flows.status(flowId);
  }

  /**
   * Handle the loopback callback: exchange the authorization code for tokens (via
   * the SDK `auth()` code path), prime the cache, and mark the flow connected.
   * Never throws — returns a status for the browser page.
   *
   * Reloading the callback page is treated as success, not failure: the PKCE
   * verifier is one-shot, so a second exchange always fails, and letting that
   * failure overwrite an already-`connected` flow told the operator their
   * successful sign-in had failed (DOR-986).
   *
   * A failed exchange can still leave the dynamic client registration on disk —
   * it is written before the code is exchanged. No token is stored, which is what
   * decides whether the server is usable.
   *
   * Serialized against the background refresh for the same target, so a refresh
   * that started on the OLD refresh token cannot land after this exchange and
   * overwrite the grant the operator just approved.
   *
   * @param args - The `state`, `code`, and optional `error` from the callback query.
   */
  async handleCallback(args: {
    state?: string;
    code?: string;
    error?: string;
  }): Promise<{ connected: boolean; error?: string }> {
    const { state, code, error } = args;
    if (!state) return { connected: false, error: 'Missing sign-in state. Please start again.' };
    const target = this.flows.target(state);
    if (!target)
      return { connected: false, error: 'This sign-in link expired. Please start again.' };
    if (this.flows.status(state).status === 'connected') return { connected: true };
    if (error || !code) {
      const message = 'Sign-in was cancelled.';
      this.flows.markFailed(state, message);
      return { connected: false, error: message };
    }

    return this.refresher.exclusive(targetKey(target), async () => {
      // Re-checked INSIDE the lock, and the check above is only a fast path. Two
      // callbacks can both pass an unlocked check while the first exchange is
      // still on the wire — a browser reload during those hundreds of
      // milliseconds is exactly how this happens. The second would then run the
      // exchange against a spent one-shot verifier, throw, and `markFailed` over
      // a flow that is already connected (DOR-986).
      if (this.flows.status(state).status === 'connected') return { connected: true };
      try {
        const provider = this.providerFor(target, state);
        await auth(provider, {
          serverUrl: target.serverUrl,
          authorizationCode: code,
          fetchFn: this.fetchImpl,
        });
        // The exchange is only real if a token actually landed: `auth()` reports
        // success, but the cache is what injection reads, so that is what we check.
        if (!(await this.primeFromStore(target))) {
          const message = 'The server did not complete the sign-in. Please try again.';
          this.flows.markFailed(state, message);
          return { connected: false, error: message };
        }
        this.flows.markConnected(state);
        return { connected: true };
      } catch (err) {
        // Keep the raw detail in the server log; hand the browser + poll a generic
        // message (the callback lands in the operator's own loopback browser, but
        // an exchange error can echo request context, so match the non-catch paths).
        this.logger.warn(
          `[mcp-oauth] callback failed for ${target.serverName}: ${err instanceof Error ? err.message : String(err)}`
        );
        const message = 'Sign-in failed. Please try again.';
        this.flows.markFailed(state, message);
        return { connected: false, error: message };
      }
    });
  }

  /**
   * Re-prime the cache from disk for a set of targets after a restart, scheduling
   * each token's background refresh. A target with no stored token is skipped
   * (stays needs-auth until the operator signs in).
   *
   * @param targets - The enabled OAuth-capable managed servers across all agents.
   */
  async warm(targets: McpOAuthTarget[]): Promise<void> {
    for (const target of targets) {
      await this.primeFromStore(target).catch((err: unknown) => {
        this.logger.warn(
          `[mcp-oauth] warm failed for ${target.serverName}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  }

  /**
   * Forget one server's OAuth credentials: delete the stored token set and client
   * registration, and drop the cached token along with its refresh timer. Called
   * when a managed server is removed, and when its URL changes — the token was
   * minted for a specific server, so it must not survive being re-pointed at a
   * different one.
   *
   * Serialized on the target's own lock, like every other writer of its token
   * store. Without that, a refresh already on the wire finishes after the delete
   * and writes a brand-new access + refresh token back to disk for a server the
   * operator just removed — cache clean, disk dirty, and nothing ever sweeps it
   * (DOR-986).
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   */
  async forgetServer(agentId: string, serverName: string): Promise<void> {
    await this.refresher.exclusive(lockKey(agentId, serverName), () =>
      this.forgetServerUnlocked(agentId, serverName)
    );
  }

  /**
   * The body of {@link forgetServer} without taking the lock. Only for callers
   * that already hold it, or that run before any refresh could exist for the
   * target — taking it again from inside would wait on the operation that is
   * currently holding it, which never completes.
   */
  private async forgetServerUnlocked(agentId: string, serverName: string): Promise<void> {
    this.cache.evict(agentId, serverName);
    await this.secrets.clear(agentId, serverName);
  }

  /**
   * Forget every OAuth credential belonging to one agent — the deleted-agent
   * cascade, so an agent's tokens do not outlive the agent.
   *
   * The agent's manifest is already gone by the time it is unregistered, so the
   * servers it used to have are recovered from the store's own key namespace —
   * and each one is then forgotten under its own lock, for the same reason
   * {@link forgetServer} takes one.
   *
   * @param agentId - The agent being deleted.
   */
  async forgetAgent(agentId: string): Promise<void> {
    this.cache.evictAgent(agentId);
    const serverNames = await this.secrets.serverNames(agentId);
    await Promise.all(serverNames.map((name) => this.forgetServer(agentId, name)));
  }

  /**
   * Run a target's background refresh right now, exactly as its scheduled timer
   * would, and report whether a fresh token replaced the cached one.
   *
   * @param target - The agent, server, and server URL to refresh.
   * @internal Exercised by tests; production reaches this through the cache timer.
   */
  async refreshNow(target: McpOAuthTarget): Promise<boolean> {
    return this.cache.refreshNow(target.agentId, target.serverName);
  }

  /** Cancel every pending refresh and empty the token cache (shutdown). */
  shutdown(): void {
    this.cache.clear();
  }

  /**
   * Load the stored token set for a target and prime the cache. Returns whether a
   * token was primed. A stored set bound to a different URL than the target's is
   * deleted rather than primed: it authorizes a server this name no longer points
   * at, so it can only ever be sent to the wrong place.
   *
   * Deletes through the UNLOCKED path deliberately. Every caller either already
   * holds the target's lock (sign-in, callback) or runs before any refresh for it
   * can exist (`warm`, which primes the cache the timers hang off), so taking the
   * lock here would be a self-deadlock in the first case and pointless in the second.
   */
  private async primeFromStore(target: McpOAuthTarget): Promise<boolean> {
    const tokens = await this.secrets.tokens(target.agentId, target.serverName);
    if (!tokens) return false;
    if (tokens.serverUrl !== target.serverUrl) {
      this.logger.warn(
        `[mcp-oauth] dropping the stored token for ${target.serverName}: it was issued for a different URL`
      );
      await this.forgetServerUnlocked(target.agentId, target.serverName);
      return false;
    }
    this.primeCache(target, tokens);
    return true;
  }

  /** Cache a stored token set (by its ABSOLUTE expiry) and bind its background refresh. */
  private primeCache(target: McpOAuthTarget, tokens: StoredMcpTokens): void {
    this.cache.store(target.agentId, target.serverName, toCachedToken(tokens), () =>
      this.refresher.refresh(targetKey(target), () =>
        attemptTokenRefresh({
          // A state no flow owns: every flow-store write this provider makes is a
          // no-op, so a background refresh can never clobber a live sign-in.
          provider: this.providerFor(target, `refresh:${randomBytes(8).toString('hex')}`),
          serverUrl: target.serverUrl,
          fetchImpl: this.fetchImpl,
          loadTokens: () => this.secrets.tokens(target.agentId, target.serverName),
        })
      )
    );
  }

  /** Build a provider bound to one target + sign-in state. */
  private providerFor(target: McpOAuthTarget, state: string): McpOAuthClientProvider {
    const ctx: McpOAuthProviderContext = {
      agentId: target.agentId,
      serverName: target.serverName,
      serverUrl: target.serverUrl,
      state,
      redirectUri: this.redirectUri,
      secrets: this.secrets,
      flows: this.flows,
    };
    return new McpOAuthClientProvider(ctx);
  }
}

/**
 * The custody disclosure shown before a managed-MCP sign-in and returned verbatim
 * by `mcp.signin` — the plain-language statement of WHERE the token lives, the
 * same honesty control the connector flow carries. Unlike Composio's managed
 * custody, the token never leaves the machine.
 *
 * @param serverName - The server being signed into, named in the sentence.
 */
export function mcpOAuthCustodyDisclosure(serverName: string): string {
  return (
    `Signing in takes you to ${serverName} to approve access. ` +
    'DorkOS keeps the resulting token encrypted on this computer and sends it to the ' +
    'server on your behalf. Your password is never shared, and you can remove the server anytime.'
  );
}
