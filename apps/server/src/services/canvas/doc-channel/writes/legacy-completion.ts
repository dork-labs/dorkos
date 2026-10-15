import { type DbTransaction } from '@dorkos/db';
import { projectVerifiedCheckbox, type VerifiedCheckboxProjection } from './checkbox-projection.js';
import {
  IngestReceiptSchema,
  matchesCanvasChannelEvent,
  type IngestReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../../core/approvals/approval-input-hash.js';
import type { DocIngestAccess } from '../ingest-data/ingest-types.js';
import type { DocChannelStore, DocWriteIntentRow } from '../store.js';
import {
  CheckboxEvidenceError,
  freezeCheckboxData,
  sync,
  validateCheckboxEvidence,
  type CheckboxCompletionPorts,
} from './checkbox-evidence.js';
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
