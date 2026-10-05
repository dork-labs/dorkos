import { readPreparedIntentPage } from '../readers/prepared-readers.js';
/** Complete, streaming sole-ledger reservation census; it grants no conversion credit. */
import type { DbTransaction } from '@dorkos/db';
import { z } from 'zod';
import { CanvasChannelCheckboxRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import type { DocWriteIntentRow } from '../store.js';
import { readChecked } from '../store-json.js';
import { projectVerifiedCheckbox } from './completion.js';
import {
  freezeCheckboxData,
  validateCheckboxEvidence,
  type VerifiedCheckboxAuthority,
} from './checkbox-evidence.js';

const PAGE_SIZE = 100;
const Status = z.enum([
  'prepared',
  'replaced',
  'committed',
  'no_op',
  'conflict',
  'in_doubt',
  'failed',
]);
const RowHeader = z.object({
  intentId: z.string().min(1).max(200),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  errorCode: z.string().min(1).max(200).nullable(),
});
const Request = z
  .object({
    documentId: CanvasChannelCheckboxRequestSchema.shape.documentId,
    eventId: CanvasChannelCheckboxRequestSchema.shape.eventId.optional(),
    routeId: z.string().min(1).max(200).optional(),
  })
  .strict();

/** Optional requested identity and route narrow only the summary, never the ledger scan. */
export type CheckboxReservationRequest = z.infer<typeof Request>;
/** Raw potential reservation use, including caller-owned rows; not proven pending-turn capacity. */
export interface CheckboxReservationUsage {
  originals: number;
  bytes: number;
  rateUnits: number;
}
/** Recorded original route identity, without inventing a canonical scope absent from evidence. */
export interface CheckboxReservationRouteIdentity {
  grantId: string;
  grantRevision: number;
  documentGeneration: string;
  routeHash: string;
  binding: VerifiedCheckboxAuthority['binding'];
}
/** Complete validated aggregates; callers still must prove current authority and capacity. */
export interface CheckboxReservationSummary {
  validated: number;
  installation: CheckboxReservationUsage;
  document: CheckboxReservationUsage;
  route: CheckboxReservationUsage & {
    identity: CheckboxReservationRouteIdentity | null;
    mixedIdentity: boolean;
  };
  matchingIntent: DocWriteIntentRow | null;
}
/** Unknown evidence or storage cannot be interpreted as free resources. */
export class CheckboxReservationCensusError extends Error {
  readonly code = 'CHECKBOX_RESERVATION_CENSUS_UNAVAILABLE';
  constructor(options?: ErrorOptions) {
    super('Checkbox reservation evidence is unavailable.', options);
    this.name = 'CheckboxReservationCensusError';
  }
}

function add(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new CheckboxReservationCensusError();
  return value;
}
function charge(usage: CheckboxReservationUsage, bytes: number): void {
  usage.originals = add(usage.originals, 1);
  usage.rateUnits = add(usage.rateUnits, 1);
  usage.bytes = add(usage.bytes, bytes);
}
function usage(): CheckboxReservationUsage {
  return { originals: 0, bytes: 0, rateUnits: 0 };
}
function validate(row: DocWriteIntentRow) {
  RowHeader.parse(row);
  const status = Status.parse(row.status);
  const evidence = validateCheckboxEvidence(row);
  if (status === 'failed' || evidence.v !== 2 || !evidence.authority.routeId)
    throw new CheckboxReservationCensusError();
  return evidence;
}
function include(
  summary: CheckboxReservationSummary,
  request: CheckboxReservationRequest,
  row: DocWriteIntentRow
): void {
  const evidence = validate(row);
  summary.validated = add(summary.validated, 1);
  if (row.documentId === request.documentId && row.eventId === request.eventId) {
    if (summary.matchingIntent) throw new CheckboxReservationCensusError();
    summary.matchingIntent = structuredClone(row);
  }
  if (['committed', 'no_op', 'conflict'].includes(row.status)) return;
  const bytes = projectVerifiedCheckbox(row).identity.bytes;
  charge(summary.installation, bytes);
  if (row.documentId !== request.documentId) return;
  charge(summary.document, bytes);
  if (evidence.authority.routeId !== request.routeId) return;
  charge(summary.route, bytes);
  const identity: CheckboxReservationRouteIdentity = {
    grantId: evidence.authority.grantId,
    grantRevision: evidence.authority.grantRevision,
    documentGeneration: evidence.authority.documentGeneration,
    routeHash: evidence.authority.routeHash,
    binding: evidence.authority.binding,
  };
  if (summary.route.identity && JSON.stringify(summary.route.identity) !== JSON.stringify(identity))
    summary.route.mixedIdentity = true;
  summary.route.identity ??= identity;
}

/**
 * Inspect every retained intent in the caller's synchronous SQLite transaction.
 * No UUID, route-slot or capacity decision is valid until the entire scan succeeds.
 * Terminal rows retain identity; unresolved rows never age out or receive own credit.
 */
export function scanCheckboxReservations(
  tx: DbTransaction,
  requested: CheckboxReservationRequest
): CheckboxReservationSummary {
  const request = Request.parse(requested);
  const summary: CheckboxReservationSummary = {
    validated: 0,
    installation: usage(),
    document: usage(),
    route: { ...usage(), identity: null, mixedIdentity: false },
    matchingIntent: null,
  };
  let cursor: string | undefined;
  try {
    for (;;) {
      const rows = readChecked('canvas_doc_write_intents', 'reservation-census', () =>
        readPreparedIntentPage(tx, cursor)
      );
      for (const row of rows) include(summary, request, row);
      if (rows.length < PAGE_SIZE) break;
      cursor = rows[rows.length - 1]!.intentId;
    }
  } catch (cause) {
    throw new CheckboxReservationCensusError({ cause });
  }
  return freezeCheckboxData(summary);
}
