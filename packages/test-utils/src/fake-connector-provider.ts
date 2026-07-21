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
  ConnectedAccount,
  ConnectedAccountId,
  ConnectedAccountStatus,
  ConnectorCapabilities,
  ConnectorCustody,
  ConnectorProvider,
  ConnectorToolkit,
  ConnectPoll,
  ConnectStart,
} from '@dorkos/shared/connector-provider';

/** Construction options for {@link FakeConnectorProvider}. */
export interface FakeConnectorProviderOpts {
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
  accountId?: ConnectedAccountId;
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
  readonly type: string;

  private readonly _supportsMultiAccount: boolean;
  private readonly _custody: ConnectorCustody;
  private readonly _exposesOverMcp: boolean;
  private readonly _toolkits: ConnectorToolkit[];

  private readonly _accounts = new Map<string, ConnectedAccount>();
  private readonly _flows = new Map<string, FakeFlow>();
  private _counter = 0;

  /**
   * Construct a fake provider with the given capability configuration.
   *
   * @param opts - Capability configuration; see {@link FakeConnectorProviderOpts}.
   */
  constructor(opts: FakeConnectorProviderOpts = {}) {
    this.type = opts.type ?? 'fake-connector';
    this._supportsMultiAccount = opts.supportsMultiAccount ?? true;
    this._custody = opts.custody ?? 'managed';
    this._exposesOverMcp = opts.exposesOverMcp ?? true;
    this._toolkits = opts.toolkits ?? DEFAULT_TOOLKITS;
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      type: this.type,
      supportsMultiAccount: this._supportsMultiAccount,
      custody: this._custody,
      exposesOverMcp: this._exposesOverMcp,
      features: {},
    };
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
    if (!flow.accountId) {
      this._counter += 1;
      const id = `${this.type}:${flow.toolkit}:${this._counter}` as ConnectedAccountId;
      this._accounts.set(id, {
        id,
        provider: this.type,
        toolkit: flow.toolkit,
        label: flow.label ?? `${flow.toolkit}@fake`,
        status: 'active',
        custody: this._custody,
      });
      flow.accountId = id;
    }
    return Promise.resolve({ status: 'connected', account: this._accounts.get(flow.accountId) });
  }

  listAccounts(opts?: { toolkit?: string }): Promise<ConnectedAccount[]> {
    const all = [...this._accounts.values()];
    return Promise.resolve(opts?.toolkit ? all.filter((a) => a.toolkit === opts.toolkit) : all);
  }

  disconnect(accountId: ConnectedAccountId): Promise<void> {
    this._accounts.delete(accountId);
    return Promise.resolve();
  }

  toolServerForAccount(accountId: ConnectedAccountId) {
    const account = this._accounts.get(accountId);
    if (!account || account.status !== 'active' || !this._exposesOverMcp) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      transport: 'http' as const,
      url: `https://fake.mcp/${account.toolkit}/${accountId}`,
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
  setStatus(accountId: ConnectedAccountId, status: ConnectedAccountStatus): void {
    const account = this._accounts.get(accountId);
    if (account) account.status = status;
  }

  /** True when an active account already exists for `toolkit`. */
  private _activeForToolkit(toolkit: string): boolean {
    return [...this._accounts.values()].some((a) => a.toolkit === toolkit && a.status === 'active');
  }
}
