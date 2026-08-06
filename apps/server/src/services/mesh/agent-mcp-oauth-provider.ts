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
 * Custody split: durable secrets (DCR client info, the token set) live in the
 * encrypted `mcp-oauth` {@link ExtensionSecretStore} so they survive a restart;
 * the transient PKCE verifier and captured authorize URL live in the in-memory
 * {@link McpOAuthFlowStore}, keyed by `state`, and never touch disk. The verifier
 * never reaches the client.
 *
 * @module services/mesh/agent-mcp-oauth-provider
 */
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';

import type { McpOAuthFlowStore } from './agent-mcp-oauth-flow-store.js';

/** The OAuth grant types DorkOS drives: the initial code exchange plus silent refresh. */
const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

/**
 * Typed persistence for one managed server's OAuth material in the encrypted
 * `mcp-oauth` store, keyed `${agentId}:${serverName}:<kind>`. JSON in, JSON out;
 * a corrupt/absent value reads as "not present" (the store already treats
 * undecryptable data as missing).
 */
export class McpOAuthSecretStore {
  constructor(private readonly store: ExtensionSecretStore) {}

  /** Read the persisted DCR client information, or `undefined` when unregistered. */
  async clientInformation(
    agentId: string,
    serverName: string
  ): Promise<OAuthClientInformationFull | undefined> {
    return this.read<OAuthClientInformationFull>(key(agentId, serverName, 'client'));
  }

  /** Persist DCR client information after registration. */
  async saveClientInformation(
    agentId: string,
    serverName: string,
    info: OAuthClientInformationFull
  ): Promise<void> {
    await this.store.set(key(agentId, serverName, 'client'), JSON.stringify(info));
  }

  /** Read the persisted token set, or `undefined` when never signed in. */
  async tokens(agentId: string, serverName: string): Promise<OAuthTokens | undefined> {
    return this.read<OAuthTokens>(key(agentId, serverName, 'tokens'));
  }

  /** Persist a token set (the refresh token stays here, never on the manifest). */
  async saveTokens(agentId: string, serverName: string, tokens: OAuthTokens): Promise<void> {
    await this.store.set(key(agentId, serverName, 'tokens'), JSON.stringify(tokens));
  }

  /** Forget everything stored for one server (sign-out / removal). */
  async clear(agentId: string, serverName: string): Promise<void> {
    await this.store.delete(key(agentId, serverName, 'client'));
    await this.store.delete(key(agentId, serverName, 'tokens'));
  }

  private async read<T>(storeKey: string): Promise<T | undefined> {
    const raw = await this.store.get(storeKey);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }
}

/** `${agentId}:${serverName}:<kind>` — the per-server, per-kind secret key. */
function key(agentId: string, serverName: string, kind: 'client' | 'tokens'): string {
  return `${agentId}:${serverName}:${kind}`;
}

/** Everything one provider instance binds to. */
export interface McpOAuthProviderContext {
  agentId: string;
  serverName: string;
  /** The opaque OAuth `state` for this sign-in, and the flow-store key. */
  state: string;
  /** The fixed loopback callback URL (`redirect_uri`), same for authorize and exchange. */
  redirectUri: string;
  secrets: McpOAuthSecretStore;
  flows: McpOAuthFlowStore;
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

  clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    return this.ctx.secrets.clientInformation(this.ctx.agentId, this.ctx.serverName);
  }

  saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    return this.ctx.secrets.saveClientInformation(this.ctx.agentId, this.ctx.serverName, info);
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return this.ctx.secrets.tokens(this.ctx.agentId, this.ctx.serverName);
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return this.ctx.secrets.saveTokens(this.ctx.agentId, this.ctx.serverName, tokens);
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
