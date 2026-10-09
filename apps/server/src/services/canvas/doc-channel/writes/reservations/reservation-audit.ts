/** Fixed original terminal projection checks; readonly SQL and inert subjects only. */
import { eq, sql, canvasDocEvents, canvasDocWriteIntents, type DbTransaction } from '@dorkos/db';
import { CanvasChannelCheckboxIntentSchema } from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../../../core/approvals/approval-input-hash.js';
import type { DocEventRow, DocWriteIntentRow } from '../../store.js';
import { readChecked } from '../../storage/store-json.js';
import type { CheckboxReservationSubject } from '../authority.js';
import type { VerifiedCheckboxProjection } from '../completion.js';
import { validateCheckboxEvidence, requireSameCheckboxAuthority } from '../checkbox-evidence.js';
function same(a: unknown, b: unknown): boolean {
  return hashApprovalInput(a) === hashApprovalInput(b);
}
/** Read the exact retained original row through fixed readonly SQL. */
export function readCheckboxOriginalIntent(tx: DbTransaction, id: string): DocWriteIntentRow {
  const row = readChecked('canvas_doc_write_intents', id, () =>
    tx.select().from(canvasDocWriteIntents).where(eq(canvasDocWriteIntents.intentId, id)).get()
  );
  if (!row) throw new Error('Original checkbox intent is absent.');
  return row;
}
/** Compare complete original inert subject data. */
export function requireCheckboxSubjectRow(
  subject: CheckboxReservationSubject,
  row: DocWriteIntentRow
): void {
  const evidence = validateCheckboxEvidence(row);
  requireSameCheckboxAuthority(evidence.authority, subject.approved);
  if (subject.kind === 'live' ? !same(subject.request, row.input) : !same(subject.intent, row))
    throw new Error('Checkbox reservation subject changed.');
}
/** Audit the exact terminal intent/event projection; caller retains private scope obligations. */
export function auditCheckboxTerminalProjection(
  tx: DbTransaction,
  expected: { projection: VerifiedCheckboxProjection; event: DocEventRow }
): void {
  const { projection, event } = expected;
  const current = readChecked('canvas_doc_write_intents', projection.intent.intentId, () =>
    tx
      .select()
      .from(canvasDocWriteIntents)
      .where(eq(canvasDocWriteIntents.intentId, projection.intent.intentId))
      .get()
  );
  if (!current) throw new Error('Original checkbox intent is absent.');
  const evidence = validateCheckboxEvidence(current);
  CanvasChannelCheckboxIntentSchema.shape.updatedAt.parse(current.updatedAt);
  if (current.status !== 'committed' || evidence.receipt?.status !== 'changed')
    throw new Error('Checkbox conversion lacks its exact terminal receipt.');
  const { receipt, ...physicalEvidence } = evidence;
  if (
    !same(
      {
        ...current,
        status: 'replaced',
        evidence: physicalEvidence,
        updatedAt: projection.intent.updatedAt,
      },
      projection.intent
    ) ||
    receipt.fileVersion !== current.afterHash ||
    !same(receipt.receipt, { id: event.eventId, status: 'recorded', docSeq: event.docSeq })
  )
    throw new Error('Checkbox terminal projection changed.');
  const saved = readChecked('canvas_doc_events', event.eventId, () =>
    tx
      .select()
      .from(canvasDocEvents)
      .where(
        sql`${canvasDocEvents.documentId}=${event.documentId} AND ${canvasDocEvents.eventId}=${event.eventId}`
      )
      .get()
  );
  if (!same(saved, event)) throw new Error('Checkbox converted event changed before commit.');
}
