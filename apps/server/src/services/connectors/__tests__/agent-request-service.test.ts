import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connectorAgentRequests,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorReviewRequests,
  connections,
  createDb,
  eq,
  ne,
  runMigrations,
  sessionMessageAcceptanceReceipts,
  type Db,
} from '@dorkos/db';
import type {
  ConnectionId,
  ConnectorAgentConnectionRequestInput,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorEventDefinition } from '@dorkos/shared/connector-event-schemas';
import type { ConnectorEventCapability } from '@dorkos/shared/connector-events';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import type { ConnectorEventGrantPort } from '../events/grant-port.js';
import { ConnectorEventGrantService } from '../events/grant-service.js';
import { ConnectorSubscriptionService } from '../events/subscription-service.js';
import { ConnectorSubscriptionStore } from '../events/subscription-store.js';
import {
  ConnectorAgentRequestService,
  ConnectorAgentRequestSourceAdapter,
  type ConnectorAgentRequestAuthorityPort,
} from '../agent-request-service.js';
import { createServerPrincipal, type ServerPrincipalProof } from '../principal/server-principal.js';
import type { ConnectorRegistry } from '../registry.js';
import { MessageQueueStore } from '../../session/message-queue-store.js';
import { PrivateSessionMessageAcceptanceService } from '../../session/private-messages/acceptance.js';

const OWNER = { kind: 'local_install', installationId: 'install-1' } as const;
const NOW = new Date('2026-09-07T12:00:00.000Z');
const CONNECTION_ID = 'connection-1' as ConnectionId;
const INPUT: ConnectorAgentConnectionRequestInput = {
  version: 1,
  serviceSlug: 'gmail',
  reason: 'Read new mail and prepare a summary',
  requestedOperations: ['gmail.read', 'gmail.draft'],
  requestedEvents: [],
};

function principal(
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
        capabilityClassification: operationSlug.endsWith('delete') ? 'destructive' : 'read',
        retryPolicy: 'never',
        providerRevisionRef: `hosted-${id}`,
        inputSchemaJson: '{}',
        discoveredAt: NOW.toISOString(),
      })
      .run();
  }
}

describe('ConnectorAgentRequestService', () => {
  let db: Db;
  let authorityLive: boolean;
  let authority: ConnectorAgentRequestAuthorityPort;
  let clock: Date;
  let id: number;
  let nudges: string[];

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    seedConnection(db);
    authorityLive = true;
    clock = NOW;
    id = 0;
    nudges = [];
    authority = {
      revalidateOrigin: vi.fn(async () => authorityLive),
      revalidateOriginSync: vi.fn(() => authorityLive),
      resolveAgent: vi.fn((_owner, agentId) =>
        agentId === 'agent-1' ? { id: agentId, displayName: 'Researcher' } : undefined
      ),
    };
  });

  function service(
    overrides: Partial<ConstructorParameters<typeof ConnectorAgentRequestService>[0]> = {}
  ): ConnectorAgentRequestService {
    return new ConnectorAgentRequestService({
      db,
      registry: {
        listToolkits: vi.fn(async () => ({
          toolkits: [{ slug: 'gmail', name: 'Gmail' }],
          warnings: [],
        })),
      } as unknown as ConnectorRegistry,
      runtimePrincipals: { revalidatePrincipal: vi.fn(async () => true) },
      authority,
      bootEpoch: 'boot-a',
      now: () => clock,
      createId: () => `id-${++id}`,
      createSecret: () => 'resume-secret',
      resume: {
        accept: vi.fn(),
        nudge: (sessionId) => nudges.push(sessionId),
      },
      ...overrides,
    });
  }

  function realEventGrants(count: number) {
    const store = new ConnectorSubscriptionStore(db);
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
      reconcileTrigger: vi.fn<ConnectorEventCapability['reconcileTrigger']>(async (input) => ({
        status: 'found' as const,
        trigger: {
          providerTriggerRef: `trigger-${input.definition.eventType}`,
          externalAccountRef: input.externalAccountRef,
          enabled: true,
        },
      })),
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
    const destinations = { authorize: vi.fn(() => true) };
    const subscriptions = new ConnectorSubscriptionService(
      store,
      providerRegistry,
      destinations,
      () => NOW.toISOString()
    );
    return {
      grants: new ConnectorEventGrantService(
        store,
        subscriptions,
        destinations,
        { reconcile: vi.fn(async () => false), ready: vi.fn(() => false) },
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

  it('creates one typed request without returning private account inventory and reuses its intent', async () => {
    const requests = service();

    const first = await requests.create(principal(), INPUT);
    const repeated = await requests.create(principal(), INPUT);

    expect(repeated.requestId).toBe(first.requestId);
    expect(first).toEqual(
      expect.objectContaining({
        status: 'awaiting_owner',
        serviceSlug: 'gmail',
        requestedOperations: ['gmail.read', 'gmail.draft'],
      })
    );
    expect(JSON.stringify(first)).not.toContain('private-account-ref');
    expect(JSON.stringify(first)).not.toContain('Work mail');
    expect(db.select().from(connectorReviewRequests).all()).toHaveLength(1);
    expect(db.select().from(connectorAgentRequests).all()).toHaveLength(1);
  });

  it('rejects a 33rd event before claiming operation or event authority', async () => {
    const { grants, scopes } = realEventGrants(33);
    const requests = service({ eventGrants: grants, resume: undefined });
    const eventNames = Array.from({ length: 32 }, (_, index) => `gmail.event_${index}`);

    await expect(
      requests.create(principal(), { ...INPUT, requestedEvents: [...eventNames, 'gmail.event_32'] })
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(db.select().from(connectorReviewRequests).all()).toEqual([]);

    const created = await requests.create(principal(), { ...INPUT, requestedEvents: eventNames });
    await expect(
      requests.resolve(OWNER, created.requestId, {
        decision: 'approved',
        connectionId: CONNECTION_ID,
        operationRevisionIds: ['revision-read'],
        eventScopes: scopes,
      })
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
    expect(
      db.$client.prepare('SELECT COUNT(*) AS count FROM connector_event_subscriptions').get()
    ).toEqual({ count: 0 });
    expect(
      db.$client.prepare('SELECT COUNT(*) AS count FROM connector_event_consent_commands').get()
    ).toEqual({ count: 0 });

    await expect(
      requests.resolve(OWNER, created.requestId, {
        decision: 'approved',
        connectionId: CONNECTION_ID,
        operationRevisionIds: ['revision-read'],
        eventScopes: scopes.slice(0, 32),
      })
    ).resolves.toMatchObject({ status: 'granted' });
    expect(db.select().from(connectionOperationGrants).all()).toHaveLength(1);
    expect(
      db.$client.prepare('SELECT COUNT(*) AS count FROM connector_event_subscriptions').get()
    ).toEqual({ count: 32 });
  });

  it('binds runtime status reads to the exact agent and session', async () => {
    const requests = service();
    const created = await requests.create(principal(), INPUT);

    await expect(
      requests.getForRuntime(principal({ canonicalSessionId: 'session-other' }), created.requestId)
    ).rejects.toMatchObject({ code: 'request_not_found' });
    await expect(
      requests.getForRuntime(principal({ agentId: 'agent-other' }), created.requestId)
    ).rejects.toMatchObject({ code: 'request_not_found' });
  });

  it('lets only the owner grant an exact requested revision set', async () => {
    const requests = service();
    const created = await requests.create(principal(), INPUT);

    await expect(
      requests.resolve({ kind: 'local_install', installationId: 'foreign' }, created.requestId, {
        decision: 'approved',
        connectionId: CONNECTION_ID,
        operationRevisionIds: ['revision-read'],
        eventScopes: [],
      })
    ).rejects.toMatchObject({ code: 'request_not_found' });
    await expect(
      requests.resolve(OWNER, created.requestId, {
        decision: 'approved',
        connectionId: CONNECTION_ID,
        operationRevisionIds: ['revision-delete'],
        eventScopes: [],
      })
    ).rejects.toMatchObject({ code: 'selection_invalid' });
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);

    const resolved = await requests.resolve(OWNER, created.requestId, {
      decision: 'approved',
      connectionId: CONNECTION_ID,
      operationRevisionIds: ['revision-read'],
      eventScopes: [],
    });

    expect(resolved).toMatchObject({
      status: 'granted',
      connectionId: CONNECTION_ID,
      grantedOperationRevisionIds: ['revision-read'],
    });
    expect(db.select().from(connectionOperationGrants).all()).toMatchObject([
      {
        agentId: 'agent-1',
        connectionId: CONNECTION_ID,
        operationRevisionId: 'revision-read',
        revokedAt: null,
      },
    ]);
  });

  it('resumes a live held request with the real result and leaves no fallback claim', async () => {
    const requests = service({ liveHoldMs: 5_000 });
    const created = await requests.create(principal(), INPUT);
    const held = requests.waitForResolution(principal(), created.requestId);
    await Promise.resolve();

    await requests.resolve(OWNER, created.requestId, {
      decision: 'approved',
      connectionId: CONNECTION_ID,
      operationRevisionIds: ['revision-read'],
      eventScopes: [],
    });

    await expect(held).resolves.toMatchObject({
      status: 'granted',
      connectionId: 'connection-1',
    });
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, created.requestId))
        .get()
    ).toMatchObject({ resumeState: 'resumed', liveHoldBootEpoch: null, liveHoldUntil: null });
    expect(nudges).toContain('session-1');
  });

  it('returns a live denial through the exact hold before clearing its claim', async () => {
    const requests = service({ liveHoldMs: 5_000 });
    const created = await requests.create(principal(), INPUT);
    const held = requests.waitForResolution(principal(), created.requestId);
    await Promise.resolve();

    await requests.resolve(OWNER, created.requestId, {
      decision: 'denied',
    });

    await expect(held).resolves.toMatchObject({ status: 'denied' });
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, created.requestId))
        .get()
    ).toMatchObject({ resumeState: 'resumed', liveHoldBootEpoch: null, liveHoldUntil: null });
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
  });

  it('keeps a duplicate live hold attached when the first caller aborts', async () => {
    const requests = service({ liveHoldMs: 5_000 });
    const created = await requests.create(principal(), INPUT);
    const firstController = new AbortController();
    const first = requests.waitForResolution(
      principal(),
      created.requestId,
      firstController.signal
    );
    const second = requests.waitForResolution(principal(), created.requestId);
    await new Promise<void>((resolve) => setImmediate(resolve));

    firstController.abort();
    await expect(first).resolves.toMatchObject({ status: 'awaiting_owner' });
    await requests.resolve(OWNER, created.requestId, { decision: 'denied' });

    await expect(second).resolves.toMatchObject({ status: 'denied' });
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, created.requestId))
        .get()
    ).toMatchObject({ resumeState: 'resumed', liveHoldBootEpoch: null, liveHoldUntil: null });
  });

  it('returns one durable terminal result to both attached live waits', async () => {
    const requests = service({ liveHoldMs: 5_000 });
    const created = await requests.create(principal(), INPUT);
    const first = requests.waitForResolution(principal(), created.requestId);
    const second = requests.waitForResolution(principal(), created.requestId);
    await new Promise<void>((resolve) => setImmediate(resolve));

    await requests.resolve(OWNER, created.requestId, { decision: 'denied' });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'denied' }),
      expect.objectContaining({ status: 'denied' }),
    ]);
    expect(nudges).toEqual(['session-1']);
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, created.requestId))
        .get()
    ).toMatchObject({ resumeState: 'resumed', liveHoldBootEpoch: null, liveHoldUntil: null });
  });

  it('attaches to a terminal result resolved between create and live wait', async () => {
    const requests = service({ liveHoldMs: 5_000 });
    const created = await requests.create(principal(), INPUT);
    await requests.resolve(OWNER, created.requestId, { decision: 'denied' });

    await expect(requests.waitForResolution(principal(), created.requestId)).resolves.toMatchObject(
      {
        status: 'denied',
      }
    );
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, created.requestId))
        .get()
    ).toMatchObject({ resumeState: 'resumed', liveHoldBootEpoch: null, liveHoldUntil: null });
  });

  it('does not let awaiting-owner rows hide a cold terminal result', async () => {
    const accept = vi.fn();
    const requests = service({ resume: { accept, nudge: vi.fn() } });
    const created = await Promise.all(
      Array.from({ length: 26 }, (_, index) =>
        requests.create(principal(), { ...INPUT, reason: `${INPUT.reason} ${index}` })
      )
    );
    const terminalRequestId = created
      .map((item) => item.requestId)
      .sort()
      .at(-1)!;
    await requests.resolve(OWNER, terminalRequestId, { decision: 'denied' });

    await requests.reconcile();

    expect(accept).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'connector_agent_request', requestId: terminalRequestId })
    );
  });

  it('rotates a bounded reconciliation page past blocked granted requests', async () => {
    const accept = vi.fn();
    const requests = service({ resume: { accept, nudge: vi.fn() } });
    const created = await Promise.all(
      Array.from({ length: 26 }, (_, index) =>
        requests.create(principal(), { ...INPUT, reason: `${INPUT.reason} ${index}` })
      )
    );
    const terminalRequestId = created
      .map((item) => item.requestId)
      .sort()
      .at(-1)!;
    db.update(connectorAgentRequests)
      .set({ outcome: 'granted' })
      .where(ne(connectorAgentRequests.id, terminalRequestId))
      .run();
    await requests.resolve(OWNER, terminalRequestId, { decision: 'denied' });

    await requests.reconcile();
    expect(accept).not.toHaveBeenCalled();
    await requests.reconcile();

    expect(accept).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'connector_agent_request', requestId: terminalRequestId })
    );
  });

  it('expires through maintenance, writes no grant, and can produce one terminal follow-up', async () => {
    const queue = new MessageQueueStore(db);
    const source = new ConnectorAgentRequestSourceAdapter(db, authority, 'boot-b');
    const acceptance = new PrivateSessionMessageAcceptanceService(
      db,
      queue,
      [source],
      'boot-b',
      () => clock
    );
    const requests = service({
      bootEpoch: 'boot-b',
      requestTtlMs: 1_000,
      resume: {
        accept: (ref) => {
          acceptance.accept(ref);
        },
        nudge: (sessionId) => nudges.push(sessionId),
      },
    });
    await requests.create(principal(), INPUT);
    clock = new Date(NOW.getTime() + 2_000);

    expect(await requests.reconcile()).toEqual({ expired: 1, accepted: 1, cancelled: 0 });
    expect(await requests.reconcile()).toEqual({ expired: 0, accepted: 0, cancelled: 0 });
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
    expect(db.select().from(sessionMessageAcceptanceReceipts).all()).toHaveLength(1);
    expect(
      await acceptance.prepare(db.select().from(sessionMessageAcceptanceReceipts).get()!.id)
    ).toMatchObject({ content: expect.stringContaining('expired') });
  });

  it('marks a removed origin terminal before any owner grant is written', async () => {
    const requests = service();
    const created = await requests.create(principal(), INPUT);
    authorityLive = false;

    await expect(
      requests.resolve(OWNER, created.requestId, {
        decision: 'approved',
        connectionId: CONNECTION_ID,
        operationRevisionIds: ['revision-read'],
        eventScopes: [],
      })
    ).rejects.toMatchObject({ code: 'request_not_found' });
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, created.requestId))
        .get()
    ).toMatchObject({ outcome: 'target_deleted', resumeState: 'ready' });
  });

  it('binds authentication to the exact owner request and derives its service and retry key', async () => {
    let savedFlow:
      | {
          flowId: string;
          providerInstanceId: string;
          toolkit: string;
          state: 'starting';
          createdAt: string;
          expiresAt: string;
        }
      | undefined;
    const authentication = {
      findByIdempotencyKey: vi.fn(() => savedFlow),
      start: vi.fn(async (_owner, input) => {
        savedFlow = {
          flowId: 'flow-1',
          providerInstanceId: input.providerInstanceId,
          toolkit: input.toolkit,
          state: 'starting',
          createdAt: NOW.toISOString(),
          expiresAt: '2026-09-07T12:15:00.000Z',
        };
        return savedFlow;
      }),
      poll: vi.fn(),
    };
    const requests = service({ authentication: authentication as never });
    const created = await requests.create(principal(), INPUT);

    const flow = await requests.startAuthentication(OWNER, created.requestId, {
      providerInstanceId: 'provider-1' as never,
      label: 'Work mail',
    });

    expect(flow.flowId).toBe('flow-1');
    expect(authentication.start).toHaveBeenCalledWith(OWNER, {
      providerInstanceId: 'provider-1',
      toolkit: 'gmail',
      label: 'Work mail',
      idempotencyKey: `agent-request:${created.requestId}`,
    });
    expect(
      db
        .select({ providerInstanceId: connectorReviewRequests.providerInstanceId })
        .from(connectorReviewRequests)
        .where(eq(connectorReviewRequests.id, `id-2`))
        .get()
    ).toEqual({ providerInstanceId: 'provider-1' });

    await expect(
      requests.startAuthentication(OWNER, created.requestId, {
        providerInstanceId: 'provider-other' as never,
      })
    ).rejects.toMatchObject({ code: 'selection_invalid' });
    expect(authentication.start).toHaveBeenCalledTimes(1);
  });

  it('makes an associated authentication failure terminal without writing grants', async () => {
    const starting = {
      flowId: 'flow-1',
      providerInstanceId: 'provider-1' as never,
      toolkit: 'gmail',
      state: 'starting' as const,
      createdAt: NOW.toISOString(),
      expiresAt: '2026-09-07T12:15:00.000Z',
    };
    const failed = {
      ...starting,
      state: 'failed' as const,
      reason: 'Sign-in was not completed.',
    };
    const authentication = {
      findByIdempotencyKey: vi.fn(() => starting),
      start: vi.fn(async () => starting),
      poll: vi.fn(async () => failed),
    };
    const requests = service({ authentication: authentication as never });
    const created = await requests.create(principal(), INPUT);
    await requests.startAuthentication(OWNER, created.requestId, {
      providerInstanceId: 'provider-1' as never,
    });

    await expect(
      requests.pollAuthentication(OWNER, created.requestId, 'foreign-flow')
    ).rejects.toMatchObject({ code: 'selection_invalid' });
    expect(authentication.poll).not.toHaveBeenCalled();

    await expect(requests.pollAuthentication(OWNER, created.requestId, 'flow-1')).resolves.toEqual(
      failed
    );
    expect(requests.getForOwner(OWNER, created.requestId).status).toBe('authentication_failed');
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
    expect(nudges).toEqual([]);
  });

  it('does not materialize authentication state for a foreign owner read', async () => {
    const failed = {
      flowId: 'flow-1',
      providerInstanceId: 'provider-1' as never,
      toolkit: 'gmail',
      state: 'failed' as const,
      reason: 'Sign-in was not completed.',
      createdAt: NOW.toISOString(),
      expiresAt: '2026-09-07T12:15:00.000Z',
    };
    const authentication = {
      findByIdempotencyKey: vi.fn(() => failed),
      start: vi.fn(),
      poll: vi.fn(),
    };
    const requests = service({ authentication: authentication as never });
    const created = await requests.create(principal(), INPUT);

    expect(() =>
      requests.getForOwner({ kind: 'local_install', installationId: 'foreign' }, created.requestId)
    ).toThrow(expect.objectContaining({ code: 'request_not_found' }));
    expect(authentication.findByIdempotencyKey).not.toHaveBeenCalled();
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, created.requestId))
        .get()
    ).toMatchObject({ outcome: null, resumeState: 'pending' });
  });

  it('keeps a connected authentication flow awaiting explicit owner grants', async () => {
    const starting = {
      flowId: 'flow-1',
      providerInstanceId: 'provider-1' as never,
      toolkit: 'gmail',
      state: 'starting' as const,
      createdAt: NOW.toISOString(),
      expiresAt: '2026-09-07T12:15:00.000Z',
    };
    const connected = {
      ...starting,
      state: 'connected' as const,
      connectionId: CONNECTION_ID,
    };
    const authentication = {
      findByIdempotencyKey: vi.fn(() => starting),
      start: vi.fn(async () => starting),
      poll: vi.fn(async () => connected),
    };
    const requests = service({ authentication: authentication as never });
    const created = await requests.create(principal(), INPUT);
    await requests.startAuthentication(OWNER, created.requestId, {
      providerInstanceId: 'provider-1' as never,
    });

    await expect(requests.pollAuthentication(OWNER, created.requestId, 'flow-1')).resolves.toEqual(
      connected
    );
    expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
  });

  it('refuses a provider poll result that no longer matches the durable request flow', async () => {
    const starting = {
      flowId: 'flow-1',
      providerInstanceId: 'provider-1' as never,
      toolkit: 'gmail',
      state: 'starting' as const,
      createdAt: NOW.toISOString(),
      expiresAt: '2026-09-07T12:15:00.000Z',
    };
    const mismatched = {
      ...starting,
      providerInstanceId: 'provider-other' as never,
      state: 'failed' as const,
      reason: 'Sign-in was not completed.',
    };
    const authentication = {
      findByIdempotencyKey: vi.fn(() => starting),
      start: vi.fn(async () => starting),
      poll: vi.fn(async () => mismatched),
    };
    const requests = service({ authentication: authentication as never });
    const created = await requests.create(principal(), INPUT);
    await requests.startAuthentication(OWNER, created.requestId, {
      providerInstanceId: 'provider-1' as never,
    });

    await expect(
      requests.pollAuthentication(OWNER, created.requestId, 'flow-1')
    ).rejects.toMatchObject({ code: 'selection_invalid' });
    expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
  });

  it('shows managed access as pending until the hosted authority ACK is applied', async () => {
    db.update(connectorProviderInstances)
      .set({ mode: 'managed', custody: 'managed' })
      .where(eq(connectorProviderInstances.id, 'provider-1'))
      .run();
    const stageAgentGrantReplacement = vi.fn(() => 'command-a');
    const deliverAgentGrantReplacement = vi.fn(async () => ({
      authoritySync: { status: 'pending' as const },
      applied: false,
      externalCleanup: 'not_required' as const,
    }));
    const requests = service({
      managedAuthority: { stageAgentGrantReplacement, deliverAgentGrantReplacement },
    });
    const created = await requests.create(principal(), INPUT);

    const resolved = await requests.resolve(OWNER, created.requestId, {
      decision: 'approved',
      connectionId: CONNECTION_ID,
      operationRevisionIds: ['revision-read'],
      eventScopes: [],
    });

    expect(resolved.status).toBe('access_pending');
    expect(stageAgentGrantReplacement).toHaveBeenCalledTimes(1);
    expect(deliverAgentGrantReplacement).toHaveBeenCalledWith('command-a', expect.any(AbortSignal));
  });

  it('reuses one durable managed command when the owner retries a pending decision', async () => {
    db.update(connectorProviderInstances)
      .set({ mode: 'managed', custody: 'managed' })
      .where(eq(connectorProviderInstances.id, 'provider-1'))
      .run();
    const stageAgentGrantReplacement = vi.fn(() => 'command-stable');
    const deliverAgentGrantReplacement = vi.fn(async () => ({
      authoritySync: { status: 'pending' as const },
      applied: false,
      externalCleanup: 'not_required' as const,
    }));
    const requests = service({
      managedAuthority: { stageAgentGrantReplacement, deliverAgentGrantReplacement },
    });
    const created = await requests.create(principal(), INPUT);
    const decision = {
      decision: 'approved' as const,
      connectionId: CONNECTION_ID,
      operationRevisionIds: ['revision-read'],
      eventScopes: [],
    };

    await requests.resolve(OWNER, created.requestId, decision);
    await requests.resolve(OWNER, created.requestId, decision);

    expect(stageAgentGrantReplacement).toHaveBeenCalledTimes(1);
    expect(deliverAgentGrantReplacement).toHaveBeenCalledTimes(1);
  });

  it('reuses the same unresolved intent while exact managed access is pending', async () => {
    db.update(connectorProviderInstances)
      .set({ mode: 'managed', custody: 'managed' })
      .where(eq(connectorProviderInstances.id, 'provider-1'))
      .run();
    const requests = service({
      managedAuthority: {
        stageAgentGrantReplacement: vi.fn(() => 'command-stable'),
        deliverAgentGrantReplacement: vi.fn(async () => ({
          authoritySync: { status: 'pending' as const },
          applied: false,
          externalCleanup: 'not_required' as const,
        })),
      },
    });
    const created = await requests.create(principal(), INPUT);
    await requests.resolve(OWNER, created.requestId, {
      decision: 'approved',
      connectionId: CONNECTION_ID,
      operationRevisionIds: ['revision-read'],
      eventScopes: [],
    });

    const repeated = await requests.create(principal(), INPUT);

    expect(repeated).toMatchObject({ requestId: created.requestId, status: 'access_pending' });
    expect(requests.listForOwner(OWNER, 'pending')).toHaveLength(1);
    expect(requests.listForOwner(OWNER, 'resolved')).toHaveLength(0);
    expect(db.select().from(connectorAgentRequests).all()).toHaveLength(1);
  });

  it('derives proposed event types from exact definitions and waits for the same review receipt', async () => {
    const eventInput = {
      ...INPUT,
      requestedEvents: ['gmail.message_received'],
    };
    let ready = false;
    const describe: ConnectorEventGrantPort['describe'] = (_owner, scopes) =>
      scopes.map((scope) => ({
        definitionId: scope.definitionId,
        eventType: 'gmail.message_received',
      }));
    const approve: ConnectorEventGrantPort['approve'] = async (_owner, review) => {
      const selections = review.scopes.map((scope) => ({
        subscriptionId: 'subscription-1',
        scopeVersion: 1,
        definitionId: scope.definitionId,
        eventScopeHash: 'a'.repeat(64),
      }));
      return ready
        ? { state: 'ready', selections, appliedEventScopeHash: 'b'.repeat(64) }
        : { state: 'pending', selections };
    };
    const eventGrants: ConnectorEventGrantPort = {
      describe: vi.fn(describe),
      approve: vi.fn(approve),
      ready: vi.fn(() => ready),
    };
    const requests = service({ eventGrants, resume: undefined });
    const created = await requests.create(principal(), eventInput);
    const eventScope = {
      connectionId: CONNECTION_ID,
      definitionId: 'definition-1',
      filter: {},
      agentId: 'agent-1',
      destination: { kind: 'agent' as const, id: 'agent-1' },
    };

    await expect(
      requests.resolve(OWNER, created.requestId, {
        decision: 'approved',
        connectionId: CONNECTION_ID,
        operationRevisionIds: ['revision-read'],
        eventScopes: [{ ...eventScope, agentId: 'agent-other' }],
      })
    ).rejects.toMatchObject({ code: 'selection_invalid' });
    expect(eventGrants.approve).not.toHaveBeenCalled();
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);

    const pending = await requests.resolve(OWNER, created.requestId, {
      decision: 'approved',
      connectionId: CONNECTION_ID,
      operationRevisionIds: ['revision-read'],
      eventScopes: [eventScope],
    });
    expect(pending.status).toBe('access_pending');
    expect(eventGrants.approve).toHaveBeenLastCalledWith(
      OWNER,
      expect.objectContaining({
        reviewId: expect.stringMatching(/^id-/),
        scopes: [eventScope],
      }),
      expect.any(AbortSignal)
    );

    ready = true;
    await expect(requests.reconcile()).resolves.toEqual({
      expired: 0,
      accepted: 0,
      cancelled: 0,
    });
    await expect(requests.getForRuntime(principal(), created.requestId)).resolves.toMatchObject({
      status: 'granted',
      grantedEvents: ['gmail.message_received'],
    });
    const stored = db
      .select()
      .from(connectorAgentRequests)
      .where(eq(connectorAgentRequests.id, created.requestId))
      .get();
    expect(JSON.parse(stored!.resolvedEventsJson!)).toEqual({
      appliedEventScopeHash: 'b'.repeat(64),
      selections: [
        {
          definitionId: 'definition-1',
          eventScopeHash: 'a'.repeat(64),
          scopeVersion: 1,
          subscriptionId: 'subscription-1',
        },
      ],
      version: 1,
    });
  });

  it('keeps a losing concurrent event decision free of authority side effects', async () => {
    let releaseFirstOrigin!: () => void;
    const firstOriginGate = new Promise<void>((resolve) => {
      releaseFirstOrigin = resolve;
    });
    let firstOriginEntered!: () => void;
    const firstOriginStarted = new Promise<void>((resolve) => {
      firstOriginEntered = resolve;
    });
    let originChecks = 0;
    vi.mocked(authority.revalidateOrigin).mockImplementation(async () => {
      originChecks += 1;
      if (originChecks === 1) {
        firstOriginEntered();
        await firstOriginGate;
      }
      return true;
    });
    let eventAuthorityWrites = 0;
    const eventScope = {
      connectionId: CONNECTION_ID,
      definitionId: 'definition-1',
      filter: {},
      agentId: 'agent-1',
      destination: { kind: 'agent' as const, id: 'agent-1' },
    };
    const eventGrants: ConnectorEventGrantPort = {
      describe: vi.fn<ConnectorEventGrantPort['describe']>((_owner, scopes) =>
        scopes.map((scope) => ({
          definitionId: scope.definitionId,
          eventType: 'gmail.message_received',
        }))
      ),
      approve: vi.fn(async () => {
        eventAuthorityWrites += 1;
        return {
          state: 'pending' as const,
          selections: [
            {
              subscriptionId: 'subscription-1',
              scopeVersion: 1,
              definitionId: eventScope.definitionId,
              eventScopeHash: 'a'.repeat(64),
            },
          ],
        };
      }),
      ready: vi.fn(() => false),
    };
    const requests = service({ eventGrants, resume: undefined });
    const created = await requests.create(principal(), {
      ...INPUT,
      requestedEvents: ['gmail.message_received'],
    });
    const eventDecision = requests.resolve(OWNER, created.requestId, {
      decision: 'approved',
      connectionId: CONNECTION_ID,
      operationRevisionIds: ['revision-read'],
      eventScopes: [eventScope],
    });
    await firstOriginStarted;

    await expect(
      requests.resolve(OWNER, created.requestId, {
        decision: 'approved',
        connectionId: CONNECTION_ID,
        operationRevisionIds: ['revision-read'],
        eventScopes: [],
      })
    ).resolves.toMatchObject({ status: 'granted', grantedEvents: [] });
    releaseFirstOrigin();
    await expect(eventDecision).rejects.toMatchObject({ code: 'request_already_resolved' });

    expect(eventAuthorityWrites).toBe(0);
    expect(db.select().from(connectionOperationGrants).all()).toHaveLength(1);
    expect(requests.getForOwner(OWNER, created.requestId)).toMatchObject({
      status: 'granted',
      grantedEvents: [],
    });
  });

  it('keeps concurrent approval and denial consistent with the one winning decision', async () => {
    const requests = service();
    const created = await requests.create(principal(), INPUT);

    const outcomes = await Promise.allSettled([
      requests.resolve(OWNER, created.requestId, {
        decision: 'approved',
        connectionId: CONNECTION_ID,
        operationRevisionIds: ['revision-read'],
        eventScopes: [],
      }),
      requests.resolve(OWNER, created.requestId, { decision: 'denied' }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const final = requests.getForOwner(OWNER, created.requestId);
    const grants = db.select().from(connectionOperationGrants).all();
    if (final.status === 'denied') {
      expect(grants).toEqual([]);
    } else {
      expect(final).toMatchObject({
        status: 'granted',
        grantedOperationRevisionIds: ['revision-read'],
      });
      expect(grants).toHaveLength(1);
    }
  });

  it('returns the same granted result to concurrent identical owner decisions', async () => {
    let releaseApprovals!: () => void;
    const approvalsReleased = new Promise<void>((resolve) => {
      releaseApprovals = resolve;
    });
    let approvalsEntered = 0;
    let releaseBothEntered!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      releaseBothEntered = resolve;
    });
    const eventScope = {
      connectionId: CONNECTION_ID,
      definitionId: 'definition-1',
      filter: {},
      agentId: 'agent-1',
      destination: { kind: 'agent' as const, id: 'agent-1' },
    };
    const eventGrants: ConnectorEventGrantPort = {
      describe: vi.fn<ConnectorEventGrantPort['describe']>((_owner, scopes) =>
        scopes.map((scope) => ({
          definitionId: scope.definitionId,
          eventType: 'gmail.message_received',
        }))
      ),
      approve: vi.fn(async () => {
        approvalsEntered += 1;
        if (approvalsEntered === 2) releaseBothEntered();
        await approvalsReleased;
        return {
          state: 'ready' as const,
          selections: [
            {
              subscriptionId: 'subscription-1',
              scopeVersion: 1,
              definitionId: eventScope.definitionId,
              eventScopeHash: 'a'.repeat(64),
            },
          ],
          appliedEventScopeHash: 'b'.repeat(64),
        };
      }),
      ready: vi.fn(() => true),
    };
    const requests = service({ eventGrants, resume: undefined });
    const created = await requests.create(principal(), {
      ...INPUT,
      requestedEvents: ['gmail.message_received'],
    });
    const decision = {
      decision: 'approved' as const,
      connectionId: CONNECTION_ID,
      operationRevisionIds: ['revision-read'],
      eventScopes: [eventScope],
    };

    const first = requests.resolve(OWNER, created.requestId, decision);
    const second = requests.resolve(OWNER, created.requestId, decision);
    await bothEntered;
    releaseApprovals();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'granted' }),
      expect.objectContaining({ status: 'granted' }),
    ]);
    expect(eventGrants.approve).toHaveBeenCalledTimes(2);
    expect(db.select().from(connectionOperationGrants).all()).toHaveLength(1);
  });

  it('replays one denied decision idempotently and rejects a different later choice', async () => {
    const requests = service();
    const created = await requests.create(principal(), INPUT);

    await expect(
      requests.resolve(OWNER, created.requestId, { decision: 'denied' })
    ).resolves.toMatchObject({ status: 'denied' });
    await expect(
      requests.resolve(OWNER, created.requestId, { decision: 'denied' })
    ).resolves.toMatchObject({ status: 'denied' });
    await expect(
      requests.resolve(OWNER, created.requestId, {
        decision: 'approved',
        connectionId: CONNECTION_ID,
        operationRevisionIds: ['revision-read'],
        eventScopes: [],
      })
    ).rejects.toMatchObject({ code: 'request_already_resolved' });
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
  });
});
