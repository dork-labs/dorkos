/**
 * The agent requests an agent's approval reads and answers (spec
 * `agent-grant-autonomy` §4.2): a request still waiting, owned by the same
 * person, read straight from the request tables; and the answer, given through
 * the request service exactly as a person's "current access" answer is, so the
 * requester is resumed the same way.
 *
 * @module services/connectors/access/approval-requests
 */
import {
  and,
  connectorAgentRequests,
  connectorReviewRequests,
  eq,
  isNull,
  type Db,
} from '@dorkos/db';
import type { ConnectorAgentRequestService } from '../agent-request-service.js';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import type { ApprovalRequests } from './access-approval.js';
import { ownerColumns } from './access-writes.js';

/**
 * Requests over the live tables and the request service.
 *
 * @param db - Canonical connector database.
 * @param service - The request service, once startup has built it.
 * @param now - The clock.
 */
export function createApprovalRequests(
  db: Db,
  service: () => Pick<ConnectorAgentRequestService, 'resolve'> | undefined,
  now: () => Date = () => new Date()
): ApprovalRequests {
  return {
    pending(owner: ConnectorOwnerAuthority, requestId: string) {
      const expected = ownerColumns(owner);
      const row = db
        .select({
          agentId: connectorAgentRequests.agentId,
          serviceSlug: connectorAgentRequests.serviceSlug,
          requestedAccess: connectorAgentRequests.requestedAccess,
          expiresAt: connectorReviewRequests.expiresAt,
        })
        .from(connectorAgentRequests)
        .innerJoin(
          connectorReviewRequests,
          eq(connectorReviewRequests.id, connectorAgentRequests.reviewRequestId)
        )
        .where(
          and(
            eq(connectorAgentRequests.id, requestId),
            eq(connectorReviewRequests.ownerKind, expected.ownerKind),
            eq(connectorReviewRequests.ownerId, expected.ownerId),
            eq(connectorReviewRequests.state, 'pending'),
            isNull(connectorReviewRequests.resolutionJson),
            isNull(connectorAgentRequests.outcome)
          )
        )
        .get();
      if (!row || Date.parse(row.expiresAt) <= now().getTime()) return null;
      return {
        agentId: row.agentId,
        serviceSlug: row.serviceSlug,
        requestedAccess: row.requestedAccess,
      };
    },
    async resolveWithCurrentAccess(owner, requestId, connectionId) {
      const requests = service();
      if (!requests) throw new Error('Agent requests are not available yet.');
      await requests.resolve(owner, requestId, {
        decision: 'current_access',
        connectionId,
        eventScopes: [],
      });
    },
  };
}
