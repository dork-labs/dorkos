/**
 * The raw-MCP baseline {@link ConnectorProvider} — the single-account,
 * no-custody adapter that connects a DorkOS agent to a preconfigured remote MCP
 * server. It is the first connector to land because it exercises the whole
 * `ConnectorProvider` seam against machinery that already exists
 * (`McpAppServerConnection` / the runtime MCP seam), with no vendor dependency.
 *
 * Capabilities: `type: 'mcp'`, `supportsMultiAccount: false`,
 * `custody: 'external'`, `exposesOverMcp: true`. Custody is `external` because
 * the gateway keeps no tokens. This adapter neither runs OAuth nor persists a
 * secret. Each configured server maps to at most one account.
 *
 * See spec `specs/connector-gateway/02-specification.md` §Detailed Design 1 and
 * §Non-Goals (baseline = single-account).
 *
 * @module services/connectors/providers/raw-mcp
 */
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import type {
  ConnectorCapabilities,
  ConnectorExternalAccountRef,
  ConnectorProvider,
  ConnectorProviderInstanceId,
  ConnectorToolkit,
  ConnectPoll,
  ConnectStart,
  ProviderConnectedAccount,
} from '@dorkos/shared/connector-provider';
import type { ConnectorProviderExecuteCommand } from '@dorkos/shared/connector-schemas';
import { legacyDefaultProviderInstanceId } from '../legacy-connection-migration.js';
import { runProbe, type ProbeOutcome } from '../../mesh/agent-mcp-probe.js';

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
  /** How the preconfigured connection authenticates. Defaults to `'none'`. */
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
  /** Stable configured provider instance id. */
  instanceId?: ConnectorProviderInstanceId;
  /**
   * MCP initialize + tools/list probe. Production uses the shared real-client
   * probe; tests may replace it without changing the provider's decisions.
   *
   * @param connection - The exact connection a runtime would receive, including headers.
   */
  probe?: (connection: RemoteMcpConnection) => Promise<ProbeOutcome>;
}

/** Safe failure copy. Probe errors may contain URLs, headers, or vendor response bodies. */
const PROBE_FAILURE = {
  unauthorized: 'The MCP server rejected the configured credentials. Check them and try again.',
  timeout: 'The MCP server did not respond before the connection check timed out. Try again.',
  failed:
    'DorkOS could not verify the MCP server. Check its address and availability, then try again.',
  cancelled: 'This connection check is no longer active. Start again to retry.',
} as const;

/** Prefix emitted by the shared probe when its bounded round trip expires. */
const PROBE_TIMEOUT_PREFIX = 'MCP server probe timed out after ';

/** Maximum retained flow records; old inactive flows are evicted before new work starts. */
const MAX_CONNECT_FLOWS = 100;

/** One raw-MCP connect flow, including its single-flight and terminal poll result. */
interface RawMcpFlow {
  /** Toolkit being verified. */
  slug: string;
  /** Optional account label requested by the caller. */
  label?: string;
  /** Shared work for concurrent polls. */
  inFlight?: Promise<ConnectPoll>;
  /** Cached terminal result, which makes repeat polls idempotent. */
  result?: ConnectPoll;
}

/** Deterministic single account id for one configured server. */
function accountIdForSlug(slug: string): ConnectorExternalAccountRef {
  return `mcp:${slug}` as ConnectorExternalAccountRef;
}

/**
 * Baseline connector for remote MCP servers. Single-account by construction: a
 * configured server yields at most one connected account, and a second connect
 * of an already-connected toolkit rejects rather than duplicating.
 */
export class RawMcpConnectorProvider implements ConnectorProvider {
  readonly instanceId: ConnectorProviderInstanceId;
  readonly type = 'mcp';

  private readonly _servers = new Map<string, RawMcpServerDescriptor>();
  private readonly _isReachable: (slug: string) => boolean | Promise<boolean>;
  private readonly _probe: (connection: RemoteMcpConnection) => Promise<ProbeOutcome>;
  /** Accounts keyed by their opaque id; the derived registry, held in memory. */
  private readonly _accounts = new Map<string, ProviderConnectedAccount>();
  /** Pending connect flows keyed by opaque flow id. */
  private readonly _flows = new Map<string, RawMcpFlow>();
  private _counter = 0;

  /**
   * Construct the adapter over a fixed set of configured remote MCP servers.
   *
   * @param opts - Configured remote servers + optional reachability probe.
   */
  constructor(opts: RawMcpConnectorProviderOpts) {
    this.instanceId =
      opts.instanceId ??
      (legacyDefaultProviderInstanceId(this.type) as ConnectorProviderInstanceId);
    for (const server of opts.servers) this._servers.set(server.slug, server);
    this._isReachable = opts.isReachable ?? (() => true);
    this._probe =
      opts.probe ??
      ((connection) => runProbe({ ...connection, headers: connection.headers ?? {} }));
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      instanceId: this.instanceId,
      type: this.type,
      supportsMultiAccount: false,
      custody: 'external',
      exposesOverMcp: true,
      capabilities: {
        catalog: { status: 'available' },
        authentication: { status: 'available' },
        accounts: { status: 'available' },
        operations: {
          status: 'unsupported',
          reason: 'Raw MCP has no trustworthy operation schema catalog.',
        },
        execution: {
          status: 'unsupported',
          reason: 'Raw MCP remains on the compatibility exposure seam until P2.',
        },
        triggers: { status: 'unsupported', reason: 'Raw MCP trigger discovery is unavailable.' },
      },
      features: {},
    };
  }

  async listToolkitPage(request: { cursor?: string; query?: string; limit: number }) {
    const all = (await this.listToolkits()).filter((toolkit) =>
      request.query ? toolkit.displayName.toLowerCase().includes(request.query.toLowerCase()) : true
    );
    const offset = request.cursor ? Number(request.cursor) : 0;
    const toolkits = all.slice(offset, offset + request.limit);
    const next = offset + toolkits.length;
    return {
      status: 'ok' as const,
      toolkits,
      ...(next < all.length && { nextCursor: String(next) }),
      truncated: next < all.length,
    };
  }

  listOperationSchemas(_request: { toolkit: string; cursor?: string; limit: number }) {
    return Promise.resolve({
      status: 'unsupported' as const,
      reason: 'Raw MCP has no trustworthy operation schema catalog.',
    });
  }

  execute(_command: ConnectorProviderExecuteCommand) {
    return Promise.resolve({
      status: 'unsupported' as const,
      reason: 'Raw MCP remains on the compatibility exposure seam until P2.',
    });
  }

  listTriggerTypes(_toolkit: string) {
    return Promise.resolve({
      status: 'unsupported' as const,
      reason: 'Raw MCP trigger discovery is unavailable.',
    });
  }

  listToolkits(): Promise<ConnectorToolkit[]> {
    return Promise.resolve(
      [...this._servers.values()].map((server) => ({
        slug: server.slug,
        displayName: server.displayName,
        authKind: server.authKind ?? 'none',
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
    if (!this._makeRoomForFlow()) {
      return Promise.reject(
        new Error('Too many MCP connection checks are already in progress. Try again shortly.')
      );
    }
    this._counter += 1;
    const flowId = `mcp-flow-${this._counter}`;
    this._flows.set(flowId, { slug: toolkit, label: opts?.label });
    // This adapter has no OAuth exchange and therefore no consent URL. The
    // configured connection is verified directly when the caller polls.
    return Promise.resolve({ flowId });
  }

  /** Keep flow bookkeeping bounded without cancelling a probe already on the wire. */
  private _makeRoomForFlow(): boolean {
    if (this._flows.size < MAX_CONNECT_FLOWS) return true;
    for (const [flowId, flow] of this._flows) {
      if (!flow.inFlight) {
        this._flows.delete(flowId);
        return true;
      }
    }
    return false;
  }

  async pollConnect(flowId: string): Promise<ConnectPoll> {
    const flow = this._flows.get(flowId);
    if (!flow) {
      return { status: 'failed', error: `unknown flow '${flowId}'` };
    }
    if (flow.result) return flow.result;
    if (flow.inFlight) return flow.inFlight;

    const verification = this._verifyFlow(flowId, flow).then((result) => {
      flow.result = result;
      flow.inFlight = undefined;
      return result;
    });
    flow.inFlight = verification;
    return verification;
  }

  /** Verify one flow before creating its active account. */
  private async _verifyFlow(flowId: string, flow: RawMcpFlow): Promise<ConnectPoll> {
    const server = this._servers.get(flow.slug);
    if (!server) return { status: 'failed', error: PROBE_FAILURE.failed };

    const outcome = await this._probe(server.connection).catch((): ProbeOutcome => ({
      kind: 'failed',
      error: 'probe rejected',
    }));
    if (outcome.kind === 'unauthorized') {
      return { status: 'failed', error: PROBE_FAILURE.unauthorized };
    }
    if (outcome.kind === 'failed') {
      const error = outcome.error.startsWith(PROBE_TIMEOUT_PREFIX)
        ? PROBE_FAILURE.timeout
        : PROBE_FAILURE.failed;
      return { status: 'failed', error };
    }
    // Disconnect removes every flow for the account's toolkit. A probe that
    // was already in flight must observe that cancellation before it can write
    // the account back and undo the disconnect.
    if (this._flows.get(flowId) !== flow) {
      return { status: 'failed', error: PROBE_FAILURE.cancelled };
    }

    const externalAccountRef = accountIdForSlug(flow.slug);
    const account =
      this._accounts.get(externalAccountRef) ??
      ({
        externalAccountRef,
        toolkit: flow.slug,
        label: flow.label ?? flow.slug,
        status: 'active',
        custody: 'external',
      } satisfies ProviderConnectedAccount);
    this._accounts.set(externalAccountRef, account);
    return { status: 'connected', account };
  }

  listAccounts(opts?: { toolkit?: string }): Promise<ProviderConnectedAccount[]> {
    const all = [...this._accounts.values()];
    return Promise.resolve(opts?.toolkit ? all.filter((a) => a.toolkit === opts.toolkit) : all);
  }

  disconnect(accountId: ConnectorExternalAccountRef): Promise<void> {
    const account = this._accounts.get(accountId);
    this._accounts.delete(accountId);
    // A repeated disconnect can arrive while a reconnect has no account row
    // yet. Raw MCP's private reference has the `mcp:<toolkit>` shape, so
    // it can still cancel only that toolkit's flows without guessing from a
    // public DorkOS connection id. Flows for other toolkits remain active.
    const toolkit =
      account?.toolkit ??
      (accountId.startsWith('mcp:') && accountId.length > 'mcp:'.length
        ? accountId.slice('mcp:'.length)
        : undefined);
    if (toolkit && accountIdForSlug(toolkit) === accountId) {
      for (const [flowId, flow] of this._flows) {
        if (flow.slug === toolkit) this._flows.delete(flowId);
      }
    }
    return Promise.resolve();
  }

  async toolServerForAccount(
    accountId: ConnectorExternalAccountRef
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
