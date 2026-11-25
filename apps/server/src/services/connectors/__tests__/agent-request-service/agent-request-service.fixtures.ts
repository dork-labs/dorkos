/**
 * Shared seed data and the per-test harness for the ConnectorAgentRequestService tests.
 */
import { beforeEach, vi } from 'vitest';
import {
  connectionOperationGrants,
  connectorAgentRequests,
  eq,
  connectorOperationRevisions,
  connectorProviderInstances,
  connections,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import type {
  ConnectionId,
  ConnectorAgentConnectionRequestInput,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorEventDefinition } from '@dorkos/shared/connector-event-schemas';
import type { ConnectorEventCapability } from '@dorkos/shared/connector-events';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import type { ConnectorEventGrantPort } from '../../events/grant-port.js';
import { ConnectorEventGrantService } from '../../events/grant-service.js';
import { ConnectorSubscriptionService } from '../../events/subscription-service.js';
import { ConnectorSubscriptionStore } from '../../events/subscription-store.js';
import {
  ConnectorAgentRequestService,
  ConnectorAgentRequestSourceAdapter,
  type ConnectorAgentRequestAuthorityPort,
} from '../../agent-request-service.js';
import {
  createServerPrincipal,
  type ServerPrincipalProof,
} from '../../principal/server-principal.js';
import { type ConnectorServiceDirectory } from '../../resources/operator-query-service.js';
import { MessageQueueStore } from '../../../session/message-queue-store.js';
import { PrivateSessionMessageAcceptanceService } from '../../../session/private-messages/acceptance.js';

export const OWNER = { kind: 'local_install', installationId: 'install-1' } as const;

export const NOW = new Date('2026-09-07T12:00:00.000Z');

export const CONNECTION_ID = 'connection-1' as ConnectionId;

export const INPUT: ConnectorAgentConnectionRequestInput = {
  version: 1,
  serviceSlug: 'gmail',
  reason: 'Read new mail and prepare a summary',
  access: 'read',
  requestedEvents: [],
};

/** The same ask, for read and write. */
export const READ_WRITE: ConnectorAgentConnectionRequestInput = { ...INPUT, access: 'read-write' };

/** The owner's answer: the access the agent already holds on the seeded account. */
export const CURRENT_ACCESS = { decision: 'current_access', connectionId: CONNECTION_ID } as const;

/** The one event scope the event-decision tests ask for: Gmail's new mail, to the agent. */
export const EVENT_SCOPE = {
  connectionId: CONNECTION_ID,
  definitionId: 'definition-1',
  filter: {},
  agentId: 'agent-1',
  destination: { kind: 'agent' as const, id: 'agent-1' },
};

/** An event port's `describe` that reads every scope as Gmail's new-mail event. */
export function describeAsMessageReceived() {
  return vi.fn<ConnectorEventGrantPort['describe']>((_owner, scopes) =>
    scopes.map((scope) => ({
      definitionId: scope.definitionId,
      eventType: 'gmail.message_received',
    }))
  );
}

export function directory(
  services: ReadonlyArray<readonly [string, string]>
): ConnectorServiceDirectory {
  return {
    services: services.map(([serviceSlug, displayName]) => ({
      serviceSlug,
      displayName,
      requestable: true,
      reached: true,
    })),
    warnings: [],
    routeTypes: ['composio'],
    reachProblem: 'app_not_reached',
  };
}

export function principal(
  overrides: Partial<Extract<ServerPrincipalProof['claims'], { kind: 'runtime' }>> = {}
) {
  return createServerPrincipal({
    kind: 'runtime',
    owner: OWNER,
    bindingId: 'binding-1',
    runtime: 'claude-code',
    canonicalSessionId: 'session-1',
    agentId: 'agent-1',
    agentPath: '/agents/researcher',
    ...overrides,
  });
}

function seedConnection(
  db: Db,
  options: { mode?: 'byo' | 'managed'; ownerId?: string } = {}
): void {
  db.insert(connectorProviderInstances)
    .values({
      id: 'provider-1',
      type: 'test',
      mode: options.mode ?? 'byo',
      displayName: 'Test provider',
      custody: options.mode === 'managed' ? 'managed' : 'self-host',
      capabilityJson: '{}',
      executionConfigGeneration: 1,
      ownerKind: 'local_install',
      ownerId: options.ownerId ?? OWNER.installationId,
      status: 'available',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
  db.insert(connections)
    .values({
      id: 'connection-1',
      providerInstanceId: 'provider-1',
      externalAccountRef: 'private-account-ref',
      toolkit: 'gmail',
      label: 'Work mail',
      status: 'active',
      lifecycleState: 'connected',
      enabled: true,
      grantReconciliationStatus: 'ready',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
  for (const [id, operationSlug] of [
    ['revision-read', 'gmail.read'],
    ['revision-draft', 'gmail.draft'],
    ['revision-delete', 'gmail.delete'],
  ] as const) {
    db.insert(connectorOperationRevisions)
      .values({
        id,
        providerInstanceId: 'provider-1',
        toolkit: 'gmail',
        operationSlug,
        toolkitVersion: '1',
        schemaHash: `hash-${id}`,
        capabilityClassification: operationSlug.endsWith('delete')
          ? 'destructive'
          : operationSlug.endsWith('draft')
            ? 'write'
            : 'read',
        retryPolicy: 'never',
        providerRevisionRef: `hosted-${id}`,
        inputSchemaJson: '{}',
        discoveredAt: NOW.toISOString(),
      })
      .run();
  }
}

/**
 * A second Gmail account, `connection-2`, on a route of its own whose actions
 * are exactly `revisions`: a read-only one, or one whose every change action
 * is destructive (no level covers it), the shape Linear has (DOR-4193).
 */
export function seedSecondAccount(
  db: Db,
  revisions: ReadonlyArray<readonly [string, 'read' | 'write' | 'destructive']>
): void {
  const stamp = NOW.toISOString();
  db.insert(connectorProviderInstances)
    .values({
      id: 'provider-2',
      type: 'test',
      mode: 'byo',
      displayName: 'Second provider',
      custody: 'self-host',
      capabilityJson: '{}',
      executionConfigGeneration: 1,
      ownerKind: 'local_install',
      ownerId: OWNER.installationId,
      status: 'available',
      createdAt: stamp,
      updatedAt: stamp,
    })
    .run();
  db.insert(connections)
    .values({
      id: 'connection-2',
      providerInstanceId: 'provider-2',
      externalAccountRef: 'private-account-ref-2',
      toolkit: 'gmail',
      label: 'Second mail',
      status: 'active',
      lifecycleState: 'connected',
      enabled: true,
      grantReconciliationStatus: 'ready',
      createdAt: stamp,
      updatedAt: stamp,
    })
    .run();
  for (const [revisionId, classification] of revisions) {
    db.insert(connectorOperationRevisions)
      .values({
        id: revisionId,
        providerInstanceId: 'provider-2',
        toolkit: 'gmail',
        operationSlug: `gmail.${revisionId}`,
        toolkitVersion: '1',
        schemaHash: `hash-${revisionId}`,
        capabilityClassification: classification,
        retryPolicy: 'never',
        providerRevisionRef: `hosted-${revisionId}`,
        inputSchemaJson: '{}',
        discoveredAt: stamp,
      })
      .run();
  }
}

/** The stored row behind one agent request. */
export function requestRow(db: Db, requestId: string) {
  return db
    .select()
    .from(connectorAgentRequests)
    .where(eq(connectorAgentRequests.id, requestId))
    .get();
}

/** The shared per-test state and helpers every agent-request-service piece uses. */
export function useAgentRequestHarness() {
  let id: number;
  const h = {
    db: undefined as unknown as Db,
    authorityLive: undefined as unknown as boolean,
    authority: undefined as unknown as ConnectorAgentRequestAuthorityPort,
    clock: undefined as unknown as Date,
    nudges: undefined as unknown as string[],
    service,
    serviceWithFollowUps,
    grantLive,
    realEventGrants,
  };

  beforeEach(() => {
    h.db = createDb(':memory:');
    runMigrations(h.db);
    seedConnection(h.db);
    h.authorityLive = true;
    h.clock = NOW;
    id = 0;
    h.nudges = [];
    h.authority = {
      revalidateOrigin: vi.fn(async () => h.authorityLive),
      revalidateOriginSync: vi.fn(() => h.authorityLive),
      resolveAgent: vi.fn((_owner, agentId) =>
        agentId === 'agent-1' ? { id: agentId, displayName: 'Researcher' } : undefined
      ),
    };
  });

  function service(
    overrides: Partial<ConstructorParameters<typeof ConnectorAgentRequestService>[0]> = {}
  ): ConnectorAgentRequestService {
    return new ConnectorAgentRequestService({
      db: h.db,
      services: {
        serviceDirectory: vi.fn(async () =>
          directory([
            ['gmail', 'Gmail'],
            ['slack', 'Slack'],
          ])
        ),
      },
      runtimePrincipals: { revalidatePrincipal: vi.fn(async () => true) },
      authority: h.authority,
      bootEpoch: 'boot-a',
      now: () => h.clock,
      createId: () => `id-${++id}`,
      createSecret: () => 'resume-secret',
      resume: {
        accept: vi.fn(),
        nudge: (sessionId) => h.nudges.push(sessionId),
      },
      ...overrides,
    });
  }

  /** A service whose follow-ups land in a real acceptance queue, the way the server wires it. */
  function serviceWithFollowUps(
    overrides: Partial<ConstructorParameters<typeof ConnectorAgentRequestService>[0]> = {}
  ) {
    const bootEpoch = overrides.bootEpoch ?? 'boot-a';
    const acceptance = new PrivateSessionMessageAcceptanceService(
      h.db,
      new MessageQueueStore(h.db),
      [new ConnectorAgentRequestSourceAdapter(h.db, h.authority, bootEpoch)],
      bootEpoch,
      () => h.clock
    );
    const requests = h.service({
      ...overrides,
      resume: {
        accept: (ref) => {
          acceptance.accept(ref);
        },
        nudge: (sessionId) => h.nudges.push(sessionId),
      },
    });
    return { acceptance, requests };
  }

  /** Give the agent live grants the way the shared access card's save would. */
  function grantLive(revisionIds: string[], connectionId = 'connection-1'): void {
    for (const operationRevisionId of revisionIds) {
      h.db
        .insert(connectionOperationGrants)
        .values({
          id: `grant-${operationRevisionId}`,
          subjectType: 'agent',
          subjectId: 'agent-1',
          agentId: 'agent-1',
          connectionId,
          operationRevisionId,
          createdBy: 'local_install:install-1',
          createdAt: NOW.toISOString(),
        })
        .run();
    }
  }

  function realEventGrants(
    count: number,
    probes: {
      /** Whether the destination check at each call (0-based) passes. */
      authorize?: (call: number) => boolean;
      /** Throws to fail a trigger at the service for the given call (0-based) or update. */
      reconcileTrigger?: (call: number, eventType: string) => void;
    } = {}
  ) {
    let triggerCalls = 0;
    const store = new ConnectorSubscriptionStore(h.db);
    const definitions: ConnectorEventDefinition[] = Array.from({ length: count }, (_, index) => ({
      eventType: `gmail.event_${index}`,
      displayName: `Event ${index}`,
      toolkit: 'gmail',
      toolkitVersion: '1',
      definitionHash: `sha256:${index.toString(16).padStart(64, '0')}`,
      filterSchema: { type: 'object', additionalProperties: false },
      payloadSchema: { type: 'object' },
      deliveryMode: 'webhook',
      expectedCadenceSeconds: null,
    }));
    const discovered = store.discover(
      store.connection(OWNER, CONNECTION_ID),
      definitions,
      NOW.toISOString()
    );
    const events: ConnectorEventCapability = {
      listDefinitions: vi.fn<ConnectorEventCapability['listDefinitions']>(async () => ({
        status: 'ok',
        definitions,
      })),
      reconcileTrigger: vi.fn<ConnectorEventCapability['reconcileTrigger']>(async (input) => {
        probes.reconcileTrigger?.(triggerCalls++, input.definition.eventType);
        return {
          status: 'found' as const,
          trigger: {
            providerTriggerRef: `trigger-${input.definition.eventType}`,
            externalAccountRef: input.externalAccountRef,
            enabled: true,
          },
        };
      }),
      createTrigger: vi.fn<ConnectorEventCapability['createTrigger']>(async () => ({
        status: 'error' as const,
        code: 'PROVIDER_PRECHECK_FAILED' as const,
      })),
      setTriggerEnabled: vi.fn<ConnectorEventCapability['setTriggerEnabled']>(async () => ({
        status: 'ok',
      })),
      deleteTrigger: vi.fn<ConnectorEventCapability['deleteTrigger']>(async () => ({
        status: 'ok',
      })),
      verifyWebhook: vi.fn<ConnectorEventCapability['verifyWebhook']>(async () => ({
        status: 'rejected',
        code: 'not_used',
      })),
    };
    const providerRegistry = {
      resolveProviderInstance: () => ({ events }) as ConnectorProvider,
    };
    let authorizeCalls = 0;
    const destinations = {
      authorize: vi.fn(async () => probes.authorize?.(authorizeCalls++) ?? true),
    };
    const subscriptions = new ConnectorSubscriptionService(
      store,
      providerRegistry,
      destinations,
      () => NOW.toISOString()
    );
    return {
      store,
      subscriptions,
      grants: new ConnectorEventGrantService(
        store,
        subscriptions,
        destinations,
        { reconcile: vi.fn(async () => false), ready: vi.fn(() => false), stage: vi.fn() },
        () => NOW.toISOString()
      ),
      scopes: discovered.map((definition) => ({
        connectionId: CONNECTION_ID,
        definitionId: definition.id,
        filter: {},
        agentId: 'agent-1',
        destination: { kind: 'agent' as const, id: 'agent-1' },
      })),
    };
  }
  return h;
}
