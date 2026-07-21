/**
 * The raw-MCP baseline {@link ConnectorProvider} — the single-account,
 * no-custody adapter that connects a DorkOS agent to a remote MCP server over
 * OAuth 2.1. It is the first connector to land because it exercises the whole
 * `ConnectorProvider` seam against machinery that already exists
 * (`McpAppServerConnection` / the runtime MCP seam), with no vendor dependency.
 *
 * Capabilities: `type: 'mcp'`, `supportsMultiAccount: false`,
 * `custody: 'external'`, `exposesOverMcp: true`. Custody is `external` because
 * the gateway keeps NO tokens — the remote server holds its own credentials, so
 * this adapter never persists a secret. Each configured server maps to at most
 * one account.
 *
 * See spec `specs/connector-gateway/02-specification.md` §Detailed Design 1 and
 * §Non-Goals (baseline = single-account).
 *
 * @module services/connectors/providers/raw-mcp
 */
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import type {
  ConnectedAccount,
  ConnectedAccountId,
  ConnectorCapabilities,
  ConnectorProvider,
  ConnectorToolkit,
  ConnectPoll,
  ConnectStart,
} from '@dorkos/shared/connector-provider';

/** The remote-server subset of {@link McpAppServerConnection} (no stdio for a raw remote MCP). */
export type RemoteMcpConnection = Extract<McpAppServerConnection, { transport: 'http' | 'sse' }>;

/** One remote MCP server this adapter can connect, as configured by the operator. */
export interface RawMcpServerDescriptor {
  /** Stable service slug used as the toolkit id, e.g. `'notion'`. */
  slug: string;
  /** Human-facing name shown in the connect picker. */
  displayName: string;
  /** The runtime-neutral connection details injected once connected. */
  connection: RemoteMcpConnection;
  /** How the server authenticates. Defaults to `'oauth2'` (remote MCP over OAuth 2.1). */
  authKind?: ConnectorToolkit['authKind'];
}

/** Construction options for {@link RawMcpConnectorProvider}. */
export interface RawMcpConnectorProviderOpts {
  /** The remote MCP servers this adapter exposes as toolkits. */
  servers: RawMcpServerDescriptor[];
  /**
   * Liveness probe for a configured server — when it resolves falsy,
   * `toolServerForAccount` returns `null` (the server is momentarily
   * unreachable). Defaults to always-reachable.
   *
   * @param slug - The server slug being probed.
   */
  isReachable?: (slug: string) => boolean | Promise<boolean>;
}

/** Deterministic single account id for one configured server. */
function accountIdForSlug(slug: string): ConnectedAccountId {
  return `mcp:${slug}` as ConnectedAccountId;
}

/**
 * Baseline connector for remote MCP servers. Single-account by construction: a
 * configured server yields at most one connected account, and a second connect
 * of an already-connected toolkit rejects rather than duplicating.
 */
export class RawMcpConnectorProvider implements ConnectorProvider {
  readonly type = 'mcp';

  private readonly _servers = new Map<string, RawMcpServerDescriptor>();
  private readonly _isReachable: (slug: string) => boolean | Promise<boolean>;
  /** Accounts keyed by their opaque id; the derived registry, held in memory. */
  private readonly _accounts = new Map<string, ConnectedAccount>();
  /** Pending connect flows keyed by opaque flow id. */
  private readonly _flows = new Map<string, { slug: string; label?: string }>();
  private _counter = 0;

  /**
   * Construct the adapter over a fixed set of configured remote MCP servers.
   *
   * @param opts - Configured remote servers + optional reachability probe.
   */
  constructor(opts: RawMcpConnectorProviderOpts) {
    for (const server of opts.servers) this._servers.set(server.slug, server);
    this._isReachable = opts.isReachable ?? (() => true);
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      type: this.type,
      supportsMultiAccount: false,
      custody: 'external',
      exposesOverMcp: true,
      features: {},
    };
  }

  listToolkits(): Promise<ConnectorToolkit[]> {
    return Promise.resolve(
      [...this._servers.values()].map((server) => ({
        slug: server.slug,
        displayName: server.displayName,
        authKind: server.authKind ?? 'oauth2',
        // Single-account by construction — the primitive raw MCP cannot exceed.
        maxAccountsPerUser: 1,
      }))
    );
  }

  startConnect(toolkit: string, opts?: { label?: string }): Promise<ConnectStart> {
    const server = this._servers.get(toolkit);
    if (!server) {
      return Promise.reject(new Error(`unknown toolkit '${toolkit}'`));
    }
    if (this._accounts.has(accountIdForSlug(toolkit))) {
      // Single-account baseline: never a second account for one server.
      return Promise.reject(
        new Error(`'${toolkit}' is already connected (raw MCP is single-account)`)
      );
    }
    this._counter += 1;
    const flowId = `mcp-flow-${this._counter}`;
    this._flows.set(flowId, { slug: toolkit, label: opts?.label });
    // Reference-not-secret: return the server's authorize URL to open; the
    // remote server owns the OAuth 2.1 exchange and keeps its own tokens.
    return Promise.resolve({ authorizeUrl: server.connection.url, flowId });
  }

  pollConnect(flowId: string): Promise<ConnectPoll> {
    const flow = this._flows.get(flowId);
    if (!flow) {
      return Promise.resolve({ status: 'failed', error: `unknown flow '${flowId}'` });
    }
    const id = accountIdForSlug(flow.slug);
    if (!this._accounts.has(id)) {
      this._accounts.set(id, {
        id,
        provider: this.type,
        toolkit: flow.slug,
        label: flow.label ?? flow.slug,
        status: 'active',
        // External custody: DorkOS holds no tokens; the server manages sign-in.
        custody: 'external',
      });
    }
    return Promise.resolve({ status: 'connected', account: this._accounts.get(id) });
  }

  listAccounts(opts?: { toolkit?: string }): Promise<ConnectedAccount[]> {
    const all = [...this._accounts.values()];
    return Promise.resolve(opts?.toolkit ? all.filter((a) => a.toolkit === opts.toolkit) : all);
  }

  disconnect(accountId: ConnectedAccountId): Promise<void> {
    this._accounts.delete(accountId);
    this._flows.clear();
    return Promise.resolve();
  }

  async toolServerForAccount(
    accountId: ConnectedAccountId
  ): Promise<McpAppServerConnection | null> {
    const account = this._accounts.get(accountId);
    if (!account || account.status !== 'active') return null;
    const server = this._servers.get(account.toolkit);
    if (!server) return null;
    // Null (never a throw) when the remote server is momentarily unreachable —
    // the surfaced per-account warning path (spec §Detailed Design 3).
    const reachable = await this._isReachable(server.slug);
    if (!reachable) return null;
    return server.connection;
  }
}
