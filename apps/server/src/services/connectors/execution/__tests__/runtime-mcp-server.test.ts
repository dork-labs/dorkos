import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorUsageAttempts,
  createDb,
  eq,
  runMigrations,
} from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/index.js';
import { connectorExecutionDomain } from '../execution-capabilities.js';
import { ConnectorAccessQueryService } from '../access-query-service.js';
import { ConnectorExecutionAuthorizationService } from '../authorization-service.js';
import { ConnectorExecutionBroker } from '../execution-broker.js';
import { ConnectorUsageStore } from '../usage-store.js';
import { createConnectorRuntimeMcpServer } from '../runtime-mcp-server.js';
import { ConnectorRegistry } from '../../registry.js';
import { ConnectorRuntimePrincipalService } from '../../principal/runtime-principal-service.js';
import {
  createServerPrincipal,
  type ConnectorOwnerAuthority,
} from '../../principal/server-principal.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;

function payload(result: unknown): Record<string, unknown> {
  if (
    !result ||
    typeof result !== 'object' ||
    !('content' in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error('Expected an MCP result with content.');
  }
  const block = result.content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('Expected a text MCP result.');
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe('createConnectorRuntimeMcpServer', () => {
  it('projects only exact principal-bound discovery and execution capabilities', async () => {
    const invoke = vi.fn(async () => ({ logicalOperationId: 'logical-a', attemptCount: 1 }));
    const capabilities = connectorExecutionDomain.capabilities;
    const registry = {
      capabilities,
      get: (id: string) => capabilities.find((capability) => capability.id === id),
      invoke,
    } as unknown as CapabilityRegistry;
    const principal = createServerPrincipal({
      kind: 'runtime',
      owner: { kind: 'local_install', installationId: 'install-a' },
      bindingId: 'binding-a',
      runtime: 'codex',
      canonicalSessionId: 'session-a',
      agentId: 'agent-a',
      agentPath: '/projects/a',
      canonicalCwd: '/projects/a',
    });
    const server = createConnectorRuntimeMcpServer(registry, principal);
    const client = new Client({ name: 'connector-runtime-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    await expect(client.listTools()).resolves.toMatchObject({
      tools: [
        { name: 'connectors.list_granted_connections' },
        { name: 'connectors.list_granted_operations' },
        { name: 'connectors.request_connection' },
        { name: 'connectors.get_connection_request' },
        { name: 'connectors.execute_read' },
        { name: 'connectors.execute_write' },
        { name: 'connectors.execute_destructive' },
      ],
    });
    const forbiddenSelectors = [
      {
        name: 'connectors.list_granted_connections',
        arguments: { ownerId: 'install-b' },
      },
      {
        name: 'connectors.list_granted_operations',
        arguments: { connectionId: 'connection-a', providerInstanceId: 'provider-b' },
      },
      ...(['read', 'write', 'destructive'] as const).map((classification) => ({
        name: `connectors.execute_${classification}`,
        arguments: {
          connectionId: 'connection-a',
          operationRevisionId: 'revision-a',
          arguments: {},
          agentId: 'agent-b',
        },
      })),
    ];
    for (const request of forbiddenSelectors) {
      await expect(client.callTool(request)).resolves.toMatchObject({ isError: true });
    }
    expect(invoke).not.toHaveBeenCalled();
    await client.callTool({
      name: 'connectors.execute_read',
      arguments: {
        connectionId: 'connection-a',
        operationRevisionId: 'revision-a',
        arguments: {},
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      'connectors.execute_read',
      expect.any(Object),
      expect.objectContaining({ serverPrincipal: principal })
    );

    await Promise.all([client.close(), server.close()]);
  });

  it('creates and checks only principal-bound owner requests without account selectors', async () => {
    const principal = createServerPrincipal({
      kind: 'runtime',
      owner: OWNER,
      bindingId: 'binding-request',
      runtime: 'codex',
      canonicalSessionId: 'session-request',
      agentId: 'agent-request',
      agentPath: '/agents/request',
      canonicalCwd: '/agents/request',
    });
    const status = {
      requestId: 'request-a',
      reviewUrl: '/connections?request=request-a',
      serviceSlug: 'gmail',
      reason: 'Read a message needed for this task.',
      requestedOperations: ['gmail.read'],
      requestedEvents: [],
      createdAt: '2026-09-07T12:00:00.000Z',
      expiresAt: '2026-09-07T14:00:00.000Z',
      status: 'awaiting_owner' as const,
    };
    const create = vi.fn(async () => status);
    const waitForResolution = vi.fn(async () => ({ ...status, status: 'denied' as const }));
    const getForRuntime = vi.fn(async () => ({ ...status, status: 'denied' as const }));
    const capabilityRegistry = composeRegistry([connectorExecutionDomain], {
      logger: noopLogger,
      connectorExecutionDeps: {
        authorization: {} as never,
        broker: {} as never,
        access: {} as never,
        requests: { create, waitForResolution, getForRuntime } as never,
      },
    });
    const server = createConnectorRuntimeMcpServer(capabilityRegistry, principal);
    const client = new Client({ name: 'connector-request-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const requestTool = (await client.listTools()).tools.find(
      (tool) => tool.name === 'connectors.request_connection'
    );
    expect(requestTool?.inputSchema).toMatchObject({
      properties: { requestedEvents: { maxItems: 32 } },
    });

    const result = payload(
      await client.callTool({
        name: 'connectors.request_connection',
        arguments: {
          version: 1,
          serviceSlug: 'gmail',
          reason: status.reason,
          requestedOperations: ['gmail.read'],
          requestedEvents: [],
        },
      })
    );
    expect(result).toMatchObject({ requestId: 'request-a', status: 'denied' });
    expect(create).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({ serviceSlug: 'gmail' })
    );
    expect(waitForResolution).toHaveBeenCalledWith(principal, 'request-a', expect.anything());

    await client.callTool({
      name: 'connectors.get_connection_request',
      arguments: { requestId: 'request-a' },
    });
    expect(getForRuntime).toHaveBeenCalledWith(principal, 'request-a');

    const forbidden = await client.callTool({
      name: 'connectors.get_connection_request',
      arguments: { requestId: 'request-a', agentId: 'agent-other' },
    });
    expect(forbidden.isError).toBe(true);
    await Promise.all([client.close(), server.close()]);
  });

  it('discovers only live grants, executes the selected revision, and refuses a revoked turn', async () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const provider = new FakeConnectorProvider({
      type: 'fake',
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
      custody: 'self-host',
    });
    const execute = vi.spyOn(provider, 'execute');
    const started = await provider.startConnect('gmail', { label: 'Work Gmail' });
    const connected = await provider.pollConnect(started.flowId);
    if (connected.status !== 'connected' || !connected.account) {
      throw new Error('Expected the fake account to connect.');
    }
    const registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: 'local_install', ownerId: OWNER.installationId },
    });
    registry.register(provider, 'material-a');
    db.insert(connections)
      .values({
        id: 'connection-a',
        providerInstanceId: provider.instanceId,
        externalAccountRef: connected.account.externalAccountRef,
        toolkit: 'gmail',
        label: 'Work Gmail',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: '2026-09-06T12:00:00.000Z',
        updatedAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
    db.insert(connectorOperationRevisions)
      .values({
        id: 'revision-a',
        providerInstanceId: provider.instanceId,
        toolkit: 'gmail',
        operationSlug: 'gmail.read',
        toolkitVersion: '2026-09-01',
        schemaHash: 'sha256:runtime-discovery',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', additionalProperties: false }),
        discoveredAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-a',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        operationRevisionId: 'revision-a',
        createdBy: 'operator',
        createdAt: '2026-09-06T12:00:00.000Z',
      })
      .run();

    const principals = new ConnectorRuntimePrincipalService({
      db,
      authority: {
        authorizeTurn: async () => ({ owner: OWNER, agentId: 'agent-a' }),
        revalidateTurn: async () => true,
      },
      makeBootEpoch: () => 'boot-runtime-discovery',
      makeBearer: () => 'bearer-runtime-discovery',
    });
    await principals.initializeBoot();
    const opened = await principals.openTurn({
      runtime: 'codex',
      canonicalSessionId: 'session-a',
      agentPath: '/agents/agent-a',
      canonicalCwd: '/repo-a',
      signal: new AbortController().signal,
    });
    const resolved = await principals.resolve({
      bearer: opened.bearer,
      expectedRuntime: 'codex',
      expectedCanonicalCwd: '/repo-a',
    });
    if (resolved.status !== 'resolved') throw new Error('Expected a live runtime principal.');

    let revokeDuringOwnershipCheck = false;
    const ownership = {
      ownsAgent: async (_owner: ConnectorOwnerAuthority, agentId: string) => {
        if (revokeDuringOwnershipCheck) {
          revokeDuringOwnershipCheck = false;
          await principals.revoke(opened.bindingId, 'turn_terminal');
        }
        return agentId === 'agent-a';
      },
    };
    const authorization = new ConnectorExecutionAuthorizationService(db, registry, ownership);
    const access = new ConnectorAccessQueryService(db, ownership, registry, principals);
    const capabilityRegistry = composeRegistry([connectorExecutionDomain], {
      logger: noopLogger,
      connectorExecutionDeps: {
        authorization,
        access,
        broker: new ConnectorExecutionBroker(authorization, new ConnectorUsageStore(db), {
          revalidate: (principal) => principals.revalidatePrincipal(principal),
        }),
        requests: {
          create: vi.fn(),
          getForRuntime: vi.fn(),
          waitForResolution: vi.fn(),
        } as never,
      },
    });
    const server = createConnectorRuntimeMcpServer(capabilityRegistry, resolved.principal);
    const client = new Client({ name: 'connector-runtime-integration', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const listedConnections = payload(
      await client.callTool({ name: 'connectors.list_granted_connections', arguments: {} })
    );
    expect(listedConnections).toMatchObject({
      connections: [{ connectionId: 'connection-a', label: 'Work Gmail' }],
    });
    const listedOperations = payload(
      await client.callTool({
        name: 'connectors.list_granted_operations',
        arguments: { connectionId: 'connection-a' },
      })
    );
    expect(listedOperations).toMatchObject({
      operations: [
        {
          operationRevisionId: 'revision-a',
          operationSlug: 'gmail.read',
          toolkitVersion: '2026-09-01',
          inputSchema: { type: 'object', additionalProperties: false },
        },
      ],
    });
    const execution = payload(
      await client.callTool({
        name: 'connectors.execute_read',
        arguments: {
          connectionId: 'connection-a',
          operationRevisionId: 'revision-a',
          arguments: {},
        },
      })
    );
    expect(execution).toMatchObject({ attemptCount: 1, result: { status: 'success' } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.select().from(connectorUsageAttempts).all()).toHaveLength(1);

    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-foreign',
        subjectType: 'agent',
        subjectId: 'agent-b',
        agentId: 'agent-b',
        connectionId: 'connection-a',
        operationRevisionId: 'revision-a',
        createdBy: 'operator',
        createdAt: '2026-09-06T12:00:01.000Z',
      })
      .run();
    db.update(connectionOperationGrants)
      .set({ revokedAt: '2026-09-06T12:00:01.000Z' })
      .where(eq(connectionOperationGrants.id, 'grant-a'))
      .run();
    expect(
      payload(await client.callTool({ name: 'connectors.list_granted_connections', arguments: {} }))
    ).toEqual({ connections: [] });

    db.update(connectionOperationGrants)
      .set({ revokedAt: null })
      .where(eq(connectionOperationGrants.id, 'grant-a'))
      .run();
    expect(
      payload(await client.callTool({ name: 'connectors.list_granted_connections', arguments: {} }))
    ).toMatchObject({ connections: [{ connectionId: 'connection-a' }] });

    registry.register(provider, 'material-b');
    expect(
      payload(await client.callTool({ name: 'connectors.list_granted_connections', arguments: {} }))
    ).toEqual({ connections: [] });
    const staleMaterialExecution = await client.callTool({
      name: 'connectors.execute_read',
      arguments: {
        connectionId: 'connection-a',
        operationRevisionId: 'revision-a',
        arguments: {},
      },
    });
    expect(staleMaterialExecution.isError).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.select().from(connectorUsageAttempts).all()).toHaveLength(1);

    revokeDuringOwnershipCheck = true;
    const revoked = await client.callTool({
      name: 'connectors.list_granted_connections',
      arguments: {},
    });
    expect(revoked.isError).toBe(true);
    expect(payload(revoked)).toMatchObject({ code: 'CONNECTOR_PRINCIPAL_REQUIRED' });

    await Promise.all([client.close(), server.close()]);
  });
});
