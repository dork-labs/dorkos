/** Final claim fence for receipts explicitly linked to document batches. */
import {
  and,
  eq,
  inArray,
  canvasDocBatches,
  canvasDocChannels,
  canvasDocIdentityIntents,
  type DbTransaction,
} from '@dorkos/db';

/** Unrelated protected sources keep their existing source-owned authority checks. */
export function documentReceiptReady(tx: DbTransaction, receiptId: string): boolean {
  const batches = tx
    .select()
    .from(canvasDocBatches)
    .where(eq(canvasDocBatches.admissionReceiptId, receiptId))
    .all();
  return batches.every((batch) => {
    const channel = tx
      .select()
      .from(canvasDocChannels)
      .where(eq(canvasDocChannels.documentId, batch.documentId))
      .get();
    const blocked = tx
      .select({ id: canvasDocIdentityIntents.intentId })
      .from(canvasDocIdentityIntents)
      .where(
        and(
          eq(canvasDocIdentityIntents.documentId, batch.documentId),
          inArray(canvasDocIdentityIntents.status, ['pending', 'failed', 'in_doubt'])
        )
      )
      .get();
    return !!channel && channel.closedAt === null && !blocked && batch.status === 'accepted';
  });
}
