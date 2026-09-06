/**
 * The test-mode {@link ConnectorProvider} — the scripted backend the Playwright
 * suite drives end to end (connector-completion spec §Detailed Design 8, task
 * E1). Server source on purpose, exactly like `TestModeRuntime`: it must run
 * inside the real server so the browser exercises the real routes, but it is
 * dynamic-imported and wired ONLY when `env.DORKOS_TEST_RUNTIME` is set, so the
 * production module graph never loads it.
 *
 * Behavior, all scripted and offline:
 * - Toolkits: Gmail + Slack (`oauth2`), multi-account with labels.
 * - Connect flows succeed instantly: the authorize URL points at the local
 *   no-op page `GET /api/test/connect-approved` (mounted by `test-control.ts`,
 *   test mode only), and the first poll resolves `connected` — so the browser
 *   walks the REAL consent sequence (disclosure → open link → poll → account)
 *   with no vendor involved.
 * - Exact account execution returns deterministic, secret-free data so owner
 *   reconciliation and brokered execution can be proved without a vendor.
 *
 * The provider is credential-gated like the real backends: the bootstrapper
 * registers it only after a key is saved for provider type `test-connector` via
 * `PUT /api/connectors/providers/test-connector/credential`, so the e2e
 * exercises the real save-key step ({@link maybeCreateTestModeConnectorProvider}).
 *
 * @module services/connectors/providers/test-mode
 */
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
import type { CredentialProvider } from '../../core/credential-provider.js';
import { TEST_CONNECTOR_API_KEY_REF, TEST_CONNECTOR_PROVIDER_TYPE } from '../bootstrap.js';
import { legacyDefaultProviderInstanceId } from '../legacy-connection-migration.js';

/** The scripted services the test backend can connect. */
const TEST_TOOLKITS: ConnectorToolkit[] = [
  { slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' },
  { slug: 'slack', displayName: 'Slack', authKind: 'oauth2' },
];

/** Trusted concrete catalog versions served by the deterministic provider. */
const TEST_TOOLKIT_VERSIONS: Record<string, string> = {
  gmail: '2026-09-01',
  slack: '2026-08-15',
};

/** Offline operation metadata used by real reconciliation and execution routes. */
const TEST_OPERATIONS = {
  gmail: [
    {
      operationSlug: 'gmail.messages.list',
      schemaHash: 'test-gmail-list-v1',
      capabilityClassification: 'read' as const,
      retryPolicy: 'never' as const,
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    },
    {
      operationSlug: 'gmail.messages.send',
      schemaHash: 'test-gmail-send-v1',
      capabilityClassification: 'write' as const,
      retryPolicy: 'provider_idempotency_key' as const,
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
        },
        required: ['to'],
      },
    },
    {
      operationSlug: 'gmail.messages.delete',
      schemaHash: 'test-gmail-delete-v1',
      capabilityClassification: 'destructive' as const,
      retryPolicy: 'never' as const,
      inputSchema: {
        type: 'object',
        properties: { messageId: { type: 'string' } },
        required: ['messageId'],
      },
    },
  ],
  slack: [
    {
      operationSlug: 'slack.messages.list',
      schemaHash: 'test-slack-list-v1',
      capabilityClassification: 'read' as const,
      retryPolicy: 'never' as const,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      operationSlug: 'slack.messages.send',
      schemaHash: 'test-slack-send-v1',
      capabilityClassification: 'write' as const,
      retryPolicy: 'provider_idempotency_key' as const,
      inputSchema: {
        type: 'object',
        properties: { channel: { type: 'string' }, text: { type: 'string' } },
        required: ['channel', 'text'],
      },
    },
  ],
} as const;

/** One in-flight connect flow, resolved to a stable account on first poll. */
interface TestFlow {
  toolkit: string;
  label?: string;
  accountId?: ConnectorExternalAccountRef;
}

/** Construction options for {@link TestModeConnectorProvider}. */
export interface TestModeConnectorProviderOpts {
  /**
   * The local server origin (e.g. `http://127.0.0.1:4243`) the authorize URL
   * and the stub tool-server URL point at — everything stays on-machine.
   */
  localOrigin: string;
  /** Stable configured provider instance id. */
  instanceId?: ConnectorProviderInstanceId;
}

/**
 * The scripted, in-memory connector backend for `DORKOS_TEST_RUNTIME` servers.
 * Passes `connectorConformance`; see the module docs for the behavior script.
 */
export class TestModeConnectorProvider implements ConnectorProvider {
  readonly instanceId: ConnectorProviderInstanceId;
  readonly type = TEST_CONNECTOR_PROVIDER_TYPE;

  private readonly _localOrigin: string;
  private readonly _accounts = new Map<string, ProviderConnectedAccount>();
  private readonly _flows = new Map<string, TestFlow>();
  private _counter = 0;

  /**
   * Construct the scripted provider.
   *
   * @param opts - The local origin its URLs point at; see {@link TestModeConnectorProviderOpts}.
   */
  constructor(opts: TestModeConnectorProviderOpts) {
    this._localOrigin = opts.localOrigin;
    this.instanceId =
      opts.instanceId ??
      (legacyDefaultProviderInstanceId(this.type) as ConnectorProviderInstanceId);
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      instanceId: this.instanceId,
      type: this.type,
      supportsMultiAccount: true,
      custody: 'managed',
      capabilities: {
        catalog: { status: 'available' },
        authentication: { status: 'available' },
        accounts: { status: 'available' },
        operations: { status: 'available' },
        execution: { status: 'available' },
        triggers: { status: 'unsupported', reason: 'Test mode triggers are unavailable.' },
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

  async resolveToolkitVersion(toolkit: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const toolkitVersion = TEST_TOOLKIT_VERSIONS[toolkit];
    if (!toolkitVersion) {
      return { status: 'unsupported' as const, reason: `Unknown test service '${toolkit}'.` };
    }
    return { status: 'ok' as const, toolkit, toolkitVersion };
  }

  async listOperationSchemas(request: {
    toolkit: string;
    toolkitVersion: string;
    cursor?: string;
    limit: number;
    signal: AbortSignal;
  }) {
    request.signal.throwIfAborted();
    const expectedVersion = TEST_TOOLKIT_VERSIONS[request.toolkit];
    const definitions = TEST_OPERATIONS[request.toolkit as keyof typeof TEST_OPERATIONS];
    if (!expectedVersion || expectedVersion !== request.toolkitVersion || !definitions) {
      return {
        status: 'unsupported' as const,
        reason: 'The requested test catalog version is unavailable.',
      };
    }
    const offset = request.cursor ? Number(request.cursor) : 0;
    const pageDefinitions = definitions.slice(offset, offset + request.limit);
    const next = offset + pageDefinitions.length;
    return {
      status: 'ok' as const,
      page: {
        operations: pageDefinitions.map((definition) => ({
          providerInstanceId: this.instanceId,
          toolkit: request.toolkit,
          toolkitVersion: request.toolkitVersion,
          ...definition,
        })),
        ...(next < definitions.length && { nextCursor: String(next) }),
        truncated: next < definitions.length,
      },
    };
  }

  async execute(command: ConnectorProviderExecuteCommand) {
    if (command.signal.aborted) {
      return {
        status: 'cancelled' as const,
        code: 'CANCELLED_BEFORE_DISPATCH' as const,
        message: 'The test operation was cancelled before it was sent.',
      };
    }
    const account = this._accounts.get(command.externalAccountRef);
    const version = TEST_TOOLKIT_VERSIONS[command.operation.toolkit];
    const definitions =
      TEST_OPERATIONS[command.operation.toolkit as keyof typeof TEST_OPERATIONS] ?? [];
    const definition = definitions.find(
      (candidate) => candidate.operationSlug === command.operation.operationSlug
    );
    if (
      !account ||
      account.status !== 'active' ||
      account.toolkit !== command.operation.toolkit ||
      command.operation.providerInstanceId !== this.instanceId ||
      command.operation.toolkitVersion !== version ||
      !definition ||
      definition.schemaHash !== command.operation.schemaHash ||
      definition.capabilityClassification !== command.operation.capabilityClassification
    ) {
      return {
        status: 'error' as const,
        code: 'TEST_OPERATION_MISMATCH',
        message: 'The test account and exact operation revision did not match.',
        retryable: false,
      };
    }
    if (!(await command.authorizeDispatch())) {
      return {
        status: 'error' as const,
        code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH',
        message: 'Access changed before the operation was sent.',
        retryable: false,
      };
    }
    return {
      status: 'success' as const,
      data: {
        ok: true,
        operation: command.operation.operationSlug,
        accountLabel: account.label,
      },
      providerLogId: `test-log-${command.attemptId}`,
    };
  }

  listTriggerTypes(_toolkit: string) {
    return Promise.resolve({
      status: 'unsupported' as const,
      reason: 'Test mode triggers are unavailable.',
    });
  }

  listToolkits(): Promise<ConnectorToolkit[]> {
    return Promise.resolve([...TEST_TOOLKITS]);
  }

  startConnect(toolkit: string, opts?: { label?: string }): Promise<ConnectStart> {
    if (!TEST_TOOLKITS.some((tk) => tk.slug === toolkit)) {
      return Promise.reject(new Error(`unknown toolkit '${toolkit}'`));
    }
    this._counter += 1;
    const flowId = `test-flow-${this._counter}`;
    this._flows.set(flowId, { toolkit, ...(opts?.label !== undefined && { label: opts.label }) });
    return Promise.resolve({
      // The local no-op page (test-control.ts): a real navigable URL so the
      // browser's "open the sign-in page" click lands somewhere honest.
      authorizeUrl: `${this._localOrigin}/api/test/connect-approved?flow=${flowId}`,
      flowId,
    });
  }

  pollConnect(flowId: string): Promise<ConnectPoll> {
    const flow = this._flows.get(flowId);
    if (!flow) {
      // Failure is typed on the result, never thrown across the port.
      return Promise.resolve({ status: 'failed', error: `unknown flow '${flowId}'` });
    }
    // Instant success, stable across re-polls: the first poll mints the
    // account; every later poll of the same flow answers the same account.
    if (!flow.accountId) {
      this._counter += 1;
      const id = `${this.type}:${flow.toolkit}:${this._counter}` as ConnectorExternalAccountRef;
      this._accounts.set(id, {
        externalAccountRef: id,
        toolkit: flow.toolkit,
        label: flow.label ?? flow.toolkit,
        status: 'active',
        custody: 'managed',
      });
      flow.accountId = id;
    }
    return Promise.resolve({ status: 'connected', account: this._accounts.get(flow.accountId) });
  }

  listAccounts(opts?: { toolkit?: string }): Promise<ProviderConnectedAccount[]> {
    const all = [...this._accounts.values()];
    return Promise.resolve(opts?.toolkit ? all.filter((a) => a.toolkit === opts.toolkit) : all);
  }

  disconnect(accountId: ConnectorExternalAccountRef): Promise<void> {
    // Idempotent by construction — deleting an unknown id is a no-op.
    this._accounts.delete(accountId);
    return Promise.resolve();
  }

  /**
   * Force an account's lifecycle status for management and execution tests.
   *
   * @param accountId - The account to mutate.
   * @param status - The status to set.
   */
  setStatus(
    accountId: ConnectorExternalAccountRef,
    status: ProviderConnectedAccount['status']
  ): void {
    const account = this._accounts.get(accountId);
    if (account) account.status = status;
  }
}

/**
 * The credential-gated factory the bootstrapper's `test-connector` spec runs:
 * `null` while no key is saved under `test-connector-api-key`, a fresh scripted
 * provider once one is — the same silent-null-when-unconfigured semantics as
 * `maybeCreateComposioProvider`, so the e2e's save-key step registers the
 * provider live and the delete unregisters it (accounts are in-memory, so each
 * reload starts clean — deliberate test isolation).
 *
 * @param opts - The credential read port and the local origin.
 * @param opts.credentials - Resolves the `file:test-connector-api-key` reference.
 * @param opts.localOrigin - Local server origin for the provider's URLs.
 */
export async function maybeCreateTestModeConnectorProvider(opts: {
  credentials: CredentialProvider;
  localOrigin: string;
}): Promise<TestModeConnectorProvider | null> {
  const resolution = await opts.credentials.resolve(TEST_CONNECTOR_API_KEY_REF);
  if (!resolution.ok) return null;
  return new TestModeConnectorProvider({ localOrigin: opts.localOrigin });
}
