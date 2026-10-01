/** Source-owned movement of an accepted protected receipt, never a new admission. */
import {
  and,
  eq,
  sessionMessageAcceptanceReceipts,
  type DbTransaction,
  type SessionMessageAcceptanceReceipt,
} from '@dorkos/db';

/** The caller validates source authority and supplies its exact canonical digest. */
export function rebindAcceptedReceipt(
  tx: DbTransaction,
  receiptId: string,
  fromSessionId: string,
  toSessionId: string,
  validate: (receipt: SessionMessageAcceptanceReceipt) => string | undefined
): boolean {
  const receipt = tx
    .select()
    .from(sessionMessageAcceptanceReceipts)
    .where(eq(sessionMessageAcceptanceReceipts.id, receiptId))
    .get();
  if (!receipt || receipt.state !== 'accepted' || receipt.sessionId !== fromSessionId) return false;
  const digest = validate(receipt);
  if (!digest) return false;
  return (
    tx
      .update(sessionMessageAcceptanceReceipts)
      .set({ sessionId: toSessionId, originAuthorityDigest: digest })
      .where(
        and(
          eq(sessionMessageAcceptanceReceipts.id, receiptId),
          eq(sessionMessageAcceptanceReceipts.state, 'accepted'),
          eq(sessionMessageAcceptanceReceipts.sessionId, fromSessionId),
          eq(sessionMessageAcceptanceReceipts.originAuthorityDigest, receipt.originAuthorityDigest)
        )
      )
      .run().changes === 1
  );
}
