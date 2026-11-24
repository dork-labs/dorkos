/**
 * Seed rows, the scripted cloud and the per-test harness for the ManagedAuthoritySyncService tests.
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '@dorkos/shared/capabilities';
import { ConnectorSubscriptionStore } from '../../events/subscription-store.js';
import { ConnectorSubscriptionService } from '../../events/subscription-service.js';
import { ConnectorEventGrantService } from '../../events/grant-service.js';
import { beforeEach, vi } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import type {
  ManagedConnectorAuthorityCommand,
  ManagedConnectorAuthorityCommandStatus,
} from '@dorkos/shared/connector-managed-schemas';
import {
  ConnectionIdSchema,
  ConnectorProviderInstanceIdSchema,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import {
  ManagedAuthoritySyncService,
  type ManagedAuthorityCloudPort,
} from '../../resources/managed-authority-sync-service.js';
import { ConnectorRegistry } from '../../registry.js';

export const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;

export const PROVIDER_ID = ConnectorProviderInstanceIdSchema.parse('provider-a');

export const CONNECTION_ID = ConnectionIdSchema.parse('connection-a');

export const MANAGED_CONNECTION_ID = 'managed-connection-a';

export const START = Date.parse('2026-09-06T18:00:00.000Z');

export function statusFor(
  command: ManagedConnectorAuthorityCommand,
  state: 'pending' | 'applied' = 'applied'
): ManagedConnectorAuthorityCommandStatus {
  return state === 'pending'
    ? {
        version: 1,
        commandId: command.commandId,
        managedConnectionId: command.managedConnectionId,
        scopeVersion: command.scopeVersion,
        state,
      }
    : {
        version: 1,
        commandId: command.commandId,
        managedConnectionId: command.managedConnectionId,
        scopeVersion: command.scopeVersion,
        state,
        externalCleanup: 'not_required',
        ...(command.kind === 'set_event_subscription' && {
          appliedEventScopeHash: createHash('sha256')
            .update(stableStringify(command))
            .digest('hex'),
        }),
      };
}

export function cloudError(code: string, privateMessage = 'private hosted detail') {
  return Object.assign(new Error(privateMessage), { code });
}

/** The one account's lifecycle change, as the connection service hands it to the sync. */
export function lifecycleChange(lifecycle: 'active' | 'paused' | 'disconnected') {
  return {
    connectionId: CONNECTION_ID,
    managedConnectionId: MANAGED_CONNECTION_ID,
    lifecycle,
    providerInstanceId: PROVIDER_ID,
    executionConfigGeneration: 1,
    owner: OWNER,
    signal: new AbortController().signal,
  };
}

/** The shared per-test state and helpers every managed-authority-sync-service piece uses. */
export function useManagedAuthoritySyncHarness() {
  const h = {
    db: undefined as unknown as Db,
    registry: undefined as unknown as ConnectorRegistry,
    clock: undefined as unknown as number,
    ids: undefined as unknown as number,
    submitted: undefined as unknown as ManagedConnectorAuthorityCommand[],
    cloud: undefined as unknown as ManagedAuthorityCloudPort,
    service,
    replace,
    eventReview,
  };

  beforeEach(() => {
    h.db = createDb(':memory:');
    runMigrations(h.db);
    h.registry = new ConnectorRegistry({
      db: h.db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    h.registry.register(
      new FakeConnectorProvider({ instanceId: PROVIDER_ID, custody: 'managed' }),
      'managed-material-a',
      'managed'
    );
    h.db
      .insert(connections)
      .values({
        id: CONNECTION_ID,
        providerInstanceId: PROVIDER_ID,
        externalAccountRef: MANAGED_CONNECTION_ID,
        toolkit: 'gmail',
        label: 'Work Gmail',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: new Date(START).toISOString(),
        updatedAt: new Date(START).toISOString(),
      })
      .run();
    h.db
      .insert(connectorOperationRevisions)
      .values({
        id: 'revision-send',
        providerInstanceId: PROVIDER_ID,
        toolkit: 'gmail',
        operationSlug: 'gmail.send',
        toolkitVersion: 'v1',
        schemaHash: 'sha256:send',
        providerRevisionRef: '10000000-0000-4000-8000-000000000001',
        capabilityClassification: 'write',
        retryPolicy: 'never',
        inputSchemaJson: '{"type":"object"}',
        discoveredAt: new Date(START).toISOString(),
      })
      .run();
    h.clock = START;
    h.ids = 0;
    h.submitted = [];
    h.cloud = {
      submitConnectorAuthorityCommand: vi.fn(async (command) => {
        h.submitted.push(command);
        return statusFor(command);
      }),
      readConnectorAuthorityCommand: vi.fn(async () => {
        throw cloudError('not_found');
      }),
      // A refusal (`unauthorized`) here stands for one the link's key check
      // backed up, so the key is gone; a test that keeps it says so.
      isLinked: () => false,
    };
  });

  function service(): ManagedAuthoritySyncService {
    return new ManagedAuthoritySyncService({
      db: h.db,
      cloud: h.cloud,
      now: () => new Date(h.clock),
      createId: () => `managed-command-${++h.ids}`,
      random: () => 0.5,
    });
  }

  function replace(sync = h.service()) {
    return sync.replaceAgentGrants({
      connectionId: CONNECTION_ID,
      managedConnectionId: MANAGED_CONNECTION_ID,
      agentId: 'agent-a',
      revisions: [
        {
          hostedRevisionId: '10000000-0000-4000-8000-000000000001',
          operationSlug: 'gmail.send',
          toolkitVersion: 'v1',
          schemaHash: 'sha256:send',
        },
      ],
      operationRevisionIds: ['revision-send'],
      providerInstanceId: PROVIDER_ID,
      executionConfigGeneration: 1,
      owner: OWNER,
      signal: new AbortController().signal,
    });
  }

  function eventReview(sync = h.service()) {
    const store = new ConnectorSubscriptionStore(h.db);
    const [definition] = store.discover(
      store.connection(OWNER, CONNECTION_ID),
      [
        {
          eventType: 'GMAIL_NEW_MESSAGE',
          displayName: 'New message',
          toolkit: 'gmail',
          toolkitVersion: 'v1',
          definitionHash: `sha256:${'a'.repeat(64)}`,
          filterSchema: { type: 'object', properties: {}, additionalProperties: false },
          payloadSchema: { type: 'object' },
          deliveryMode: 'polling',
          expectedCadenceSeconds: null,
          providerDefinitionRef: '10000000-0000-4000-8000-000000000099',
        },
      ],
      new Date(h.clock).toISOString()
    );
    const destinations = { authorize: () => true };
    const subscriptions = new ConnectorSubscriptionService(
      store,
      { resolveProviderInstance: () => undefined },
      destinations
    );
    const grants = new ConnectorEventGrantService(
      store,
      subscriptions,
      destinations,
      {
        reconcile: (id, version, signal) => sync.reconcileEventSubscription(id, version, signal),
        ready: (id, version) => sync.eventSubscriptionReady(id, version),
        stage: (id, version) => sync.stageEventSubscriptionChange(id, version),
      },
      () => new Date(h.clock).toISOString()
    );
    const review = {
      reviewId: 'durable-owner-event-review',
      scopes: [
        {
          connectionId: CONNECTION_ID,
          definitionId: definition!.id,
          filter: {},
          agentId: 'agent-a',
          destination: { kind: 'agent' as const, id: 'agent-a' },
        },
      ],
    };
    return { store, grants, review, sync, signal: new AbortController().signal };
  }
  return h;
}

/** State and helpers for the "refused changes are never a dead end" tests. */
export function useRefusedChangesHarness(h: ReturnType<typeof useManagedAuthoritySyncHarness>) {
  const r = {
    grants: () =>
      h.db
        .select({
          operationRevisionId: connectionOperationGrants.operationRevisionId,
          revokedAt: connectionOperationGrants.revokedAt,
        })
        .from(connectionOperationGrants)
        .all(),
    rejected,
  };

  function rejected(
    command: ManagedConnectorAuthorityCommand,
    rejectionCode: 'connection_unavailable' | 'revision_unavailable' | 'scope_conflict'
  ): ManagedConnectorAuthorityCommandStatus {
    return {
      version: 1,
      commandId: command.commandId,
      managedConnectionId: command.managedConnectionId,
      scopeVersion: command.scopeVersion,
      state: 'rejected',
      rejectionCode,
    };
  }
  return r;
}
