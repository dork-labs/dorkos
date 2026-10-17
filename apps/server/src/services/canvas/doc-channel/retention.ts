/** Bounded payload and receipt retention; missing UUID history is never inferred from client time. */
import {
  and,
  eq,
  sql,
  canvasDocChannels,
  canvasDocEvents,
  canvasDocDeliveries,
  canvasDocBatches,
  type DbTransaction,
  type SQL,
} from '@dorkos/db';
import { DocChannelStore } from './store.js';
import {
  protectedEventSql,
  retainedRoomEventSql,
  backfillEnvelopeAccounting,
} from './current/accounting.js';
import { DocIngestRefusal } from './ingest-types.js';

/** Completed history caps include compact headers and receipt outcomes, not only app payloads. */
export interface DocRetentionPolicy {
  ageMs: number;
  documentBytes: number;
  installationBytes: number;
}
/** Hard retention ceiling; policy may lower each bound. */
export const DOC_RETENTION_POLICY: DocRetentionPolicy = {
  ageMs: 30 * 86400_000,
  documentBytes: 64 * 1024 * 1024,
  installationBytes: 1024 * 1024 * 1024,
};
// Count the complete serialized persisted rows, including UTF-8 escaping of JSON columns.
// Names below are constants; no app data can enter SQL identifiers.
function rowBytes(alias: string, columns: string[]) {
  return sql.raw(
    `length(CAST(json_object(${columns.map((column) => `'${column}',${alias}.${column}`).join(',')}) AS BLOB))`
  );
}
const eventBytes = rowBytes('e', [
  'document_id',
  'event_id',
  'doc_seq',
  'direction',
  'type',
  'payload',
  'envelope_hash',
  'envelope_bytes',
  'payload_pruned_at',
  'coalesce_key',
  'client_ts',
  'received_at',
  'provenance',
]);
const deliveryBytes = rowBytes('d', [
  'document_id',
  'event_id',
  'route_id',
  'batch_id',
  'status',
  'turn_id',
  'reason',
  'ack_outcome',
  'acknowledged_at',
  'acknowledged_by',
  'ack_evidence',
  'updated_at',
  'delivery_kind',
  'room_admission_id',
]);
const originalBatchBytes = rowBytes('b', [
  'batch_id',
  'document_id',
  'scope',
  'route_id',
  'grant_id',
  'grant_revision',
  'generation',
  'input_event_ids',
  'effective_payload',
  'due_at',
  'status',
  'attempt',
  'lease_until',
  'relay_message_id',
  'turn_id',
  'admission_receipt_id',
  'error_code',
  'waiting_warning_at',
  'created_at',
  'updated_at',
  'delivery_kind',
  'room_admission_id',
  'room_source_attempt',
  'room_source_json',
  'room_source_hash',
]);
// Historical pending capsules share their original batch's retention ceiling and lifecycle.
const pendingCapsuleBytes = rowBytes('s', [
  'document_id',
  'batch_id',
  'generation',
  'source_json',
  'source_hash',
  'due_at',
  'updated_at',
]);
const batchBytes = sql`${originalBatchBytes} + coalesce((SELECT sum(${pendingCapsuleBytes})
  FROM canvas_doc_room_pending_sources s WHERE s.batch_id=b.batch_id),0)`;
const roomAdmissionBytes = rowBytes('ra', [
  'admission_id',
  'document_id',
  'batch_id',
  'generation',
  'source_attempt',
  'room_id',
  'entry_id',
  'entry_seq',
  'grant_id',
  'grant_revision',
  'route_id',
  'route_hash',
  'declaration_hash',
  'manifest_hash',
  'input_fingerprint',
  'authority_digest',
  'effective_payload_digest',
  'source_hash',
  'producer_evidence_json',
  'target_agent_id',
  'target_author_id',
  'target_session_id',
  'target_runtime',
  'target_agent_path',
  'cascade_root',
  'root_room_id',
  'root_entry_id',
  'frozen_ceiling',
  'dispatch_attempt',
  'boot_epoch',
  'dispatch_id',
  'claimed_at_ms',
  'claimed_at',
  'spend_row_id',
  'status',
  'turn_id',
  'outcome',
  'created_at',
  'updated_at',
  'row_json',
]);
const roomInputBytes = rowBytes('ri', [
  'admission_id',
  'document_id',
  'event_id',
  'route_id',
  'input_ordinal',
  'doc_seq',
  'envelope_hash',
  'source_delivery_status',
  'source_delivery_reason',
]);
const roomExhaustionBytes = rowBytes('rx', [
  'cascade_root',
  'root_room_id',
  'root_entry_id',
  'original_admission_id',
  'frozen_ceiling',
  'exhausted_at',
]);
const historyBytes = sql`${eventBytes} + coalesce((SELECT sum(${deliveryBytes}) FROM canvas_doc_deliveries d
  WHERE d.document_id=e.document_id AND d.event_id=e.event_id),0)`;
const completedBatchSql = sql`b.status NOT IN ('pending','waiting','accepted','dispatching','turn_started','in_doubt')
  AND NOT EXISTS (SELECT 1 FROM room_doc_admissions ra WHERE ra.document_id=b.document_id AND ra.batch_id=b.batch_id)`;

/** Completed correlations still prove route starts until the strict rolling-hour boundary. */
function recentTurnStartSql(admissionReceiptId: SQL, startedAfter: string): SQL {
  return sql`EXISTS (SELECT 1 FROM session_message_acceptance_receipts r
    WHERE r.id=${admissionReceiptId} AND r.turn_started_at>${startedAfter})`;
}

/** Prune oldest completed inputs atomically, preserving uncertain work and monotonic reset floors. */
export function retainDocHistory(
  store: DocChannelStore,
  now: string,
  policy: Partial<DocRetentionPolicy> = {}
): void {
  const limits = { ...DOC_RETENTION_POLICY, ...policy };
  for (const key of Object.keys(limits) as (keyof DocRetentionPolicy)[])
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > DOC_RETENTION_POLICY[key]
    )
      throw new RangeError('Invalid retention ceiling.');
  store.transaction((tx) => {
    backfillEnvelopeAccounting(store, tx);
    const cutoff = new Date(Date.parse(now) - limits.ageMs).toISOString();
    const startedAfter = new Date(Date.parse(now) - 3600_000).toISOString();
    // Remove expired source correlations with no retained receipt before computing usage.
    tx.delete(canvasDocBatches)
      .where(
        sql`NOT EXISTS (SELECT 1 FROM room_doc_admissions ra WHERE ra.document_id=canvas_doc_batches.document_id
      AND ra.batch_id=canvas_doc_batches.batch_id)
      AND status NOT IN ('pending','waiting','accepted','dispatching','turn_started','in_doubt')
      AND updated_at < ${cutoff}
      AND NOT ${recentTurnStartSql(sql`${canvasDocBatches.admissionReceiptId}`, startedAfter)}
      AND NOT EXISTS (SELECT 1 FROM canvas_doc_deliveries d WHERE
      d.document_id=canvas_doc_batches.document_id AND d.batch_id=canvas_doc_batches.batch_id)`
      )
      .run();
    const usage = historyUsage(tx);
    const adjustUsage = (documentId: string, delta: number) => {
      usage.documents.set(documentId, (usage.documents.get(documentId) ?? 0) + delta);
      usage.installation += delta;
    };
    let cursor: { documentId: string; docSeq: number; receivedAt: string } | undefined;
    for (;;) {
      const candidates = tx.all<{
        documentId: string;
        eventId: string;
        docSeq: number;
        receivedAt: string;
        bytes: number;
        payloadPrunedAt: string | null;
      }>(sql`
      SELECT e.document_id AS documentId,e.event_id AS eventId,e.doc_seq AS docSeq,e.received_at AS receivedAt,
        ${historyBytes} AS bytes,e.payload_pruned_at AS payloadPrunedAt
      FROM canvas_doc_events e WHERE NOT (${protectedEventSql} OR ${retainedRoomEventSql})
      AND ${cursor ? sql`(e.received_at,e.document_id,e.doc_seq)>(${cursor.receivedAt},${cursor.documentId},${cursor.docSeq})` : sql`1`}
      ORDER BY e.received_at,e.document_id,e.doc_seq LIMIT 200`);
      if (!candidates.length) break;
      cursor = candidates[candidates.length - 1]!;
      for (const candidate of candidates) {
        if (
          candidate.receivedAt >= cutoff &&
          (usage.documents.get(candidate.documentId) ?? 0) <= limits.documentBytes &&
          usage.installation <= limits.installationBytes
        )
          continue;
        let retainedBytes = candidate.bytes;
        // Payload reset is distinct from receipt membership; compaction preserves source evidence.
        if (candidate.payloadPrunedAt === null) {
          tx.update(canvasDocEvents)
            .set({ payload: sql`'null'`, provenance: {}, payloadPrunedAt: now })
            .where(
              and(
                eq(canvasDocEvents.documentId, candidate.documentId),
                eq(canvasDocEvents.eventId, candidate.eventId)
              )
            )
            .run();
          retainedBytes = tx.get<{ bytes: number }>(sql`SELECT ${historyBytes} AS bytes
            FROM canvas_doc_events e WHERE e.document_id=${candidate.documentId}
            AND e.event_id=${candidate.eventId}`)!.bytes;
          adjustUsage(candidate.documentId, retainedBytes - candidate.bytes);
          advanceFloor(tx, candidate.documentId, candidate.docSeq + 1, false);
        }
        if (
          candidate.receivedAt >= cutoff &&
          (usage.documents.get(candidate.documentId) ?? 0) <= limits.documentBytes &&
          usage.installation <= limits.installationBytes
        )
          continue;
        const batchIds = tx
          .all<{ batchId: string }>(
            sql`SELECT DISTINCT batch_id AS batchId
          FROM canvas_doc_deliveries WHERE document_id=${candidate.documentId}
          AND event_id=${candidate.eventId} AND batch_id IS NOT NULL`
          )
          .map((row) => row.batchId);
        tx.delete(canvasDocDeliveries)
          .where(
            and(
              eq(canvasDocDeliveries.documentId, candidate.documentId),
              eq(canvasDocDeliveries.eventId, candidate.eventId)
            )
          )
          .run();
        tx.delete(canvasDocEvents)
          .where(
            and(
              eq(canvasDocEvents.documentId, candidate.documentId),
              eq(canvasDocEvents.eventId, candidate.eventId)
            )
          )
          .run();
        advanceFloor(tx, candidate.documentId, candidate.docSeq + 1, true);
        adjustUsage(candidate.documentId, -retainedBytes);
        adjustUsage(
          candidate.documentId,
          -deleteOrphanBatches(tx, candidate.documentId, batchIds, startedAfter)
        );
      }
    }
    // Keep source correlation for rolling started-turn limits until its one-hour window ends.
    tx.delete(canvasDocBatches)
      .where(
        sql`NOT EXISTS (SELECT 1 FROM room_doc_admissions ra WHERE ra.document_id=canvas_doc_batches.document_id
      AND ra.batch_id=canvas_doc_batches.batch_id)
      AND status NOT IN ('pending','waiting','accepted','dispatching','turn_started','in_doubt')
        AND NOT ${recentTurnStartSql(sql`${canvasDocBatches.admissionReceiptId}`, startedAfter)}
        AND NOT EXISTS (SELECT 1 FROM canvas_doc_deliveries d WHERE
          d.document_id=canvas_doc_batches.document_id AND d.batch_id=canvas_doc_batches.batch_id)`
      )
      .run();
  });
}
/** Aggregate completed rows once; subsequent compaction/deletion adjusts these exact totals. */
function historyUsage(tx: DbTransaction): { documents: Map<string, number>; installation: number } {
  const rows = tx.all<{ documentId: string | null; bytes: number }>(sql`
    SELECT e.document_id AS documentId,sum(${historyBytes}) AS bytes FROM canvas_doc_events e
      WHERE NOT ${protectedEventSql} OR ${retainedRoomEventSql} GROUP BY e.document_id
    UNION ALL
    SELECT b.document_id AS documentId,sum(${batchBytes}) AS bytes FROM canvas_doc_batches b
      WHERE b.status NOT IN ('pending','waiting','accepted','dispatching','turn_started','in_doubt')
        OR EXISTS (SELECT 1 FROM room_doc_admissions ra WHERE ra.document_id=b.document_id AND ra.batch_id=b.batch_id)
      GROUP BY b.document_id
    UNION ALL SELECT ra.document_id AS documentId,sum(${roomAdmissionBytes}) AS bytes
      FROM room_doc_admissions ra GROUP BY ra.document_id
    UNION ALL SELECT ri.document_id AS documentId,sum(${roomInputBytes}) AS bytes
      FROM room_doc_admission_inputs ri GROUP BY ri.document_id
    UNION ALL SELECT NULL AS documentId,coalesce(sum(${roomExhaustionBytes}),0) AS bytes
      FROM room_doc_exhausted_lineages rx`);
  const documents = new Map<string, number>();
  let installation = 0;
  for (const row of rows) {
    if (row.documentId !== null)
      documents.set(row.documentId, (documents.get(row.documentId) ?? 0) + row.bytes);
    installation += row.bytes;
  }
  return { documents, installation };
}
/** Only the deleted input's bounded route correlations can have become newly orphaned. */
function deleteOrphanBatches(
  tx: DbTransaction,
  documentId: string,
  batchIds: string[],
  startedAfter: string
): number {
  if (!batchIds.length) return 0;
  const rows = tx.all<{ batchId: string; bytes: number }>(sql`SELECT b.batch_id AS batchId,
    ${batchBytes} AS bytes FROM canvas_doc_batches b WHERE b.document_id=${documentId}
    AND b.batch_id IN (${sql.join(
      batchIds.map((id) => sql`${id}`),
      sql`,`
    )})
    AND ${completedBatchSql}
    AND NOT ${recentTurnStartSql(sql`b.admission_receipt_id`, startedAfter)}
    AND NOT EXISTS (SELECT 1 FROM canvas_doc_deliveries d WHERE d.document_id=b.document_id
    AND d.batch_id=b.batch_id)`);
  for (const row of rows)
    tx.delete(canvasDocBatches).where(eq(canvasDocBatches.batchId, row.batchId)).run();
  return rows.reduce((sum, row) => sum + row.bytes, 0);
}

function advanceFloor(
  tx: DbTransaction,
  documentId: string,
  floor: number,
  receipts: boolean
): void {
  // A protected older input remains replayable, but cannot hide a later missing sequence.
  // Reset snapshots include those retained receipts separately from the contiguous event tail.
  tx.update(canvasDocChannels)
    .set(
      receipts
        ? { receiptRetentionFloor: sql`max(receipt_retention_floor,${floor})` }
        : { retentionFloor: sql`max(retention_floor,${floor})` }
    )
    .where(eq(canvasDocChannels.documentId, documentId))
    .run();
}

/** Explicit operator replay refuses missing or payload-pruned history; it cannot manufacture a new generation. */
export function requireReplayInput(
  store: DocChannelStore,
  documentId: string,
  eventId: string,
  tx?: DbTransaction
) {
  const event = store.getEvent(documentId, eventId, tx);
  if (!event || event.payloadPrunedAt !== null)
    throw new DocIngestRefusal('DOC_EVENT_MISSING_HISTORY', 409);
  return event;
}

/**
 * SDK contract: an uncertain retry crossing either floor requires review, not automatic re-emission.
 * The sequence may be an accepted receipt or a lower bound captured from the pre-request watermark.
 * Without that bound the host must look up its retained receipt and stop if history is missing.
 * Receipt UUID membership is bounded: a fresh POST with a formerly-pruned UUID is unknowable and
 * cannot be promised permanent deduplication. Client timestamps are never evidence of freshness.
 * Explicit operator replay uses requireReplayInput and cannot mint a replacement generation.
 */
export function mayRetryRetainedInput(
  acceptedDocSeq: number | undefined,
  retentionFloor: number,
  receiptRetentionFloor: number,
  uncertain: boolean
): boolean {
  if (!uncertain) return true;
  return (
    acceptedDocSeq !== undefined &&
    acceptedDocSeq >= Math.max(retentionFloor, receiptRetentionFloor)
  );
}
