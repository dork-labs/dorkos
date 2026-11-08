/**
 * Leaving one agent out of an every-agent share (DOR-3961), over one real
 * database. Security's review terms, each pinned here:
 *
 * - X1: the exclusion is a deny that wins over every-agent grants on every
 *   path that reads grants (execute read, write and destructive, a call
 *   already prepared before the exclusion, the runtime tool lists, the
 *   per-turn snapshot, the owner's view of the agent, and the agent request
 *   service's live grants).
 * - X3: it holds for shares made later.
 * - X4: it fails closed when the exclusion can't be read.
 * - X5: an excluded agent is refused on every path; other agents keep the
 *   share; the agent's own named grants still count.
 *
 * Mutants that must turn this file red: `everyAgentGrantFor` returning plain
 * `everyAgentGrantSubject()` (the deny removed), and either caller of the
 * precedence rule switched back to `everyAgentGrantSubject()` (a second copy
 * without the deny).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectionGrantExclusions,
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  createDb,
  EVERY_AGENT_GRANT_SUBJECT_ID,
  runMigrations,
  sql,
  type Db,
} from '@dorkos/db';
import {
  ConnectionIdSchema,
  ConnectorExecutionTargetSchema,
  ConnectorProviderInstanceIdSchema,
  type ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import {
  AGENT_EXCLUSION_CHANGED_EVENT,
  ConnectorGrantExclusionError,
  ConnectorGrantExclusionService,
} from '../access/grant-exclusions.js';
import { agentGrantScope } from '../execution/agent-grant-scope.js';
import { ConnectorAccessQueryService } from '../execution/access-query-service.js';
import { ConnectorExecutionAuthorizationService } from '../execution/authorization-service.js';
import { createServerPrincipal } from '../principal/server-principal.js';
import { ConnectorReconciliationService } from '../reconciliation-service.js';
import { ConnectorRegistry } from '../registry.js';
import { ConnectorManagementReviewContextBuilder } from '../management-review-context.js';
import { ConnectorOperatorQueryService } from '../resources/operator-query-service.js';
import type { EveryAgentActivitySink } from '../every-agent-activity.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const OTHER_OWNER = { kind: 'local_install', installationId: 'install-b' } as const;
const NOW = new Date('2026-11-08T12:00:00.000Z');
const CONNECTION_ID = ConnectionIdSchema.parse('connection-a');
const AGENTS = [
  { id: 'flow-snapshot', name: 'flow-snapshot' },
  { id: 'agent-b', name: 'agent-b', displayName: 'Bea' },
];
const OWNED_AGENTS = new Set(AGENTS.map((agent) => agent.id));

function codeOf(error: unknown): string {
  const value = error as { code?: string; payload?: { code?: string } };
  return value.payload?.code ?? value.code ?? String(error);
}

describe('leaving one agent out of an every-agent share', () => {
  let db: Db;
  let provider: FakeConnectorProvider;
  let registry: ConnectorRegistry;
  let reconciliation: ConnectorReconciliationService;
  let authorization: ConnectorExecutionAuthorizationService;
  let access: ConnectorAccessQueryService;
  let query: ConnectorOperatorQueryService;
  let exclusions: ConnectorGrantExclusionService;
  let activity: { emit: ReturnType<typeof vi.fn<EveryAgentActivitySink['emit']>> };
  let nextId: number;

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
      listAgents: () => AGENTS.map((agent) => ({ agentId: agent.id, displayName: agent.name })),
      now: () => NOW,
      createId: () => `generated-${++nextId}`,
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
    exclusions = new ConnectorGrantExclusionService({
      db,
      agents: () => AGENTS,
      activity,
      writer: () => ({ actorType: 'user', actorLabel: 'Someone on this computer' }),
      now: () => NOW,
      createId: () => `exclusion-${++nextId}`,
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

  /** Share read and write with every agent; returns the two revision ids. */
  async function shareReadAndWrite(): Promise<{ read: string; write: string }> {
    const snapshot = await preview();
    const read = revisionId(snapshot, 'gmail.read');
    const write = revisionId(snapshot, 'gmail.write');
    await reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: [read, write] },
    });
    return { read, write };
  }

  /** A destructive revision shared with every agent, inserted directly (the fake has none). */
  function shareDestructive(): string {
    db.insert(connectorOperationRevisions)
      .values({
        id: 'posthog-delete-v1',
        providerInstanceId: provider.instanceId,
        toolkit: 'gmail',
        operationSlug: 'gmail.delete',
        toolkitVersion: 'v1',
        schemaHash: 'sha256:fake-delete',
        capabilityClassification: 'destructive',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', additionalProperties: false }),
        discoveredAt: NOW.toISOString(),
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'every-agent-delete',
        subjectType: 'every_agent',
        subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
        agentId: null,
        connectionId: CONNECTION_ID,
        operationRevisionId: 'posthog-delete-v1',
        createdBy: OWNER.installationId,
        createdAt: NOW.toISOString(),
      })
      .run();
    return 'posthog-delete-v1';
  }

  function principal(agentId: string, sessionId = `session-${agentId}`) {
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

  function executeInput(
    agentId: string,
    operationRevisionId: string,
    classification: 'read' | 'write' | 'destructive'
  ) {
    return {
      capabilityId: `connectors.execute_${classification}` as const,
      principal: principal(agentId),
      target: ConnectorExecutionTargetSchema.parse({
        connectionId: CONNECTION_ID,
        operationRevisionId,
        arguments: {},
      }),
    };
  }

  async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
      return undefined;
    } catch (error) {
      return codeOf(error);
    }
  }

  it('refuses the excluded agent on read, write and destructive, while another agent keeps the share', async () => {
    const { read, write } = await shareReadAndWrite();
    const destructive = shareDestructive();
    await exclusions.leaveOut(OWNER, CONNECTION_ID, 'flow-snapshot');

    for (const [revision, kind] of [
      [read, 'read'],
      [write, 'write'],
      [destructive, 'destructive'],
    ] as const) {
      expect(
        await refusal(authorization.prepare(executeInput('flow-snapshot', revision, kind)))
      ).toBe('CONNECTOR_GRANT_REQUIRED');
      await expect(
        authorization.prepare(executeInput('agent-b', revision, kind))
      ).resolves.toMatchObject({ agentId: 'agent-b' });
    }
  });

  it('refuses a call prepared before the exclusion when it is rechecked just before it goes out', async () => {
    const { read } = await shareReadAndWrite();
    const input = executeInput('flow-snapshot', read, 'read');
    const prepared = await authorization.prepare(input);

    await exclusions.leaveOut(OWNER, CONNECTION_ID, 'flow-snapshot');

    let recheck: string | undefined;
    try {
      authorization.recheckPreparedSynchronously(input, prepared);
    } catch (error) {
      recheck = codeOf(error);
    }
    expect(recheck).toBe('CONNECTOR_GRANT_REQUIRED');
  });

  it("drops the connection from the excluded agent's tool lists and turn snapshot", async () => {
    await shareReadAndWrite();
    const before = await access.accessSnapshot(OWNER, 'flow-snapshot', 'session-1');
    expect(before.accountCount).toBe(1);

    await exclusions.leaveOut(OWNER, CONNECTION_ID, 'flow-snapshot');

    await expect(access.listRuntimeConnections(principal('flow-snapshot'))).resolves.toEqual({
      connections: [],
    });
    await expect(
      access.listRuntimeOperations(principal('flow-snapshot'), CONNECTION_ID)
    ).rejects.toMatchObject({ code: 'connection_not_found' });
    const after = await access.accessSnapshot(OWNER, 'flow-snapshot', 'session-1');
    expect(after.accountCount).toBe(0);
    expect(after.revision).not.toBe(before.revision);
    await expect(access.listRuntimeConnections(principal('agent-b'))).resolves.toMatchObject({
      connections: [{ connectionId: CONNECTION_ID }],
    });
  });

  it("drops it from the owner's view of that agent, and from the request service's live grants", async () => {
    await shareReadAndWrite();
    await exclusions.leaveOut(OWNER, CONNECTION_ID, 'flow-snapshot');

    await expect(query.agentConnections(OWNER, 'flow-snapshot')).resolves.toMatchObject({
      connections: [],
    });
    await expect(query.agentConnections(OWNER, 'agent-b')).resolves.toMatchObject({
      connections: [expect.objectContaining({ connectionId: CONNECTION_ID })],
    });
    // The agent request service reads live grants through `agentGrantScope`.
    const scope = agentGrantScope(db, {
      agentId: 'flow-snapshot',
      sessionId: undefined,
      connectionId: CONNECTION_ID,
    });
    if (scope.kind !== 'scope') throw new Error('expected a scope');
    const live = db
      .select({ id: connectionOperationGrants.id })
      .from(connectionOperationGrants)
      .where(scope.subject)
      .all();
    expect(live).toEqual([]);
  });

  // DOR-3978: a removal review must not tell the owner a left-out agent keeps the share.
  it('tells the owner a left-out agent keeps nothing through the share', async () => {
    const { read } = await shareReadAndWrite();
    const builder = new ConnectorManagementReviewContextBuilder(db, () => ({
      displayName: 'flow-snapshot',
    }));
    const removal = () =>
      builder.build(OWNER, {
        version: 1,
        kind: 'remove_agent_access',
        connectionId: CONNECTION_ID,
        agentId: 'flow-snapshot',
      });
    expect(removal()).toMatchObject({
      keptThroughEveryAgent: expect.arrayContaining([
        expect.objectContaining({ operationRevisionId: read }),
      ]),
    });

    await exclusions.leaveOut(OWNER, CONNECTION_ID, 'flow-snapshot');

    expect(removal()).toMatchObject({ keptThroughEveryAgent: [] });
    expect(builder.withLiveEveryAgent(removal())).toMatchObject({ keptThroughEveryAgent: [] });
    expect(
      builder.build(OWNER, { version: 1, kind: 'disconnect', connectionId: CONNECTION_ID })
    ).toMatchObject({ everyAgent: true });
  });

  it("keeps the excluded agent's own named grants", async () => {
    const { read, write } = await shareReadAndWrite();
    db.insert(connectionOperationGrants)
      .values({
        id: 'named-read',
        subjectType: 'agent',
        subjectId: 'flow-snapshot',
        agentId: 'flow-snapshot',
        connectionId: CONNECTION_ID,
        operationRevisionId: read,
        createdBy: OWNER.installationId,
        createdAt: NOW.toISOString(),
      })
      .run();
    await exclusions.leaveOut(OWNER, CONNECTION_ID, 'flow-snapshot');

    await expect(
      authorization.prepare(executeInput('flow-snapshot', read, 'read'))
    ).resolves.toMatchObject({ agentId: 'flow-snapshot' });
    expect(
      await refusal(authorization.prepare(executeInput('flow-snapshot', write, 'write')))
    ).toBe('CONNECTOR_GRANT_REQUIRED');
  });

  it('holds for a share made after the exclusion', async () => {
    await exclusions.leaveOut(OWNER, CONNECTION_ID, 'flow-snapshot');
    const { read } = await shareReadAndWrite();

    expect(await refusal(authorization.prepare(executeInput('flow-snapshot', read, 'read')))).toBe(
      'CONNECTOR_GRANT_REQUIRED'
    );
    await expect(
      authorization.prepare(executeInput('agent-b', read, 'read'))
    ).resolves.toBeDefined();
  });

  it('gives the share back when a person lets the agent back in, and only then', async () => {
    const { read } = await shareReadAndWrite();
    await exclusions.leaveOut(OWNER, CONNECTION_ID, 'flow-snapshot');
    const lifted = await exclusions.letBackIn(OWNER, CONNECTION_ID, 'flow-snapshot');

    expect(lifted).toEqual({
      connectionId: CONNECTION_ID,
      agentId: 'flow-snapshot',
      excluded: false,
      changed: true,
    });
    await expect(
      authorization.prepare(executeInput('flow-snapshot', read, 'read'))
    ).resolves.toBeDefined();
    // The lifted row is kept, with who lifted it.
    expect(db.select().from(connectionGrantExclusions).all()).toEqual([
      expect.objectContaining({
        agentId: 'flow-snapshot',
        createdBy: OWNER.installationId,
        revokedBy: OWNER.installationId,
        revokedAt: NOW.toISOString(),
      }),
    ]);
  });

  it('fails closed when the exclusions table cannot be read', async () => {
    const { read } = await shareReadAndWrite();
    db.run(sql`DROP TABLE connection_grant_exclusions`);

    expect(
      await refusal(authorization.prepare(executeInput('agent-b', read, 'read')))
    ).toBeDefined();
    await expect(access.listRuntimeConnections(principal('agent-b'))).rejects.toThrow();
  });

  it('is idempotent both ways, and records each real change in Activity', async () => {
    await shareReadAndWrite();
    const first = await exclusions.leaveOut(OWNER, CONNECTION_ID, 'agent-b');
    const again = await exclusions.leaveOut(OWNER, CONNECTION_ID, 'agent-b');
    expect(first.changed).toBe(true);
    expect(again.changed).toBe(false);
    expect(exclusions.list(OWNER, CONNECTION_ID)).toEqual([
      { agentId: 'agent-b', displayName: 'Bea', createdAt: NOW.toISOString() },
    ]);

    await exclusions.letBackIn(OWNER, CONNECTION_ID, 'agent-b');
    const notSet = await exclusions.letBackIn(OWNER, CONNECTION_ID, 'agent-b');
    expect(notSet.changed).toBe(false);
    expect(exclusions.list(OWNER, CONNECTION_ID)).toEqual([]);

    expect(activity.emit).toHaveBeenCalledTimes(2);
    expect(activity.emit.mock.calls.map(([event]) => [event.eventType, event.summary])).toEqual([
      [
        AGENT_EXCLUSION_CHANGED_EVENT,
        'Left Bea out of sharing Gmail (Work Gmail) with every agent',
      ],
      [
        AGENT_EXCLUSION_CHANGED_EVENT,
        'Let Bea back into sharing Gmail (Work Gmail) with every agent',
      ],
    ]);
  });

  it("refuses another owner's connection and an agent that isn't registered", async () => {
    await expect(exclusions.leaveOut(OTHER_OWNER, CONNECTION_ID, 'agent-b')).rejects.toMatchObject({
      code: 'connection_not_found',
    });
    await expect(exclusions.leaveOut(OWNER, CONNECTION_ID, 'nobody')).rejects.toBeInstanceOf(
      ConnectorGrantExclusionError
    );
    await expect(exclusions.leaveOut(OWNER, CONNECTION_ID, 'nobody')).rejects.toMatchObject({
      code: 'agent_not_found',
    });
    expect(() => exclusions.list(OTHER_OWNER, CONNECTION_ID)).toThrow(ConnectorGrantExclusionError);
    expect(db.select().from(connectionGrantExclusions).all()).toEqual([]);
  });
});
