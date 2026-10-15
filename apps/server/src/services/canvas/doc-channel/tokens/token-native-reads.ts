/** Fixed native token-filtered DATA selection; predicates precede bounded LIMIT. */
import type { Db } from '@dorkos/db';
import { requireServerNativeDatabaseQueryCustody } from '@dorkos/db/internal-server';
import type { OriginalNativeDocTokenHeader } from './token-store.js';
import type { OriginalDocTokenNativeRow } from './token-native-facts.js';
const define = Object.defineProperty,
  freeze = Object.freeze;
const apply = Reflect.apply,
  keys = Object.keys,
  slot = Object.getOwnPropertyDescriptor;
function row(input: unknown): OriginalDocTokenNativeRow {
  if (!input || typeof input !== 'object')
    throw new Error('Original native token event unavailable');
  const fields = keys(input),
    output: Record<string, string | number | null> = Object.create(null);
  for (let index = 0; index < fields.length; index++) {
    const name = fields[index]!,
      field = slot(input, name),
      value = field && slot(field, 'value');
    if (!value) throw new Error('Original native token event unavailable');
    const item = value.value;
    if (
      item !== null &&
      typeof item !== 'string' &&
      !(typeof item === 'number' && Number.isFinite(item))
    )
      throw new Error('Original native token event unavailable');
    define(output, name, { value: item, enumerable: true });
  }
  return freeze(output);
}
/** Construct fixed native event readers for the original token store. */
export function createOriginalDocTokenEventReader(db: Db) {
  requireServerNativeDatabaseQueryCustody(db);
  const client = db.$client,
    prepare = client.prepare;
  const columns = `e.event_id,e.document_id,e.doc_seq,e.type,e.direction,e.received_at,e.payload_pruned_at,
    CASE WHEN length(CAST(e.payload AS BLOB))<=1048576 THEN e.payload ELSE NULL END AS payload`;
  const predicate = `e.document_id=? AND e.type IN (SELECT value FROM json_each(?))
    AND e.direction IN (SELECT value FROM json_each(?))`;
  const page = apply(prepare, client, [
    `SELECT ${columns} FROM main.canvas_doc_events e
    WHERE ${predicate} AND e.doc_seq>? AND e.doc_seq<=? ORDER BY e.doc_seq ASC LIMIT ?`,
  ]);
  const event = apply(prepare, client, [
    `SELECT ${columns} FROM main.canvas_doc_events e
    WHERE ${predicate} AND e.event_id=? LIMIT 1`,
  ]);
  const channel = apply(prepare, client, [
    `SELECT next_doc_seq,retention_floor,receipt_retention_floor
    FROM main.canvas_doc_channels WHERE document_id=? AND closed_at IS NULL LIMIT 1`,
  ]);
  const deliveries = apply(prepare, client, [
    `SELECT d.event_id,d.route_id,d.batch_id,d.status,d.turn_id,d.reason,
    d.updated_at,d.ack_outcome,d.acknowledged_at FROM main.canvas_doc_deliveries d
    JOIN main.canvas_doc_events e ON e.document_id=d.document_id AND e.event_id=d.event_id
    WHERE ${predicate} AND e.event_id=? ORDER BY d.route_id ASC LIMIT 17`,
  ]);
  const deliveriesAll = deliveries.all;
  const pageAll = page.all,
    eventGet = event.get,
    channelGet = channel.get;
  return freeze({
    page(header: OriginalNativeDocTokenHeader, since: number, limit: number) {
      requireServerNativeDatabaseQueryCustody(db);
      if (
        !Number.isSafeInteger(since) ||
        since < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200
      )
        throw new RangeError('Invalid token replay page');
      const current = row(apply(channelGet, channel, [header.documentId]));
      const next = current.next_doc_seq,
        floor = current.retention_floor,
        receiptFloor = current.receipt_retention_floor;
      if (typeof next !== 'number' || typeof floor !== 'number' || typeof receiptFloor !== 'number')
        throw new Error('Original native token channel unavailable');
      const reset = since < floor - 1;
      const found = apply(pageAll, page, [
        header.documentId,
        header.allowedTypesJson,
        header.directionsJson,
        reset ? floor - 1 : since,
        next - 1,
        limit,
      ]);
      const rows: OriginalDocTokenNativeRow[] = [];
      for (let index = 0; index < found.length; index++)
        define(rows, String(index), {
          value: row(found[index]),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      requireServerNativeDatabaseQueryCustody(db);
      return freeze({
        documentId: header.documentId,
        scope: header.scope,
        generation: header.generation,
        highWatermark: next - 1,
        retentionFloor: floor,
        receiptRetentionFloor: receiptFloor,
        resetRequired: reset,
        rows: freeze(rows),
      });
    },
    receipt(header: OriginalNativeDocTokenHeader, eventId: string) {
      requireServerNativeDatabaseQueryCustody(db);
      if (typeof eventId !== 'string' || !eventId || eventId.length > 200)
        throw new Error('Invalid token event');
      const found = apply(eventGet, event, [
        header.documentId,
        header.allowedTypesJson,
        header.directionsJson,
        eventId,
      ]);
      if (found === undefined) throw new Error('Original token receipt unavailable');
      const retained = row(found),
        current = row(apply(channelGet, channel, [header.documentId]));
      if (
        typeof retained.doc_seq !== 'number' ||
        typeof current.receipt_retention_floor !== 'number' ||
        retained.doc_seq < current.receipt_retention_floor
      )
        throw new Error('Original token receipt unavailable');
      const raw = apply(deliveriesAll, deliveries, [
        header.documentId,
        header.allowedTypesJson,
        header.directionsJson,
        eventId,
      ]);
      if (raw.length > 16) throw new Error('Original token deliveries unavailable');
      const projected = [];
      for (let index = 0; index < raw.length; index++) {
        const value = row(raw[index]);
        projected[index] = freeze({
          eventId: value.event_id,
          routeId: value.route_id,
          batchId: value.batch_id,
          status: value.status,
          turnId: value.turn_id,
          reason: value.reason,
          updatedAt: value.updated_at,
          ackOutcome: value.ack_outcome,
          acknowledgedAt: value.acknowledged_at,
        });
      }
      requireServerNativeDatabaseQueryCustody(db);
      return freeze({
        receipt: freeze({ id: eventId, status: 'duplicate' as const, docSeq: retained.doc_seq }),
        deliveries: freeze(projected),
      });
    },
    event(header: OriginalNativeDocTokenHeader, eventId: string) {
      requireServerNativeDatabaseQueryCustody(db);
      if (typeof eventId !== 'string' || !eventId || eventId.length > 200)
        throw new Error('Invalid token event');
      const found = apply(eventGet, event, [
        header.documentId,
        header.allowedTypesJson,
        header.directionsJson,
        eventId,
      ]);
      const result = found === undefined ? undefined : row(found);
      requireServerNativeDatabaseQueryCustody(db);
      return result;
    },
  });
}
