/** Initial route outcomes join the original input's transaction and durable replay log. */
import type { DbTransaction } from '@dorkos/db';
import { appendDocStatus } from './status.js';
import { DocChannelStore, type DocDeliveryRow, type DocEventRow } from './store.js';

// Public initial refusals emitted by current grant revalidation and the ingest/coalescer gates.
// Unknown text must never turn an internal diagnostic into a document-visible status payload.
const savedReasons = new Set([
  'approval_required',
  'route_generation_changed',
  'ROUTE_UNAPPROVED',
  'TYPE_NOT_GRANTED',
  'INVALID_PRINCIPAL',
  'ROUTE_UNDECLARED',
  'MANIFEST_CHANGED',
  'DECLARATION_CHANGED',
  'GRANT_NOT_FOUND',
  'GRANT_REVOKED',
  'GRANT_EXPIRED',
  'GRANT_EVIDENCE_MISMATCH',
  'GRANT_AUTHORITY_LOST',
  'ORIGIN_AUTHORITY_LOST',
  'TARGET_IDENTITY_CHANGED',
  'TARGET_UNAVAILABLE',
  'TARGET_SCOPE_MISMATCH',
  'TARGET_IDENTITY_MISMATCH',
  'ROOM_ROUTE_UNAVAILABLE',
  'LOCAL_SOURCE_UNAVAILABLE',
  'WRITE_BINDING_MISMATCH',
]);

/** Publish only bounded public receipt fields, after every route has finished accepting the input. */
export function appendInitialDocStatuses(
  store: DocChannelStore,
  tx: DbTransaction,
  original: DocEventRow,
  deliveries: readonly DocDeliveryRow[],
  now: string
): void {
  const identifier = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 200;
  if (
    original.direction !== 'upstream' ||
    !identifier(original.documentId) ||
    !identifier(original.eventId) ||
    deliveries.length > 16
  )
    throw new Error('Invalid initial document status snapshot.');
  const routes = new Set<string>();
  // Validate the whole snapshot before appending its first status. The transaction still owns rollback.
  for (const delivery of deliveries) {
    if (
      delivery.documentId !== original.documentId ||
      delivery.eventId !== original.eventId ||
      !identifier(delivery.routeId) ||
      routes.has(delivery.routeId) ||
      !['saved', 'pending', 'waiting', 'routed'].includes(delivery.status) ||
      (delivery.batchId !== null && !identifier(delivery.batchId)) ||
      (delivery.reason !== null &&
        (typeof delivery.reason !== 'string' || delivery.reason.length > 1000)) ||
      (delivery.status === 'saved' &&
        (delivery.reason === null || !savedReasons.has(delivery.reason))) ||
      (delivery.status === 'routed' && delivery.reason !== 'no_turn') ||
      ((delivery.status === 'pending' || delivery.status === 'waiting') &&
        delivery.reason !== null) ||
      (delivery.status === 'pending' || delivery.status === 'waiting') !==
        (delivery.batchId !== null)
    )
      throw new Error('Invalid initial document status snapshot.');
    routes.add(delivery.routeId);
  }
  for (const delivery of [...deliveries].sort((a, b) =>
    a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0
  ))
    appendDocStatus(
      store,
      tx,
      original.documentId,
      {
        eventId: original.eventId,
        routeId: delivery.routeId,
        status: delivery.status,
        ...(delivery.batchId !== null ? { batchId: delivery.batchId } : {}),
        ...(delivery.reason !== null ? { reason: delivery.reason } : {}),
      },
      now
    );
}
