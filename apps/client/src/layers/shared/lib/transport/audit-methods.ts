/**
 * Audit log Transport methods (HTTP adapter) — reads only (spec `audit-trail`
 * PR4, `GET /api/audit` and the per-account timeline).
 *
 * @module shared/lib/transport/audit-methods
 */
import type {
  AuditQuery,
  AuditQueryResult,
  AuditTimelineQuery,
} from '@dorkos/shared/audit-schemas';
import { buildQueryString, fetchJSON } from './http-client';

/** Create the audit log methods bound to a base URL. */
export function createAuditMethods(baseUrl: string) {
  return {
    /** List audit events the caller may see, newest first. */
    listAuditEvents(query?: Partial<AuditQuery>): Promise<AuditQueryResult> {
      const qs = buildQueryString({
        actorId: query?.actorId,
        targetId: query?.targetId,
        action: query?.action,
        operation: query?.operation,
        sessionId: query?.sessionId,
        since: query?.since,
        until: query?.until,
        beforeSeq: query?.beforeSeq,
        limit: query?.limit,
      });
      return fetchJSON<AuditQueryResult>(baseUrl, `/audit${qs}`);
    },

    /** Everything one account did, had done to it, or had done on its behalf. */
    getAccountTimeline(
      accountId: string,
      query?: Partial<Omit<AuditTimelineQuery, 'accountId'>>
    ): Promise<AuditQueryResult> {
      const qs = buildQueryString({
        action: query?.action,
        operation: query?.operation,
        sessionId: query?.sessionId,
        since: query?.since,
        until: query?.until,
        beforeSeq: query?.beforeSeq,
        limit: query?.limit,
      });
      return fetchJSON<AuditQueryResult>(
        baseUrl,
        `/audit/accounts/${encodeURIComponent(accountId)}/timeline${qs}`
      );
    },
  };
}
