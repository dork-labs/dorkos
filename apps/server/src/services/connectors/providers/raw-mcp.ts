/**
 * The raw-MCP baseline {@link ConnectorProvider} — the single-account,
 * no-custody adapter that connects a DorkOS agent to a preconfigured remote MCP
 * server. It retains the configured transport inside the provider boundary for
 * connection probes; exact operation execution remains typed unsupported.
 *
 * Capabilities: `type: 'mcp'`, `supportsMultiAccount: false`,
 * `custody: 'external'`. Custody is `external` because
 * the gateway keeps no tokens. This adapter neither runs OAuth nor persists a
 * secret. Each configured server maps to at most one account.
 *
 * See spec `specs/connector-gateway/02-specification.md` §Detailed Design 1 and
 * §Non-Goals (baseline = single-account).
 *
 * @module services/connectors/providers/raw-mcp
 */
import { randomUUID } from 'node:crypto';
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
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
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
  /** The remote connection used only inside this provider's probe boundary. */
  connection: RemoteMcpConnection;
  /** How the preconfigured connection authenticates. Defaults to `'none'`. */
  authKind?: ConnectorToolkit['authKind'];
}

/** Nonsecret canonical authentication row selected inside the server boundary. */
export interface RawMcpPendingConnect {
  /** Stable public flow identity; never reconstructed from the private handle. */
  authenticationFlowId: string;
  /** Original owner identity, retained in the comparison across the probe. */
  ownerKind: 'user' | 'local_install';
  ownerId: string;
  /** Exact registered provider configuration. */
  providerInstanceId: string;
  executionConfigGeneration: number;
  /** Random private selector, never a URL or encoded credentials. */
  providerFlowId: string;
  /** Configured server and original owner label. */
  toolkit: string;
  label: string | null;
  /** Original immutable request and lifetime. */
  requestHash: string;
  reconnectConnectionId: string | null;
  expiresAt: string;
}

/** Server-private lookup; the caller must supply the exact registered provider object. */
export type RawMcpPendingConnectResolver = (
  provider: RawMcpConnectorProvider,
  providerFlowId: string
) => RawMcpPendingConnect | undefined;

/** Construction options for {@link RawMcpConnectorProvider}. */
export interface RawMcpConnectorProviderOpts {
  /** The remote MCP servers this adapter exposes as toolkits. */
  servers: RawMcpServerDescriptor[];
  /** Required canonical lookup; missing authority never falls back to memory. */
  resolvePendingConnect: RawMcpPendingConnectResolver;
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

/** Maximum concurrent probes and retained derived results; pending authority lives in SQLite. */
const MAX_CONNECT_FLOWS = 100;

/** One raw-MCP connect flow, including its single-flight and terminal poll result. */
interface RawMcpFlow {
  /** Exact durable snapshot admitted before the probe. */
  binding: RawMcpPendingConnect;
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
 * configured server yields at most one connected account. Re-verification uses
 * the same private account identity, including after process reconstruction.
 */
export class RawMcpConnectorProvider implements ConnectorProvider {
  readonly instanceId: ConnectorProviderInstanceId;
  readonly type = 'mcp';

  private readonly _servers = new Map<string, RawMcpServerDescriptor>();
  private readonly _probe: (connection: RemoteMcpConnection) => Promise<ProbeOutcome>;
  /** Accounts keyed by their opaque id; the derived registry, held in memory. */
  private readonly _accounts = new Map<string, ProviderConnectedAccount>();
  /** Derived single-flight/results only; eviction cannot delete durable consent. */
  private readonly _checks = new Map<string, RawMcpFlow>();
  private readonly _resolvePendingConnect: RawMcpPendingConnectResolver;

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
    this._resolvePendingConnect = opts.resolvePendingConnect;
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
          reason: 'Raw MCP does not expose trusted exact-revision operations to the broker.',
        },
        triggers: { status: 'unsupported', reason: 'Raw MCP trigger discovery is unavailable.' },
      },
      features: {},
    };
  }

  async listToolkitPage(request: {
    cursor?: string;
    query?: string;
    limit: number;
    signal: AbortSignal;
  }) {
    request.signal.throwIfAborted();
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

  async resolveToolkitVersion(_toolkit: string, _signal: AbortSignal) {
    _signal.throwIfAborted();
    return Promise.resolve({
      status: 'unsupported' as const,
      reason: 'Raw MCP does not expose a trusted immutable toolkit version.',
    });
  }

  async listOperationSchemas(_request: {
    toolkit: string;
    toolkitVersion: string;
    cursor?: string;
    limit: number;
    signal: AbortSignal;
  }) {
    _request.signal.throwIfAborted();
    return Promise.resolve({
      status: 'unsupported' as const,
      reason: 'Raw MCP has no trustworthy operation schema catalog.',
    });
  }

  execute(_command: ConnectorProviderExecuteCommand) {
    return Promise.resolve({
      status: 'unsupported' as const,
      reason: 'Raw MCP does not expose trusted exact-revision operations to the broker.',
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

  startConnect(toolkit: string, _opts?: { label?: string }): Promise<ConnectStart> {
    const server = this._servers.get(toolkit);
    if (!server) {
      return Promise.reject(new Error(`unknown toolkit '${toolkit}'`));
    }
    if (!this._makeRoomForFlow()) {
      return Promise.reject(
        new Error('Too many MCP connection checks are already in progress. Try again shortly.')
      );
    }
    const flowId = `raw-mcp:v1:${randomUUID()}`;
    // This adapter has no OAuth exchange and therefore no consent URL. The
    // configured connection is verified directly when the caller polls.
    return Promise.resolve({ flowId });
  }

  /** Keep flow bookkeeping bounded without cancelling a probe already on the wire. */
  private _makeRoomForFlow(): boolean {
    if (this._checks.size < MAX_CONNECT_FLOWS) return true;
    for (const [flowId, flow] of this._checks) {
      if (!flow.inFlight) {
        this._checks.delete(flowId);
        return true;
      }
    }
    return false;
  }

  async pollConnect(flowId: string): Promise<ConnectPoll> {
    const binding = this._resolveBinding(flowId);
    if (!binding) return { status: 'failed', error: PROBE_FAILURE.cancelled };
    let flow = this._checks.get(flowId);
    if (flow && JSON.stringify(flow.binding) !== JSON.stringify(binding)) {
      return { status: 'failed', error: PROBE_FAILURE.cancelled };
    }
    if (flow?.result) return flow.result;
    if (flow?.inFlight) return flow.inFlight;
    if (!this._makeRoomForFlow()) {
      return {
        status: 'failed',
        error: 'Too many MCP connection checks are already in progress. Try again shortly.',
      };
    }
    flow = { binding };
    this._checks.set(flowId, flow);
    const current = flow;
    const verification = this._verifyFlow(flowId, current).then((result) => {
      current.result = result;
      current.inFlight = undefined;
      return result;
    });
    flow.inFlight = verification;
    return verification;
  }

  /** Resolve only a canonical, currently live UUID selector; lookup errors fail closed. */
  private _resolveBinding(flowId: string): RawMcpPendingConnect | undefined {
    if (
      !/^raw-mcp:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        flowId
      )
    )
      return undefined;
    try {
      const binding = this._resolvePendingConnect(this, flowId);
      return binding?.providerFlowId === flowId &&
        binding.providerInstanceId === this.instanceId &&
        this._servers.has(binding.toolkit)
        ? binding
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Verify one flow before creating its active account. */
  private async _verifyFlow(flowId: string, flow: RawMcpFlow): Promise<ConnectPoll> {
    const server = this._servers.get(flow.binding.toolkit);
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
    if (
      this._checks.get(flowId) !== flow ||
      JSON.stringify(this._resolveBinding(flowId)) !== JSON.stringify(flow.binding)
    ) {
      return { status: 'failed', error: PROBE_FAILURE.cancelled };
    }

    const externalAccountRef = accountIdForSlug(flow.binding.toolkit);
    const account = {
      externalAccountRef,
      toolkit: flow.binding.toolkit,
      label: flow.binding.label ?? flow.binding.toolkit,
      status: 'active',
      custody: 'external',
    } satisfies ProviderConnectedAccount;
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
      for (const [flowId, flow] of this._checks) {
        if (flow.binding.toolkit === toolkit) this._checks.delete(flowId);
      }
    }
    return Promise.resolve();
  }
}
