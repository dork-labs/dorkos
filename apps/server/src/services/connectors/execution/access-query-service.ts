import { createHash } from 'node:crypto';
/** Owner-bound connector access and usage reads for REST and CLI programs. */
import { z } from 'zod';
import {
  and,
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorUsageAttempts,
  connectorUsageTerminalReceipts,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  or,
  sessionConnectionOverrides,
  type Db,
} from '@dorkos/db';
import {
  ConnectorAccessibleConnectionsResponseSchema,
  ConnectorAccessibleOperationsResponseSchema,
  ConnectorUsagePageSchema,
  type ConnectorAccessibleConnectionsResponse,
  type ConnectorAccessibleOperationsResponse,
  type ConnectorUsagePage,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorProviderInstanceId } from '@dorkos/shared/connector-provider';
import type { ConnectionReadinessReason } from '@dorkos/shared/connector-schemas';
import {
  deriveConnectionReadiness,
  registryWayHealth,
  type ConnectionWayHealthPort,
} from '../readiness/connection-readiness.js';
import {
  isServerPrincipal,
  type ConnectorOwnerAuthority,
  type ServerPrincipalProof,
} from '../principal/server-principal.js';
import type { ConnectorRegistry } from '../registry.js';
import type { ConnectorAgentOwnershipPort } from './authorization-service.js';
import { everyAgentGrantSubject } from '../every-agent-grants.js';
import { managedAgentAccess } from './managed-agent-access.js';

/** Bounded cursor input shared by agent and operator usage views. */
export interface ConnectorUsageQuery {
  /** Opaque cursor from a prior page. */
  readonly cursor?: string;
  /** Page size, already constrained by the HTTP schema. */
  readonly limit?: number;
}

/** Operator usage filters, deliberately independent from program agent authority. */
export interface ConnectorOperatorUsageQuery extends ConnectorUsageQuery {
  /** Optional stable connection within the verified owner. */
  readonly connectionId?: string;
}

/** Safe refusal from an owner-bound connector read. */
export class ConnectorAccessQueryError extends Error {
  /** Stable refusal category. */
  readonly code:
    'agent_not_owned' | 'connection_not_found' | 'invalid_cursor' | 'runtime_authority_expired';

  /** Construct a secret-free connector read refusal. */
  constructor(code: ConnectorAccessQueryError['code'], message: string) {
    super(message);
    this.name = 'ConnectorAccessQueryError';
    this.code = code;
  }
}

/** Live durable runtime authority needed by private grant discovery. */
export interface ConnectorRuntimeDiscoveryPrincipalPort {
  /** Recheck the exact process-authenticated runtime principal. */
  revalidatePrincipal(principal: ServerPrincipalProof): Promise<boolean>;
}

const UsageCursorSchema = z
  .object({ startedAt: z.string().datetime(), attemptId: z.string().min(1) })
  .strict();

function ownerColumns(owner: ConnectorOwnerAuthority): {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
} {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

/**
 * Grant rows that can speak for one agent: its own named grants (and, with a
 * session, that session's grants), plus every-agent grants (ADR 260926-192625),
 * which count on every connection, including one made through a DorkOS account
 * (DOR-2439).
 */
function agentGrantRows(agentId: string, sessionId?: string) {
  const named = and(
    eq(connectionOperationGrants.subjectType, 'agent'),
    eq(connectionOperationGrants.subjectId, agentId)
  );
  return or(
    and(
      eq(connectionOperationGrants.agentId, agentId),
      sessionId
        ? or(
            named,
            and(
              eq(connectionOperationGrants.subjectType, 'session'),
              eq(connectionOperationGrants.subjectId, sessionId)
            )
          )
        : named
    ),
    everyAgentGrantSubject()
  );
}

/** Keep the first row for each exact connection and revision. */
function uniqueRevisions<T extends { connectionId: string; operationRevisionId: string }>(
  rows: readonly T[]
): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.connectionId}\0${row.operationRevisionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function encodeUsageCursor(startedAt: string, attemptId: string): string {
  return Buffer.from(JSON.stringify({ startedAt, attemptId }), 'utf8').toString('base64url');
}

function decodeUsageCursor(cursor: string): z.infer<typeof UsageCursorSchema> {
  try {
    return UsageCursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new ConnectorAccessQueryError(
      'invalid_cursor',
      'This usage page is invalid. Use the next page link from the previous result.'
    );
  }
}

/** One session's access override for one connection. */
interface SessionOverride {
  connectionId: string;
  agentId: string | null;
  state: 'attached' | 'detached';
  needsReconciliation: boolean;
}

/**
 * Whether one grant row gives this agent the connection in this session. The
 * same precedence as `ConnectorExecutionAuthorizationService.hasGrant`: a
 * session override decides alone; without one, named-agent and every-agent
 * grants both count.
 */
function grantApplies(
  row: { subjectType: string },
  override: SessionOverride | undefined,
  agentId: string
): boolean {
  if (!override) return row.subjectType === 'agent' || row.subjectType === 'every_agent';
  if (
    override.agentId !== agentId ||
    override.needsReconciliation ||
    override.state === 'detached'
  ) {
    return false;
  }
  return row.subjectType === 'session';
}

/**
 * True when this chat turned the connection off for its agent: a current
 * override for this agent says detached, so no other grant counts here.
 */
function turnedOffHere(override: SessionOverride | undefined, agentId: string): boolean {
  return (
    override !== undefined &&
    override.agentId === agentId &&
    !override.needsReconciliation &&
    override.state === 'detached'
  );
}

/** SQLite-backed, owner-scoped access and usage query service. */
export class ConnectorAccessQueryService {
  private readonly wayHealth: ConnectionWayHealthPort;

  /**
   * Construct owner-bound reads over canonical connector state.
   *
   * @param wayHealth - The live health of the way behind an account. Without
   *   it, only the registry is read.
   */
  constructor(
    private readonly db: Db,
    private readonly agentOwnership: ConnectorAgentOwnershipPort,
    private readonly registry: ConnectorRegistry,
    private readonly runtimePrincipals: ConnectorRuntimeDiscoveryPrincipalPort,
    wayHealth?: ConnectionWayHealthPort
  ) {
    this.wayHealth = wayHealth ?? registryWayHealth(registry);
  }

  /** Build a private, server-only awareness snapshot for the next normal agent turn. */
  async accessSnapshot(owner: ConnectorOwnerAuthority, agentId: string, sessionId: string) {
    await this.requireOwnedAgent(owner, agentId);
    this.registry.assertAvailable();
    const executable = this.listRuntimeGrantRows(owner, agentId, sessionId);
    const ownerKey = ownerColumns(owner);
    // Include retired grants and access-state transitions, not account labels or credentials.
    // A revoke/regrant or changed operation must change awareness even at the same count.
    const history = this.db
      .select({
        id: connectionOperationGrants.id,
        revision: connectionOperationGrants.operationRevisionId,
        createdAt: connectionOperationGrants.createdAt,
        revokedAt: connectionOperationGrants.revokedAt,
        connectionUpdatedAt: connections.updatedAt,
        enabled: connections.enabled,
        status: connections.status,
        lifecycle: connections.lifecycleState,
        reconciliation: connections.grantReconciliationStatus,
        providerGeneration: connectorProviderInstances.executionConfigGeneration,
      })
      .from(connectionOperationGrants)
      .innerJoin(connections, eq(connections.id, connectionOperationGrants.connectionId))
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(
        and(
          agentGrantRows(agentId, sessionId),
          eq(connectorProviderInstances.ownerKind, ownerKey.ownerKind),
          eq(connectorProviderInstances.ownerId, ownerKey.ownerId)
        )
      )
      .all()
      .sort((a, b) => a.id.localeCompare(b.id));
    const visible = executable.map((row) => [row.connectionId, row.operationRevisionId]).sort();
    return {
      accountCount: new Set(executable.map((row) => row.connectionId)).size,
      revision: createHash('sha256')
        .update(JSON.stringify([history, visible]))
        .digest('hex'),
    };
  }

  /** List connections that retain at least one exact grant for an owned agent. */
  async listConnections(
    owner: ConnectorOwnerAuthority,
    agentId: string
  ): Promise<ConnectorAccessibleConnectionsResponse> {
    await this.requireOwnedAgent(owner, agentId);
    const ownerKey = ownerColumns(owner);
    const rows = this.db
      .select({
        connectionId: connections.id,
        toolkit: connections.toolkit,
        label: connections.label,
        status: connections.status,
        lifecycleState: connections.lifecycleState,
        enabled: connections.enabled,
        custody: connectorProviderInstances.custody,
        reconciliationStatus: connections.grantReconciliationStatus,
      })
      .from(connectionOperationGrants)
      .innerJoin(connections, eq(connections.id, connectionOperationGrants.connectionId))
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(
        and(
          agentGrantRows(agentId),
          isNull(connectionOperationGrants.revokedAt),
          eq(connectorProviderInstances.ownerKind, ownerKey.ownerKind),
          eq(connectorProviderInstances.ownerId, ownerKey.ownerId),
          eq(connections.lifecycleState, 'connected')
        )
      )
      .all();
    const unique = new Map<string, (typeof rows)[number]>();
    for (const row of rows) unique.set(row.connectionId, row);
    return ConnectorAccessibleConnectionsResponseSchema.parse({
      connections: [...unique.values()]
        .sort(
          (a, b) => a.label.localeCompare(b.label) || a.connectionId.localeCompare(b.connectionId)
        )
        .map((row) => ({
          connectionId: row.connectionId,
          toolkit: row.toolkit,
          label: row.label,
          status: row.enabled ? row.status : 'paused',
          custody: row.custody,
          reconciliationStatus: row.reconciliationStatus,
        })),
    });
  }

  /** List exact immutable revisions granted to an owned agent for one connection. */
  async listOperations(
    owner: ConnectorOwnerAuthority,
    agentId: string,
    connectionId: string
  ): Promise<ConnectorAccessibleOperationsResponse> {
    await this.requireOwnedAgent(owner, agentId);
    const ownerKey = ownerColumns(owner);
    const rows = this.db
      .select({
        operationRevisionId: connectorOperationRevisions.id,
        toolkit: connectorOperationRevisions.toolkit,
        operationSlug: connectorOperationRevisions.operationSlug,
        toolkitVersion: connectorOperationRevisions.toolkitVersion,
        capabilityClassification: connectorOperationRevisions.capabilityClassification,
        retryPolicy: connectorOperationRevisions.retryPolicy,
        inputSchemaJson: connectorOperationRevisions.inputSchemaJson,
      })
      .from(connectionOperationGrants)
      .innerJoin(connections, eq(connections.id, connectionOperationGrants.connectionId))
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .innerJoin(
        connectorOperationRevisions,
        and(
          eq(connectorOperationRevisions.id, connectionOperationGrants.operationRevisionId),
          eq(connectorOperationRevisions.providerInstanceId, connections.providerInstanceId)
        )
      )
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.lifecycleState, 'connected'),
          agentGrantRows(agentId),
          isNull(connectionOperationGrants.revokedAt),
          eq(connectorProviderInstances.ownerKind, ownerKey.ownerKind),
          eq(connectorProviderInstances.ownerId, ownerKey.ownerId)
        )
      )
      .all();
    const connectionExists = this.db
      .select({ id: connections.id })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.lifecycleState, 'connected'),
          eq(connectorProviderInstances.ownerKind, ownerKey.ownerKind),
          eq(connectorProviderInstances.ownerId, ownerKey.ownerId)
        )
      )
      .get();
    if (!connectionExists) {
      throw new ConnectorAccessQueryError('connection_not_found', 'Connection not found.');
    }
    return ConnectorAccessibleOperationsResponseSchema.parse({
      connectionId,
      operations: uniqueRevisions(rows.map((row) => ({ ...row, connectionId })))
        .map((row) => ({
          operationRevisionId: row.operationRevisionId,
          toolkit: row.toolkit,
          operationSlug: row.operationSlug,
          toolkitVersion: row.toolkitVersion,
          capabilityClassification: row.capabilityClassification,
          retryPolicy: row.retryPolicy,
          inputSchema: JSON.parse(row.inputSchemaJson) as Record<string, unknown>,
        }))
        .sort(
          (a, b) =>
            a.operationSlug.localeCompare(b.operationSlug) ||
            a.operationRevisionId.localeCompare(b.operationRevisionId)
        ),
    });
  }

  /** List only connections executable by one authenticated runtime turn. */
  async listRuntimeConnections(
    principal: ServerPrincipalProof
  ): Promise<ConnectorAccessibleConnectionsResponse> {
    const claims = await this.requireLiveRuntimePrincipal(principal);
    this.registry.assertAvailable();
    const rows = this.listRuntimeGrantRows(claims.owner, claims.agentId, claims.canonicalSessionId);
    const unique = new Map<string, (typeof rows)[number]>();
    for (const row of rows) unique.set(row.connectionId, row);
    const unavailable = this.listUnavailableConnections(
      claims.owner,
      claims.agentId,
      claims.canonicalSessionId
    ).filter((row) => !unique.has(row.connectionId));
    return ConnectorAccessibleConnectionsResponseSchema.parse({
      ...(unavailable.length > 0 && { unavailable }),
      connections: [...unique.values()]
        .sort(
          (left, right) =>
            left.label.localeCompare(right.label) ||
            left.connectionId.localeCompare(right.connectionId)
        )
        .map((row) => ({
          connectionId: row.connectionId,
          toolkit: row.toolkit,
          label: row.label,
          status: row.status,
          custody: row.custody,
          reconciliationStatus: row.reconciliationStatus,
        })),
    });
  }

  /** List only exact revisions executable by one authenticated runtime turn. */
  async listRuntimeOperations(
    principal: ServerPrincipalProof,
    connectionId: string
  ): Promise<ConnectorAccessibleOperationsResponse> {
    const claims = await this.requireLiveRuntimePrincipal(principal);
    this.registry.assertAvailable();
    const rows = this.listRuntimeGrantRows(
      claims.owner,
      claims.agentId,
      claims.canonicalSessionId,
      connectionId
    );
    if (rows.length === 0) {
      throw new ConnectorAccessQueryError('connection_not_found', 'Connection not found.');
    }
    return ConnectorAccessibleOperationsResponseSchema.parse({
      connectionId,
      operations: rows
        .map((row) => ({
          operationRevisionId: row.operationRevisionId,
          toolkit: row.operationToolkit,
          operationSlug: row.operationSlug,
          toolkitVersion: row.toolkitVersion,
          capabilityClassification: row.capabilityClassification,
          retryPolicy: row.retryPolicy,
          inputSchema: JSON.parse(row.inputSchemaJson) as Record<string, unknown>,
        }))
        .sort(
          (left, right) =>
            left.operationSlug.localeCompare(right.operationSlug) ||
            left.operationRevisionId.localeCompare(right.operationRevisionId)
        ),
    });
  }

  /** List usage for one owned agent without exposing another agent or owner. */
  async listAgentUsage(
    owner: ConnectorOwnerAuthority,
    agentId: string,
    query: ConnectorUsageQuery
  ): Promise<ConnectorUsagePage> {
    await this.requireOwnedAgent(owner, agentId);
    return this.listUsage(owner, { ...query, agentId });
  }

  /** List owner-wide usage, optionally narrowed to one owner-scoped connection. */
  listOperatorUsage(
    owner: ConnectorOwnerAuthority,
    query: ConnectorOperatorUsageQuery
  ): ConnectorUsagePage {
    return this.listUsage(owner, query);
  }

  private async requireOwnedAgent(owner: ConnectorOwnerAuthority, agentId: string): Promise<void> {
    if (!(await this.agentOwnership.ownsAgent(owner, agentId))) {
      throw new ConnectorAccessQueryError('agent_not_owned', 'Agent not found.');
    }
  }

  private async requireLiveRuntimePrincipal(principal: ServerPrincipalProof) {
    if (!isServerPrincipal(principal) || principal.claims.kind !== 'runtime') {
      throw new ConnectorAccessQueryError(
        'runtime_authority_expired',
        'This agent session can no longer use connections. Start a new turn and try again.'
      );
    }
    if (!(await this.runtimePrincipals.revalidatePrincipal(principal))) {
      throw new ConnectorAccessQueryError(
        'runtime_authority_expired',
        'This agent session can no longer use connections. Start a new turn and try again.'
      );
    }
    await this.requireOwnedAgent(principal.claims.owner, principal.claims.agentId);
    if (!(await this.runtimePrincipals.revalidatePrincipal(principal))) {
      throw new ConnectorAccessQueryError(
        'runtime_authority_expired',
        'This agent session can no longer use connections. Start a new turn and try again.'
      );
    }
    return principal.claims;
  }

  private listRuntimeGrantRows(
    owner: ConnectorOwnerAuthority,
    agentId: string,
    sessionId: string,
    connectionId?: string
  ) {
    const ownerKey = ownerColumns(owner);
    const overrides = this.sessionOverrides(sessionId);
    const rows = this.db
      .select({
        subjectType: connectionOperationGrants.subjectType,
        connectionId: connections.id,
        toolkit: connections.toolkit,
        label: connections.label,
        status: connections.status,
        custody: connectorProviderInstances.custody,
        reconciliationStatus: connections.grantReconciliationStatus,
        providerInstanceId: connectorProviderInstances.id,
        providerType: connectorProviderInstances.type,
        mode: connectorProviderInstances.mode,
        externalAccountRef: connections.externalAccountRef,
        operationRevisionId: connectorOperationRevisions.id,
        operationToolkit: connectorOperationRevisions.toolkit,
        operationSlug: connectorOperationRevisions.operationSlug,
        toolkitVersion: connectorOperationRevisions.toolkitVersion,
        capabilityClassification: connectorOperationRevisions.capabilityClassification,
        retryPolicy: connectorOperationRevisions.retryPolicy,
        inputSchemaJson: connectorOperationRevisions.inputSchemaJson,
      })
      .from(connectionOperationGrants)
      .innerJoin(connections, eq(connections.id, connectionOperationGrants.connectionId))
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .innerJoin(
        connectorOperationRevisions,
        and(
          eq(connectorOperationRevisions.id, connectionOperationGrants.operationRevisionId),
          eq(connectorOperationRevisions.providerInstanceId, connections.providerInstanceId)
        )
      )
      .where(
        and(
          isNull(connectionOperationGrants.revokedAt),
          agentGrantRows(agentId, sessionId),
          eq(connectorProviderInstances.ownerKind, ownerKey.ownerKind),
          eq(connectorProviderInstances.ownerId, ownerKey.ownerId),
          eq(connectorProviderInstances.status, 'available'),
          isNotNull(connectorProviderInstances.executionConfigDigest),
          gt(connectorProviderInstances.executionConfigGeneration, 0),
          eq(connections.lifecycleState, 'connected'),
          eq(connections.enabled, true),
          eq(connections.status, 'active'),
          eq(connections.grantReconciliationStatus, 'ready'),
          ...(connectionId ? [eq(connections.id, connectionId)] : [])
        )
      )
      .all();
    const executable = rows.filter((row) => {
      const provider = this.registry.resolveProviderInstance(
        row.providerInstanceId as ConnectorProviderInstanceId
      );
      if (
        !provider ||
        provider.type !== row.providerType ||
        provider.getCapabilities().capabilities.execution.status !== 'available'
      ) {
        return false;
      }
      if (!grantApplies(row, overrides.get(row.connectionId), agentId)) return false;
      // Through a DorkOS account, a call needs this agent's access applied at
      // the hosted side, exactly as the execution check reads it.
      return (
        row.mode !== 'managed' ||
        managedAgentAccess(this.db, row.externalAccountRef, agentId, {
          named: row.subjectType !== 'every_agent',
          everyAgent: row.subjectType === 'every_agent',
        }).applied !== undefined
      );
    });
    return uniqueRevisions(executable);
  }

  /**
   * Accounts this agent was given that it cannot use right now, each with the
   * readiness reason and what the agent tells the person (DOR-2494, DOR-2500).
   * Same owner and grant rules as {@link listRuntimeGrantRows}, except that an
   * account this chat turned off is listed (as off for this chat) rather than
   * dropped. A disconnected account is not listed: it is no longer the
   * agent's to use. Access sync is this agent's own ({@link managedAgentAccess}),
   * never the account-wide state that spans every agent.
   */
  private listUnavailableConnections(
    owner: ConnectorOwnerAuthority,
    agentId: string,
    sessionId: string
  ): Array<{
    connectionId: string;
    toolkit: string;
    label: string;
    reason: ConnectionReadinessReason;
    note: string;
  }> {
    const ownerKey = ownerColumns(owner);
    const overrides = this.sessionOverrides(sessionId);
    const rows = this.db
      .select({
        subjectType: connectionOperationGrants.subjectType,
        connectionId: connections.id,
        toolkit: connections.toolkit,
        label: connections.label,
        providerInstanceId: connections.providerInstanceId,
        enabled: connections.enabled,
        pausedBy: connections.pausedBy,
        status: connections.status,
        reconciliationStatus: connections.grantReconciliationStatus,
        mode: connectorProviderInstances.mode,
        externalAccountRef: connections.externalAccountRef,
      })
      .from(connectionOperationGrants)
      .innerJoin(connections, eq(connections.id, connectionOperationGrants.connectionId))
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(
        and(
          isNull(connectionOperationGrants.revokedAt),
          agentGrantRows(agentId, sessionId),
          eq(connectorProviderInstances.ownerKind, ownerKey.ownerKind),
          eq(connectorProviderInstances.ownerId, ownerKey.ownerId),
          isNull(connections.removedAt),
          eq(connections.lifecycleState, 'connected')
        )
      )
      .all();
    const unavailable = new Map<
      string,
      {
        connectionId: string;
        toolkit: string;
        label: string;
        reason: ConnectionReadinessReason;
        note: string;
      }
    >();
    // Every grant row that gives this agent the account, by account.
    const byConnection = new Map<
      string,
      {
        row: (typeof rows)[number];
        offHere: boolean;
        granted: { named: boolean; everyAgent: boolean };
      }
    >();
    for (const row of rows) {
      const override = overrides.get(row.connectionId);
      const offHere = turnedOffHere(override, agentId);
      if (!offHere && !grantApplies(row, override, agentId)) continue;
      const current = byConnection.get(row.connectionId) ?? {
        row,
        offHere,
        granted: { named: false, everyAgent: false },
      };
      if (row.subjectType === 'every_agent') current.granted.everyAgent = true;
      else current.granted.named = true;
      byConnection.set(row.connectionId, current);
    }
    for (const { row, offHere, granted } of byConnection.values()) {
      const readiness = deriveConnectionReadiness({
        lifecycle: row.enabled ? 'connected' : 'paused',
        pausedBy: row.pausedBy,
        authenticationStatus: row.status,
        reconciliationStatus: row.reconciliationStatus,
        // This agent's own hosted access, never another agent's.
        ...(row.mode === 'managed' && {
          authoritySync: managedAgentAccess(this.db, row.externalAccountRef, agentId, granted).sync,
        }),
        mode: row.mode,
        toolkit: row.toolkit,
        way: this.wayHealth(row.providerInstanceId, row.toolkit),
        offForThisChat: offHere,
      });
      if (readiness.state === 'ready') continue;
      unavailable.set(row.connectionId, {
        connectionId: row.connectionId,
        toolkit: row.toolkit,
        label: row.label,
        reason: readiness.reason,
        note: readiness.copy.agent,
      });
    }
    return [...unavailable.values()].sort(
      (left, right) =>
        left.label.localeCompare(right.label) || left.connectionId.localeCompare(right.connectionId)
    );
  }

  /** This session's per-connection access overrides, by connection id. */
  private sessionOverrides(sessionId: string): Map<string, SessionOverride> {
    return new Map(
      this.db
        .select({
          connectionId: sessionConnectionOverrides.connectionId,
          agentId: sessionConnectionOverrides.agentId,
          state: sessionConnectionOverrides.state,
          needsReconciliation: sessionConnectionOverrides.needsReconciliation,
        })
        .from(sessionConnectionOverrides)
        .where(eq(sessionConnectionOverrides.sessionId, sessionId))
        .all()
        .map((row) => [row.connectionId, row] as const)
    );
  }

  private listUsage(
    owner: ConnectorOwnerAuthority,
    query: ConnectorOperatorUsageQuery & { agentId?: string }
  ): ConnectorUsagePage {
    const ownerKey = ownerColumns(owner);
    const limit = query.limit ?? 50;
    const cursor = query.cursor ? decodeUsageCursor(query.cursor) : undefined;
    const conditions = [
      eq(connectorUsageAttempts.ownerKind, ownerKey.ownerKind),
      eq(connectorUsageAttempts.ownerId, ownerKey.ownerId),
      ...(query.agentId ? [eq(connectorUsageAttempts.agentId, query.agentId)] : []),
      ...(query.connectionId ? [eq(connectorUsageAttempts.connectionId, query.connectionId)] : []),
      ...(cursor
        ? [
            or(
              lt(connectorUsageAttempts.startedAt, cursor.startedAt),
              and(
                eq(connectorUsageAttempts.startedAt, cursor.startedAt),
                lt(connectorUsageAttempts.attemptId, cursor.attemptId)
              )
            ),
          ]
        : []),
    ];
    const rows = this.db
      .select({
        attemptId: connectorUsageAttempts.attemptId,
        logicalOperationId: connectorUsageAttempts.logicalOperationId,
        attemptIndex: connectorUsageAttempts.attemptIndex,
        surface: connectorUsageAttempts.surface,
        actorKind: connectorUsageAttempts.actorKind,
        agentId: connectorUsageAttempts.agentId,
        connectionId: connectorUsageAttempts.connectionId,
        toolkit: connectorOperationRevisions.toolkit,
        operationRevisionId: connectorUsageAttempts.operationRevisionId,
        operationSlug: connectorOperationRevisions.operationSlug,
        payer: connectorUsageAttempts.payer,
        outcome: connectorUsageTerminalReceipts.outcome,
        errorCode: connectorUsageTerminalReceipts.errorCode,
        startedAt: connectorUsageAttempts.startedAt,
        completedAt: connectorUsageTerminalReceipts.completedAt,
      })
      .from(connectorUsageAttempts)
      .innerJoin(
        connectorOperationRevisions,
        eq(connectorOperationRevisions.id, connectorUsageAttempts.operationRevisionId)
      )
      .leftJoin(
        connectorUsageTerminalReceipts,
        eq(connectorUsageTerminalReceipts.attemptId, connectorUsageAttempts.attemptId)
      )
      .where(and(...conditions))
      .orderBy(desc(connectorUsageAttempts.startedAt), desc(connectorUsageAttempts.attemptId))
      .limit(limit + 1)
      .all();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return ConnectorUsagePageSchema.parse({
      items: page.map(
        ({ attemptId: _attemptId, agentId, outcome, errorCode, completedAt, ...row }) => ({
          ...row,
          ...(agentId ? { agentId } : {}),
          ...(outcome ? { outcome } : {}),
          ...(errorCode ? { errorCode } : {}),
          ...(completedAt ? { completedAt } : {}),
        })
      ),
      ...(rows.length > limit && last
        ? { nextCursor: encodeUsageCursor(last.startedAt, last.attemptId) }
        : {}),
    });
  }
}
