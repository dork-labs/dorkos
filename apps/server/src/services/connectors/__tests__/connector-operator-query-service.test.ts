import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agents,
  connectionOperationGrants,
  connections,
  connectorManagedAuthorityOutbox,
  connectorManagedAuthorityScopes,
  connectorOperationRevisions,
  connectorProviderInstances,
  createDb,
  eq,
  runMigrations,
  sessionConnectionOverrides,
  type Db,
} from '@dorkos/db';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import {
  ConnectorOperatorQueryError,
  ConnectorOperatorQueryService,
} from '../resources/operator-query-service.js';
import { ConnectorRegistry } from '../registry.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const FOREIGN_OWNER = { kind: 'local_install', installationId: 'install-b' } as const;
const PROVIDER_ID = ConnectorProviderInstanceIdSchema.parse('provider-a');
const NOW = '2026-09-06T18:00:00.000Z';

describe('ConnectorOperatorQueryService', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let service: ConnectorOperatorQueryService;
  let provider: FakeConnectorProvider;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    provider = new FakeConnectorProvider({
      instanceId: PROVIDER_ID,
      type: 'fake',
      custody: 'managed',
      toolkits: [
        {
          slug: 'gmail',
          displayName: 'Gmail',
          authKind: 'oauth2',
          authentication: { status: 'available' },
        },
        {
          slug: 'linear',
          displayName: 'Linear',
          authKind: 'api-key',
          authentication: {
            status: 'unsupported',
            reason: 'Managed account sign-in is not available for this service yet.',
          },
        },
      ],
    });
    registry.register(provider, 'material-a');
    db.insert(agents)
      .values({
        id: 'agent-a',
        name: 'agent-a',
        displayName: 'Researcher',
        runtime: 'claude-code',
        projectPath: '/agents/agent-a',
        registeredAt: NOW,
        updatedAt: NOW,
      })
      .run();
    db.insert(connections)
      .values({
        id: 'connection-a',
        providerInstanceId: PROVIDER_ID,
        externalAccountRef: 'private-account-a',
        toolkit: 'gmail',
        label: 'Work Gmail',
        identityHint: 'work@example.com',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    db.insert(connectorOperationRevisions)
      .values({
        id: 'revision-a',
        providerInstanceId: PROVIDER_ID,
        toolkit: 'gmail',
        operationSlug: 'gmail.messages.list',
        toolkitVersion: '20260901',
        schemaHash: 'sha256:a',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', properties: {} }),
        discoveredAt: NOW,
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
        createdAt: NOW,
      })
      .run();
    service = new ConnectorOperatorQueryService({
      db,
      registry,
      relay: { getManifest: (type) => (type === 'gmail' ? { displayName: 'Gmail' } : undefined) },
      sessions: {
        resolveSessionAgent: (_owner, sessionId) =>
          sessionId === 'session-a' ? { agentId: 'agent-a' } : undefined,
      },
      agentOwnership: {
        ownsAgent: (owner, agentId) =>
          owner.kind === 'local_install' &&
          owner.installationId === OWNER.installationId &&
          agentId === 'agent-a',
      },
    });
  });

  it('returns one account-free catalog with per-route authentication and message intents', async () => {
    const catalog = await service.catalog({ signal: new AbortController().signal });

    expect(catalog.services).toEqual([
      expect.objectContaining({
        serviceSlug: 'gmail',
        intents: [
          expect.objectContaining({ kind: 'messages' }),
          expect.objectContaining({
            kind: 'account',
            routes: [
              expect.objectContaining({ authKind: 'oauth2', providerInstanceId: PROVIDER_ID }),
            ],
          }),
        ],
      }),
      expect.objectContaining({
        serviceSlug: 'linear',
        intents: [
          expect.objectContaining({
            kind: 'account',
            routes: [
              expect.objectContaining({
                authKind: 'api-key',
                capabilities: expect.objectContaining({
                  authentication: {
                    status: 'unsupported',
                    reason: 'Managed account sign-in is not available for this service yet.',
                  },
                }),
              }),
            ],
          }),
        ],
      }),
    ]);
    expect(JSON.stringify(catalog)).not.toContain('private-account-a');
  });

  it('never lets a toolkit override elevate unavailable provider authentication', async () => {
    const capabilities = provider.getCapabilities();
    vi.spyOn(provider, 'getCapabilities').mockReturnValue({
      ...capabilities,
      capabilities: {
        ...capabilities.capabilities,
        authentication: {
          status: 'unsupported',
          reason: 'Managed connections are awaiting production verification.',
        },
      },
    });

    const catalog = await service.catalog({ signal: new AbortController().signal });
    const gmail = catalog.services.find((service) => service.serviceSlug === 'gmail');
    expect(gmail).toBeDefined();
    expect(gmail?.intents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'account',
          routes: [
            expect.objectContaining({
              capabilities: expect.objectContaining({
                authentication: {
                  status: 'unsupported',
                  reason: 'Managed connections are awaiting production verification.',
                },
              }),
            }),
          ],
        }),
      ])
    );
  });

  it('lists native message services without any account provider and preserves filtering and paging', async () => {
    const nativeOnly = new ConnectorOperatorQueryService({
      db,
      registry: new ConnectorRegistry({
        db,
        configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
      }),
      relay: {
        getManifest: (type) =>
          type === 'slack' || type === 'telegram' ? { displayName: type } : undefined,
        getCatalog: () => [
          { manifest: { type: 'telegram', displayName: 'Telegram' } },
          { manifest: { type: 'slack', displayName: 'Slack' } },
        ],
      },
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => false },
    });

    await expect(
      nativeOnly.catalog({ query: 'gram', limit: 1, signal: new AbortController().signal })
    ).resolves.toEqual({
      services: [
        {
          serviceSlug: 'telegram',
          displayName: 'Telegram',
          iconKey: 'telegram',
          intents: [
            {
              kind: 'messages',
              displayName: 'Messages through a Telegram bot',
              relayAdapterType: 'telegram',
            },
          ],
        },
      ],
      warnings: [],
    });

    const first = await nativeOnly.catalog({
      limit: 1,
      signal: new AbortController().signal,
    });
    expect(first.services[0]?.serviceSlug).toBe('slack');
    expect(first.nextCursor).toBeTruthy();
    await expect(
      nativeOnly.catalog({
        cursor: first.nextCursor,
        limit: 1,
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ services: [{ serviceSlug: 'telegram' }] });
  });

  it('retains native message services when an account provider catalog fails', async () => {
    const failing = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-failing'),
      type: 'failing',
    });
    Object.defineProperty(failing, 'listToolkitPage', {
      value: () => Promise.reject(new Error('provider unavailable')),
    });
    const failingRegistry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    failingRegistry.register(failing);
    const withFailure = new ConnectorOperatorQueryService({
      db,
      registry: failingRegistry,
      relay: {
        getManifest: (type) => (type === 'slack' ? { displayName: 'Slack' } : undefined),
        getCatalog: () => [{ manifest: { type: 'slack', displayName: 'Slack' } }],
      },
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => false },
    });

    await expect(
      withFailure.catalog({ signal: new AbortController().signal })
    ).resolves.toMatchObject({
      services: [{ serviceSlug: 'slack', intents: [{ kind: 'messages' }] }],
      warnings: [{ code: 'catalog_provider_unavailable' }],
    });
  });

  it('scopes connection detail and agent profiles to the verified owner', async () => {
    await expect(service.listConnections(OWNER)).resolves.toEqual([
      expect.objectContaining({
        connectionId: 'connection-a',
        agentCount: 1,
        usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
      }),
    ]);
    await expect(service.getConnection(OWNER, 'connection-a')).resolves.toMatchObject({
      agents: [{ agentId: 'agent-a', operationRevisionIds: ['revision-a'] }],
      provider: { providerInstanceId: PROVIDER_ID },
    });
    await expect(service.listConnections(FOREIGN_OWNER)).resolves.toEqual([]);
    await expect(service.getConnection(FOREIGN_OWNER, 'connection-a')).rejects.toThrow(
      ConnectorOperatorQueryError
    );
    await expect(service.agentConnections(FOREIGN_OWNER, 'agent-a')).rejects.toMatchObject({
      code: 'agent_not_found',
    });
  });

  it('shows canonical session detach and connection pause as disabled effective access', async () => {
    db.insert(sessionConnectionOverrides)
      .values({
        sessionId: 'session-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        state: 'detached',
        updatedAt: NOW,
      })
      .run();
    await expect(service.sessionConnections(OWNER, 'session-a')).resolves.toMatchObject({
      connections: [
        { connectionId: 'connection-a', access: 'disabled', dominatingReason: 'session_detached' },
      ],
    });

    db.update(sessionConnectionOverrides)
      .set({ state: 'attached' })
      .where(eq(sessionConnectionOverrides.sessionId, 'session-a'))
      .run();
    db.update(connections).set({ enabled: false }).where(eq(connections.id, 'connection-a')).run();
    await expect(service.sessionConnections(OWNER, 'session-a')).resolves.toMatchObject({
      connections: [{ access: 'disabled', dominatingReason: 'connection_paused' }],
    });
  });

  it('derives managed synchronization only from each scope current command', async () => {
    db.update(connectorProviderInstances)
      .set({ mode: 'managed' })
      .where(eq(connectorProviderInstances.id, PROVIDER_ID))
      .run();
    db.insert(connectorManagedAuthorityOutbox)
      .values([
        {
          connectionId: 'connection-a',
          providerInstanceId: PROVIDER_ID,
          executionConfigGeneration: 1,
          ownerKind: OWNER.kind,
          ownerId: OWNER.installationId,
          commandId: 'old-rejected',
          managedConnectionId: 'private-account-a',
          scopeKind: 'connection_lifecycle',
          subjectId: 'connection',
          scopeVersion: 1,
          requestHash: 'old',
          requestJson: '{}',
          state: 'rejected',
          safeReason: 'Old failure',
          attemptCount: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          connectionId: 'connection-a',
          providerInstanceId: PROVIDER_ID,
          executionConfigGeneration: 1,
          ownerKind: OWNER.kind,
          ownerId: OWNER.installationId,
          commandId: 'current-applied',
          managedConnectionId: 'private-account-a',
          scopeKind: 'connection_lifecycle',
          subjectId: 'connection',
          scopeVersion: 2,
          requestHash: 'current',
          requestJson: '{}',
          state: 'applied',
          attemptCount: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ])
      .run();
    db.insert(connectorManagedAuthorityScopes)
      .values({
        managedConnectionId: 'private-account-a',
        scopeKind: 'connection_lifecycle',
        subjectId: 'connection',
        scopeVersion: 2,
        lastCommandId: 'current-applied',
        lastCommandHash: 'current',
        updatedAt: NOW,
      })
      .run();

    expect((await service.listConnections(OWNER))[0]?.authoritySync).toEqual({ status: 'ready' });
    db.update(connectorManagedAuthorityOutbox)
      .set({ state: 'pending' })
      .where(eq(connectorManagedAuthorityOutbox.commandId, 'current-applied'))
      .run();
    expect((await service.listConnections(OWNER))[0]?.authoritySync).toEqual({ status: 'pending' });
    await expect(service.sessionConnections(OWNER, 'session-a')).resolves.toMatchObject({
      connections: [{ access: 'disabled', dominatingReason: 'authority_sync_required' }],
    });
    db.insert(sessionConnectionOverrides)
      .values({
        sessionId: 'session-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        state: 'attached',
        updatedAt: NOW,
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'session-grant',
        subjectType: 'session',
        subjectId: 'session-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        operationRevisionId: 'revision-a',
        createdBy: 'operator',
        createdAt: NOW,
      })
      .run();
    await expect(service.sessionConnections(OWNER, 'session-a')).resolves.toMatchObject({
      connections: [{ access: 'disabled', dominatingReason: 'authority_sync_required' }],
    });
    db.update(connectorManagedAuthorityOutbox)
      .set({ state: 'applied' })
      .where(eq(connectorManagedAuthorityOutbox.commandId, 'current-applied'))
      .run();
    await expect(service.sessionConnections(OWNER, 'session-a')).resolves.toMatchObject({
      connections: [
        { access: 'session_only', dominatingReason: 'none', operationRevisionIds: ['revision-a'] },
      ],
    });
  });

  it('uses hosted authoritative counts for managed connections and reports unavailability honestly', async () => {
    db.update(connectorProviderInstances)
      .set({ mode: 'managed' })
      .where(eq(connectorProviderInstances.id, PROVIDER_ID))
      .run();
    const listManagedConnectorUsage = vi.fn().mockResolvedValue({
      version: 1,
      status: 'available',
      counts: { logicalOperationCount: 8, attemptCount: 11 },
      items: [],
    });
    const managedService = new ConnectorOperatorQueryService({
      db,
      registry,
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => true },
      managedUsage: { listManagedConnectorUsage },
    });

    await expect(managedService.listConnections(OWNER)).resolves.toEqual([
      expect.objectContaining({
        usage: { status: 'available', logicalOperationCount: 8, attemptCount: 11 },
      }),
    ]);
    expect(listManagedConnectorUsage).toHaveBeenCalledWith(
      { version: 1, managedConnectionId: 'private-account-a', limit: 1 },
      expect.any(AbortSignal)
    );

    listManagedConnectorUsage.mockRejectedValueOnce(new Error('cloud unavailable'));
    await expect(managedService.listConnections(OWNER)).resolves.toEqual([
      expect.objectContaining({
        usage: { status: 'unavailable', reason: 'Managed usage is temporarily unavailable.' },
      }),
    ]);
  });
});
