/** Bounded operator DATA. No row returned here issues document authority. */
import type { Db } from '@dorkos/db';
import { requireServerNativeDatabaseQueryCustody } from '@dorkos/db/internal-server';
import {
  CanvasChannelTokenMetadataSchema,
  CanvasChannelRouteSchema,
  CanvasChannelDeliverySchema,
  CanvasChannelEventIdSchema,
  CanvasChannelAppAckSchema,
} from '@dorkos/shared/canvas-channel-schemas';
const apply = Reflect.apply;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const ownKeys = Object.keys;

/** Compile fixed native projections before entering the original management transaction. */
export function createOriginalDocManagementReader(db: Db) {
  requireServerNativeDatabaseQueryCustody(db);
  const client = db.$client,
    prepare = client.prepare;
  if (client.inTransaction) throw new Error('Document management construction cannot nest.');
  const grants = apply(prepare, client, [
    `SELECT grant_id AS grantId,revision,route_id AS routeId,
    allowed_types AS allowedTypes,normalized_route AS route,expires_at AS expiresAt,revoked_at AS revokedAt
    FROM canvas_doc_grants WHERE document_id=? ORDER BY grant_id ASC LIMIT 201`,
  ]);
  const tokens = apply(prepare, client, [
    `SELECT token_id AS tokenId,document_id AS documentId,
    allowed_types AS allowedTypes,directions,permissions,creator_id AS creatorId,
    created_at AS createdAt,expires_at AS expiresAt,revoked_at AS revokedAt
    FROM canvas_doc_channel_tokens WHERE document_id=? ORDER BY created_at DESC,token_id ASC LIMIT 201`,
  ]);
  const reviews = apply(prepare, client, [
    `SELECT batch_id AS batchId,generation AS batchGeneration,route_id AS routeId,grant_id AS grantId,
    scope,status,created_at AS createdAt,updated_at AS updatedAt,error_code AS reason,
    admission_receipt_id AS admissionReceiptId,delivery_kind AS deliveryKind,grant_revision AS grantRevision,
    (SELECT count(*) FROM canvas_doc_deliveries d WHERE d.document_id=canvas_doc_batches.document_id AND d.batch_id=canvas_doc_batches.batch_id AND d.route_id=canvas_doc_batches.route_id) AS inputCount,
    CASE WHEN status='expired' AND (scope LIKE 'session:%' OR scope LIKE 'room:%') AND
      (error_code IS NULL OR error_code!='manual_replay_consumed') AND
      admission_receipt_id IS NULL AND turn_id IS NULL AND relay_message_id IS NULL AND lease_until IS NULL AND
      (delivery_kind IS NULL OR delivery_kind!='room_app_event') AND room_admission_id IS NULL AND
      room_source_attempt IS NULL AND room_source_json IS NULL AND room_source_hash IS NULL AND
      NOT EXISTS (SELECT 1 FROM room_doc_admissions a WHERE a.document_id=canvas_doc_batches.document_id AND a.batch_id=canvas_doc_batches.batch_id) AND
      NOT EXISTS (SELECT 1 FROM session_message_acceptance_receipts r WHERE r.source_kind='document_event_batch' AND r.source_id=canvas_doc_batches.batch_id) AND
      NOT EXISTS (SELECT 1 FROM canvas_doc_deliveries d WHERE d.document_id=canvas_doc_batches.document_id AND d.batch_id=canvas_doc_batches.batch_id AND
        (d.status!='expired' OR d.turn_id IS NOT NULL OR d.room_admission_id IS NOT NULL OR d.delivery_kind='room_app_event' OR
         d.ack_outcome IS NOT NULL OR d.ack_evidence IS NOT NULL OR d.acknowledged_at IS NOT NULL OR d.acknowledged_by IS NOT NULL))
      THEN 1 ELSE 0 END AS replayAvailable
    FROM canvas_doc_batches WHERE document_id=? ORDER BY updated_at DESC,batch_id ASC LIMIT 201`,
  ]);
  // At most 201 actual input rows from the same bounded review set; never infer ACK from a batch status.
  const inputs = apply(prepare, client, [
    `WITH reviewed AS (
    SELECT batch_id,route_id,updated_at FROM canvas_doc_batches WHERE document_id=?
    ORDER BY updated_at DESC,batch_id ASC LIMIT 200)
    SELECT d.batch_id AS batchId,d.event_id AS eventId,d.route_id AS routeId,d.status,d.turn_id AS turnId,
      d.reason,d.updated_at AS updatedAt,d.ack_outcome AS ackOutcome,d.acknowledged_at AS acknowledgedAt,
      d.acknowledged_by AS acknowledgedBy,d.ack_evidence AS ackEvidence,
      a.direction AS ackDirection,a.type AS ackType,a.payload AS ackPayload,a.provenance AS ackProvenance,a.received_at AS ackReceivedAt,a.payload_pruned_at AS ackPrunedAt
    FROM canvas_doc_deliveries d JOIN reviewed b ON b.batch_id=d.batch_id AND b.route_id=d.route_id
    LEFT JOIN canvas_doc_events a ON a.document_id=d.document_id AND a.event_id=json_extract(d.ack_evidence,'$.downstreamEventId')
    WHERE d.document_id=? ORDER BY b.updated_at DESC,b.batch_id ASC,d.event_id ASC LIMIT 201`,
  ]);
  const grantsAll = grants.all,
    tokensAll = tokens.all,
    reviewsAll = reviews.all,
    inputsAll = inputs.all;
  const rows = (value: unknown): Readonly<Record<string, string | number | null>>[] => {
    if (!Array.isArray(value) || value.length > 201)
      throw new Error('Invalid document management DATA.');
    return value.map((row) => {
      if (!row || typeof row !== 'object' || ownKeys(row).length > 17)
        throw new Error('Invalid management row.');
      const result: Record<string, string | number | null> = Object.create(null);
      for (const key of ownKeys(row)) {
        const descriptor = ownDescriptor(row, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value'))
          throw new Error('Invalid management cell.');
        const cell: unknown = descriptor.value;
        if (
          cell !== null &&
          typeof cell !== 'string' &&
          !(typeof cell === 'number' && Number.isFinite(cell))
        )
          throw new Error('Invalid management scalar.');
        if (typeof cell === 'string' && Buffer.byteLength(cell, 'utf8') > 65536)
          throw new Error('Management scalar too large.');
        Object.defineProperty(result, key, { value: cell, enumerable: true });
      }
      return Object.freeze(result);
    });
  };
  return (documentId: string) => {
    requireServerNativeDatabaseQueryCustody(db);
    if (
      db.$client !== client ||
      !client.open ||
      !client.inTransaction ||
      typeof documentId !== 'string' ||
      !documentId ||
      documentId.length > 200
    )
      throw new Error('Management requires its original current SQL transaction.');
    const result = Object.freeze({
      grants: Object.freeze(rows(apply(grantsAll, grants, [documentId]))),
      tokens: Object.freeze(rows(apply(tokensAll, tokens, [documentId]))),
      reviews: Object.freeze(rows(apply(reviewsAll, reviews, [documentId]))),
      inputs: Object.freeze(rows(apply(inputsAll, inputs, [documentId, documentId]))),
    });
    requireServerNativeDatabaseQueryCustody(db);
    return result;
  };
}
/** Decode display JSON before the final authority gate; final equality rereads raw scalar bytes only. */
export function projectDocManagementRows(
  rows: ReturnType<ReturnType<typeof createOriginalDocManagementReader>>,
  nativeRoomAvailable = false
) {
  const json = (value: string | number | null | undefined): unknown => {
    if (typeof value !== 'string') throw new Error('Invalid management JSON cell.');
    return JSON.parse(value);
  };
  return {
    grants: rows.grants.slice(0, 200).map(({ route, allowedTypes, ...row }) => ({
      ...row,
      allowedTypes: json(allowedTypes),
      destination: CanvasChannelRouteSchema.parse(json(route)).to,
    })),
    grantsTruncated: rows.grants.length > 200,
    tokens: rows.tokens.slice(0, 200).map(({ allowedTypes, directions, permissions, ...row }) =>
      CanvasChannelTokenMetadataSchema.parse({
        ...row,
        allowedTypes: json(allowedTypes),
        directions: json(directions),
        permissions: json(permissions),
      })
    ),
    tokensTruncated: rows.tokens.length > 200,
    reviews: rows.reviews
      .slice(0, 200)
      .map(
        ({
          scope,
          admissionReceiptId,
          deliveryKind,
          replayAvailable,
          inputCount,
          grantRevision,
          ...row
        }) => ({
          ...row,
          inputs: rows.inputs
            .slice(0, 200)
            .filter((input) => input.batchId === row.batchId && input.routeId === row.routeId)
            .map(
              ({
                acknowledgedBy,
                ackEvidence,
                ackDirection,
                ackType,
                ackPayload,
                ackProvenance,
                ackReceivedAt,
                ackPrunedAt,
                ...input
              }) => {
                let ackEvidenceStatus: 'none' | 'verified' | 'unavailable' = 'none';
                const absent =
                  input.ackOutcome === null &&
                  input.acknowledgedAt === null &&
                  acknowledgedBy === null &&
                  ackEvidence === null;
                if (!absent) {
                  if (
                    typeof acknowledgedBy !== 'string' ||
                    !acknowledgedBy ||
                    typeof ackEvidence !== 'string' ||
                    input.ackOutcome === null ||
                    input.acknowledgedAt === null
                  )
                    throw new Error('Incomplete original acknowledgement evidence.');
                  const evidence = json(ackEvidence);
                  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence))
                    throw new Error('Invalid original acknowledgement evidence.');
                  const cell = (key: string): unknown => ownDescriptor(evidence, key)?.value;
                  CanvasChannelEventIdSchema.parse(cell('downstreamEventId'));
                  if (
                    cell('routeId') !== row.routeId ||
                    cell('batchId') !== row.batchId ||
                    cell('generation') !== row.batchGeneration ||
                    cell('grantId') !== row.grantId ||
                    cell('grantRevision') !== grantRevision
                  )
                    throw new Error('Foreign original acknowledgement evidence.');
                  if (
                    ackDirection === null &&
                    ackType === null &&
                    ackPayload === null &&
                    ackProvenance === null &&
                    ackReceivedAt === null &&
                    ackPrunedAt === null
                  ) {
                    // Retention can remove a downstream event while preserving its original input receipt.
                    ackEvidenceStatus = 'unavailable';
                  } else if (ackPrunedAt !== null) {
                    CanvasChannelDeliverySchema.shape.updatedAt.parse(ackPrunedAt);
                    if (
                      ackDirection !== 'downstream' ||
                      ackType !== 'app.ack' ||
                      ackReceivedAt !== input.acknowledgedAt ||
                      ackPayload !== 'null' ||
                      ackProvenance !== '{}'
                    )
                      throw new Error('Invalid pruned original acknowledgement header.');
                    ackEvidenceStatus = 'unavailable';
                  } else {
                    if (
                      ackDirection !== 'downstream' ||
                      ackType !== 'app.ack' ||
                      ackReceivedAt !== input.acknowledgedAt
                    )
                      throw new Error('Invalid original acknowledgement event.');
                    const ack = CanvasChannelAppAckSchema.parse(json(ackPayload));
                    const provenance = json(ackProvenance);
                    if (
                      !provenance ||
                      typeof provenance !== 'object' ||
                      Array.isArray(provenance) ||
                      ownDescriptor(provenance, 'source')?.value !== 'doc-channel-agent' ||
                      ownDescriptor(provenance, 'senderKey')?.value !== acknowledgedBy ||
                      ack.batchId !== row.batchId ||
                      ack.routeId !== row.routeId ||
                      ack.outcome !== input.ackOutcome ||
                      typeof input.eventId !== 'string' ||
                      !ack.eventIds.includes(input.eventId)
                    )
                      throw new Error('Foreign original acknowledgement event.');
                    ackEvidenceStatus = 'verified';
                  }
                }
                return { ...CanvasChannelDeliverySchema.parse(input), ackEvidenceStatus };
              }
            ),
          inputsTruncated:
            typeof inputCount !== 'number' ||
            inputCount < 0 ||
            inputCount !==
              rows.inputs
                .slice(0, 200)
                .filter((input) => input.batchId === row.batchId && input.routeId === row.routeId)
                .length,
          replayAvailable:
            replayAvailable === 1 &&
            typeof scope === 'string' &&
            (scope.startsWith('session:') || nativeRoomAvailable),
          replayUnavailableReason:
            replayAvailable === 1 &&
            typeof scope === 'string' &&
            (scope.startsWith('session:') || nativeRoomAvailable)
              ? null
              : 'Only expired, never-admitted work with its original available transport can be replayed. Acknowledged, admitted and uncertain work cannot be repeated.',
          requiresExplicitReview:
            row.status === 'expired' &&
            admissionReceiptId === null &&
            deliveryKind !== 'room_app_event' &&
            row.reason !== 'manual_replay_consumed',
        })
      ),
    reviewsTruncated: rows.reviews.length > 200,
  };
}
