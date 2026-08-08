/**
 * The MCP SDK `OAuthClientProvider` for managed-MCP sign-in (DOR-942).
 *
 * DorkOS owns the whole OAuth lifecycle because the Agent SDK's `mcpServers`
 * config is static-headers-only (no `authProvider`): DorkOS obtains and refreshes
 * the token out-of-band and injects it as a bearer header at injection time. This
 * provider is the acquisition-side seam the SDK's `auth()`/`exchangeAuthorization`/
 * `refreshAuthorization` drive. It is bound to one `(agentId, serverName)` target
 * and one in-flight sign-in `state`.
 *
 * Custody split: durable secrets (the client identity, the token set) live in the
 * encrypted `mcp-oauth` {@link McpOAuthSecretStore} so they survive a restart;
 * the transient PKCE verifier and captured authorize URL live in the in-memory
 * {@link McpOAuthFlowStore}, keyed by `state`, and never touch disk. The verifier
 * never reaches the client.
 *
 * @module services/mesh/agent-mcp-oauth-provider
 */
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import type { McpOAuthFlowStore } from './agent-mcp-oauth-flow-store.js';
import type { McpOAuthSecretStore } from './agent-mcp-oauth-secret-store.js';

/** The OAuth grant types DorkOS drives: the initial code exchange plus silent refresh. */
const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

/**
 * How far the SDK's `auth()` got before it threw (DOR-982).
 *
 * `auth()` reports failure as a thrown `Error` whose message is whatever the
 * provider's HTTP response happened to say, so the STAGE is the only structured
 * signal about what went wrong — and the provider is the one thing `auth()` calls
 * at each step, which makes it the place to record it. Sniffing the message
 * instead was the alternative, and it would break the moment a provider changed
 * its wording.
 *
 * - `discovery` — still working out where the OAuth server is and what it offers.
 * - `registration` — no client identity is stored, so `auth()` is about to
 *   register DorkOS with the provider (RFC 7591) or has just failed doing so.
 * - `authorize` — a client identity is in hand; the PKCE authorize URL and the
 *   token exchange come next.
 */
export type McpSigninStage = 'discovery' | 'registration' | 'authorize';

/**
 * The mutable note a provider writes its progress onto, so the caller of
 * `auth()` can classify a throw. One per sign-in attempt; `undefined` for the
 * background refresh, which classifies nothing.
 */
export interface McpSigninProgress {
  /** The furthest stage reached; see {@link McpSigninStage}. */
  stage: McpSigninStage;
  /**
   * Whether the authorization server published OAuth metadata at all, once
   * discovery has answered. `false` means the server has no OAuth details to
   * work from — which reads very differently from "it has them but will not
   * register us". Absent until discovery finishes.
   */
  metadataFound?: boolean;
  /**
   * Whether ANY request in this attempt got an answer, of any status.
   *
   * The separator between "this is not an OAuth server" and "this server is
   * down", which otherwise look identical from inside `auth()`: the SDK treats a
   * dead metadata endpoint exactly as it treats a 404 one — it moves on and ends
   * up with no metadata either way. Telling a person their server "doesn't offer
   * sign-in" because their Wi-Fi dropped is the lie this prevents.
   *
   * Recorded by the engine, which owns the `fetch` seam, not by the provider.
   */
  responded?: boolean;
}

/** A fresh progress note, before `auth()` has taken a step. */
export function newSigninProgress(): McpSigninProgress {
  return { stage: 'discovery' };
}

/** Everything one provider instance binds to. */
export interface McpOAuthProviderContext {
  agentId: string;
  serverName: string;
  /** The MCP server URL being authorized — stored alongside the token set (DOR-986). */
  serverUrl: string;
  /** The opaque OAuth `state` for this sign-in, and the flow-store key. */
  state: string;
  /** The fixed loopback callback URL (`redirect_uri`), same for authorize and exchange. */
  redirectUri: string;
  secrets: McpOAuthSecretStore;
  flows: McpOAuthFlowStore;
  /** Where to record how far `auth()` got, when the caller means to classify a failure. */
  progress?: McpSigninProgress;
}

/**
 * An {@link OAuthClientProvider} bound to one sign-in. Durable material routes to
 * the encrypted store; transient PKCE + the authorize URL route to the flow store.
 */
export class McpOAuthClientProvider implements OAuthClientProvider {
  constructor(private readonly ctx: McpOAuthProviderContext) {}

  get redirectUrl(): string {
    return this.ctx.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'DorkOS',
      redirect_uris: [this.ctx.redirectUri],
      grant_types: [...GRANT_TYPES],
      response_types: ['code'],
      // Public client (loopback, no confidential secret to hold): PKCE is the proof.
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    return this.ctx.state;
  }

  /**
   * The stored client identity, and the point at which the SDK decides whether
   * to register: a value here skips RFC 7591 registration entirely, which is
   * exactly what makes operator-supplied credentials work (DOR-982).
   */
  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    const info = await this.ctx.secrets.clientInformation(this.ctx.agentId, this.ctx.serverName);
    if (this.ctx.progress) this.ctx.progress.stage = info ? 'authorize' : 'registration';
    return info;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    // Only reached on the automatic-registration path — an operator-supplied
    // client is written directly by the service and short-circuits the SDK here.
    if (this.ctx.progress) this.ctx.progress.stage = 'authorize';
    await this.ctx.secrets.saveClientInformation(
      this.ctx.agentId,
      this.ctx.serverName,
      info,
      'dcr'
    );
  }

  /**
   * Observation only — nothing is persisted, deliberately.
   *
   * Implementing this pairs with NOT implementing `discoveryState()`, so the SDK
   * re-discovers on every `auth()` (which is what {@link invalidateCredentials}'s
   * `'discovery'` scope relies on) and simply tells us what it found on the way
   * past. What it found is the difference between "this server publishes no OAuth
   * details" and "it does, but it will not register us" — two failures that read
   * identically from the throw alone (DOR-982).
   *
   * @param state - What the SDK discovered; only whether metadata exists is read.
   */
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    if (this.ctx.progress) {
      this.ctx.progress.metadataFound = state.authorizationServerMetadata !== undefined;
    }
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return this.ctx.secrets.tokens(this.ctx.agentId, this.ctx.serverName);
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return this.ctx.secrets.saveTokens(
      this.ctx.agentId,
      this.ctx.serverName,
      tokens,
      this.ctx.serverUrl
    );
  }

  /**
   * Drop credentials the OAuth server just told us are no longer good, so the
   * SDK's `auth()` retry can start clean instead of replaying them.
   *
   * This method is why a revoked grant is recoverable at all (DOR-986). `auth()`
   * catches an `invalid_grant` from a refresh, calls this with `'tokens'`, and
   * retries; without an implementation the retry replays the same dead refresh
   * token and throws again, so `mcp.signin` can never produce a fresh sign-in
   * link and the server is stuck. `'client'`/`'all'` cover the sibling case of a
   * stale registration (an `invalid_client` after the callback URL moved).
   *
   * @param scope - Which credentials the SDK wants forgotten.
   */
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    const { agentId, serverName, state, secrets, flows } = this.ctx;
    if (scope === 'tokens' || scope === 'all') await secrets.clearTokens(agentId, serverName);
    if (scope === 'client' || scope === 'all')
      await secrets.clearClientInformation(agentId, serverName);
    if (scope === 'verifier' || scope === 'all') flows.clearVerifier(state);
    // 'discovery' has nothing to forget: this provider's `saveDiscoveryState`
    // stores nothing and it implements no `discoveryState`, so the SDK
    // re-discovers on every `auth()` anyway.
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Acquisition is out-of-band from any subprocess: rather than redirect, we
    // capture the URL so `mcp.signin` can hand it to the operator to open.
    this.ctx.flows.setAuthorizeUrl(this.ctx.state, authorizationUrl.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.ctx.flows.setVerifier(this.ctx.state, codeVerifier);
  }

  codeVerifier(): string {
    const verifier = this.ctx.flows.claimVerifier(this.ctx.state);
    if (!verifier) {
      throw new Error(
        'The sign-in PKCE verifier is missing or already used. Start the sign-in again.'
      );
    }
    return verifier;
  }
}
