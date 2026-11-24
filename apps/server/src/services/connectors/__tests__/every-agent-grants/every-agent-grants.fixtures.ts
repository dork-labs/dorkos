/**
 * Seed rows and the per-test harness for the every-agent grant tests.
 */
import { afterEach, beforeEach, vi } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  createDb,
  eq,
  EVERY_AGENT_GRANT_SUBJECT_ID,
  runMigrations,
  type Db,
} from '@dorkos/db';
import {
  ConnectionIdSchema,
  ConnectorExecutionTargetSchema,
  ConnectorProviderInstanceIdSchema,
  type ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorAccessQueryService } from '../../execution/access-query-service.js';
import { ConnectorExecutionAuthorizationService } from '../../execution/authorization-service.js';
import { createServerPrincipal } from '../../principal/server-principal.js';
import { ConnectorReconciliationService } from '../../reconciliation-service.js';
import { ConnectorRegistry } from '../../registry.js';
import { ConnectorOperatorQueryService } from '../../resources/operator-query-service.js';
import { setOnEveryAgentEnded, type EveryAgentActivitySink } from '../../every-agent-activity.js';
import { setOnAgentCreated } from '../../../core/agent-created-hook.js';

export const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;

export const NOW = new Date('2026-09-26T12:00:00.000Z');

export const CONNECTION_ID = ConnectionIdSchema.parse('connection-a');

/** Agents the owner has. `agent-new` is never part of any preview: it arrives later. */
const OWNED_AGENTS = new Set(['agent-a', 'agent-new', 'dorkbot']);

/** The stable refusal code a connector error carries, wherever it keeps it. */
export function codeOf(error: unknown): string {
  const value = error as { code?: string; payload?: { code?: string } };
  return value.payload?.code ?? value.code ?? String(error);
}

/** The shared per-test state and helpers every every-agent-grants piece uses. */
export function useEveryAgentGrantsHarness() {
  const h = {
    db: undefined as unknown as Db,
    provider: undefined as unknown as FakeConnectorProvider,
    registry: undefined as unknown as ConnectorRegistry,
    reconciliation: undefined as unknown as ConnectorReconciliationService,
    authorization: undefined as unknown as ConnectorExecutionAuthorizationService,
    access: undefined as unknown as ConnectorAccessQueryService,
    query: undefined as unknown as ConnectorOperatorQueryService,
    nextId: undefined as unknown as number,
    activity: undefined as unknown as {
      emit: ReturnType<typeof vi.fn<EveryAgentActivitySink['emit']>>;
    },
    preview,
    revisionId,
    giveEveryAgent,
    agentPrincipal,
    runtimePrincipal,
    execute,
    refusal,
    everyAgentRows,
    grantNamed,
    insertConnection,
    strayEveryAgentRow,
    namedRevokedAt,
  };

  afterEach(() => {
    setOnAgentCreated(null);
    setOnEveryAgentEnded(null);
  });

  beforeEach(() => {
    h.activity = { emit: vi.fn<EveryAgentActivitySink['emit']>() };
    h.db = createDb(':memory:');
    runMigrations(h.db);
    h.provider = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
      type: 'fake',
      custody: 'self-host',
      toolkitVersion: 'v1',
    });
    h.registry = new ConnectorRegistry({
      db: h.db,
      configuredOwner: { ownerKind: 'local_install', ownerId: OWNER.installationId },
    });
    h.registry.register(h.provider, 'material-a');
    h.db
      .insert(connections)
      .values({
        id: CONNECTION_ID,
        providerInstanceId: h.provider.instanceId,
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
    h.nextId = 0;
    const ownership = {
      ownsAgent: (_owner: unknown, agentId: string) => OWNED_AGENTS.has(agentId),
    };
    h.reconciliation = new ConnectorReconciliationService({
      db: h.db,
      registry: h.registry,
      bootEpoch: 'boot-a',
      listAgents: () => [{ agentId: 'agent-a', displayName: 'Alpha' }],
      now: () => NOW,
      createId: () => `generated-${++h.nextId}`,
      activity: h.activity,
      writer: () => ({ actorType: 'user', actorLabel: 'Someone on this computer' }),
    });
    h.authorization = new ConnectorExecutionAuthorizationService(h.db, h.registry, ownership);
    h.access = new ConnectorAccessQueryService(h.db, ownership, h.registry, {
      revalidatePrincipal: async () => true,
    });
    h.query = new ConnectorOperatorQueryService({
      db: h.db,
      registry: h.registry,
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: ownership,
    });
  });

  async function preview(): Promise<ConnectorReconciliationPreview> {
    return h.reconciliation.preview(
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
    const snapshot = await h.preview();
    await h.reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: slugs.map((slug) => h.revisionId(snapshot, slug)) },
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
    principal: ReturnType<typeof h.agentPrincipal>,
    operationRevisionId: string,
    classification: 'read' | 'write' | 'destructive'
  ) {
    return h.authorization.prepare({
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
    return h.db
      .select()
      .from(connectionOperationGrants)
      .where(eq(connectionOperationGrants.subjectType, 'every_agent'))
      .all();
  }

  function grantNamed(id: string, agentId: string, operationRevisionId: string) {
    h.db
      .insert(connectionOperationGrants)
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
    h.db
      .insert(connections)
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
    h.db
      .insert(connectionOperationGrants)
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

  function namedRevokedAt(id: string) {
    return h.db
      .select({ revokedAt: connectionOperationGrants.revokedAt })
      .from(connectionOperationGrants)
      .where(eq(connectionOperationGrants.id, id))
      .get()?.revokedAt;
  }
  return h;
}
