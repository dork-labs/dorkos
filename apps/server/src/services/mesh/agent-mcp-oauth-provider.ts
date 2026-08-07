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

/** Milliseconds per second, for converting the relative `expires_in` to an absolute clock. */
const MS_PER_SECOND = 1000;

/**
 * A persisted token set augmented with an ABSOLUTE `expiresAt` (epoch ms),
 * computed from the relative `expires_in` at save time. This is the
 * restart-staleness fix (DOR-942): `expires_in` alone is meaningless after a
 * restart — a token issued long ago would look freshly minted — so the absolute
 * expiry is what the cache trusts on load. Absent `expiresAt` = no lifetime given.
 */
export interface StoredMcpTokens extends OAuthTokens {
  /** Absolute expiry in epoch ms; omitted when the token set carried no `expires_in`. */
  expiresAt?: number;
  /**
   * The MCP server URL this token set was minted for (DOR-986). A managed server
   * keeps its name across a URL change, so the `(agentId, serverName)` key alone
   * cannot tell "the token for this server" from "the token for whatever used to
   * live under this name" — the bound URL is what makes that distinguishable, and
   * a mismatch means the token is withheld. Absent on records written before the
   * binding existed, which read as unbound and are re-minted on next sign-in.
   */
  serverUrl?: string;
}

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

  /** Read the persisted token set (with its absolute expiry), or `undefined` when never signed in. */
  async tokens(agentId: string, serverName: string): Promise<StoredMcpTokens | undefined> {
    return this.read<StoredMcpTokens>(key(agentId, serverName, 'tokens'));
  }

  /**
   * Persist a token set (the refresh token stays here, never on the manifest),
   * stamping an ABSOLUTE `expiresAt` from the relative `expires_in` so a token
   * loaded after a restart is judged by its real issue time, not the restart time,
   * and binding it to the server URL it was minted for (DOR-986).
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   * @param tokens - The token set the OAuth server just issued.
   * @param serverUrl - The MCP server URL the token authorizes against.
   */
  async saveTokens(
    agentId: string,
    serverName: string,
    tokens: OAuthTokens,
    serverUrl: string
  ): Promise<void> {
    const record: StoredMcpTokens = {
      ...tokens,
      ...(tokens.expires_in !== undefined
        ? { expiresAt: Date.now() + tokens.expires_in * MS_PER_SECOND }
        : {}),
      serverUrl,
    };
    await this.store.set(key(agentId, serverName, 'tokens'), JSON.stringify(record));
  }

  /** Forget the stored token set for one server, keeping its DCR registration. */
  async clearTokens(agentId: string, serverName: string): Promise<void> {
    await this.store.delete(key(agentId, serverName, 'tokens'));
  }

  /** Forget the DCR client registration for one server (a stale `redirect_uri`, say). */
  async clearClientInformation(agentId: string, serverName: string): Promise<void> {
    await this.store.delete(key(agentId, serverName, 'client'));
  }

  /** Forget everything stored for one server (sign-out / removal). */
  async clear(agentId: string, serverName: string): Promise<void> {
    await this.clearClientInformation(agentId, serverName);
    await this.clearTokens(agentId, serverName);
  }

  /**
   * Every server name this agent has OAuth material for, recovered from the key
   * namespace. This is how the deleted-agent cascade knows what to forget: by
   * the time an agent is unregistered its manifest is gone, so the store's own
   * keys are the only remaining record. Nothing is decrypted along the way.
   *
   * @param agentId - The agent whose stored servers are being listed.
   */
  async serverNames(agentId: string): Promise<string[]> {
    const prefix = `${agentId}:`;
    const names = new Set<string>();
    for (const storeKey of await this.store.keys()) {
      if (!storeKey.startsWith(prefix)) continue;
      // `<agentId>:<serverName>:<kind>` — split off the kind from the right, so a
      // server name is read whole even though it sits between two delimiters.
      const rest = storeKey.slice(prefix.length);
      const kindAt = rest.lastIndexOf(':');
      if (kindAt > 0) names.add(rest.slice(0, kindAt));
    }
    return [...names];
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
  /** The MCP server URL being authorized — stored alongside the token set (DOR-986). */
  serverUrl: string;
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
   * stale dynamic registration (an `invalid_client` after the callback URL moved).
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
    // 'discovery' has nothing to forget: this provider implements no
    // `saveDiscoveryState`, so the SDK re-discovers on every `auth()` anyway.
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
