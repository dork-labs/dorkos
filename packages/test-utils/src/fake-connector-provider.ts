/**
 * In-memory {@link ConnectorProvider} for tests — the connector analogue of
 * {@link ./fake-agent-runtime.js | FakeAgentRuntime}. Backs the
 * `connectorConformance` suite and stands in as a scenario provider in server
 * tests, with no network and no persistence.
 *
 * Configurable to exercise both `supportsMultiAccount` true/false and each
 * custody class, so one fake covers the whole capability matrix.
 *
 * @module test-utils/fake-connector-provider
 */
import type {
  ConnectorExternalAccountRef,
  ConnectorCapabilities,
  ConnectorCustody,
  ConnectorProvider,
  ConnectorToolkit,
  ConnectPoll,
  ConnectStart,
  ProviderConnectedAccount,
} from '@dorkos/shared/connector-provider';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import type {
  ConnectorOperationRevision,
  ConnectorProviderExecuteCommand,
  ConnectorProviderInstanceId,
} from '@dorkos/shared/connector-schemas';

/** Construction options for {@link FakeConnectorProvider}. */
export interface FakeConnectorProviderOpts {
  /** Stable provider-instance identifier. */
  instanceId?: ConnectorProviderInstanceId;
  /** Backend type identifier. Defaults to `'fake-connector'`. */
  type?: string;
  /** Whether one user may hold N accounts of one toolkit. Defaults to `true`. */
  supportsMultiAccount?: boolean;
  /** Custody stance echoed onto every account. Defaults to `'managed'`. */
  custody?: ConnectorCustody;
  /** Whether accounts expose over MCP. Defaults to `true`. */
  exposesOverMcp?: boolean;
  /** Toolkits this fake can connect. Defaults to Gmail + Slack. */
  toolkits?: ConnectorToolkit[];
  /** Delay exact-account execution so cancellation after dispatch can be tested. */
  executeDelayMs?: number;
}

/** Default toolkit set — a multi-account service and a single common one. */
const DEFAULT_TOOLKITS: ConnectorToolkit[] = [
  { slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' },
  { slug: 'slack', displayName: 'Slack', authKind: 'oauth2' },
];

/** One pending connect flow, resolved to a stable account on first poll. */
interface FakeFlow {
  toolkit: string;
  label?: string;
  externalAccountRef?: ConnectorExternalAccountRef;
}

/**
 * A full in-memory {@link ConnectorProvider} for Vitest tests.
 *
 * Connect flows resolve synchronously on the first `pollConnect`. A
 * single-account fake (`supportsMultiAccount: false`) rejects a second connect
 * of an already-connected toolkit. `toolServerForAccount` returns a stub `http`
 * connection for `active` accounts and `null` otherwise — call
 * {@link setStatus} to drive an account into the null branch.
 *
 * @example
 * ```typescript
 * const provider = new FakeConnectorProvider({ supportsMultiAccount: false });
 * connectorConformance(() => new FakeConnectorProvider(), {
 *   makeUnexposableAccount: async () => {
 *     const p = new FakeConnectorProvider();
 *     const { flowId } = await p.startConnect('gmail');
 *     const { account } = await p.pollConnect(flowId);
 *     p.setStatus(account!.id, 'expired');
 *     return { provider: p, accountId: account!.id };
 *   },
 * });
 * ```
 */
export class FakeConnectorProvider implements ConnectorProvider {
  readonly instanceId: ConnectorProviderInstanceId;
  readonly type: string;

  private readonly _supportsMultiAccount: boolean;
  private readonly _custody: ConnectorCustody;
  private readonly _exposesOverMcp: boolean;
  private readonly _toolkits: ConnectorToolkit[];
  private readonly _executeDelayMs: number;

  private readonly _accounts = new Map<string, ProviderConnectedAccount>();
  private readonly _flows = new Map<string, FakeFlow>();
  private _counter = 0;

  /**
   * Construct a fake provider with the given capability configuration.
   *
   * @param opts - Capability configuration; see {@link FakeConnectorProviderOpts}.
   */
  constructor(opts: FakeConnectorProviderOpts = {}) {
    this.type = opts.type ?? 'fake-connector';
    this.instanceId =
      opts.instanceId ?? (`provider_instance_${this.type}` as ConnectorProviderInstanceId);
    this._supportsMultiAccount = opts.supportsMultiAccount ?? true;
    this._custody = opts.custody ?? 'managed';
    this._exposesOverMcp = opts.exposesOverMcp ?? true;
    this._toolkits = opts.toolkits ?? DEFAULT_TOOLKITS;
    this._executeDelayMs = opts.executeDelayMs ?? 0;
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      instanceId: this.instanceId,
      type: this.type,
      supportsMultiAccount: this._supportsMultiAccount,
      custody: this._custody,
      exposesOverMcp: this._exposesOverMcp,
      capabilities: {
        catalog: { status: 'available' },
        authentication: { status: 'available' },
        accounts: { status: 'available' },
        operations: { status: 'available' },
        execution: { status: 'available' },
        triggers: { status: 'unsupported', reason: 'Fake trigger support is disabled.' },
      },
      features: {},
    };
  }

  listToolkitPage(request: { cursor?: string; query?: string; limit: number }) {
    const offset = request.cursor ? Number(request.cursor) : 0;
    const matching = request.query
      ? this._toolkits.filter((toolkit) =>
          toolkit.displayName.toLowerCase().includes(request.query!.toLowerCase())
        )
      : this._toolkits;
    const toolkits = matching.slice(offset, offset + request.limit);
    const next = offset + toolkits.length;
    return Promise.resolve({
      status: 'ok' as const,
      toolkits,
      ...(next < matching.length && { nextCursor: String(next) }),
      truncated: next < matching.length,
    });
  }

  listOperationSchemas(request: { toolkit: string; cursor?: string; limit: number }) {
    const operations: Omit<ConnectorOperationRevision, 'id' | 'discoveredAt'>[] = [
      {
        providerInstanceId: this.instanceId,
        toolkit: request.toolkit,
        operationSlug: `${request.toolkit}.read`,
        toolkitVersion: '2026-09-01',
        schemaHash: 'sha256:fake-read-v1',
        capabilityClassification: 'read',
        inputSchema: { type: 'object', additionalProperties: false },
      },
      {
        providerInstanceId: this.instanceId,
        toolkit: request.toolkit,
        operationSlug: `${request.toolkit}.write`,
        toolkitVersion: '2026-09-01',
        schemaHash: 'sha256:fake-write-v1',
        capabilityClassification: 'write',
        inputSchema: { type: 'object', additionalProperties: false },
      },
    ];
    const offset = request.cursor ? Number(request.cursor) : 0;
    const page = operations.slice(offset, offset + request.limit);
    const next = offset + page.length;
    return Promise.resolve({
      status: 'ok' as const,
      page: {
        operations: page,
        ...(next < operations.length && { nextCursor: String(next) }),
        truncated: next < operations.length,
      },
    });
  }

  async execute(command: ConnectorProviderExecuteCommand) {
    if (command.signal.aborted) {
      return { status: 'error' as const, code: 'aborted', message: 'Aborted' };
    }
    if (this._executeDelayMs > 0) {
      const aborted = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), this._executeDelayMs);
        command.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          { once: true }
        );
      });
      if (aborted) return { status: 'error' as const, code: 'aborted', message: 'Aborted' };
    }
    if (!this._accounts.has(command.externalAccountRef)) {
      return {
        status: 'error' as const,
        code: 'account_not_found',
        message: 'Account not found',
      };
    }
    return {
      status: 'success' as const,
      data: { operation: command.operation.operationSlug, arguments: command.arguments },
      providerLogId: `fake-log-${command.attemptId}`,
    };
  }

  listTriggerTypes(_toolkit: string) {
    return Promise.resolve({
      status: 'unsupported' as const,
      reason: 'Fake trigger support is disabled.',
    });
  }

  listToolkits(): Promise<ConnectorToolkit[]> {
    return Promise.resolve([...this._toolkits]);
  }

  startConnect(toolkit: string, opts?: { label?: string }): Promise<ConnectStart> {
    if (!this._toolkits.some((tk) => tk.slug === toolkit)) {
      return Promise.reject(new Error(`unknown toolkit '${toolkit}'`));
    }
    if (!this._supportsMultiAccount && this._activeForToolkit(toolkit)) {
      // Single-account backend: a second connect of an already-connected
      // toolkit rejects rather than minting a duplicate account.
      return Promise.reject(new Error(`'${toolkit}' already connected (single-account backend)`));
    }
    this._counter += 1;
    const flowId = `fake-flow-${this._counter}`;
    this._flows.set(flowId, { toolkit, label: opts?.label });
    return Promise.resolve({
      authorizeUrl: `https://fake.connect/${toolkit}?flow=${flowId}`,
      flowId,
    });
  }

  pollConnect(flowId: string): Promise<ConnectPoll> {
    const flow = this._flows.get(flowId);
    if (!flow) {
      return Promise.resolve({ status: 'failed', error: `unknown flow '${flowId}'` });
    }
    // Resolve to a stable account: re-polling the same flow yields the same one.
    if (!flow.externalAccountRef) {
      this._counter += 1;
      const externalAccountRef =
        `${this.type}:${flow.toolkit}:${this._counter}` as ConnectorExternalAccountRef;
      this._accounts.set(externalAccountRef, {
        externalAccountRef,
        toolkit: flow.toolkit,
        label: flow.label ?? `${flow.toolkit}@fake`,
        status: 'active',
        custody: this._custody,
      });
      flow.externalAccountRef = externalAccountRef;
    }
    return Promise.resolve({
      status: 'connected',
      account: this._accounts.get(flow.externalAccountRef),
    });
  }

  listAccounts(opts?: { toolkit?: string }): Promise<ProviderConnectedAccount[]> {
    const all = [...this._accounts.values()];
    return Promise.resolve(opts?.toolkit ? all.filter((a) => a.toolkit === opts.toolkit) : all);
  }

  disconnect(externalAccountRef: ConnectorExternalAccountRef): Promise<void> {
    this._accounts.delete(externalAccountRef);
    return Promise.resolve();
  }

  toolServerForAccount(
    externalAccountRef: ConnectorExternalAccountRef
  ): Promise<McpAppServerConnection | null> {
    const account = this._accounts.get(externalAccountRef);
    if (!account || account.status !== 'active' || !this._exposesOverMcp) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      transport: 'http' as const,
      url: `https://fake.mcp/${account.toolkit}/${externalAccountRef}`,
      headers: {},
    });
  }

  /**
   * Force an account's status — the test hook that drives the null branch of
   * {@link toolServerForAccount} (an `expired`/`revoked` account resolves null).
   *
   * @param accountId - The account to mutate.
   * @param status - The status to set.
   */
  setStatus(
    externalAccountRef: ConnectorExternalAccountRef,
    status: ProviderConnectedAccount['status']
  ): void {
    const account = this._accounts.get(externalAccountRef);
    if (account) account.status = status;
  }

  /** True when an active account already exists for `toolkit`. */
  private _activeForToolkit(toolkit: string): boolean {
    return [...this._accounts.values()].some((a) => a.toolkit === toolkit && a.status === 'active');
  }
}
