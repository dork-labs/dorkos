/** Fixed original reservation capacity SQL checks; no callbacks, mutation or authority issuance. */
import { sql, canvasDocBatches, type DbTransaction } from '@dorkos/db';
import { CanvasChannelDocEventsContextSchema } from '@dorkos/shared/canvas-channel-schemas';
import {
  protectedCapacityQuery,
  DOC_INGEST_LIMITS,
  type DocIngestLimits,
} from '../../current/accounting.js';
import { DOC_EVENTS_PROMPT_BYTES, docEventsPromptBytes } from '../../prompt.js';
import { DocIngestRefusal } from '../../ingest-types.js';
import type { DocWriteIntentRow, DocBatchRow } from '../../store.js';
import { freezeCheckboxData, validateCheckboxEvidence } from '../checkbox-evidence.js';
import { checkboxAuthoritySync } from '../authority-snapshot.js';
import type { VerifiedCheckboxProjection } from '../completion.js';
import type {
  CheckboxPolicySummary,
  CheckboxReservationPolicy,
} from './reservation-policy-census.js';

/** Validate fixed original capacity against fresh SQL rows without issuing credit. */
export function requireCheckboxCapacity(
  tx: DbTransaction,
  summary: CheckboxPolicySummary,
  row: DocWriteIntentRow,
  policy: CheckboxReservationPolicy,
  projection: VerifiedCheckboxProjection,
  caps: Readonly<DocIngestLimits>,
  converting: boolean,
  now: string,
  documentLabel: string
): DocBatchRow | null {
  const since = new Date(Date.parse(now) - 60000).toISOString();
  const rate = tx.get<{ count: number }>(sql`SELECT count(*) AS count FROM canvas_doc_events
    WHERE document_id=${row.documentId} AND direction='upstream' AND received_at>${since}`)!.count;
  const ownRate = converting ? 1 : 0;
  if (
    rate + summary.document.rateUnits - ownRate >=
    Math.min(policy.eventsPerMinute, caps.eventsPerMinute)
  )
    throw new DocIngestRefusal('DOC_EVENT_RATE_LIMIT', 429, 60);
  if (projection.identity.bytes > policy.envelopeBytes)
    throw new DocIngestRefusal('DOC_EVENT_TOO_LARGE', 413);
  if (!policy.pending) return null;
  const context = CanvasChannelDocEventsContextSchema.parse({
    documentId: row.documentId,
    documentLabel,
    scope: policy.scope,
    batchId: 'x'.repeat(200),
    routeId: policy.route.id,
    grantId: row.grantId,
    events: [
      {
        id: projection.event.id,
        type: projection.event.type,
        payload: projection.event.payload,
        docSeq: Number.MAX_SAFE_INTEGER,
      },
    ],
  });
  if (docEventsPromptBytes(context) > DOC_EVENTS_PROMPT_BYTES)
    throw new DocIngestRefusal('DOC_EVENT_TOO_LARGE', 413);
  const ownOriginal = converting ? 1 : 0;
  const ownBytes = converting ? projection.identity.bytes : 0;
  const used = tx.get<{ count: number; bytes: number }>(protectedCapacityQuery(row.documentId))!;
  const installation = tx.get<{ bytes: number }>(protectedCapacityQuery())!.bytes;
  const occupied = tx
    .select()
    .from(canvasDocBatches)
    .where(
      sql`${canvasDocBatches.documentId}=${row.documentId} AND ${canvasDocBatches.routeId}=${policy.route.id} AND ${canvasDocBatches.status} IN ('pending','waiting')`
    )
    .limit(2)
    .all();
  const joining =
    occupied.length === 1 &&
    occupied[0]!.scope === policy.scope &&
    occupied[0]!.grantId === row.grantId &&
    occupied[0]!.grantRevision === validateCheckboxEvidence(row).authority.grantRevision &&
    !occupied[0]!.inputEventIds.includes(row.eventId);

  if (
    summary.route.originals - ownOriginal !== 0 ||
    (occupied.length !== 0 && !joining) ||
    used.count + summary.document.originals - ownOriginal >= caps.pendingEvents ||
    used.bytes + summary.document.bytes - ownBytes + projection.identity.bytes >
      caps.pendingBytes ||
    installation + summary.installation.bytes - ownBytes + projection.identity.bytes >
      caps.installationPendingBytes
  )
    throw new DocIngestRefusal('DOC_EVENT_BACKLOG_FULL', 429, 60);
  return joining ? freezeCheckboxData(structuredClone(occupied[0]!)) : null;
}

/** Capture only explicit lowering platform limits; no mutable caller policy is retained. */
export function checkboxReservationLimits(input: DocIngestLimits): Readonly<DocIngestLimits> {
  checkboxAuthoritySync(input);
  const out = { ...input };
  for (const key of Object.keys(DOC_INGEST_LIMITS) as (keyof DocIngestLimits)[]) {
    if (!Number.isSafeInteger(out[key]) || out[key] < 1 || out[key] > DOC_INGEST_LIMITS[key])
      throw new RangeError('Checkbox reservation limits may only lower platform caps.');
  }
  if (Object.keys(out).length !== 4) throw new RangeError('Unknown checkbox reservation limit.');
  return Object.freeze(out);
}
