/**
 * Owner-wide "every agent" grants (ADR 260926-192625), end to end over one real
 * database: the owner's reviewed write path, the one authorization check, the
 * runtime tool list and per-turn awareness, the owner reads, and the lifecycle
 * rules (disconnect clears it, removing an agent never does).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  and,
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  createDb,
  eq,
  EVERY_AGENT_GRANT_SUBJECT_ID,
  isNull,
  runMigrations,
  sessionConnectionOverrides,
  type Db,
} from '@dorkos/db';
import {
  ConnectionIdSchema,
  ConnectorExecutionTargetSchema,
  ConnectorProviderInstanceIdSchema,
  type ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorAccessQueryService } from '../execution/access-query-service.js';
import { ConnectorExecutionAuthorizationService } from '../execution/authorization-service.js';
import { createServerPrincipal } from '../principal/server-principal.js';
import {
  ConnectorReconciliationError,
  ConnectorReconciliationService,
} from '../reconciliation-service.js';
import { ConnectorRegistry } from '../registry.js';
import { ConnectorOperatorQueryService } from '../resources/operator-query-service.js';
import { ConnectorManagementReviewContextBuilder } from '../management-review-context.js';
import {
  createEveryAgentArrivalReaction,
  createEveryAgentEndedRecorder,
  recordEveryAgentChange,
  setOnEveryAgentEnded,
  EVERY_AGENT_CHANGED_EVENT,
  EVERY_AGENT_INHERITED_EVENT,
  type EveryAgentActivitySink,
} from '../every-agent-activity.js';
import { notifyAgentCreated, setOnAgentCreated } from '../../core/agent-created-hook.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const NOW = new Date('2026-09-26T12:00:00.000Z');
const CONNECTION_ID = ConnectionIdSchema.parse('connection-a');
/** Agents the owner has. `agent-new` is never part of any preview: it arrives later. */
const OWNED_AGENTS = new Set(['agent-a', 'agent-new', 'dorkbot']);

/** The stable refusal code a connector error carries, wherever it keeps it. */
function codeOf(error: unknown): string {
  const value = error as { code?: string; payload?: { code?: string } };
  return value.payload?.code ?? value.code ?? String(error);
}

describe('every-agent grants', () => {
  let db: Db;
  let provider: FakeConnectorProvider;
  let registry: ConnectorRegistry;
  let reconciliation: ConnectorReconciliationService;
  let authorization: ConnectorExecutionAuthorizationService;
  let access: ConnectorAccessQueryService;
  let query: ConnectorOperatorQueryService;
  let nextId: number;
  let activity: { emit: ReturnType<typeof vi.fn<EveryAgentActivitySink['emit']>> };

  afterEach(() => {
    setOnAgentCreated(null);
    setOnEveryAgentEnded(null);
  });

  beforeEach(() => {
    activity = { emit: vi.fn<EveryAgentActivitySink['emit']>() };
    db = createDb(':memory:');
    runMigrations(db);
    provider = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
      type: 'fake',
      custody: 'self-host',
      toolkitVersion: 'v1',
    });
    registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: 'local_install', ownerId: OWNER.installationId },
    });
    registry.register(provider, 'material-a');
    db.insert(connections)
      .values({
        id: CONNECTION_ID,
        providerInstanceId: provider.instanceId,
        externalAccountRef: 'external-a',
        toolkit: 'gmail',
        label: 'Work Gmail',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .run();
    nextId = 0;
    const ownership = {
      ownsAgent: (_owner: unknown, agentId: string) => OWNED_AGENTS.has(agentId),
    };
    reconciliation = new ConnectorReconciliationService({
      db,
      registry,
      bootEpoch: 'boot-a',
      listAgents: () => [{ agentId: 'agent-a', displayName: 'Alpha' }],
      now: () => NOW,
      createId: () => `generated-${++nextId}`,
      activity,
      writer: () => ({ actorType: 'user', actorLabel: 'Someone on this computer' }),
    });
    authorization = new ConnectorExecutionAuthorizationService(db, registry, ownership);
    access = new ConnectorAccessQueryService(db, ownership, registry, {
      revalidatePrincipal: async () => true,
    });
    query = new ConnectorOperatorQueryService({
      db,
      registry,
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: ownership,
    });
  });

  async function preview(): Promise<ConnectorReconciliationPreview> {
    return reconciliation.preview(
      OWNER,
      { connectionId: CONNECTION_ID },
      new AbortController().signal
    );
  }

  function revisionId(snapshot: ConnectorReconciliationPreview, slug: string): string {
    const candidate = snapshot.candidates.find((entry) => entry.operationSlug === slug);
    if (!candidate) throw new Error(`No ${slug} candidate in the preview.`);
    return candidate.operationRevisionId;
  }

  /** Review the current catalog and give every agent `slugs`; returns the preview used. */
  async function giveEveryAgent(slugs: string[]): Promise<ConnectorReconciliationPreview> {
    const snapshot = await preview();
    await reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: slugs.map((slug) => revisionId(snapshot, slug)) },
    });
    return snapshot;
  }

  function agentPrincipal(agentId: string) {
    return createServerPrincipal({
      kind: 'agent',
      owner: OWNER,
      agentId,
      agentPath: `/agents/${agentId}`,
    });
  }

  function runtimePrincipal(agentId: string, sessionId: string) {
    return createServerPrincipal({
      kind: 'runtime',
      owner: OWNER,
      bindingId: `binding-${sessionId}`,
      runtime: 'codex',
      canonicalSessionId: sessionId,
      agentId,
      agentPath: `/agents/${agentId}`,
    });
  }

  function execute(
    principal: ReturnType<typeof agentPrincipal>,
    operationRevisionId: string,
    classification: 'read' | 'write' | 'destructive'
  ) {
    return authorization.prepare({
      capabilityId: `connectors.execute_${classification}`,
      principal,
      target: ConnectorExecutionTargetSchema.parse({
        connectionId: CONNECTION_ID,
        operationRevisionId,
        arguments: {},
      }),
    });
  }

  async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
      return undefined;
    } catch (error) {
      return codeOf(error);
    }
  }

  function everyAgentRows() {
    return db
      .select()
      .from(connectionOperationGrants)
      .where(eq(connectionOperationGrants.subjectType, 'every_agent'))
      .all();
  }

  it('gives an agent created after the grant exactly the reviewed revisions, and nothing newer', async () => {
    const snapshot = await giveEveryAgent(['gmail.read']);
    const read = revisionId(snapshot, 'gmail.read');
    const write = revisionId(snapshot, 'gmail.write');

    expect(everyAgentRows()).toEqual([
      expect.objectContaining({
        subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
        agentId: null,
        operationRevisionId: read,
        createdBy: OWNER.installationId,
        revokedAt: null,
      }),
    ]);
    await expect(execute(agentPrincipal('agent-new'), read, 'read')).resolves.toMatchObject({
      agentId: 'agent-new',
    });
    expect(await refusal(execute(agentPrincipal('agent-new'), write, 'write'))).toBe(
      'CONNECTOR_GRANT_REQUIRED'
    );

    // The provider ships a new version of the same operation: it stays off until reviewed.
    db.insert(connectorOperationRevisions)
      .values({
        id: 'gmail-read-v2',
        providerInstanceId: provider.instanceId,
        toolkit: 'gmail',
        operationSlug: 'gmail.read',
        toolkitVersion: 'v2',
        schemaHash: 'sha256:fake-read-v2',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', additionalProperties: false }),
        discoveredAt: NOW.toISOString(),
      })
      .run();
    expect(await refusal(execute(agentPrincipal('agent-new'), 'gmail-read-v2', 'read'))).toBe(
      'CONNECTOR_GRANT_REQUIRED'
    );
    // An every-agent grant never lets a call change its classification.
    expect(await refusal(execute(agentPrincipal('agent-new'), read, 'write'))).toBe(
      'CONNECTOR_CAPABILITY_MISMATCH'
    );
  });

  it('covers system agents such as DorkBot, because they are agents', async () => {
    const snapshot = await giveEveryAgent(['gmail.read']);
    await expect(
      execute(agentPrincipal('dorkbot'), revisionId(snapshot, 'gmail.read'), 'read')
    ).resolves.toMatchObject({ agentId: 'dorkbot' });
  });

  it('adds to a named-agent grant without narrowing it', async () => {
    const first = await preview();
    await reconciliation.apply(OWNER, {
      previewId: first.previewId,
      grants: [{ agentId: 'agent-a', operationRevisionIds: [revisionId(first, 'gmail.write')] }],
      everyAgent: { operationRevisionIds: [revisionId(first, 'gmail.read')] },
    });

    await expect(
      execute(agentPrincipal('agent-a'), revisionId(first, 'gmail.write'), 'write')
    ).resolves.toBeDefined();
    await expect(
      execute(agentPrincipal('agent-a'), revisionId(first, 'gmail.read'), 'read')
    ).resolves.toBeDefined();
    expect(
      await refusal(execute(agentPrincipal('agent-new'), revisionId(first, 'gmail.write'), 'write'))
    ).toBe('CONNECTOR_GRANT_REQUIRED');
  });

  it('lets a session override decide alone: detached denies and attached never widens', async () => {
    const snapshot = await giveEveryAgent(['gmail.read']);
    const read = revisionId(snapshot, 'gmail.read');
    const write = revisionId(snapshot, 'gmail.write');
    db.insert(sessionConnectionOverrides)
      .values([
        {
          sessionId: 'session-detached',
          agentId: 'agent-new',
          connectionId: CONNECTION_ID,
          state: 'detached',
          updatedAt: NOW.toISOString(),
        },
        {
          sessionId: 'session-attached',
          agentId: 'agent-new',
          connectionId: CONNECTION_ID,
          state: 'attached',
          updatedAt: NOW.toISOString(),
        },
      ])
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'session-write',
        subjectType: 'session',
        subjectId: 'session-attached',
        agentId: 'agent-new',
        connectionId: CONNECTION_ID,
        operationRevisionId: write,
        createdBy: 'operator',
        createdAt: NOW.toISOString(),
      })
      .run();

    // No override: the every-agent grant applies.
    await expect(
      execute(runtimePrincipal('agent-new', 'session-plain'), read, 'read')
    ).resolves.toBeDefined();
    expect(
      await refusal(execute(runtimePrincipal('agent-new', 'session-detached'), read, 'read'))
    ).toBe('CONNECTOR_GRANT_REQUIRED');
    expect(
      await refusal(execute(runtimePrincipal('agent-new', 'session-attached'), read, 'read'))
    ).toBe('CONNECTOR_GRANT_REQUIRED');
    await expect(
      execute(runtimePrincipal('agent-new', 'session-attached'), write, 'write')
    ).resolves.toBeDefined();

    // The runtime tool list agrees with the check, session by session.
    await expect(
      access.listRuntimeConnections(runtimePrincipal('agent-new', 'session-detached'))
    ).resolves.toEqual({ connections: [] });
    const attached = await access.listRuntimeOperations(
      runtimePrincipal('agent-new', 'session-attached'),
      CONNECTION_ID
    );
    expect(attached.operations.map((operation) => operation.operationRevisionId)).toEqual([write]);
  });

  it('revokes for every agent at once, including a call already prepared inside a turn', async () => {
    const snapshot = await giveEveryAgent(['gmail.read']);
    const read = revisionId(snapshot, 'gmail.read');
    const principal = runtimePrincipal('agent-new', 'session-running');
    const input = {
      capabilityId: 'connectors.execute_read' as const,
      principal,
      target: ConnectorExecutionTargetSchema.parse({
        connectionId: CONNECTION_ID,
        operationRevisionId: read,
        arguments: {},
      }),
    };
    const prepared = await authorization.prepare(input);

    const off = await preview();
    await reconciliation.apply(OWNER, {
      previewId: off.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: [] },
    });

    let recheck: string | undefined;
    try {
      authorization.recheckPreparedSynchronously(input, prepared);
    } catch (error) {
      recheck = codeOf(error);
    }
    expect(recheck).toBe('CONNECTOR_GRANT_REQUIRED');
    expect(await refusal(execute(agentPrincipal('dorkbot'), read, 'read'))).toBe(
      'CONNECTOR_GRANT_REQUIRED'
    );
    await expect(access.listRuntimeConnections(principal)).resolves.toEqual({ connections: [] });
    expect(everyAgentRows().every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('counts in per-turn awareness exactly like a named-agent grant', async () => {
    const before = await access.accessSnapshot(OWNER, 'agent-new', 'session-1');
    expect(before.accountCount).toBe(0);

    const snapshot = await giveEveryAgent(['gmail.read']);
    const granted = await access.accessSnapshot(OWNER, 'agent-new', 'session-1');
    expect(granted.accountCount).toBe(1);
    expect(granted.revision).not.toBe(before.revision);
    await expect(
      access.listRuntimeConnections(runtimePrincipal('agent-new', 'session-1'))
    ).resolves.toMatchObject({ connections: [{ connectionId: CONNECTION_ID }] });

    // Also granted by name: the agent still sees one account and one operation, not two.
    db.insert(connectionOperationGrants)
      .values({
        id: 'named-read',
        subjectType: 'agent',
        subjectId: 'agent-new',
        agentId: 'agent-new',
        connectionId: CONNECTION_ID,
        operationRevisionId: revisionId(snapshot, 'gmail.read'),
        createdBy: 'operator',
        createdAt: NOW.toISOString(),
      })
      .run();
    const both = await access.listRuntimeOperations(
      runtimePrincipal('agent-new', 'session-1'),
      CONNECTION_ID
    );
    expect(both.operations).toHaveLength(1);
    await expect(access.listOperations(OWNER, 'agent-new', CONNECTION_ID)).resolves.toMatchObject({
      operations: [{ operationSlug: 'gmail.read' }],
    });
    await expect(access.listConnections(OWNER, 'agent-new')).resolves.toMatchObject({
      connections: [{ connectionId: CONNECTION_ID }],
    });

    db.delete(connectionOperationGrants)
      .where(eq(connectionOperationGrants.id, 'named-read'))
      .run();
    const off = await preview();
    await reconciliation.apply(OWNER, {
      previewId: off.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: [] },
    });
    const revoked = await access.accessSnapshot(OWNER, 'agent-new', 'session-1');
    expect(revoked.accountCount).toBe(0);
    expect(revoked.revision).not.toBe(granted.revision);
  });

  it('survives removing an agent, and ends when the connection is disconnected', async () => {
    const snapshot = await giveEveryAgent(['gmail.read']);
    const read = revisionId(snapshot, 'gmail.read');
    db.insert(connectionOperationGrants)
      .values({
        id: 'named-write',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        operationRevisionId: revisionId(snapshot, 'gmail.write'),
        createdBy: 'operator',
        createdAt: NOW.toISOString(),
      })
      .run();

    registry.recordAgentRemoval('agent-a');
    registry.removeAgentAccess('agent-a');
    registry.removeAgentConnectionAccess('agent-a', CONNECTION_ID);
    expect(
      db
        .select({ revokedAt: connectionOperationGrants.revokedAt })
        .from(connectionOperationGrants)
        .where(eq(connectionOperationGrants.id, 'named-write'))
        .get()?.revokedAt
    ).not.toBeNull();
    expect(everyAgentRows().map((row) => row.revokedAt)).toEqual([null]);
    await expect(execute(agentPrincipal('agent-new'), read, 'read')).resolves.toBeDefined();

    registry.recordDisconnect(CONNECTION_ID);
    expect(everyAgentRows().map((row) => row.revokedAt)).toEqual([expect.any(String)]);
    expect(query.everyAgentGrants(OWNER)).toEqual({ connections: [] });
    expect(await refusal(execute(agentPrincipal('agent-new'), read, 'read'))).toBe(
      'CONNECTOR_NOT_EXECUTABLE'
    );
  });

  it('records sharing that ends because the account was disconnected', async () => {
    await giveEveryAgent(['gmail.read']);
    setOnEveryAgentEnded(createEveryAgentEndedRecorder(activity));
    activity.emit.mockClear();
    registry.recordDisconnect(CONNECTION_ID);
    await vi.waitFor(() =>
      expect(activity.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: EVERY_AGENT_CHANGED_EVENT,
          resourceId: CONNECTION_ID,
          summary:
            'Stopped sharing Gmail (Work Gmail) with every agent because the account was disconnected',
        })
      )
    );
    // Nothing was shared on a second disconnect, so nothing more is recorded.
    activity.emit.mockClear();
    registry.recordDisconnect(CONNECTION_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activity.emit).not.toHaveBeenCalled();
  });

  it('refuses a revision the owner did not review in this preview', async () => {
    const snapshot = await preview();
    await expect(
      reconciliation.apply(OWNER, {
        previewId: snapshot.previewId,
        grants: [],
        everyAgent: { operationRevisionIds: ['not-reviewed'] },
      })
    ).rejects.toMatchObject({ code: 'invalid_selection' });
    await expect(
      reconciliation.apply(OWNER, {
        previewId: snapshot.previewId,
        grants: [],
        everyAgent: {
          operationRevisionIds: [
            revisionId(snapshot, 'gmail.read'),
            revisionId(snapshot, 'gmail.read'),
          ],
        },
      })
    ).rejects.toMatchObject({ code: 'invalid_selection' });
    expect(everyAgentRows()).toEqual([]);
  });

  it('is unavailable on a connection through a DorkOS account, and ignored there if present', async () => {
    db.update(connectorProviderInstances)
      .set({ mode: 'managed' })
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .run();
    const snapshot = await preview();
    expect(snapshot.everyAgent).toEqual({ available: false, operationRevisionIds: [] });
    const refused = reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: [revisionId(snapshot, 'gmail.read')] },
    });
    await expect(refused).rejects.toBeInstanceOf(ConnectorReconciliationError);
    await expect(refused).rejects.toMatchObject({ code: 'every_agent_unavailable' });
    expect(everyAgentRows()).toEqual([]);

    // A row that somehow exists still grants nothing: hosted authority cannot see it.
    db.insert(connectionOperationGrants)
      .values({
        id: 'stray-every-agent',
        subjectType: 'every_agent',
        subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
        agentId: null,
        connectionId: CONNECTION_ID,
        operationRevisionId: revisionId(snapshot, 'gmail.read'),
        createdBy: 'operator',
        createdAt: NOW.toISOString(),
      })
      .run();
    expect(
      await refusal(
        execute(agentPrincipal('agent-new'), revisionId(snapshot, 'gmail.read'), 'read')
      )
    ).toBe('CONNECTOR_GRANT_REQUIRED');
    await expect(access.listConnections(OWNER, 'agent-new')).resolves.toEqual({ connections: [] });
    expect((await query.listConnections(OWNER))[0]?.everyAgent).toBeNull();
    expect(query.everyAgentGrants(OWNER)).toEqual({ connections: [] });
  });

  it('shows the owner what every agent, including a new one, will get', async () => {
    expect(query.everyAgentGrants(OWNER)).toEqual({ connections: [] });
    const snapshot = await giveEveryAgent(['gmail.read', 'gmail.write']);
    const ids = [revisionId(snapshot, 'gmail.read'), revisionId(snapshot, 'gmail.write')].sort();
    const expectedAccess = { operationRevisionIds: ids, classifications: ['read', 'write'] };

    expect(query.everyAgentGrants(OWNER)).toEqual({
      connections: [
        {
          connectionId: CONNECTION_ID,
          toolkit: 'gmail',
          label: 'Work Gmail',
          lifecycle: 'connected',
          access: expectedAccess,
        },
      ],
    });
    const [summary] = await query.listConnections(OWNER);
    expect(summary?.everyAgent).toEqual(expectedAccess);
    expect(query.disconnectImpact(OWNER, CONNECTION_ID).everyAgent).toBe(true);
    await expect(query.agentConnections(OWNER, 'agent-new')).resolves.toMatchObject({
      connections: [{ connectionId: CONNECTION_ID, operationRevisionIds: ids, everyAgent: true }],
    });
    const again = await preview();
    expect(again.everyAgent).toEqual({ available: true, operationRevisionIds: ids });

    // Another owner sees none of it.
    expect(query.everyAgentGrants({ kind: 'local_install', installationId: 'install-b' })).toEqual({
      connections: [],
    });
    // Paused still inherits once resumed, so it is still disclosed, marked paused.
    db.update(connections).set({ enabled: false }).where(eq(connections.id, CONNECTION_ID)).run();
    expect(query.everyAgentGrants(OWNER).connections[0]?.lifecycle).toBe('paused');
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .where(
          and(
            eq(connectionOperationGrants.subjectType, 'agent'),
            isNull(connectionOperationGrants.revokedAt)
          )
        )
        .all()
    ).toEqual([]);
  });

  function grantNamed(id: string, agentId: string, operationRevisionId: string) {
    db.insert(connectionOperationGrants)
      .values({
        id,
        subjectType: 'agent',
        subjectId: agentId,
        agentId,
        connectionId: CONNECTION_ID,
        operationRevisionId,
        createdBy: 'operator',
        createdAt: NOW.toISOString(),
      })
      .run();
  }

  function insertConnection(id: string, providerInstanceId: string) {
    db.insert(connections)
      .values({
        id,
        providerInstanceId,
        externalAccountRef: `external-${id}`,
        toolkit: 'gmail',
        label: `Mail ${id}`,
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .run();
  }

  function strayEveryAgentRow(id: string, connectionId: string, operationRevisionId: string) {
    db.insert(connectionOperationGrants)
      .values({
        id,
        subjectType: 'every_agent',
        subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
        agentId: null,
        connectionId,
        operationRevisionId,
        createdBy: 'operator',
        createdAt: NOW.toISOString(),
      })
      .run();
  }

  it('comes back after being turned off and on again (a revoked row is restored)', async () => {
    const snapshot = await giveEveryAgent(['gmail.read']);
    const read = revisionId(snapshot, 'gmail.read');
    const off = await preview();
    await reconciliation.apply(OWNER, {
      previewId: off.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: [] },
    });
    expect(await refusal(execute(agentPrincipal('agent-new'), read, 'read'))).toBe(
      'CONNECTOR_GRANT_REQUIRED'
    );

    await giveEveryAgent(['gmail.read']);
    expect(everyAgentRows().map((row) => row.revokedAt)).toEqual([null]);
    await expect(execute(agentPrincipal('agent-new'), read, 'read')).resolves.toBeDefined();
  });

  it('re-verifies every-agent revisions from an older version in the next preview', async () => {
    db.insert(connectorOperationRevisions)
      .values({
        id: 'old-read-v0',
        providerInstanceId: provider.instanceId,
        toolkit: 'gmail',
        operationSlug: 'gmail.read',
        toolkitVersion: 'v0',
        schemaHash: 'sha256:fake-read-v1',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', additionalProperties: false }),
        discoveredAt: NOW.toISOString(),
      })
      .run();
    strayEveryAgentRow('every-old', CONNECTION_ID, 'old-read-v0');

    const snapshot = await preview();
    expect(
      snapshot.candidates.find((candidate) => candidate.operationRevisionId === 'old-read-v0')
    ).toMatchObject({ toolkitVersion: 'v0', supported: true });
    expect(snapshot.everyAgent).toEqual({ available: true, operationRevisionIds: ['old-read-v0'] });
    // Keeping it is a valid selection from this preview.
    await reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: ['old-read-v0'] },
    });
    expect(everyAgentRows().map((row) => row.revokedAt)).toEqual([null]);
  });

  it("counts it in an agent's own list only for this owner and never on a managed connection", async () => {
    const snapshot = await giveEveryAgent(['gmail.read']);
    const read = revisionId(snapshot, 'gmail.read');
    // A second owner's provider instance with its own every-agent row.
    const foreign = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-foreign'),
      type: 'fake-foreign',
      custody: 'self-host',
      toolkitVersion: 'v1',
    });
    const foreignRegistry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: 'local_install', ownerId: 'install-b' },
    });
    foreignRegistry.register(foreign, 'material-foreign');
    insertConnection('connection-foreign', foreign.instanceId);
    db.insert(connectorOperationRevisions)
      .values({
        id: 'foreign-read',
        providerInstanceId: foreign.instanceId,
        toolkit: 'gmail',
        operationSlug: 'gmail.read',
        toolkitVersion: 'v1',
        schemaHash: 'sha256:foreign',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object' }),
        discoveredAt: NOW.toISOString(),
      })
      .run();
    strayEveryAgentRow('every-foreign', 'connection-foreign', 'foreign-read');
    // A managed instance of this owner with a stray every-agent row.
    const managed = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-managed'),
      type: 'fake-managed',
      custody: 'managed',
      toolkitVersion: 'v1',
    });
    registry.register(managed, 'material-managed', 'managed');
    insertConnection('connection-managed', managed.instanceId);
    db.insert(connectorOperationRevisions)
      .values({
        id: 'managed-read',
        providerInstanceId: managed.instanceId,
        toolkit: 'gmail',
        operationSlug: 'gmail.read',
        toolkitVersion: 'v1',
        schemaHash: 'sha256:managed',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object' }),
        discoveredAt: NOW.toISOString(),
      })
      .run();
    strayEveryAgentRow('every-managed', 'connection-managed', 'managed-read');

    const own = await query.agentConnections(OWNER, 'agent-new');
    expect(own.connections.map((connection) => connection.connectionId)).toEqual([CONNECTION_ID]);
    expect(own.connections[0]?.operationRevisionIds).toEqual([read]);
    expect(query.disconnectImpact(OWNER, 'connection-managed').everyAgent).toBe(false);
  });

  function namedRevokedAt(id: string) {
    return db
      .select({ revokedAt: connectionOperationGrants.revokedAt })
      .from(connectionOperationGrants)
      .where(eq(connectionOperationGrants.id, id))
      .get()?.revokedAt;
  }

  it('ends for good when the instance moves to a DorkOS account', async () => {
    const snapshot = await giveEveryAgent(['gmail.read']);
    grantNamed('named-survives-move', 'agent-a', revisionId(snapshot, 'gmail.write'));
    setOnEveryAgentEnded(createEveryAgentEndedRecorder(activity));
    activity.emit.mockClear();
    registry.register(provider, 'material-a', 'managed');
    // Only the every-agent row ends; a grant made to one agent by name does not.
    expect(namedRevokedAt('named-survives-move')).toBeNull();
    await vi.waitFor(() =>
      expect(activity.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: EVERY_AGENT_CHANGED_EVENT,
          actorLabel: 'DorkOS',
          summary:
            'Stopped sharing Gmail (Work Gmail) with every agent because it now connects through your DorkOS account',
        })
      )
    );
    expect(everyAgentRows().map((row) => row.revokedAt)).toEqual([expect.any(String)]);
    registry.register(provider, 'material-a', 'byo');
    expect(everyAgentRows().map((row) => row.revokedAt)).toEqual([expect.any(String)]);
    expect(
      await refusal(
        execute(agentPrincipal('agent-new'), revisionId(snapshot, 'gmail.read'), 'read')
      )
    ).not.toBeUndefined();
    expect(query.disconnectImpact(OWNER, CONNECTION_ID).everyAgent).toBe(false);
  });

  it('stops sharing with no preview, even while the provider is unavailable', async () => {
    const snapshot = await giveEveryAgent(['gmail.read', 'gmail.write']);
    grantNamed('named-survives-stop', 'agent-a', revisionId(snapshot, 'gmail.read'));
    activity.emit.mockClear();
    db.update(connectorProviderInstances)
      .set({ status: 'unavailable' })
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .run();
    await expect(
      reconciliation.preview(OWNER, { connectionId: CONNECTION_ID }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'connection_not_found' });

    await expect(
      reconciliation.revokeEveryAgent(
        { kind: 'local_install', installationId: 'install-b' },
        CONNECTION_ID
      )
    ).rejects.toMatchObject({ code: 'connection_not_found' });
    expect(everyAgentRows().every((row) => row.revokedAt === null)).toBe(true);

    await expect(reconciliation.revokeEveryAgent(OWNER, CONNECTION_ID)).resolves.toEqual({
      connectionId: CONNECTION_ID,
      revokedCount: 2,
    });
    expect(everyAgentRows().every((row) => row.revokedAt !== null)).toBe(true);
    // Stopping the sharing never touches what an agent was given by name.
    expect(namedRevokedAt('named-survives-stop')).toBeNull();
    expect(activity.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: EVERY_AGENT_CHANGED_EVENT,
        summary: 'Stopped sharing Gmail (Work Gmail) with every agent',
        actorLabel: 'Someone on this computer',
      })
    );
    await expect(reconciliation.revokeEveryAgent(OWNER, CONNECTION_ID)).resolves.toEqual({
      connectionId: CONNECTION_ID,
      revokedCount: 0,
    });
    expect(
      await refusal(
        execute(agentPrincipal('agent-new'), revisionId(snapshot, 'gmail.read'), 'read')
      )
    ).not.toBeUndefined();
  });

  it('leaves a trail when sharing starts or widens, whoever sent it', async () => {
    await giveEveryAgent(['gmail.read']);
    expect(activity.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        category: 'permissions',
        eventType: EVERY_AGENT_CHANGED_EVENT,
        resourceId: CONNECTION_ID,
        summary: 'Shared Gmail (Work Gmail) with every agent, including agents added later: read',
        actorLabel: 'Someone on this computer',
      })
    );
    await giveEveryAgent(['gmail.read', 'gmail.write']);
    expect(activity.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        summary: 'Changed what every agent can do with Gmail (Work Gmail): read and write',
      })
    );
    activity.emit.mockClear();
    await giveEveryAgent(['gmail.read', 'gmail.write']);
    expect(activity.emit).not.toHaveBeenCalled();
  });

  it('tells the owner what an agent added on any path inherits (the shared arrival hook)', async () => {
    const reaction = createEveryAgentArrivalReaction({
      activity,
      everyAgentGrants: () => query.everyAgentGrants(OWNER),
    });
    setOnAgentCreated(reaction);
    const arrival = {
      id: 'agent-adopted',
      name: 'research-bot',
      displayName: 'Research Bot',
      path: '/agents/research-bot',
      origin: 'registered' as const,
    };
    await notifyAgentCreated(arrival);
    expect(activity.emit).not.toHaveBeenCalled();

    await giveEveryAgent(['gmail.read']);
    db.update(connections).set({ enabled: false }).where(eq(connections.id, CONNECTION_ID)).run();
    activity.emit.mockClear();
    await notifyAgentCreated(arrival);
    expect(activity.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: EVERY_AGENT_INHERITED_EVENT,
        resourceId: 'agent-adopted',
        summary:
          'Research Bot can use Gmail (Work Gmail, read, paused), because it is shared with every agent',
        linkPath: '/connections?app=connection-a',
      })
    );
  });

  it('tells the owner, before a removal, what the agent keeps through every agent', async () => {
    const snapshot = await giveEveryAgent(['gmail.read']);
    grantNamed('named-write', 'agent-a', revisionId(snapshot, 'gmail.write'));
    const builder = new ConnectorManagementReviewContextBuilder(db, () => ({
      displayName: 'Alpha',
    }));

    const removal = builder.build(OWNER, {
      version: 1,
      kind: 'remove_agent_access',
      connectionId: CONNECTION_ID,
      agentId: 'agent-a',
    });
    expect(removal).toMatchObject({
      kind: 'remove_agent_access',
      affectedOperations: [{ operationRevisionId: revisionId(snapshot, 'gmail.write') }],
      keptThroughEveryAgent: [{ operationRevisionId: revisionId(snapshot, 'gmail.read') }],
    });
    const disconnect = builder.build(OWNER, {
      version: 1,
      kind: 'disconnect',
      connectionId: CONNECTION_ID,
    });
    expect(disconnect).toMatchObject({
      kind: 'disconnect',
      everyAgent: true,
      affectedAgentCount: 1,
    });

    const off = await preview();
    await reconciliation.apply(OWNER, {
      previewId: off.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: [] },
    });
    expect(
      builder.build(OWNER, {
        version: 1,
        kind: 'remove_agent_access',
        connectionId: CONNECTION_ID,
        agentId: 'agent-a',
      })
    ).toMatchObject({ keptThroughEveryAgent: [] });
    expect(
      builder.build(OWNER, { version: 1, kind: 'disconnect', connectionId: CONNECTION_ID })
    ).toMatchObject({ everyAgent: false });
  });

  it('names an app in Activity the way the app does ("Google Calendar")', async () => {
    await recordEveryAgentChange(
      activity,
      { actorType: 'user', actorLabel: 'Someone on this computer' },
      {
        connectionId: 'connection-cal',
        toolkit: 'google_calendar',
        label: 'Work',
        before: [],
        after: ['read'],
        operationCount: 1,
      }
    );
    expect(activity.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        summary:
          'Shared Google Calendar (Work) with every agent, including agents added later: read',
      })
    );
  });
});
