/** Early-boot cleanup of pending connector authority for canonical agent removal. */
import {
  and,
  approvals,
  connectorReconciliationAgents,
  connectorReconciliationPreviews,
  connectorReviewRequests,
  connectorRuntimeBindings,
  eq,
  inArray,
  isNull,
  type Db,
} from '@dorkos/db';
import type { ConnectorAuthorityCleanupPort } from './authority-cleanup-port.js';

/** Construction options for exact connector authority cleanup. */
export interface ConnectorAuthorityCleanupServiceOptions {
  /** Canonical DorkOS database available before provider reconciliation. */
  readonly db: Db;
  /** Injectable clock for deterministic cleanup evidence. */
  readonly now?: () => Date;
}

/** SQLite cleanup implementation constructed beside the early connector stores. */
export class ConnectorAuthorityCleanupService implements ConnectorAuthorityCleanupPort {
  private readonly db: Db;
  private readonly now: () => Date;

  /**
   * Construct the cleanup service.
   *
   * @param options - Early database handle and optional deterministic clock.
   */
  constructor(options: ConnectorAuthorityCleanupServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
  }

  /** Revoke pending authority for one removed stable agent. */
  revokeAgent(input: { readonly agentId: string; readonly reason: 'agent_removed' }): void {
    this.revoke({ agentId: input.agentId, revokeRuntimeBindings: true, reason: input.reason });
  }

  /** Revoke pending authority for one removed agent/connection pair. */
  revokeAgentConnection(
    input: Parameters<ConnectorAuthorityCleanupPort['revokeAgentConnection']>[0]
  ): void {
    this.revoke({
      agentId: input.agentId,
      connectionId: input.connectionId,
      revokeRuntimeBindings: false,
      reason: input.reason,
    });
  }

  /** Revoke pending authority for one disconnected connection across every agent. */
  revokeConnection(input: Parameters<ConnectorAuthorityCleanupPort['revokeConnection']>[0]): void {
    const now = this.now().toISOString();
    this.db.transaction((tx) => {
      const approvalScope = and(
        eq(approvals.connectorConnectionId, input.connectionId),
        isNull(approvals.consumedAt)
      );
      tx.update(approvals)
        .set({
          state: 'denied',
          denyReason: 'Connector authority was removed.',
          decidedAt: now,
          consumedAt: now,
        })
        .where(and(approvalScope, eq(approvals.state, 'pending')))
        .run();
      tx.update(approvals).set({ consumedAt: now }).where(approvalScope).run();

      const reviewScope = eq(connectorReviewRequests.connectionId, input.connectionId);
      tx.update(connectorReviewRequests)
        .set({
          state: 'expired',
          resolvedAt: now,
          resolutionSummary: 'Connector authority was removed.',
          resolutionJson: null,
          authorityRevokedAt: now,
          authorityRevokeReason: input.reason,
        })
        .where(
          and(
            reviewScope,
            eq(connectorReviewRequests.state, 'pending'),
            isNull(connectorReviewRequests.authorityRevokedAt)
          )
        )
        .run();
      tx.update(connectorReviewRequests)
        .set({ authorityRevokedAt: now, authorityRevokeReason: input.reason })
        .where(and(reviewScope, isNull(connectorReviewRequests.authorityRevokedAt)))
        .run();

      tx.delete(connectorReconciliationPreviews)
        .where(eq(connectorReconciliationPreviews.connectionId, input.connectionId))
        .run();
    });
  }

  private revoke(input: {
    agentId: string;
    connectionId?: string;
    revokeRuntimeBindings: boolean;
    reason: 'agent_removed' | 'agent_connection_removed';
  }): void {
    const now = this.now().toISOString();
    this.db.transaction((tx) => {
      const approvalScope = input.connectionId
        ? and(
            eq(approvals.connectorAgentId, input.agentId),
            eq(approvals.connectorConnectionId, input.connectionId),
            isNull(approvals.consumedAt)
          )
        : and(eq(approvals.connectorAgentId, input.agentId), isNull(approvals.consumedAt));
      tx.update(approvals)
        .set({
          state: 'denied',
          denyReason: 'Connector authority was removed.',
          decidedAt: now,
          consumedAt: now,
        })
        .where(and(approvalScope, eq(approvals.state, 'pending')))
        .run();
      tx.update(approvals).set({ consumedAt: now }).where(approvalScope).run();

      const reviewIdentityScope = input.connectionId
        ? and(
            eq(connectorReviewRequests.agentId, input.agentId),
            eq(connectorReviewRequests.connectionId, input.connectionId)
          )
        : eq(connectorReviewRequests.agentId, input.agentId);
      tx.update(connectorReviewRequests)
        .set({
          state: 'expired',
          resolvedAt: now,
          resolutionSummary: 'Connector authority was removed.',
          resolutionJson: null,
          authorityRevokedAt: now,
          authorityRevokeReason: input.reason,
        })
        .where(
          and(
            reviewIdentityScope,
            eq(connectorReviewRequests.state, 'pending'),
            isNull(connectorReviewRequests.authorityRevokedAt)
          )
        )
        .run();
      tx.update(connectorReviewRequests)
        .set({ authorityRevokedAt: now, authorityRevokeReason: input.reason })
        .where(and(reviewIdentityScope, isNull(connectorReviewRequests.authorityRevokedAt)))
        .run();

      const previewRows = tx
        .select({ id: connectorReconciliationPreviews.id })
        .from(connectorReconciliationAgents)
        .innerJoin(
          connectorReconciliationPreviews,
          eq(connectorReconciliationPreviews.id, connectorReconciliationAgents.previewId)
        )
        .where(
          input.connectionId
            ? and(
                eq(connectorReconciliationAgents.agentId, input.agentId),
                eq(connectorReconciliationPreviews.connectionId, input.connectionId),
                isNull(connectorReconciliationPreviews.consumedAt)
              )
            : and(
                eq(connectorReconciliationAgents.agentId, input.agentId),
                isNull(connectorReconciliationPreviews.consumedAt)
              )
        )
        .all();
      const previewIds = [...new Set(previewRows.map((row) => row.id))];
      if (previewIds.length > 0) {
        tx.delete(connectorReconciliationPreviews)
          .where(inArray(connectorReconciliationPreviews.id, previewIds))
          .run();
      }

      // A runtime binding covers the whole turn and may authorize several
      // independent connections. Exact connection removal therefore leaves
      // the bearer alive: the next broker preflight sees the revoked exact
      // grant and refuses only that connection. Whole-agent removal invalidates
      // every turn because no connection remains legitimate for that agent.
      const runtimeScope = input.revokeRuntimeBindings
        ? and(
            eq(connectorRuntimeBindings.agentId, input.agentId),
            isNull(connectorRuntimeBindings.revokedAt)
          )
        : undefined;
      if (runtimeScope) {
        tx.update(connectorRuntimeBindings)
          .set({ revokedAt: now, revokeReason: input.reason })
          .where(runtimeScope)
          .run();
      }
    });
  }
}
