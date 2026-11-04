/** Expired approvals can be removed only after rows that cite them are removed. */
import { and, approvals, isNotNull, lt, notInArray, type Db } from '@dorkos/db';

/** Keep the source audit row available while a person-requested review references it. */
export function purgeExpiredApprovals(db: Db, olderThan: Date): number {
  const referenced = db
    .select({ id: approvals.retryOf })
    .from(approvals)
    .where(isNotNull(approvals.retryOf));
  return db
    .delete(approvals)
    .where(
      and(lt(approvals.expiresAt, olderThan.toISOString()), notInArray(approvals.id, referenced))
    )
    .run().changes;
}
