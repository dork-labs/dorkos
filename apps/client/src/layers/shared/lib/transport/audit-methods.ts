/**
 * Audit log Transport methods (HTTP adapter) — reads only (spec `audit-trail`
 * PR4, `GET /api/audit` and the per-account timeline), through the generated
 * API client (DOR-5473).
 *
 * @module shared/lib/transport/audit-methods
 */
import type {
  AuditQuery,
  AuditQueryResult,
  AuditTimelineQuery,
} from '@dorkos/shared/audit-schemas';
import { createTransportApiClient } from './api-client';

/** Create the audit log methods bound to a base URL. */
export function createAuditMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    /** List audit events the caller may see, newest first. */
    async listAuditEvents(query?: Partial<AuditQuery>): Promise<AuditQueryResult> {
      const answer = await api.call('audit.query', {
        query: {
          actorId: query?.actorId,
          targetId: query?.targetId,
          action: query?.action,
          operation: query?.operation,
          sessionId: query?.sessionId,
          since: query?.since,
          until: query?.until,
          cursor: query?.cursor,
          limit: query?.limit,
        },
      });
      // The document also lists the capability mount's 202 approval answer,
      // which a person's own read never gets; the cast keeps today's type.
      return answer as AuditQueryResult;
    },

    /** Everything one account did, had done to it, or had done on its behalf. */
    async getAccountTimeline(
      accountId: string,
      query?: Partial<Omit<AuditTimelineQuery, 'accountId'>>
    ): Promise<AuditQueryResult> {
      const answer = await api.call('audit.account_timeline', {
        path: { accountId },
        query: {
          action: query?.action,
          operation: query?.operation,
          sessionId: query?.sessionId,
          since: query?.since,
          until: query?.until,
          cursor: query?.cursor,
          limit: query?.limit,
        },
      });
      return answer as AuditQueryResult;
    },
  };
}
