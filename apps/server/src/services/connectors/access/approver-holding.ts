/**
 * What an approving agent holds itself on one app (spec `agent-grant-autonomy`
 * §4.2, W1, Security Q3): its live read actions there, read through the same
 * grant-scope rule every execution uses, and the level it holds them at.
 *
 * Access through the app's every-agent share counts (Q3), but only while the
 * approver is not left out of it: the shared rule already drops the share for
 * an excluded agent, so an excluded approver holds nothing here.
 *
 * @module services/connectors/access/approver-holding
 */
import {
  and,
  connectionAccessLevels,
  connectionOperationGrants,
  connectorOperationRevisions,
  eq,
  isNull,
  sessionConnectionOverrides,
  type DbTransaction,
} from '@dorkos/db';
import { isPaidOperation, type ConnectorAccessLevel } from '@dorkos/shared/connector-schemas';
import { everyAgentLevel } from '../execution/access-levels.js';
import { agentGrantScope } from '../execution/agent-grant-scope.js';
import { readAccessState } from './access-state.js';

/** What one approver can give away on one app. */
export interface ApproverHolding {
  /** Its live read actions on the app, sorted. */
  readonly readIds: readonly string[];
  /**
   * The level it holds the app at, or `null` when it holds hand-picked actions
   * only (or a chat's own setting decides for it). Only a level covers every
   * read action the app offers, so only a level can answer a request for Read.
   */
  readonly level: ConnectorAccessLevel | null;
}

const LEVEL_RANK: Record<ConnectorAccessLevel, number> = { read: 1, 'read-write': 2 };

/**
 * What the approver holds on the app, in the chat it is acting from.
 *
 * @param tx - The open transaction.
 * @param approver - The approving agent and its chat.
 * @param connectionId - The app.
 */
export function approverHolding(
  tx: DbTransaction,
  approver: { readonly agentId: string; readonly sessionId?: string },
  connectionId: string
): ApproverHolding {
  const scope = agentGrantScope(tx, {
    agentId: approver.agentId,
    sessionId: approver.sessionId,
    connectionId,
  });
  if (scope.kind === 'denied') return { readIds: [], level: null };
  const readIds = tx
    .select({
      id: connectionOperationGrants.operationRevisionId,
      toolkit: connectorOperationRevisions.toolkit,
      operationSlug: connectorOperationRevisions.operationSlug,
    })
    .from(connectionOperationGrants)
    .innerJoin(
      connectorOperationRevisions,
      eq(connectorOperationRevisions.id, connectionOperationGrants.operationRevisionId)
    )
    .where(
      and(
        scope.subject,
        eq(connectionOperationGrants.connectionId, connectionId),
        isNull(connectionOperationGrants.revokedAt),
        eq(connectorOperationRevisions.capabilityClassification, 'read')
      )
    )
    .all()
    .filter((row) => !isPaidOperation(row))
    .map((row) => row.id);
  const unique = [...new Set(readIds)].sort();
  // A chat's own setting decides alone, as exact actions: no level.
  const chatDecides =
    approver.sessionId !== undefined &&
    tx
      .select({ id: sessionConnectionOverrides.sessionId })
      .from(sessionConnectionOverrides)
      .where(
        and(
          eq(sessionConnectionOverrides.sessionId, approver.sessionId),
          eq(sessionConnectionOverrides.connectionId, connectionId)
        )
      )
      .get() !== undefined;
  if (chatDecides) return { readIds: unique, level: null };
  const own =
    tx
      .select({ level: connectionAccessLevels.level })
      .from(connectionAccessLevels)
      .where(
        and(
          eq(connectionAccessLevels.connectionId, connectionId),
          eq(connectionAccessLevels.subjectType, 'agent'),
          eq(connectionAccessLevels.subjectId, approver.agentId)
        )
      )
      .get()?.level ?? null;
  const shared = readAccessState(tx, approver.agentId, connectionId).excluded
    ? null
    : everyAgentLevel(tx, connectionId);
  const level = [own, shared].reduce<ConnectorAccessLevel | null>(
    (best, next) => (next && (!best || LEVEL_RANK[next] > LEVEL_RANK[best]) ? next : best),
    null
  );
  return { readIds: unique, level };
}
