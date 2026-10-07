/** Private checkbox completion adapter; common ingestion and reservation ports are mandatory. */
import { and, eq, canvasDocWriteIntents, type DbTransaction } from '@dorkos/db';
import { readChecked } from '../storage/store-json.js';
import { projectVerifiedCheckbox, type VerifiedCheckboxProjection } from './checkbox-projection.js';
export { projectVerifiedCheckbox } from './checkbox-projection.js';
export type { VerifiedCheckboxProjection } from './checkbox-projection.js';
import { types as utilTypes } from 'node:util';
import { DocChannelIngest, completeOriginalCheckboxOutbox } from '../ingest.js';
import {
  prepareServiceOriginalCheckboxSource,
  completeServiceOriginalCheckboxSource,
  publishServiceOriginalCheckboxSource,
  abandonServiceOriginalCheckboxSource,
  type DocChannelService,
} from '../service.js';
import type { DocIngestLimits } from '../current/accounting.js';
import {
  requireOriginalCheckboxWriterCompletion,
  type DocCheckboxWriteService,
} from './checkbox-service.js';
import {
  requireOriginalCanonicalWriteLease,
  type CanonicalFileWriteCoordinator,
  type CanonicalWriteLease,
} from './canonical-writer.js';
import {
  createCheckboxReservationBridge,
  failCheckboxCompletion,
  readCheckboxConvertedIntent,
  readPreparedCheckboxConversion,
  consumePreparedCheckboxConversion,
  type OriginalPreparedCheckboxConversion,
} from './reservations/reservation-bridge.js';
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
  matchesCanvasChannelEvent,
  type IngestReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../../core/approvals/approval-input-hash.js';
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

const originalCompletionOwners = new WeakMap<
  object,
  {
    store: DocChannelStore;
    ingest: DocChannelIngest;
    writer?: DocCheckboxWriteService;
    coordinator?: CanonicalFileWriteCoordinator;
  }
>();
const originalCompletionStages = new WeakMap<
  DbTransaction,
  {
    owner: object;
    store: DocChannelStore;
    phase: OriginalPreparedCheckboxConversion;
    finish: (tx: DbTransaction) => Extract<CheckboxReceipt, { status: 'changed' }>;
    consumed: boolean;
    committed: boolean;
    lease?: CanonicalWriteLease;
    intent: DocWriteIntentRow;
    receipt?: Extract<CheckboxReceipt, { status: 'changed' }>;
  }
>();
/** Constructor recognition only. No returned data supplies document/source permission. */
export function requireOriginalCheckboxCompletionOwner(owner: object, store: DocChannelStore) {
  const own = originalCompletionOwners.get(owner);
  if (!own || own.store !== store)
    throw new CheckboxEvidenceError('Foreign checkbox completion owner.');
  if (own.writer && own.coordinator)
    requireOriginalCheckboxWriterCompletion(own.writer, owner, store, own.coordinator);
}
/** Reads only the active original A phase; row DTOs and another constructor cannot issue it. */
export function readOriginalCheckboxCompletionStage(
  owner: object,
  store: DocChannelStore,
  tx: DbTransaction
) {
  requireOriginalCheckboxCompletionOwner(owner, store);
  const stage = originalCompletionStages.get(tx);
  if (!stage || stage.owner !== owner || stage.store !== store || stage.consumed)
    throw new CheckboxEvidenceError('Original checkbox source stage is unavailable.');
  const own = originalCompletionOwners.get(owner)!;
  const data = readPreparedCheckboxConversion(store, tx, stage.phase);
  if (own.writer && own.coordinator) {
    const physical = validateCheckboxEvidence(data.originalIntent).tempIdentity;
    if (!physical || !stage.lease)
      throw new CheckboxEvidenceError('Original checkbox lease is absent.');
    requireOriginalCanonicalWriteLease(own.coordinator, stage.lease, {
      canonicalPath: data.originalIntent.canonicalPath,
      device: physical.device,
      inode: physical.inode,
    });
  }
  return { data, phase: stage.phase, ingest: originalCompletionOwners.get(owner)!.ingest };
}
/** Fixed original conversion/terminal sequence, with no caller work or supplied checker. */
export function consumeOriginalCheckboxCompletionStage(
  owner: object,
  store: DocChannelStore,
  tx: DbTransaction
): Extract<CheckboxReceipt, { status: 'changed' }> {
  readOriginalCheckboxCompletionStage(owner, store, tx);
  const stage = originalCompletionStages.get(tx)!;
  stage.consumed = true;
  consumePreparedCheckboxConversion(store, tx, stage.phase);
  const receipt = stage.finish(tx);
  if (originalCompletionStages.get(tx) !== stage)
    throw new CheckboxEvidenceError('Original checkbox completion stage changed.');
  stage.receipt = receipt;
  return receipt;
}
/** Exact original transaction/commit/lease lookup. Returned rows are comparison data only. */
export function readOriginalCheckboxCommittedStage(
  owner: object,
  store: DocChannelStore,
  tx: DbTransaction
) {
  requireOriginalCheckboxCompletionCommitted(owner, store, tx);
  const stage = originalCompletionStages.get(tx)!;
  if (!stage.receipt)
    throw new CheckboxEvidenceError('Original committed checkbox receipt is absent.');
  return freezeCheckboxData({ intent: stage.intent, receipt: stage.receipt });
}
/** Commit recognition is written only by the original outer A transaction return. */
export function requireOriginalCheckboxCompletionCommitted(
  owner: object,
  store: DocChannelStore,
  tx: DbTransaction
): void {
  requireOriginalCheckboxCompletionOwner(owner, store);
  const own = originalCompletionStages.get(tx);
  if (!own || own.owner !== owner || own.store !== store || !own.consumed || !own.committed)
    throw new CheckboxEvidenceError('Original checkbox completion has no confirmed owning commit.');
  const constructor = originalCompletionOwners.get(owner)!;
  if (constructor.writer && constructor.coordinator) {
    const physical = validateCheckboxEvidence(own.intent).tempIdentity;
    if (!physical || !own.lease)
      throw new CheckboxEvidenceError('Original committed checkbox lease is absent.');
    requireOriginalCanonicalWriteLease(constructor.coordinator, own.lease, {
      canonicalPath: own.intent.canonicalPath,
      device: physical.device,
      inode: physical.inode,
    });
  }
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
  service?: DocChannelService;
  writer?: DocCheckboxWriteService;
  coordinator?: CanonicalFileWriteCoordinator;
}) {
  if (utilTypes.isProxy(deps) || Object.getPrototypeOf(deps) !== Object.prototype)
    throw new CheckboxEvidenceError('Checkbox completion requires own dependency data.');
  const captured = {} as typeof deps;
  const fields = Reflect.has(deps, 'service')
    ? ([
        'authority',
        'store',
        'policyLimits',
        'notifyCommitted',
        'service',
        'writer',
        'coordinator',
      ] as const)
    : (['authority', 'store', 'policyLimits', 'notifyCommitted'] as const);
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
  if (
    Reflect.has(captured, 'service') &&
    (!captured.service || !captured.writer || !captured.coordinator)
  )
    throw new CheckboxEvidenceError(
      'Native checkbox completion requires its actual writer constructor.'
    );
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
  const completionCapture: { owner?: object } = {};
  let enteredOuter = false;
  const completeInTransaction = (
    input: {
      intentId: string;
      subject: CheckboxReservationSubject;
      freshSnapshot: CheckboxAuthoritySnapshot;
      lease?: CanonicalWriteLease;
    },
    tx: DbTransaction
  ): Extract<CheckboxReceipt, { status: 'changed' }> => {
    if (originalCompletionStages.has(tx))
      throw new CheckboxEvidenceError('Original checkbox source stage cannot be reused.');
    if (deps.service && !enteredOuter)
      throw new CheckboxEvidenceError(
        'Native checkbox source requires its original outer completion.'
      );
    // The original coordinator lease is executable private custody, not port DATA.
    // Preserve it only in the owning stage; conversion validates its declared DATA.
    const phase = bridge.prepareOwnReservationConversion(
      {
        intentId: input.intentId,
        subject: input.subject,
        freshSnapshot: input.freshSnapshot,
      },
      tx
    );
    const capturedIntent = readPreparedCheckboxConversion(deps.store, tx, phase).originalIntent;
    originalCompletionStages.set(tx, {
      owner: completionCapture.owner!,
      store: deps.store,
      phase,
      finish: finishInTransaction,
      consumed: false,
      committed: false,
      lease: input.lease,
      intent: capturedIntent,
    });
    if (deps.service)
      return completeServiceOriginalCheckboxSource(deps.service, completionCapture.owner!, tx);
    try {
      return consumeOriginalCheckboxCompletionStage(completionCapture.owner!, deps.store, tx);
    } finally {
      originalCompletionStages.delete(tx);
    }
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
  const original = Object.freeze({
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
      if (enteredOuter)
        throw new CheckboxEvidenceError('Original checkbox completion is already active.');
      enteredOuter = true;
      let currentTx: DbTransaction | undefined;
      try {
        // Latch before Room construction or other configured callbacks can reenter completion.
        if (deps.service)
          prepareServiceOriginalCheckboxSource(deps.service, completionCapture.owner!);
        const committed = runCheckboxReservationTransaction(binding, (tx) => {
          currentTx = tx;
          return {
            receipt: completeInTransaction(input, tx),
            documentId: readCheckboxConvertedIntent(deps.store, tx).documentId,
          };
        });
        if (deps.service) {
          const original = originalCompletionStages.get(currentTx!);
          if (!original || original.owner !== completionCapture.owner! || !original.consumed)
            throw new CheckboxEvidenceError('Original checkbox committed scope changed.');
          original.committed = true;
          publishServiceOriginalCheckboxSource(deps.service, completionCapture.owner!, currentTx!);
        }
        try {
          sync(deps.notifyCommitted(committed.documentId));
        } catch {
          /* True committed evidence owns the public outcome. */
        }
        return committed.receipt;
      } catch (cause) {
        if (deps.service && currentTx) {
          try {
            abandonServiceOriginalCheckboxSource(deps.service, completionCapture.owner!, currentTx);
          } catch {
            /* The original source/commit cause owns this refusal, including undefined. */
          }
        }
        throw cause;
      } finally {
        if (currentTx) originalCompletionStages.delete(currentTx);
        enteredOuter = false;
      }
    },
  });
  completionCapture.owner = original;
  originalCompletionOwners.set(original, {
    store: deps.store,
    ingest,
    writer: deps.writer,
    coordinator: deps.coordinator,
  });
  return original;
}
