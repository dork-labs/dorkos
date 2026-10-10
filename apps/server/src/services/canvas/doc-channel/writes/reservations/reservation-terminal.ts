/** Fixed terminal/transition row data and readonly SQL verification; no authority issuance. */
import {
  eq,
  sql,
  canvasDocEvents,
  canvasDocDeliveries,
  canvasDocBatches,
  canvasDocWriteIntents,
  type DbTransaction,
} from '@dorkos/db';
import { CanvasChannelCheckboxReceiptSchema } from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../../../core/approvals/approval-input-hash.js';
import type { DocWriteIntentRow } from '../../store.js';
import {
  CheckboxEvidenceError,
  CheckboxPhysicalIdentitySchema,
  freezeCheckboxData,
  validateCheckboxEvidence,
  type CheckboxPhysicalIdentity,
  type CheckboxReceipt,
} from '../checkbox-evidence.js';

/** Compare complete inert original row data, including every evidence field. */
export function sameCheckboxRow(left: unknown, right: unknown): boolean {
  return hashApprovalInput(left) === hashApprovalInput(right);
}
/** Fixed new terminal forms; observed bytes are never invented for an identity refusal. */
export function checkCheckboxTerminal(
  row: DocWriteIntentRow,
  kind: 'no_op' | 'conflict'
): CheckboxReceipt {
  const evidence = validateCheckboxEvidence(row);
  const receipt = CanvasChannelCheckboxReceiptSchema.parse(evidence.receipt);
  if (
    evidence.v !== 2 ||
    row.status !== kind ||
    receipt.status !== kind ||
    evidence.tempPath !== null ||
    evidence.tempIdentity !== null ||
    (kind === 'no_op' && (row.errorCode !== null || evidence.preEffectRefusal)) ||
    (kind === 'conflict' &&
      !['source_conflict', 'identity_changed_before_effect'].includes(row.errorCode ?? ''))
  )
    throw new CheckboxEvidenceError('Checkbox fixed terminal evidence changed.');
  return freezeCheckboxData(receipt);
}
/** Persist only an owned exclusively-created temporary identity on an original prepared row. */
export function stagedCheckboxRow(
  row: DocWriteIntentRow,
  replacement: CheckboxPhysicalIdentity,
  now: string
): DocWriteIntentRow {
  const evidence = validateCheckboxEvidence(row);
  if (
    row.status !== 'prepared' ||
    row.errorCode !== null ||
    evidence.v !== 2 ||
    evidence.receipt ||
    !evidence.tempPath ||
    evidence.tempIdentity !== null ||
    evidence.preEffectRefusal
  )
    throw new CheckboxEvidenceError('Checkbox staging requires its original prepared evidence.');
  const next = {
    ...row,
    updatedAt: now,
    evidence: { ...evidence, tempIdentity: CheckboxPhysicalIdentitySchema.parse(replacement) },
  };
  validateCheckboxEvidence(next);
  return freezeCheckboxData(next);
}
/** A recorded replacement remains unresolved until genuine common completion succeeds. */
export function replacedCheckboxRow(row: DocWriteIntentRow, now: string): DocWriteIntentRow {
  const evidence = validateCheckboxEvidence(row);
  if (
    row.status !== 'prepared' ||
    row.errorCode !== null ||
    evidence.v !== 2 ||
    evidence.receipt ||
    !evidence.tempPath ||
    !evidence.tempIdentity ||
    evidence.preEffectRefusal
  )
    throw new CheckboxEvidenceError('Checkbox replacement requires its original staged evidence.');
  const next: DocWriteIntentRow = { ...row, status: 'replaced', updatedAt: now };
  validateCheckboxEvidence(next);
  return freezeCheckboxData(next);
}
/** Whole-row equality includes the original request, authority, receipt and physical evidence. */
export function requireCheckboxRow(tx: DbTransaction, expected: DocWriteIntentRow): void {
  const current = tx
    .select()
    .from(canvasDocWriteIntents)
    .where(eq(canvasDocWriteIntents.intentId, expected.intentId))
    .get();
  if (!current || !sameCheckboxRow(current, expected))
    throw new CheckboxEvidenceError('Checkbox original transition row changed.');
  validateCheckboxEvidence(current);
}
/** A no-effect terminal UUID has no changed original event or delivery. */
export function requireCheckboxTerminalAbsentOutbox(
  tx: DbTransaction,
  row: DocWriteIntentRow
): void {
  if (
    tx
      .select({ id: canvasDocEvents.eventId })
      .from(canvasDocEvents)
      .where(
        sql`${canvasDocEvents.documentId}=${row.documentId} AND ${canvasDocEvents.eventId}=${row.eventId}`
      )
      .get() ||
    tx
      .select({ id: canvasDocDeliveries.eventId })
      .from(canvasDocDeliveries)
      .where(
        sql`${canvasDocDeliveries.documentId}=${row.documentId} AND ${canvasDocDeliveries.eventId}=${row.eventId}`
      )
      .get() ||
    tx.get(
      sql`SELECT 1 FROM ${canvasDocBatches} WHERE ${canvasDocBatches.documentId}=${row.documentId} AND EXISTS (SELECT 1 FROM json_each(${canvasDocBatches.inputEventIds}) WHERE value=${row.eventId})`
    ) ||
    tx.get(
      sql`SELECT 1 FROM ${canvasDocEvents} WHERE ${canvasDocEvents.documentId}=${row.documentId} AND ${canvasDocEvents.type}='event.status' AND json_extract(${canvasDocEvents.payload}, '$.eventId')=${row.eventId}`
    )
  )
    throw new CheckboxEvidenceError('Checkbox terminal row has a changed outbox.');
}
