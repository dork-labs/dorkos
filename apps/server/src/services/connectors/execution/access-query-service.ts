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
import {
  isServerPrincipal,
  type ConnectorOwnerAuthority,
  type ServerPrincipalProof,
} from '../principal/server-principal.js';
import type { ConnectorRegistry } from '../registry.js';
import type { ConnectorAgentOwnershipPort } from './authorization-service.js';

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

/** SQLite-backed, owner-scoped access and usage query service. */
export class ConnectorAccessQueryService {
  /** Construct owner-bound reads over canonical connector state. */
  constructor(
    private readonly db: Db,
    private readonly agentOwnership: ConnectorAgentOwnershipPort,
    private readonly registry: ConnectorRegistry,
    private readonly runtimePrincipals: ConnectorRuntimeDiscoveryPrincipalPort
  ) {}

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
          eq(connectionOperationGrants.subjectType, 'agent'),
          eq(connectionOperationGrants.subjectId, agentId),
          eq(connectionOperationGrants.agentId, agentId),
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
          eq(connectionOperationGrants.subjectType, 'agent'),
          eq(connectionOperationGrants.subjectId, agentId),
          eq(connectionOperationGrants.agentId, agentId),
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
      operations: rows
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
    return ConnectorAccessibleConnectionsResponseSchema.parse({
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
    const overrides = new Map(
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
          eq(connectionOperationGrants.agentId, agentId),
          or(
            and(
              eq(connectionOperationGrants.subjectType, 'agent'),
              eq(connectionOperationGrants.subjectId, agentId)
            ),
            and(
              eq(connectionOperationGrants.subjectType, 'session'),
              eq(connectionOperationGrants.subjectId, sessionId)
            )
          ),
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
    return rows.filter((row) => {
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
      const override = overrides.get(row.connectionId);
      if (!override) return row.subjectType === 'agent';
      if (
        override.agentId !== agentId ||
        override.needsReconciliation ||
        override.state === 'detached'
      ) {
        return false;
      }
      return row.subjectType === 'session';
    });
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
