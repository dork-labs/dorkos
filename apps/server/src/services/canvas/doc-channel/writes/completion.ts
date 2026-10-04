/** Private checkbox completion adapter; common ingestion and reservation ports are mandatory. */
import { and, eq, canvasDocWriteIntents, type DbTransaction } from '@dorkos/db';
import { readChecked } from '../store-json.js';
import { types as utilTypes } from 'node:util';
import { DocChannelIngest, completeOriginalCheckboxOutbox } from '../ingest.js';
import type { DocIngestLimits } from '../accounting.js';
import {
  createCheckboxReservationBridge,
  failCheckboxCompletion,
  readCheckboxConvertedIntent,
} from './reservation-bridge.js';
import {
  createCheckboxReservationBinding,
  requireCheckboxReservationAccess,
  runCheckboxReservationTransaction,
  requireCheckboxReservationScope,
  type DocCheckboxAuthority,
  type CheckboxReservationSubject,
} from './authority.js';
import type { DocChannelActor } from '../authorization.js';
import type { CheckboxAuthoritySnapshot } from './authority-snapshot.js';
import {
  IngestReceiptSchema,
  CanvasChannelCheckboxRequestSchema,
  StoredPageEventSchema,
  matchesCanvasChannelEvent,
  type IngestReceipt,
  type StoredPageEvent,
} from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../../core/approvals/approval-input-hash.js';
import { envelopeIdentity } from '../envelope.js';
import type { DocIngestAccess } from '../ingest-types.js';
import type { DocChannelStore, DocWriteIntentRow } from '../store.js';
import {
  CheckboxEvidenceError,
  freezeCheckboxData,
  sync,
  validateCheckboxEvidence,
  type CheckboxCompletionPorts,
  type CheckboxReceipt,
} from './checkbox-evidence.js';

/** Fixed host input, independent of the original write-request fingerprint. */
export interface VerifiedCheckboxProjection {
  intent: DocWriteIntentRow;
  event: StoredPageEvent;
  identity: { hash: string; bytes: number };
  provenance: { transport: 'host'; producer: 'verified_checkbox'; intentId: string };
}

/** Parent composition must check current original approval and the caller's fresh authority proof. */
export interface OriginalCheckboxCompletionAccess {
  requireOriginalCompletionAccess(intent: DocWriteIntentRow, tx: DbTransaction): DocIngestAccess;
}

/** Reserved common-source seams; no public accept, nested transaction or fallback implementation. */
export interface CheckboxTransactionalIngest {
  /** Check the exact active, scoped caller handle belongs to this same store/installation. */
  requireTransaction(tx: DbTransaction): undefined;
  /** Account for every existing reservation and reserve the original route slot before any effect. */
  requireCheckboxPreparedAdmissionInTransaction(
    candidate: VerifiedCheckboxProjection,
    original: DocIngestAccess,
    tx: DbTransaction
  ): undefined;
  /** Convert only this owning replaced reservation to the original event and frozen outbox. */
  acceptVerifiedCheckboxInTransaction(
    candidate: VerifiedCheckboxProjection,
    original: DocIngestAccess,
    tx: DbTransaction
  ): IngestReceipt;
}

/** Writer invokes this in the same preparation transaction before inserting its prepared intent. */
export interface CheckboxPreparedAdmissionPorts {
  requirePreparedAdmission(candidate: DocWriteIntentRow, tx: DbTransaction): undefined;
}

/** Derive only the fixed host envelope; physical byte verification remains a caller obligation. */
export function projectVerifiedCheckbox(intent: DocWriteIntentRow): VerifiedCheckboxProjection {
  const evidence = validateCheckboxEvidence(intent);
  if (evidence.v !== 2 || evidence.receipt || evidence.preEffectRefusal)
    throw new CheckboxEvidenceError('Checkbox completion requires current physical evidence.');
  const request = CanvasChannelCheckboxRequestSchema.parse(intent.input);
  const event = StoredPageEventSchema.parse({
    v: 1,
    id: intent.eventId,
    type: 'md.task.toggled',
    payload: {
      line: request.line,
      done: request.done,
      textHash: request.textHash,
      beforeFileVersion: intent.beforeHash,
      afterFileVersion: intent.afterHash,
    },
  });
  return freezeCheckboxData({
    intent: structuredClone(intent),
    event,
    identity: envelopeIdentity(event),
    provenance: { transport: 'host', producer: 'verified_checkbox', intentId: intent.intentId },
  });
}

/** Validate durable delegated work before the existing writer can perform its terminal CAS. */
export function createCheckboxCompletion(deps: {
  store: DocChannelStore;
  ingest: CheckboxTransactionalIngest;
  original: OriginalCheckboxCompletionAccess;
  notifyCommitted: (documentId: string) => undefined;
}): { completion: CheckboxCompletionPorts; admission: CheckboxPreparedAdmissionPorts } {
  let entered = false;
  const guarded = <T>(work: () => T): T => {
    if (entered) throw new CheckboxEvidenceError('Checkbox completion is already active.');
    entered = true;
    try {
      return work();
    } finally {
      entered = false;
    }
  };
  const access = (projection: VerifiedCheckboxProjection, tx: DbTransaction): DocIngestAccess => {
    const original = sync(deps.original.requireOriginalCompletionAccess(projection.intent, tx));
    const authority = validateCheckboxEvidence(projection.intent).authority;
    const channel = deps.store.getChannel(projection.intent.documentId, tx);
    const decision = original.routes[0];
    if (
      !channel ||
      channel.closedAt ||
      channel.scope !== original.scope ||
      original.documentId !== projection.intent.documentId ||
      original.routes.length !== 1 ||
      !authority.routeId ||
      !decision ||
      decision.reason ||
      decision.route.id !== authority.routeId ||
      decision.grantId !== authority.grantId ||
      decision.grantRevision !== authority.grantRevision ||
      hashApprovalInput(decision.route) !== authority.routeHash ||
      !matchesCanvasChannelEvent(decision.route.on, projection.event.type)
    )
      throw new CheckboxEvidenceError('Checkbox original completion route changed.');
    // Host provenance cannot be supplied by an actor or copied from an earlier transport.
    return freezeCheckboxData({ ...original, provenance: projection.provenance });
  };
  return {
    admission: {
      requirePreparedAdmission(candidate, tx) {
        return guarded(() => {
          if (sync(deps.ingest.requireTransaction(tx)) !== undefined)
            throw new CheckboxEvidenceError('Checkbox transaction witness changed.');
          if (candidate.status !== 'prepared' || deps.store.getWriteIntent(candidate.intentId, tx))
            throw new CheckboxEvidenceError('Checkbox preparation candidate changed.');
          const projection = projectVerifiedCheckbox(candidate);
          const original = access(projection, tx);
          if (
            sync(
              deps.ingest.requireCheckboxPreparedAdmissionInTransaction(projection, original, tx)
            ) !== undefined
          )
            throw new CheckboxEvidenceError('Checkbox prepared admission result changed.');
          return undefined;
        });
      },
    },
    completion: {
      completeVerified(intent, tx) {
        return guarded(() => {
          if (sync(deps.ingest.requireTransaction(tx)) !== undefined)
            throw new CheckboxEvidenceError('Checkbox transaction witness changed.');
          const current = deps.store.getWriteIntent(intent.intentId, tx);
          if (
            !current ||
            current.status !== 'replaced' ||
            JSON.stringify(current) !== JSON.stringify(intent)
          )
            throw new CheckboxEvidenceError('Checkbox replaced intent changed.');
          const projection = projectVerifiedCheckbox(current);
          const evidence = validateCheckboxEvidence(current);
          if (!evidence.tempIdentity || !evidence.tempPath)
            throw new CheckboxEvidenceError('Checkbox replacement identity is absent.');
          const original = access(projection, tx);
          const receipt = IngestReceiptSchema.parse(
            sync(deps.ingest.acceptVerifiedCheckboxInTransaction(projection, original, tx))
          );
          const saved = deps.store.getEvent(current.documentId, current.eventId, tx);
          const deliveries = deps.store.listDeliveries(current.documentId, current.eventId, tx);
          const delivery = deliveries[0];
          const route = original.routes[0]!.route;
          if (
            receipt.id !== current.eventId ||
            receipt.status !== 'recorded' ||
            !saved ||
            saved.docSeq !== receipt.docSeq ||
            saved.direction !== 'upstream' ||
            saved.type !== projection.event.type ||
            saved.envelopeHash !== projection.identity.hash ||
            saved.envelopeBytes !== projection.identity.bytes ||
            saved.payloadPrunedAt !== null ||
            saved.coalesceKey !== null ||
            saved.clientTs !== null ||
            JSON.stringify(saved.payload) !== JSON.stringify(projection.event.payload) ||
            JSON.stringify(saved.provenance) !== JSON.stringify(projection.provenance) ||
            deliveries.length !== 1 ||
            !delivery ||
            delivery.routeId !== route.id
          )
            throw new CheckboxEvidenceError('Checkbox durable completion projection changed.');
          if (route.to === 'log' || route.turn.mode === 'none') {
            if (
              delivery.status !== 'routed' ||
              delivery.reason !== 'no_turn' ||
              delivery.batchId !== null
            )
              throw new CheckboxEvidenceError('Checkbox no-turn delivery changed.');
          } else {
            const batch = delivery.batchId ? deps.store.getBatch(delivery.batchId, tx) : undefined;
            if (
              !batch ||
              !['pending', 'waiting'].includes(delivery.status) ||
              batch.status !== delivery.status ||
              batch.documentId !== current.documentId ||
              batch.scope !== original.scope ||
              batch.routeId !== route.id ||
              batch.grantId !== current.grantId ||
              batch.grantRevision !== evidence.authority.grantRevision ||
              !batch.inputEventIds.includes(current.eventId)
            )
              throw new CheckboxEvidenceError('Checkbox original pending outbox changed.');
          }
          if (
            JSON.stringify(deps.store.getWriteIntent(current.intentId, tx)) !==
            JSON.stringify(current)
          )
            throw new CheckboxEvidenceError('Checkbox completion changed its owning reservation.');
          return receipt;
        });
      },
      notifyCommitted(documentId) {
        try {
          sync(deps.notifyCommitted(documentId));
        } catch {
          /* A hint cannot undo commit. */
        }
        return undefined;
      },
    },
  };
}

/** Production private orchestration; the original authority owns the caller transaction and exit audit. */
export function createOriginalCheckboxCompletion(deps: {
  authority: DocCheckboxAuthority;
  store: DocChannelStore;
  policyLimits: DocIngestLimits;
  notifyCommitted: (documentId: string) => undefined;
}) {
  if (utilTypes.isProxy(deps) || Object.getPrototypeOf(deps) !== Object.prototype)
    throw new CheckboxEvidenceError('Checkbox completion requires own dependency data.');
  const captured = {} as typeof deps;
  const fields = ['authority', 'store', 'policyLimits', 'notifyCommitted'] as const;
  if (Reflect.ownKeys(deps).length !== fields.length)
    throw new CheckboxEvidenceError('Checkbox completion dependency fields changed.');
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(deps, key);
    if (!descriptor || !('value' in descriptor))
      throw new CheckboxEvidenceError('Checkbox completion dependency must be own data.');
    Object.defineProperty(captured, key, { value: descriptor.value, enumerable: true });
  }
  if (typeof captured.notifyCommitted !== 'function')
    throw new CheckboxEvidenceError('Checkbox completion notification is required.');
  deps = Object.freeze(captured);
  const bridge = createCheckboxReservationBridge(deps.authority, deps.store, deps.policyLimits);
  const ingest = new DocChannelIngest(deps.store, undefined, deps.policyLimits);
  const binding = createCheckboxReservationBinding(deps.authority, deps.store);
  const finishInTransaction = (
    tx: DbTransaction
  ): Extract<CheckboxReceipt, { status: 'changed' }> => {
    try {
      requireCheckboxReservationScope(binding, tx);
      const original = readCheckboxConvertedIntent(deps.store, tx);
      const current = deps.store.getWriteIntent(original.intentId, tx);
      if (!current || JSON.stringify(current) !== JSON.stringify(original))
        throw new CheckboxEvidenceError('Checkbox original replaced intent changed.');
      const evidence = validateCheckboxEvidence(current);
      const receipt: CheckboxReceipt = {
        status: 'changed',
        receipt: IngestReceiptSchema.parse(completeOriginalCheckboxOutbox(ingest, deps.store, tx)),
        fileVersion: current.afterHash,
      };
      if (receipt.receipt.id !== current.eventId || receipt.receipt.status !== 'recorded')
        throw new CheckboxEvidenceError('Checkbox original completion receipt changed.');
      const event = deps.store.getEvent(current.documentId, current.eventId, tx)!;
      if (
        !deps.store.transitionWriteIntent(
          current.intentId,
          'replaced',
          {
            status: 'committed',
            updatedAt: event.receivedAt,
            errorCode: null,
            evidence: { ...evidence, receipt },
          },
          tx
        )
      )
        throw new CheckboxEvidenceError('Checkbox original completion raced.');
      return freezeCheckboxData(receipt);
    } catch (cause) {
      return failCheckboxCompletion(deps.store, tx, cause);
    }
  };
  const completeInTransaction = (
    input: {
      intentId: string;
      subject: CheckboxReservationSubject;
      freshSnapshot: CheckboxAuthoritySnapshot;
    },
    tx: DbTransaction
  ): Extract<CheckboxReceipt, { status: 'changed' }> => {
    bridge.convertOwnReservationInTransaction(input, tx);
    return finishInTransaction(tx);
  };
  const readDuplicate = (
    input: {
      intentId: string;
      documentId: string;
      eventId: string;
      digest: string;
      actor: DocChannelActor;
    },
    tx: DbTransaction
  ): CheckboxReceipt => {
    requireCheckboxReservationAccess(binding, input.documentId, input.actor, tx);
    const row = readChecked('canvas_doc_write_intents', input.intentId, () =>
      tx
        .select()
        .from(canvasDocWriteIntents)
        .where(
          and(
            eq(canvasDocWriteIntents.intentId, input.intentId),
            eq(canvasDocWriteIntents.documentId, input.documentId),
            eq(canvasDocWriteIntents.eventId, input.eventId)
          )
        )
        .get()
    );
    if (!row || row.documentId !== input.documentId || row.eventId !== input.eventId)
      throw new CheckboxEvidenceError('Checkbox duplicate identity changed.');
    const original = freezeCheckboxData(structuredClone(row));
    const evidence = validateCheckboxEvidence(original);
    const receipt = freezeCheckboxData<CheckboxReceipt>(
      original.envelopeHash !== input.digest
        ? { status: 'conflict', eventId: row.eventId, action: 'reload' }
        : (evidence.receipt ?? { status: 'in_doubt', eventId: original.eventId, action: 'review' })
    );
    requireCheckboxReservationAccess(binding, original.documentId, input.actor, tx);
    return receipt;
  };
  return Object.freeze({
    readDuplicate(input: Parameters<typeof readDuplicate>[0], tx?: DbTransaction): CheckboxReceipt {
      return tx
        ? readDuplicate(input, tx)
        : runCheckboxReservationTransaction(binding, (current) => readDuplicate(input, current));
    },
    insertPreparedInTransaction: bridge.insertPreparedInTransaction,
    insertNoOpInTransaction: bridge.insertNoOpInTransaction,
    insertConflictInTransaction: bridge.insertConflictInTransaction,
    stageInTransaction: bridge.stageInTransaction,
    replaceInTransaction: bridge.replaceInTransaction,
    requireEffectInTransaction: bridge.requireEffectInTransaction,
    requireEffect: bridge.requireEffect,
    completeInTransaction,
    finishInTransaction,
    complete(
      input: Parameters<typeof completeInTransaction>[0]
    ): Extract<CheckboxReceipt, { status: 'changed' }> {
      const committed = runCheckboxReservationTransaction(binding, (tx) => ({
        receipt: completeInTransaction(input, tx),
        documentId: readCheckboxConvertedIntent(deps.store, tx).documentId,
      }));
      try {
        sync(deps.notifyCommitted(committed.documentId));
      } catch {
        /* Committed evidence owns the outcome. */
      }
      return committed.receipt;
    },
  });
}
