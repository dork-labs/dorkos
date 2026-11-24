/**
 * Seed rows and the per-test harness for the ConnectorOperatorQueryService tests.
 */
import { beforeEach } from 'vitest';
import {
  agents,
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorOperatorQueryService } from '../../resources/operator-query-service.js';
import { ConnectorRegistry } from '../../registry.js';

export const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;

export const FOREIGN_OWNER = { kind: 'local_install', installationId: 'install-b' } as const;

export const PROVIDER_ID = ConnectorProviderInstanceIdSchema.parse('provider-a');

export const NOW = '2026-09-06T18:00:00.000Z';

/** The shared per-test state and helpers every connector-operator-query-service piece uses. */
export function useOperatorQueryHarness() {
  const h = {
    db: undefined as unknown as Db,
    registry: undefined as unknown as ConnectorRegistry,
    service: undefined as unknown as ConnectorOperatorQueryService,
    provider: undefined as unknown as FakeConnectorProvider,
  };

  beforeEach(() => {
    h.db = createDb(':memory:');
    runMigrations(h.db);
    h.registry = new ConnectorRegistry({
      db: h.db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    h.provider = new FakeConnectorProvider({
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
    h.registry.register(h.provider, 'material-a');
    h.db
      .insert(agents)
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
    h.db
      .insert(connections)
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
    h.db
      .insert(connectorOperationRevisions)
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
    h.db
      .insert(connectionOperationGrants)
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
    h.service = new ConnectorOperatorQueryService({
      db: h.db,
      registry: h.registry,
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

  return h;
}
