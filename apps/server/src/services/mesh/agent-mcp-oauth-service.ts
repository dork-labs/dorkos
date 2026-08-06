/**
 * Managed-MCP OAuth engine (DOR-942): DorkOS owns the full OAuth lifecycle for an
 * agent's OAuth-protected MCP servers and injects the access token as a bearer
 * header at session-injection time.
 *
 * Why DorkOS owns it: the Agent SDK's `mcpServers` config is static-headers-only
 * (no `authProvider`), so the subprocess can never run OAuth itself. This service
 * drives the MCP SDK's `auth()`/`refreshAuthorization()` on the acquisition side —
 * discover → dynamic client registration → authorization-code + PKCE → token
 * exchange → refresh — persists the token set encrypted, and keeps the current
 * access token in a **synchronous** in-memory cache ({@link McpAccessTokenCache})
 * that the injection read path can consult without awaiting.
 *
 * Two surfaces call in: the `mcp.signin`/`mcp.poll_signin` capabilities
 * ({@link startSignin}, {@link pollSignin}) and the loopback callback route
 * ({@link handleCallback}). Injection calls {@link getAccessToken}. Boot calls
 * {@link warm} to re-prime the cache from disk after a restart.
 *
 * @module services/mesh/agent-mcp-oauth-service
 */
import { randomBytes } from 'node:crypto';
import {
  auth,
  discoverOAuthServerInfo,
  refreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';
import type { Logger } from '@dorkos/shared/logger';

import {
  McpAccessTokenCache,
  type CachedToken,
  type McpAccessTokenCacheDeps,
} from './agent-mcp-access-token-cache.js';
import { McpOAuthFlowStore, type McpSigninStatus } from './agent-mcp-oauth-flow-store.js';
import {
  McpOAuthClientProvider,
  McpOAuthSecretStore,
  type StoredMcpTokens,
  type McpOAuthProviderContext,
} from './agent-mcp-oauth-provider.js';

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
 * The managed-MCP OAuth engine. One instance per server process; construct after
 * `dorkHome` resolves and the listen port is known.
 */
export class AgentMcpOAuthService {
  private readonly secrets: McpOAuthSecretStore;
  private readonly flows = new McpOAuthFlowStore();
  private readonly cache: McpAccessTokenCache;
  private readonly redirectUri: string;
  private readonly fetchImpl: FetchFn;
  private readonly logger: Pick<Logger, 'warn'>;

  constructor(deps: AgentMcpOAuthServiceDeps) {
    this.secrets = new McpOAuthSecretStore(
      new ExtensionSecretStore(MCP_OAUTH_STORE_ID, deps.dorkHome)
    );
    this.cache = new McpAccessTokenCache(deps.cache ?? {});
    this.redirectUri = new URL(MCP_OAUTH_CALLBACK_PATH, deps.callbackBaseUrl).toString();
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.logger = deps.logger ?? console;
  }

  /**
   * The live access token for `(agentId, serverName)`, or `undefined`. Synchronous
   * — this is the exact call the injection read path makes to decide whether to
   * merge the bearer header.
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   */
  getAccessToken(agentId: string, serverName: string): string | undefined {
    return this.cache.getAccessToken(agentId, serverName);
  }

  /**
   * Begin a sign-in for a target: mint a flow, drive the SDK `auth()` orchestrator
   * (discovery → DCR → PKCE authorize URL), and return the link for the operator
   * to open. When a live token already exists, primes the cache and reports
   * `alreadyConnected` with no link.
   *
   * @param target - The agent, server, and server URL to authorize.
   * @throws {Error} When `auth()` neither authorizes nor yields an authorize URL.
   */
  async startSignin(target: McpOAuthTarget): Promise<StartSigninResult> {
    const state = randomBytes(16).toString('hex');
    this.flows.start(state, target);
    const provider = this.providerFor(target, state);

    const result = await auth(provider, { serverUrl: target.serverUrl, fetchFn: this.fetchImpl });
    if (result === 'AUTHORIZED') {
      await this.primeFromStore(target);
      this.flows.markConnected(state);
      return { flowId: state, alreadyConnected: true };
    }

    const authorizeUrl = this.flows.authorizeUrl(state);
    if (!authorizeUrl) {
      this.flows.markFailed(state, 'Could not build a sign-in link for this server.');
      throw new Error('Could not build a sign-in link for this server.');
    }
    return { flowId: state, authorizeUrl, alreadyConnected: false };
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
   * Never throws — returns a status for the browser page. Nothing is stored on
   * failure.
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
    if (error || !code) {
      const message = 'Sign-in was cancelled.';
      this.flows.markFailed(state, message);
      return { connected: false, error: message };
    }

    try {
      const provider = this.providerFor(target, state);
      const result = await auth(provider, {
        serverUrl: target.serverUrl,
        authorizationCode: code,
        fetchFn: this.fetchImpl,
      });
      if (result !== 'AUTHORIZED') {
        const message = 'The server did not complete the sign-in. Please try again.';
        this.flows.markFailed(state, message);
        return { connected: false, error: message };
      }
      await this.primeFromStore(target);
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

  /** Cancel every pending refresh and empty the token cache (shutdown). */
  shutdown(): void {
    this.cache.clear();
  }

  /** Load the stored token set for a target and prime the cache (no-op when absent). */
  private async primeFromStore(target: McpOAuthTarget): Promise<void> {
    const tokens = await this.secrets.tokens(target.agentId, target.serverName);
    if (tokens) this.primeCache(target, tokens);
  }

  /** Cache a stored token set (by its ABSOLUTE expiry) and bind its background refresh. */
  private primeCache(target: McpOAuthTarget, tokens: StoredMcpTokens): void {
    this.cache.store(target.agentId, target.serverName, toCachedToken(tokens), () =>
      this.refresh(target)
    );
  }

  /**
   * Exchange the stored refresh token for a new access token, persist it (stamping
   * a fresh absolute expiry), and hand the resulting cached token back. Returns
   * `null` (evicting the cached token) when there is no refresh token, no client
   * registration, or the exchange fails — so a failed refresh degrades to
   * needs-auth rather than a stale token.
   */
  private async refresh(target: McpOAuthTarget): Promise<CachedToken | null> {
    try {
      const [stored, clientInformation] = await Promise.all([
        this.secrets.tokens(target.agentId, target.serverName),
        this.secrets.clientInformation(target.agentId, target.serverName),
      ]);
      if (!stored?.refresh_token || !clientInformation) return null;

      const info = await discoverOAuthServerInfo(target.serverUrl, { fetchFn: this.fetchImpl });
      const next = await refreshAuthorization(info.authorizationServerUrl, {
        ...(info.authorizationServerMetadata ? { metadata: info.authorizationServerMetadata } : {}),
        clientInformation,
        refreshToken: stored.refresh_token,
        fetchFn: this.fetchImpl,
      });
      await this.secrets.saveTokens(target.agentId, target.serverName, next);
      // Re-read so the absolute expiry is the one saveTokens just stamped (single
      // source of that computation), rather than recomputing it here.
      const persisted = await this.secrets.tokens(target.agentId, target.serverName);
      return persisted ? toCachedToken(persisted) : null;
    } catch (err) {
      this.logger.warn(
        `[mcp-oauth] refresh failed for ${target.serverName}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  /** Build a provider bound to one target + sign-in state. */
  private providerFor(target: McpOAuthTarget, state: string): McpOAuthClientProvider {
    const ctx: McpOAuthProviderContext = {
      agentId: target.agentId,
      serverName: target.serverName,
      state,
      redirectUri: this.redirectUri,
      secrets: this.secrets,
      flows: this.flows,
    };
    return new McpOAuthClientProvider(ctx);
  }
}

/**
 * Convert a persisted token set into the cache's {@link CachedToken}, trusting the
 * ABSOLUTE `expiresAt` stamped at save time — never recomputing from the relative
 * `expires_in`, which is meaningless after a restart (DOR-942). No stored
 * `expiresAt` means no declared lifetime, so it never expires on our clock.
 *
 * @param stored - The persisted token set.
 */
function toCachedToken(stored: StoredMcpTokens): CachedToken {
  return {
    accessToken: stored.access_token,
    expiresAt: stored.expiresAt ?? Number.POSITIVE_INFINITY,
    refreshable: Boolean(stored.refresh_token),
  };
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
