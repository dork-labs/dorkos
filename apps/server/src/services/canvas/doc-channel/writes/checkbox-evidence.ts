/** Immutable checkbox evidence and synchronous transaction-boundary checks. */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  CanvasChannelCheckboxRequestSchema,
  CanvasChannelCheckboxBindingSchema,
  CanvasChannelCheckboxReceiptSchema,
  type IngestReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import type { DbTransaction } from '@dorkos/db';
import type { DocChannelActor } from '../authorization.js';
import type { DocWriteIntentRow } from '../store.js';
import { rawByteHash, type CheckboxByteEdit } from './checkbox-bytes.js';
export type CheckboxRequest = z.infer<typeof CanvasChannelCheckboxRequestSchema>;
export type CheckboxReceipt = z.infer<typeof CanvasChannelCheckboxReceiptSchema>;
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const VerifiedCheckboxAuthoritySchema = z
  .object({
    documentId: CanvasChannelCheckboxRequestSchema.shape.documentId,
    binding: CanvasChannelCheckboxBindingSchema,
    grantId: z.string().min(1),
    grantRevision: z.number().int().positive(),
    documentGeneration: z.string().min(1),
    routeId: z.string().nullable(),
    routeHash: Hash,
  })
  .strict();
export type VerifiedCheckboxAuthority = z.infer<typeof VerifiedCheckboxAuthoritySchema>;
export const CheckboxPhysicalIdentitySchema = z
  .object({
    device: z.string().regex(/^(0|[1-9][0-9]*)$/),
    inode: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
export type CheckboxPhysicalIdentity = z.infer<typeof CheckboxPhysicalIdentitySchema>;
const EvidenceFields = {
  authority: VerifiedCheckboxAuthoritySchema,
  markerOffset: z.number().int().nonnegative().nullable(),
  tempPath: z.string().nullable(),
  tempIdentity: z
    .object({ device: z.string().min(1), inode: z.string().min(1) })
    .strict()
    .nullable(),
  beforeMarker: z.union([z.literal(32), z.literal(88), z.literal(120)]).nullable(),
  lineHash: Hash.nullable(),
  receipt: CanvasChannelCheckboxReceiptSchema.optional(),
  preEffectRefusal: z.literal('identity_changed').optional(),
};
const EvidenceSchema = z.discriminatedUnion('v', [
  z.object({ v: z.literal(1), ...EvidenceFields }).strict(),
  z
    .object({
      v: z.literal(2),
      ...EvidenceFields,
      originalIdentity: CheckboxPhysicalIdentitySchema.nullable(),
      tempIdentity: CheckboxPhysicalIdentitySchema.nullable(),
    })
    .strict(),
]);
export interface CheckboxAuthorityPorts {
  /** Recognize only proven typed authority reductions, preserving unknown/transient failures. */
  isAuthorityRefusal(error: unknown): boolean;
  preflight(documentId: string, actor: DocChannelActor): Promise<void>;
  requireAccess(documentId: string, actor: DocChannelActor, tx: DbTransaction): undefined;
  prepare(request: CheckboxRequest, actor: DocChannelActor): Promise<VerifiedCheckboxAuthority>;
  requireCurrent(
    request: CheckboxRequest,
    actor: DocChannelActor,
    authority: VerifiedCheckboxAuthority,
    tx: DbTransaction
  ): VerifiedCheckboxAuthority;
  prepareRecovery(intent: DocWriteIntentRow): Promise<VerifiedCheckboxAuthority>;
  requireRecoveryCurrent(
    intent: DocWriteIntentRow,
    authority: VerifiedCheckboxAuthority,
    tx: DbTransaction
  ): VerifiedCheckboxAuthority;
}
export interface CheckboxCompletionPorts {
  /** Append the original verified host event and its exact frozen outbox in this transaction. */
  completeVerified(intent: DocWriteIntentRow, tx: DbTransaction): IngestReceipt;
  notifyCommitted?: (documentId: string) => undefined;
}
export interface CheckboxServiceOptions {
  now?: () => Date;
  /** Outside transactions; a terminated process leaves durable evidence at this exact boundary. */
  checkpoint?: (
    point: 'prepared' | 'staged' | 'replaced' | 'verified',
    intent: DocWriteIntentRow
  ) => Promise<void>;
}

/** Validate persisted original input, exact binding, and mutually consistent receipts. */
export function validateCheckboxEvidence(row: DocWriteIntentRow): z.infer<typeof EvidenceSchema> {
  const request = CanvasChannelCheckboxRequestSchema.parse(row.input);
  const evidence = EvidenceSchema.parse(row.evidence);
  const binding = evidence.authority.binding;
  if (
    evidence.v === 2 &&
    ((evidence.originalIdentity === null) !== Boolean(evidence.preEffectRefusal) ||
      (evidence.tempIdentity !== null && evidence.tempPath === null) ||
      (evidence.tempIdentity !== null &&
        evidence.originalIdentity !== null &&
        evidence.tempIdentity.device === evidence.originalIdentity.device &&
        evidence.tempIdentity.inode === evidence.originalIdentity.inode))
  )
    throw new CheckboxEvidenceError('Checkbox physical evidence is inconsistent.');
  if (
    request.documentId !== row.documentId ||
    evidence.authority.documentId !== row.documentId ||
    request.eventId !== row.eventId ||
    row.envelopeHash !== rawByteHash(Buffer.from(JSON.stringify(request))) ||
    row.operation !== binding.operation ||
    row.grantId !== evidence.authority.grantId ||
    row.sourceIdentity !== binding.sourceIdentity ||
    row.canonicalPath !== binding.canonicalPath ||
    row.resolvedCwd !== binding.resolvedCwd ||
    row.treeKind !== binding.treeKind ||
    row.expectedVersion !== request.expectedFileVersion ||
    (evidence.tempPath !== null &&
      evidence.tempPath !== join(dirname(row.canonicalPath), `.dork-checkbox-${row.intentId}.tmp`))
  )
    throw new CheckboxEvidenceError('Checkbox evidence does not match its intent.');
  if (
    (row.errorCode === 'identity_changed_before_effect') !== Boolean(evidence.preEffectRefusal) ||
    (evidence.preEffectRefusal &&
      (row.status !== 'conflict' ||
        evidence.receipt?.status !== 'conflict' ||
        evidence.markerOffset !== null ||
        evidence.beforeMarker !== null ||
        evidence.lineHash !== null ||
        evidence.tempPath !== null ||
        evidence.tempIdentity !== null ||
        row.beforeHash !== request.expectedFileVersion ||
        row.afterHash !== request.expectedFileVersion))
  )
    throw new CheckboxEvidenceError('Checkbox pre-effect conflict evidence changed.');
  // Only the fully checked terminal pre-effect refusal carries the caller's version,
  // not an observed byte hash. Every other lifecycle still requires SHA-256 evidence.
  if (
    !evidence.preEffectRefusal &&
    (!Hash.safeParse(row.beforeHash).success || !Hash.safeParse(row.afterHash).success)
  )
    throw new CheckboxEvidenceError('Checkbox evidence does not match its intent.');
  if (
    evidence.receipt &&
    (evidence.receipt.status === 'changed'
      ? evidence.receipt.receipt.id
      : evidence.receipt.eventId) !== row.eventId
  )
    throw new CheckboxEvidenceError('Checkbox receipt identity changed.');
  if (evidence.receipt) {
    const status = evidence.receipt.status;
    if (
      (status === 'changed' &&
        (row.status !== 'committed' || evidence.receipt.fileVersion !== row.afterHash)) ||
      (status === 'no_op' &&
        (row.status !== 'no_op' ||
          row.beforeHash !== row.afterHash ||
          evidence.receipt.fileVersion !== row.beforeHash)) ||
      (status === 'conflict' && row.status !== 'conflict') ||
      status === 'in_doubt'
    )
      throw new CheckboxEvidenceError('Checkbox receipt status contradicts its intent.');
  } else if (['committed', 'no_op', 'conflict'].includes(row.status))
    throw new CheckboxEvidenceError('Checkbox terminal receipt is absent.');
  if (
    !evidence.receipt &&
    (evidence.markerOffset === null ||
      evidence.beforeMarker === null ||
      evidence.lineHash !== request.textHash ||
      row.beforeHash !== request.expectedFileVersion ||
      row.beforeHash === row.afterHash)
  )
    throw new CheckboxEvidenceError('Checkbox mutation evidence is incomplete.');
  return evidence;
}
/** Reject and observe asynchronous continuations before a transaction can commit. */
export function sync<T>(value: T): T {
  if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
    void Promise.resolve(value).catch(() => {});
    throw new Error('Checkbox transaction ports must be synchronous.');
  }
  return value;
}

/** A verified inconsistency reduces authority rather than retrying completion. */
export class CheckboxEvidenceError extends Error {}

export const UNRESOLVED_CHECKBOX_STATUSES = ['prepared', 'replaced', 'in_doubt'] as const;

/** Detached checked JSON evidence stays immutable across trusted callback boundaries. */
export function freezeCheckboxData<T>(value: T): T {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const current = pending.pop();
    if (current && typeof current === 'object' && !seen.has(current)) {
      seen.add(current);
      pending.push(...Object.values(current));
      Object.freeze(current);
    }
  }
  return value;
}
/** Refuse any revision, generation, document, path or route change across awaits. */
export function requireSameCheckboxAuthority(
  expected: VerifiedCheckboxAuthority,
  actual: VerifiedCheckboxAuthority
): void {
  if (JSON.stringify(VerifiedCheckboxAuthoritySchema.parse(actual)) !== JSON.stringify(expected))
    throw new CheckboxEvidenceError('Checkbox authority changed.');
}

/** Preserve unobserved request-version evidence after a proven pre-callback identity refusal. */
export function preEffectCheckboxConflict(
  request: CheckboxRequest,
  approved: VerifiedCheckboxAuthority,
  digest: string,
  now: string
): { receipt: CheckboxReceipt; intent: DocWriteIntentRow } {
  const receipt: CheckboxReceipt = {
    status: 'conflict',
    eventId: request.eventId,
    action: 'reload',
  };
  return {
    receipt,
    intent: {
      intentId: randomUUID(),
      documentId: request.documentId,
      eventId: request.eventId,
      envelopeHash: digest,
      grantId: approved.grantId,
      sourceIdentity: approved.binding.sourceIdentity,
      resolvedCwd: approved.binding.resolvedCwd,
      treeKind: approved.binding.treeKind,
      canonicalPath: approved.binding.canonicalPath,
      operation: 'checkbox-toggle',
      input: request,
      // These legacy-named fields carry only the original request version here, not byte hashes.
      beforeHash: request.expectedFileVersion,
      afterHash: request.expectedFileVersion,
      expectedVersion: request.expectedFileVersion,
      evidence: {
        v: 2,
        originalIdentity: null,
        authority: approved,
        tempPath: null,
        tempIdentity: null,
        markerOffset: null,
        beforeMarker: null,
        lineHash: null,
        receipt,
        preEffectRefusal: 'identity_changed',
      },
      status: 'conflict',
      errorCode: 'identity_changed_before_effect',
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** Construct original intent evidence only from a bounded source read and parser-proven edit. */
export function observedCheckboxIntent(
  request: CheckboxRequest,
  approved: VerifiedCheckboxAuthority,
  digest: string,
  now: string,
  observedHash: string,
  originalIdentity: CheckboxPhysicalIdentity,
  edit?: CheckboxByteEdit
): { receipt: CheckboxReceipt | undefined; intent: DocWriteIntentRow } {
  const receipt: CheckboxReceipt | undefined = !edit
    ? { status: 'conflict', eventId: request.eventId, action: 'reload' }
    : !edit.changed
      ? { status: 'no_op', eventId: request.eventId, fileVersion: edit.beforeHash }
      : undefined;
  const intentId = randomUUID();
  const intent: DocWriteIntentRow = {
    intentId,
    documentId: request.documentId,
    eventId: request.eventId,
    envelopeHash: digest,
    grantId: approved.grantId,
    sourceIdentity: approved.binding.sourceIdentity,
    resolvedCwd: approved.binding.resolvedCwd,
    treeKind: approved.binding.treeKind,
    canonicalPath: approved.binding.canonicalPath,
    operation: 'checkbox-toggle',
    input: request,
    beforeHash: edit?.beforeHash ?? observedHash,
    afterHash: edit?.afterHash ?? observedHash,
    expectedVersion: request.expectedFileVersion,
    evidence: {
      v: 2,
      originalIdentity: CheckboxPhysicalIdentitySchema.parse(originalIdentity),
      authority: approved,
      tempPath: receipt
        ? null
        : join(dirname(approved.binding.canonicalPath), `.dork-checkbox-${intentId}.tmp`),
      tempIdentity: null,
      markerOffset: edit?.markerOffset ?? null,
      beforeMarker: edit ? edit.before[edit.markerOffset] : null,
      lineHash: edit?.lineHash ?? null,
      ...(receipt ? { receipt } : {}),
    },
    status: !edit ? 'conflict' : !edit.changed ? 'no_op' : 'prepared',
    errorCode: receipt?.status === 'conflict' ? 'source_conflict' : null,
    createdAt: now,
    updatedAt: now,
  };

  return { receipt, intent };
}
