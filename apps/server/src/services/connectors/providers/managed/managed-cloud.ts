/**
 * Local ConnectorProvider adapter for the DorkOS hosted managed service.
 *
 * @module services/connectors/providers/managed/managed-cloud
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
import type {
  ManagedConnectorAccount,
  ManagedConnectorAccountListRequest,
  ManagedConnectorAccountListResponse,
  ManagedConnectorAuthenticationCreateRequest,
  ManagedConnectorAuthenticationState,
  ManagedConnectorCatalogPage,
  ManagedConnectorCatalogRequest,
  ManagedConnectorOperationPageRequest,
  ManagedConnectorOperationPageResponse,
  ManagedConnectorToolkitVersionRequest,
  ManagedConnectorToolkitVersionResponse,
} from '@dorkos/shared/connector-managed-discovery-schemas';
import {
  ManagedConnectorExecutionRequestSchema,
  type ManagedConnectorExecutionAttribution,
  type ManagedConnectorExecutionReceipt,
  type ManagedConnectorExecutionRequest,
  type ManagedConnectorExecutionResponse,
} from '@dorkos/shared/connector-managed-schemas';
import type {
  ConnectorCatalogPageRequest,
  ConnectorOperationPageRequest,
  ConnectorProviderExecuteCommand,
  ConnectorProviderExecuteResult,
} from '@dorkos/shared/connector-schemas';

/** Provider type registered for the DorkOS hosted managed service. */
export const MANAGED_CLOUD_PROVIDER_TYPE = 'dorkos-managed';

/** Exact CloudLinkManager surface consumed by the managed provider adapter. */
export interface ManagedConnectorCloudPort {
  listManagedConnectorCatalog(
    request: ManagedConnectorCatalogRequest,
    signal: AbortSignal
  ): Promise<ManagedConnectorCatalogPage>;
  resolveManagedConnectorToolkitVersion(
    request: ManagedConnectorToolkitVersionRequest,
    signal: AbortSignal
  ): Promise<ManagedConnectorToolkitVersionResponse>;
  listManagedConnectorOperationSchemas(
    request: ManagedConnectorOperationPageRequest,
    signal: AbortSignal
  ): Promise<ManagedConnectorOperationPageResponse>;
  listManagedConnectorAccounts(
    request: ManagedConnectorAccountListRequest,
    signal: AbortSignal
  ): Promise<ManagedConnectorAccountListResponse>;
  getManagedConnectorAccount(
    managedConnectionId: string,
    signal: AbortSignal
  ): Promise<ManagedConnectorAccount>;
  startManagedConnectorAuthentication(
    request: ManagedConnectorAuthenticationCreateRequest,
    signal: AbortSignal
  ): Promise<ManagedConnectorAuthenticationState>;
  getManagedConnectorAuthenticationState(
    flowId: string,
    signal: AbortSignal
  ): Promise<ManagedConnectorAuthenticationState>;
  executeManagedConnectorOperation(
    request: ManagedConnectorExecutionRequest,
    signal: AbortSignal
  ): Promise<ManagedConnectorExecutionResponse>;
}

/** Trusted local broker context attached to one server-created provider command. */
export interface ManagedConnectorProviderExecutionContext {
  hostedRevisionId: string;
  agentId: string;
  attemptIndex: number;
  grantScopeVersion: number;
  attribution: ManagedConnectorExecutionAttribution;
}

/** Construction dependencies for {@link ManagedCloudConnectorProvider}. */
export interface ManagedCloudConnectorProviderOptions {
  instanceId: ConnectorProviderInstanceId;
  cloud: ManagedConnectorCloudPort;
  /** Resolve context by command object identity; undefined fails closed. */
  executionContext: (
    command: ConnectorProviderExecuteCommand
  ) => ManagedConnectorProviderExecutionContext | undefined;
}

function providerAccount(account: ManagedConnectorAccount): ProviderConnectedAccount {
  return {
    externalAccountRef: account.managedConnectionId as ConnectorExternalAccountRef,
    toolkit: account.toolkit,
    label: account.label,
    status: account.authenticationStatus,
    custody: 'managed',
  };
}

function terminalUnknown(code: string, message: string): ConnectorProviderExecuteResult {
  return { status: 'outcome_unknown', code, message };
}

function resultNotRetained(
  outcome: Exclude<ManagedConnectorExecutionReceipt['outcome'], 'outcome_unknown'>
): ConnectorProviderExecuteResult {
  return {
    status: 'error',
    code: 'RESULT_NOT_RETAINED',
    message: `The hosted service recorded a ${outcome} outcome, but result data is no longer available.`,
    retryable: false,
  };
}

/**
 * ConnectorProvider backed by the linked instance's authenticated CloudLinkManager.
 *
 * The adapter never holds a cloud token or calls fetch. Hosted managed connection
 * IDs remain private provider references inside the local connection registry.
 */
export class ManagedCloudConnectorProvider implements ConnectorProvider {
  readonly type = MANAGED_CLOUD_PROVIDER_TYPE;
  readonly instanceId: ConnectorProviderInstanceId;
  readonly #cloud: ManagedConnectorCloudPort;
  readonly #executionContext: ManagedCloudConnectorProviderOptions['executionContext'];

  constructor(options: ManagedCloudConnectorProviderOptions) {
    this.instanceId = options.instanceId;
    this.#cloud = options.cloud;
    this.#executionContext = options.executionContext;
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
        triggers: {
          status: 'unsupported',
          reason: 'Managed connector events are not available yet.',
        },
      },
      features: {},
    };
  }

  async listToolkitPage(request: ConnectorCatalogPageRequest) {
    const page = await this.#cloud.listManagedConnectorCatalog(
      {
        version: 1,
        ...(request.query !== undefined && { query: request.query }),
        ...(request.cursor !== undefined && { cursor: request.cursor }),
        limit: request.limit,
      },
      request.signal
    );
    return {
      status: 'ok' as const,
      toolkits: page.toolkits,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
      truncated: page.truncated,
    };
  }

  async resolveToolkitVersion(toolkit: string, signal: AbortSignal) {
    const result = await this.#cloud.resolveManagedConnectorToolkitVersion(
      { version: 1, toolkit },
      signal
    );
    if (result.status === 'unsupported') return result;
    return {
      status: 'ok' as const,
      toolkit: result.toolkit,
      toolkitVersion: result.toolkitVersion,
    };
  }

  async listOperationSchemas(request: ConnectorOperationPageRequest) {
    const result = await this.#cloud.listManagedConnectorOperationSchemas(
      {
        version: 1,
        toolkit: request.toolkit,
        toolkitVersion: request.toolkitVersion,
        ...(request.cursor !== undefined && { cursor: request.cursor }),
        limit: request.limit,
      },
      request.signal
    );
    if (result.status === 'unsupported') return result;
    return {
      status: 'ok' as const,
      page: {
        operations: result.operations.map(({ hostedRevisionId, ...operation }) => ({
          ...operation,
          providerRevisionRef: hostedRevisionId,
          providerInstanceId: this.instanceId,
          discoveredAt: new Date().toISOString(),
        })),
        ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
        truncated: result.truncated,
      },
    };
  }

  async execute(command: ConnectorProviderExecuteCommand): Promise<ConnectorProviderExecuteResult> {
    if (command.signal.aborted) {
      return {
        status: 'cancelled',
        code: 'CANCELLED_BEFORE_DISPATCH',
        message: 'The operation was cancelled before it was sent.',
      };
    }
    const context = this.#executionContext(command);
    if (!context) {
      return {
        status: 'error',
        code: 'MANAGED_EXECUTION_CONTEXT_REQUIRED',
        message: 'Managed account access could not be verified.',
        retryable: false,
      };
    }
    if (!(await command.authorizeDispatch())) {
      return {
        status: 'error',
        code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH',
        message: 'Access changed before the operation was sent.',
        retryable: false,
      };
    }
    const request = ManagedConnectorExecutionRequestSchema.parse({
      version: 1,
      logicalOperationId: command.logicalOperationId,
      attemptId: command.attemptId,
      attemptIndex: context.attemptIndex,
      managedConnectionId: command.externalAccountRef,
      agentId: context.agentId,
      grantScopeVersion: context.grantScopeVersion,
      attribution: context.attribution,
      revision: {
        hostedRevisionId: context.hostedRevisionId,
        operationSlug: command.operation.operationSlug,
        toolkitVersion: command.operation.toolkitVersion,
        schemaHash: command.operation.schemaHash,
      },
      arguments: command.arguments,
    });
    let response: ManagedConnectorExecutionResponse;
    try {
      response = await this.#cloud.executeManagedConnectorOperation(request, command.signal);
    } catch {
      return terminalUnknown(
        'MANAGED_EXECUTION_OUTCOME_UNKNOWN',
        'The hosted service did not confirm the managed connector outcome.'
      );
    }
    if ('receipt' in response) {
      const { receipt } = response;
      if (
        receipt.attemptId !== request.attemptId ||
        receipt.logicalOperationId !== request.logicalOperationId ||
        receipt.attemptIndex !== request.attemptIndex
      ) {
        return terminalUnknown(
          'MANAGED_RECEIPT_IDENTITY_MISMATCH',
          'The hosted service returned receipt evidence for another attempt.'
        );
      }
    }
    if (response.state === 'completed') return response.result;
    if (response.state === 'receipt_only' && response.receipt.outcome !== 'outcome_unknown') {
      return resultNotRetained(response.receipt.outcome);
    }
    return terminalUnknown(
      'MANAGED_RESULT_UNAVAILABLE',
      'The hosted service has not confirmed a result for this attempt.'
    );
  }

  listTriggerTypes(_toolkit: string) {
    return Promise.resolve({
      status: 'unsupported' as const,
      reason: 'Managed connector events are not available yet.',
    });
  }

  async listToolkits(): Promise<ConnectorToolkit[]> {
    const signal = new AbortController().signal;
    const page = await this.listToolkitPage({ limit: 100, signal });
    if (page.truncated) {
      throw new Error('Managed connector catalog requires paginated discovery.');
    }
    return page.toolkits;
  }

  async startConnect(toolkit: string, opts?: { label?: string }): Promise<ConnectStart> {
    const state = await this.#cloud.startManagedConnectorAuthentication(
      {
        version: 1,
        requestId: randomUUID(),
        toolkit,
        ...(opts?.label !== undefined && { label: opts.label }),
      },
      new AbortController().signal
    );
    return {
      flowId: state.flowId,
      ...(state.state === 'pending' && state.authorizeUrl
        ? { authorizeUrl: state.authorizeUrl }
        : {}),
    };
  }

  async pollConnect(flowId: string): Promise<ConnectPoll> {
    const state = await this.#cloud.getManagedConnectorAuthenticationState(
      flowId,
      new AbortController().signal
    );
    if (state.state === 'connected') {
      return { status: 'connected', account: providerAccount(state.account) };
    }
    if (state.state === 'starting' || state.state === 'pending') return { status: 'pending' };
    return {
      status: 'failed',
      error: state.state === 'expired' ? 'Managed account sign-in expired.' : state.reason,
    };
  }

  async listAccounts(opts?: { toolkit?: string }): Promise<ProviderConnectedAccount[]> {
    const page = await this.#cloud.listManagedConnectorAccounts(
      {
        version: 1,
        ...(opts?.toolkit !== undefined && { toolkit: opts.toolkit }),
        limit: 100,
      },
      new AbortController().signal
    );
    if (page.nextCursor) {
      throw new Error('Managed connector accounts require paginated discovery.');
    }
    return page.accounts.map(providerAccount);
  }

  async disconnect(_externalAccountRef: ConnectorExternalAccountRef): Promise<void> {
    throw new Error('Managed connection changes require owner authority synchronization.');
  }
}
