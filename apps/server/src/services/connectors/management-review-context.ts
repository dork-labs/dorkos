/** Immutable, owner-visible presentation facts for connector management reviews. */
import {
  and,
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  eq,
  inArray,
  isNull,
  or,
  type Db,
} from '@dorkos/db';
import {
  ConnectionIdSchema,
  type ConnectorManagementReviewAction,
  type ConnectorManagementReviewContext,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorOwnerAuthority } from './principal/server-principal.js';

/** Resolve one verified owner agent into stable presentation data. */
export type ConnectorReviewAgentPresentationResolver = (
  owner: ConnectorOwnerAuthority,
  agentId: string
) => { readonly displayName: string } | undefined;

/** Capture review display facts once, without consulting a fresh provider catalog. */
export class ConnectorManagementReviewContextBuilder {
  /** Construct the builder over canonical local state. */
  constructor(
    private readonly db: Db,
    private readonly resolveAgent: ConnectorReviewAgentPresentationResolver
  ) {}

  /** Build the immutable public snapshot stored beside a validated action. */
  build(
    owner: ConnectorOwnerAuthority,
    action: ConnectorManagementReviewAction
  ): ConnectorManagementReviewContext {
    if (action.kind === 'connect') {
      const provider = this.db
        .select({ displayName: connectorProviderInstances.displayName })
        .from(connectorProviderInstances)
        .where(eq(connectorProviderInstances.id, action.providerInstanceId))
        .get();
      if (!provider) throw new Error('Validated connector provider disappeared during review.');
      return {
        kind: action.kind,
        providerInstanceId: action.providerInstanceId,
        providerDisplayName: provider.displayName,
        toolkit: action.toolkit,
        ...(action.label ? { label: action.label } : {}),
      };
    }

    const connection = this.db
      .select({
        connectionId: connections.id,
        label: connections.label,
        toolkit: connections.toolkit,
        status: connections.status,
        enabled: connections.enabled,
        custody: connectorProviderInstances.custody,
        providerDisplayName: connectorProviderInstances.displayName,
        providerStatus: connectorProviderInstances.status,
        reconciliationStatus: connections.grantReconciliationStatus,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(eq(connections.id, action.connectionId))
      .get();
    if (!connection) throw new Error('Validated connector disappeared during review.');
    const publicConnection = {
      connectionId: ConnectionIdSchema.parse(connection.connectionId),
      label: connection.label,
      toolkit: connection.toolkit,
      status: connection.enabled ? connection.status : ('paused' as const),
      custody: connection.custody,
      providerDisplayName: connection.providerDisplayName,
      providerStatus: connection.providerStatus,
      reconciliationStatus: connection.reconciliationStatus,
    };
    if (action.kind === 'edit' || action.kind === 'pause' || action.kind === 'resume') {
      return { kind: action.kind, connection: publicConnection };
    }
    if (action.kind === 'set_agent_access') {
      const agent = this.requireAgent(owner, action.agentId);
      return {
        kind: action.kind,
        connection: publicConnection,
        agent: { agentId: action.agentId, displayName: agent.displayName },
        requestedOperations: this.readOperationContext(action.operationRevisionIds),
      };
    }
    if (action.kind === 'remove_agent_access') {
      const agent = this.requireAgent(owner, action.agentId);
      const grants = this.db
        .select({ operationRevisionId: connectionOperationGrants.operationRevisionId })
        .from(connectionOperationGrants)
        .where(
          and(
            eq(connectionOperationGrants.connectionId, action.connectionId),
            isNull(connectionOperationGrants.revokedAt),
            or(
              eq(connectionOperationGrants.agentId, action.agentId),
              and(
                eq(connectionOperationGrants.subjectType, 'agent'),
                eq(connectionOperationGrants.subjectId, action.agentId)
              )
            )
          )
        )
        .all();
      return {
        kind: action.kind,
        connection: publicConnection,
        agent: { agentId: action.agentId, displayName: agent.displayName },
        affectedOperations: this.readOperationContext(
          [...new Set(grants.map((grant) => grant.operationRevisionId))].sort()
        ),
      };
    }

    const grants = this.db
      .select({
        operationRevisionId: connectionOperationGrants.operationRevisionId,
        agentId: connectionOperationGrants.agentId,
        subjectType: connectionOperationGrants.subjectType,
        subjectId: connectionOperationGrants.subjectId,
      })
      .from(connectionOperationGrants)
      .where(
        and(
          eq(connectionOperationGrants.connectionId, action.connectionId),
          isNull(connectionOperationGrants.revokedAt)
        )
      )
      .all();
    const agentIds = new Set(
      grants.flatMap((grant) => {
        const agentId = grant.agentId ?? (grant.subjectType === 'agent' ? grant.subjectId : null);
        return agentId ? [agentId] : [];
      })
    );
    return {
      kind: action.kind,
      connection: publicConnection,
      affectedAgentCount: agentIds.size,
      affectedOperations: this.readOperationContext(
        [...new Set(grants.map((grant) => grant.operationRevisionId))].sort()
      ),
    };
  }

  private requireAgent(
    owner: ConnectorOwnerAuthority,
    agentId: string
  ): { readonly displayName: string } {
    const agent = this.resolveAgent(owner, agentId);
    if (!agent) throw new Error('Validated connector agent disappeared during review.');
    return agent;
  }

  private readOperationContext(operationRevisionIds: readonly string[]) {
    if (operationRevisionIds.length === 0) return [];
    const rows = this.db
      .select({
        operationRevisionId: connectorOperationRevisions.id,
        operationSlug: connectorOperationRevisions.operationSlug,
        toolkitVersion: connectorOperationRevisions.toolkitVersion,
        capabilityClassification: connectorOperationRevisions.capabilityClassification,
      })
      .from(connectorOperationRevisions)
      .where(inArray(connectorOperationRevisions.id, [...operationRevisionIds]))
      .all();
    const byId = new Map(rows.map((row) => [row.operationRevisionId, row]));
    return operationRevisionIds.map((id) => {
      const row = byId.get(id);
      if (!row) throw new Error('Validated connector revision disappeared during review.');
      return row;
    });
  }
}
