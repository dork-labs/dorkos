/** SQL accounting counts original inputs once even when multiple routes reference them. */
import { sql, type DbTransaction } from '@dorkos/db';
import type { CanvasChannelJsonValue } from '@dorkos/shared/canvas-channel-schemas';
import { envelopeIdentity } from './envelope.js';
import { scanCheckboxReservationPolicies } from './writes/reservation-policy-census.js';
import { DocIngestRefusal } from './ingest-types.js';

/** Platform caps may be lowered by tests or installation policy, never raised. */
export interface DocIngestLimits {
  eventsPerMinute: number;
  pendingEvents: number;
  pendingBytes: number;
  installationPendingBytes: number;
}
/** Hard install defaults; app limits can only reduce envelope and rate ceilings. */
export const DOC_INGEST_LIMITS: DocIngestLimits = {
  eventsPerMinute: 60,
  pendingEvents: 1000,
  pendingBytes: 16 * 1024 * 1024,
  installationPendingBytes: 256 * 1024 * 1024,
};
/** A pending/uncertain route or batch protects the original input from retention. */
export const protectedEventSql = sql`EXISTS (SELECT 1 FROM canvas_doc_deliveries d
  LEFT JOIN canvas_doc_batches b ON b.document_id=d.document_id AND b.batch_id=d.batch_id
  WHERE d.document_id=e.document_id AND d.event_id=e.event_id AND
  (d.status IN ('pending','waiting','accepted','turn_started','in_doubt') OR
  (b.status IN ('pending','waiting','accepted','dispatching','turn_started','in_doubt') AND
  EXISTS (SELECT 1 FROM json_each(b.input_event_ids) WHERE value=e.event_id))))`;

/** Query live protected keys without revisiting every retained event header. */
export function protectedCapacityQuery(documentId?: string) {
  const deliveryScope = documentId === undefined ? sql`` : sql`AND document_id=${documentId}`;
  const batchScope = documentId === undefined ? sql`` : sql`AND b.document_id=${documentId}`;
  const count = documentId === undefined ? sql`` : sql`count(*) AS count,`;
  // Materialization and join order keep SQLite on the live status indexes and
  // event primary key; ordinary joins can choose retained-history scans instead.
  // Probe the delivery composite primary key per input. The batch index would
  // revisit every delivery in a large batch for each json_each input.
  return sql`WITH protected AS MATERIALIZED (
    SELECT document_id,event_id FROM canvas_doc_deliveries
      INDEXED BY canvas_doc_deliveries_status_idx
      WHERE status IN ('pending','waiting','accepted','turn_started','in_doubt') ${deliveryScope}
    UNION
    SELECT b.document_id,ids.value AS event_id FROM canvas_doc_batches b
      INDEXED BY canvas_doc_batches_due_idx CROSS JOIN json_each(b.input_event_ids) ids
      WHERE b.status IN ('pending','waiting','accepted','dispatching','turn_started','in_doubt')
      ${batchScope}
      AND EXISTS (SELECT 1 FROM canvas_doc_deliveries d
        INDEXED BY sqlite_autoindex_canvas_doc_deliveries_1
        WHERE d.document_id=b.document_id AND d.event_id=ids.value AND d.batch_id=b.batch_id)
  ) SELECT ${count} coalesce(sum(e.envelope_bytes),0) AS bytes
    FROM protected p CROSS JOIN canvas_doc_events e
    WHERE e.document_id=p.document_id AND e.event_id=p.event_id`;
}

/** Refuse before allocating a sequence or recording any new receipt. */
export function checkIngestCapacity(
  tx: DbTransaction,
  documentId: string,
  now: string,
  bytes: number,
  appRate: number | undefined,
  limits: DocIngestLimits,
  createsPending = true
): void {
  const reservations = scanCheckboxReservationPolicies(tx, { documentId });
  const since = new Date(Date.parse(now) - 60_000).toISOString();
  const rate = tx.get<{ count: number }>(sql`SELECT count(*) AS count FROM canvas_doc_events
    WHERE document_id=${documentId} AND direction='upstream' AND received_at>${since}`)!.count;
  if (rate + reservations.document.rateUnits >= Math.min(appRate ?? 60, limits.eventsPerMinute))
    throw new DocIngestRefusal('DOC_EVENT_RATE_LIMIT', 429, 60);
  if (!createsPending) return;
  const usage = tx.get<{ count: number; bytes: number }>(protectedCapacityQuery(documentId))!;
  const installation = tx.get<{ bytes: number }>(protectedCapacityQuery())!.bytes;
  if (
    usage.count + reservations.document.originals >= limits.pendingEvents ||
    usage.bytes + reservations.document.bytes + bytes > limits.pendingBytes ||
    installation + reservations.installation.bytes + bytes > limits.installationPendingBytes
  )
    throw new DocIngestRefusal('DOC_EVENT_BACKLOG_FULL', 429, 60);
}

/** Backfill foundation rows in bounded pages before installation accounting can undercount them. */
export function backfillEnvelopeAccounting(
  store: import('./store.js').DocChannelStore,
  tx: DbTransaction
): void {
  for (;;) {
    const rows = tx.all<{
      documentId: string;
      eventId: string;
    }>(sql`SELECT document_id AS documentId,
      event_id AS eventId FROM canvas_doc_events WHERE envelope_bytes=0 AND payload_pruned_at IS NULL LIMIT 200`);
    if (!rows.length) return;
    for (const row of rows) {
      const event = store.getEvent(row.documentId, row.eventId, tx)!;
      const identity = envelopeIdentity({
        v: 1,
        id: event.eventId,
        type: event.type,
        payload: event.payload as CanvasChannelJsonValue,
        ...(event.coalesceKey === null ? {} : { coalesceKey: event.coalesceKey }),
        ...(event.clientTs === null ? {} : { ts: event.clientTs }),
      });
      tx.run(sql`UPDATE canvas_doc_events SET envelope_bytes=${identity.bytes}
        WHERE document_id=${row.documentId} AND event_id=${row.eventId} AND envelope_bytes=0`);
    }
  }
}
