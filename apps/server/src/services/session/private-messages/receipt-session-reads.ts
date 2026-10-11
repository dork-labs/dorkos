import { sessionMessageAcceptanceReceipts, and, eq, ne, gt, asc, type Db } from '@dorkos/db';

/** List one stable keyset page of sessions with accepted messages awaiting dispatch. */
export function readAcceptedPrivateSessionIds(
  db: Db,
  limit = 100,
  afterSessionId?: string,
  excludeDocuments = false
): string[] {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  return db
    .selectDistinct({ sessionId: sessionMessageAcceptanceReceipts.sessionId })
    .from(sessionMessageAcceptanceReceipts)
    .where(
      and(
        eq(sessionMessageAcceptanceReceipts.state, 'accepted'),
        excludeDocuments
          ? ne(sessionMessageAcceptanceReceipts.sourceKind, 'document_event_batch')
          : undefined,
        afterSessionId ? gt(sessionMessageAcceptanceReceipts.sessionId, afterSessionId) : undefined
      )
    )
    .orderBy(asc(sessionMessageAcceptanceReceipts.sessionId))
    .limit(boundedLimit)
    .all()
    .map((row) => row.sessionId);
}
