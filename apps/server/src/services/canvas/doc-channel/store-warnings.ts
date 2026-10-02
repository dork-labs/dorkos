/** Transaction-scoped once-only warning markers; publication remains owned by the caller. */
import { and, eq, isNull, sql, canvasDocBatches, type DbTransaction } from '@dorkos/db';

/** CAS only a still-waiting generation; the caller appends its status in the same transaction. */
export function markDocWaitingWarning(
  batchId: string,
  generation: string,
  now: string,
  tx: DbTransaction
): boolean {
  return (
    tx
      .update(canvasDocBatches)
      .set({ waitingWarningAt: now })
      .where(
        and(
          eq(canvasDocBatches.batchId, batchId),
          eq(canvasDocBatches.generation, generation),
          eq(canvasDocBatches.status, 'waiting'),
          isNull(canvasDocBatches.waitingWarningAt)
        )
      )
      .run().changes === 1
  );
}

/** CAS only an exact accepted receipt with a selected wait; dispatch evidence remains unchanged. */
export function markAcceptedDocWaitingWarning(
  receiptId: string,
  generation: string,
  now: string,
  tx: DbTransaction
): boolean {
  return (
    tx
      .update(canvasDocBatches)
      .set({ waitingWarningAt: now })
      .where(
        and(
          eq(canvasDocBatches.generation, generation),
          eq(canvasDocBatches.status, 'accepted'),
          isNull(canvasDocBatches.waitingWarningAt),
          sql`exists (select 1 from session_message_acceptance_receipts r
        where r.id = ${receiptId} and r.id = ${canvasDocBatches.admissionReceiptId}
        and r.source_kind = 'document_event_batch' and r.state = 'accepted'
        and r.source_id = ${canvasDocBatches.batchId} and r.source_generation = ${canvasDocBatches.generation}
        and ${canvasDocBatches.scope} = 'session:' || r.session_id
        and r.dispatch_claimed_at is null and r.turn_started_at is null)`,
          sql`exists (select 1 from canvas_doc_deliveries d where d.document_id = ${canvasDocBatches.documentId} and d.batch_id = ${canvasDocBatches.batchId}
    and d.route_id = ${canvasDocBatches.routeId}
        and d.status in ('waiting','routed') and d.event_id in (select value from json_each(${canvasDocBatches.inputEventIds})))`
        )
      )
      .run().changes === 1
  );
}
