import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConnectorExternalAccountRef,
  ConnectorProviderInstanceId,
} from '@dorkos/shared/connector-provider';
import type {
  ManagedConnectorAccount,
  ManagedConnectorAccountListResponse,
  ManagedConnectorAuthenticationState,
  ManagedConnectorCatalogPage,
  ManagedConnectorOperationPageResponse,
  ManagedConnectorToolkitVersionResponse,
} from '@dorkos/shared/connector-managed-discovery-schemas';
import type { ManagedConnectorExecutionResponse } from '@dorkos/shared/connector-managed-schemas';
import type {
  ConnectorOperationRevision,
  ConnectorProviderExecuteCommand,
} from '@dorkos/shared/connector-schemas';
import { ManagedCloudConnectorProvider, type ManagedConnectorCloudPort } from '../managed-cloud.js';

import { ManagedConnectorCloudError } from '../../../../core/auth/cloud-link-client.js';
import { CloudLinkManager } from '../../../../core/auth/cloud-link.js';

const instanceId = 'managed:cloud' as ConnectorProviderInstanceId;

const operation: ConnectorOperationRevision = {
  id: 'revision-1',
  providerInstanceId: instanceId,
  toolkit: 'gmail',
  operationSlug: 'gmail.messages.list',
  toolkitVersion: '2026-09-01',
  schemaHash: 'gmail-list-v1',
  capabilityClassification: 'read',
  retryPolicy: 'never',
  inputSchema: {},
  discoveredAt: '2026-09-06T00:00:00.000Z',
};

const account: ManagedConnectorAccount = {
  managedConnectionId: 'managed-account-1',
  toolkit: 'gmail',
  label: 'Personal',
  authenticationStatus: 'active',
  lifecycle: 'active',
  bindingGeneration: 1,
  materialGeneration: 1,
};

const receipt = {
  version: 1,
  receiptId: 'receipt-1',
  logicalOperationId: 'logical-1',
  attemptId: 'attempt-1',
  attemptIndex: 1,
  outcome: 'success',
  completedAt: '2026-09-06T00:00:01.000Z',
  recordedAt: '2026-09-06T00:00:02.000Z',
} as const;

function cloudPort(): ManagedConnectorCloudPort {
  return {
    listManagedConnectorCatalog: vi.fn(async (): Promise<ManagedConnectorCatalogPage> => ({
      version: 1,
      toolkits: [
        {
          slug: 'gmail',
          displayName: 'Gmail',
          authKind: 'oauth2',
          authentication: { status: 'available' },
        },
      ],
      truncated: false,
    })),
    resolveManagedConnectorToolkitVersion: vi.fn(
      async (): Promise<ManagedConnectorToolkitVersionResponse> => ({
        version: 1,
        status: 'ok',
        toolkit: 'gmail',
        toolkitVersion: '2026-09-01',
      })
    ),
    listManagedConnectorOperationSchemas: vi.fn(
      async (): Promise<ManagedConnectorOperationPageResponse> => ({
        version: 1,
        status: 'ok',
        operations: [
          {
            providerInstanceId: 'private-hosted-provider',
            toolkit: operation.toolkit,
            hostedRevisionId: '11111111-1111-4111-8111-111111111111',
            operationSlug: operation.operationSlug,
            toolkitVersion: operation.toolkitVersion,
            schemaHash: operation.schemaHash,
            capabilityClassification: operation.capabilityClassification,
            retryPolicy: operation.retryPolicy,
            inputSchema: {},
          },
        ],
        truncated: false,
      })
    ),
    listManagedConnectorAccounts: vi.fn(async (): Promise<ManagedConnectorAccountListResponse> => ({
      version: 1,
      accounts: [account],
    })),
    getManagedConnectorAccount: vi.fn(async () => account),
    startManagedConnectorAuthentication: vi.fn(
      async (): Promise<ManagedConnectorAuthenticationState> => ({
        version: 1,
        state: 'pending',
        flowId: 'flow-1',
        toolkit: 'gmail',
        authorizeUrl: 'https://dorkos.ai/connectors/managed/authorize?flow=flow-1',
        createdAt: '2026-09-06T00:00:00.000Z',
        expiresAt: '2026-09-06T00:10:00.000Z',
      })
    ),
    getManagedConnectorAuthenticationState: vi.fn(
      async (): Promise<ManagedConnectorAuthenticationState> => ({
        version: 1,
        state: 'connected',
        flowId: 'flow-1',
        toolkit: 'gmail',
        createdAt: '2026-09-06T00:00:00.000Z',
        expiresAt: '2026-09-06T00:10:00.000Z',
        completedAt: '2026-09-06T00:00:03.000Z',
        account,
      })
    ),
    executeManagedConnectorOperation: vi.fn(
      async (): Promise<ManagedConnectorExecutionResponse> => ({
        state: 'completed',
        result: { status: 'success', data: { messages: 2 } },
        receipt,
      })
    ),
  };
}

function command(
  authorizeDispatch: ConnectorProviderExecuteCommand['authorizeDispatch'] = () => true
): ConnectorProviderExecuteCommand {
  return {
    externalAccountRef: 'managed-account-1' as ConnectorExternalAccountRef,
    operation,
    arguments: { query: 'from:me' },
    logicalOperationId: 'logical-1',
    attemptId: 'attempt-1',
    signal: new AbortController().signal,
    authorizeDispatch,
  };
}

function provider(cloud: ManagedConnectorCloudPort) {
  return new ManagedCloudConnectorProvider({
    instanceId,
    cloud,
    executionContext: () => ({
      hostedRevisionId: '11111111-1111-4111-8111-111111111111',
      agentId: 'agent-a',
      attemptIndex: 1,
      grantScopeVersion: 4,
      attribution: {
        surface: 'mcp',
        actorKind: 'agent',
        actorId: 'agent-a',
        sessionId: 'session-a',
      },
    }),
  });
}

describe('ManagedCloudConnectorProvider', () => {
  let cloud: ManagedConnectorCloudPort;

  beforeEach(() => {
    cloud = cloudPort();
  });

  it('maps catalog, exact version, operation namespace, and stable account identity', async () => {
    const subject = provider(cloud);
    expect(
      await subject.listToolkitPage({ limit: 20, signal: new AbortController().signal })
    ).toMatchObject({
      status: 'ok',
      toolkits: [{ slug: 'gmail', authentication: { status: 'available' } }],
      truncated: false,
    });
    expect(await subject.resolveToolkitVersion('gmail', new AbortController().signal)).toEqual({
      status: 'ok',
      toolkit: 'gmail',
      toolkitVersion: '2026-09-01',
    });
    const schemas = await subject.listOperationSchemas({
      toolkit: 'gmail',
      toolkitVersion: '2026-09-01',
      limit: 20,
      signal: new AbortController().signal,
    });
    expect(schemas).toMatchObject({
      status: 'ok',
      page: { operations: [{ providerInstanceId: 'managed:cloud' }] },
    });
    expect(JSON.stringify(schemas)).not.toContain('private-hosted-provider');
    expect(await subject.listAccounts({ toolkit: 'gmail' })).toEqual([
      expect.objectContaining({
        externalAccountRef: 'managed-account-1',
        custody: 'managed',
      }),
    ]);
  });

  it('sends trusted context and exact revision after the final dispatch guard', async () => {
    const events: string[] = [];
    vi.mocked(cloud.executeManagedConnectorOperation).mockImplementation(async (request) => {
      events.push('cloud');
      expect(request).toEqual({
        version: 1,
        logicalOperationId: 'logical-1',
        attemptId: 'attempt-1',
        attemptIndex: 1,
        managedConnectionId: 'managed-account-1',
        agentId: 'agent-a',
        grantScopeVersion: 4,
        attribution: {
          surface: 'mcp',
          actorKind: 'agent',
          actorId: 'agent-a',
          sessionId: 'session-a',
        },
        revision: {
          hostedRevisionId: '11111111-1111-4111-8111-111111111111',
          operationSlug: 'gmail.messages.list',
          toolkitVersion: '2026-09-01',
          schemaHash: 'gmail-list-v1',
        },
        arguments: { query: 'from:me' },
      });
      return { state: 'completed', result: { status: 'success', data: { ok: true } }, receipt };
    });
    const result = await provider(cloud).execute(
      command(() => {
        events.push('authorize');
        return true;
      })
    );
    expect(events).toEqual(['authorize', 'cloud']);
    expect(result).toEqual({ status: 'success', data: { ok: true } });
  });

  it('fails closed before the cloud call when trusted context or authority is absent', async () => {
    const noContext = new ManagedCloudConnectorProvider({
      instanceId,
      cloud,
      executionContext: () => undefined,
    });
    expect(await noContext.execute(command())).toMatchObject({
      status: 'error',
      code: 'MANAGED_EXECUTION_CONTEXT_REQUIRED',
      retryable: false,
    });
    expect(await provider(cloud).execute(command(() => false))).toMatchObject({
      status: 'error',
      code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH',
      retryable: false,
    });
    expect(cloud.executeManagedConnectorOperation).not.toHaveBeenCalled();
  });

  it('reports a removed local link before dispatch despite valid execution authority', async () => {
    let token: string | null = 'linked-token';
    const fetchImpl = vi.fn<typeof fetch>();
    const manager = new CloudLinkManager({
      config: {
        getToken: () => token,
        getAccountLabel: () => null,
        save: vi.fn(),
        setAccountLabel: vi.fn(),
        clear: vi.fn(),
      },
      fetchImpl,
    });
    expect(manager.getSummary().linked).toBe(true);
    token = null;
    const result = await provider(manager).execute(command());
    expect(result).toMatchObject({
      status: 'error',
      code: 'MANAGED_LINK_REQUIRED',
      retryable: false,
      message: expect.stringContaining('Settings > Access'),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(manager.getSummary().linked).toBe(false);
  });

  it('keeps a lost remote acknowledgement unknown and never replays the request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('private network detail'));
    const manager = new CloudLinkManager({
      config: {
        getToken: () => 'linked-token',
        getAccountLabel: () => null,
        save: vi.fn(),
        setAccountLabel: vi.fn(),
        clear: vi.fn(),
      },
      fetchImpl,
    });
    expect(await provider(manager).execute(command())).toEqual({
      status: 'outcome_unknown',
      code: 'MANAGED_EXECUTION_OUTCOME_UNKNOWN',
      message: 'The hosted service did not confirm the managed connector outcome.',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('distinguishes known receipt-only outcomes from pending and unknown outcomes', async () => {
    vi.mocked(cloud.executeManagedConnectorOperation)
      .mockResolvedValueOnce({ state: 'receipt_only', receipt })
      .mockResolvedValueOnce({
        state: 'receipt_only',
        receipt: { ...receipt, outcome: 'outcome_unknown', completedAt: null },
      })
      .mockResolvedValueOnce({ state: 'pending', attemptId: 'attempt-1' });
    const subject = provider(cloud);
    expect(await subject.execute(command())).toEqual({
      status: 'error',
      code: 'RESULT_NOT_RETAINED',
      message:
        'The hosted service recorded a success outcome, but result data is no longer available.',
      retryable: false,
    });
    expect(await subject.execute(command())).toMatchObject({
      status: 'outcome_unknown',
      code: 'MANAGED_RESULT_UNAVAILABLE',
    });
    expect(await subject.execute(command())).toMatchObject({
      status: 'outcome_unknown',
      code: 'MANAGED_RESULT_UNAVAILABLE',
    });
  });

  it('does not mistake a remote unauthorized response for local token absence', async () => {
    vi.mocked(cloud.executeManagedConnectorOperation).mockRejectedValue(
      new ManagedConnectorCloudError('unauthorized', 401)
    );
    expect(await provider(cloud).execute(command())).toMatchObject({
      status: 'outcome_unknown',
      code: 'MANAGED_EXECUTION_OUTCOME_UNKNOWN',
    });
    expect(cloud.executeManagedConnectorOperation).toHaveBeenCalledTimes(1);
  });

  it('never retries a thrown response or accepts receipt evidence for another attempt', async () => {
    vi.mocked(cloud.executeManagedConnectorOperation)
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce({
        state: 'receipt_only',
        receipt: { ...receipt, attemptId: 'other-attempt' },
      });
    const subject = provider(cloud);
    expect(await subject.execute(command())).toMatchObject({
      status: 'outcome_unknown',
      code: 'MANAGED_EXECUTION_OUTCOME_UNKNOWN',
    });
    expect(await subject.execute(command())).toMatchObject({
      status: 'outcome_unknown',
      code: 'MANAGED_RECEIPT_IDENTITY_MISMATCH',
    });
    expect(cloud.executeManagedConnectorOperation).toHaveBeenCalledTimes(2);
  });

  it('returns typed cancellation without asking for context or calling the cloud', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await provider(cloud).execute({ ...command(), signal: controller.signal })
    ).toMatchObject({
      status: 'cancelled',
      code: 'CANCELLED_BEFORE_DISPATCH',
    });
    expect(cloud.executeManagedConnectorOperation).not.toHaveBeenCalled();
  });
});
