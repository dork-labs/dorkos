/**
 * Durable custody for one managed server's OAuth material (DOR-942): the token
 * set, and the OAuth client identity DorkOS signs in as.
 *
 * The sibling {@link McpOAuthFlowStore} holds the TRANSIENT half of a sign-in
 * (the PKCE verifier, the captured authorize URL) in memory, keyed by `state`.
 * Everything that must survive a restart lives here instead, encrypted, keyed
 * `${agentId}:${serverName}:<kind>`.
 *
 * Split out of `agent-mcp-oauth-provider.ts` when operator-supplied client
 * credentials arrived (DOR-982): persistence and the SDK's `OAuthClientProvider`
 * are two jobs, and only one of them is bound to a single in-flight sign-in.
 *
 * @module services/mesh/agent-mcp-oauth-secret-store
 */
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpClientOrigin } from '@dorkos/shared/mesh-schemas';
import type { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';

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
 * A persisted OAuth client identity, plus where it came from (DOR-982).
 *
 * The SDK reads only the RFC 7591 fields, so `origin` rides along inert — it
 * exists purely so a card can say "using your own app credentials" after a
 * restart, when nothing else on this machine remembers which of the two
 * registration paths was taken. Absent on records written before it existed,
 * which read as `'dcr'` because that was the only path then.
 */
export interface StoredMcpClientInfo extends OAuthClientInformationFull {
  /** How this client identity was obtained; see {@link McpClientOrigin}. */
  origin?: McpClientOrigin;
}

/**
 * Typed persistence for one managed server's OAuth material in the encrypted
 * `mcp-oauth` store, keyed `${agentId}:${serverName}:<kind>`. JSON in, JSON out;
 * a corrupt/absent value reads as "not present" (the store already treats
 * undecryptable data as missing).
 */
export class McpOAuthSecretStore {
  constructor(private readonly store: ExtensionSecretStore) {}

  /** Read the persisted OAuth client identity, or `undefined` when there is none. */
  async clientInformation(
    agentId: string,
    serverName: string
  ): Promise<StoredMcpClientInfo | undefined> {
    return this.read<StoredMcpClientInfo>(key(agentId, serverName, 'client'));
  }

  /**
   * Persist an OAuth client identity, stamped with where it came from.
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   * @param info - The client identity, in the SDK's own RFC 7591 shape.
   * @param origin - `'dcr'` when the provider registered DorkOS automatically,
   *   `'manual'` when the operator supplied the credentials themselves.
   */
  async saveClientInformation(
    agentId: string,
    serverName: string,
    info: OAuthClientInformationFull,
    origin: McpClientOrigin
  ): Promise<void> {
    const record: StoredMcpClientInfo = { ...info, origin };
    await this.store.set(key(agentId, serverName, 'client'), JSON.stringify(record));
  }

  /**
   * Where the stored client identity came from, or `undefined` when none is
   * stored. A record written before origins were stamped reads as `'dcr'`, which
   * is what it must have been.
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   */
  async clientOrigin(agentId: string, serverName: string): Promise<McpClientOrigin | undefined> {
    const info = await this.clientInformation(agentId, serverName);
    if (!info) return undefined;
    return info.origin ?? 'dcr';
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

  /** Forget the stored token set for one server, keeping its client registration. */
  async clearTokens(agentId: string, serverName: string): Promise<void> {
    await this.store.delete(key(agentId, serverName, 'tokens'));
  }

  /** Forget the OAuth client identity for one server (a stale `redirect_uri`, say). */
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
