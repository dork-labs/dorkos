import { requireOriginalRoomResponderOwner } from './room-current-operation.js';
import {
  readOriginalCheckboxCommittedStage,
  requireOriginalCheckboxCompletionCommitted,
} from '../writes/completion.js';
import { validateCheckboxEvidence } from '../writes/checkbox-evidence.js';
import { type DbTransaction } from '@dorkos/db';
import { withCheckboxReadOnlyGate } from '../writes/authority/authority-snapshot.js';
import { requireDocChannelStoreDatabase, type DocChannelStore } from '../store.js';
import type {
  OriginalFrozenRoomSource,
  PendingRoomSource as PendingSource,
} from '../current/current-operation-types.js';
import { copyCurrentDocData } from '../current/current-operation-data.js';
import { readOriginalRoomOperationView } from './room-current-operation.js';

/** Original private room-operation responsibility; exact constructor identity is required first. */
export function retainConfirmedFreeze(
  operationOwner: object,
  pending: PendingSource,
  selector: Readonly<{ documentId: string; batchId: string; generation: string }>
): void {
  const facet = readOriginalRoomOperationView(operationOwner);
  const source = pending.source;
  if (
    selector.documentId !== source.documentId ||
    selector.batchId !== source.batchId ||
    selector.generation !== source.generation
  )
    throw new Error('Native Room freeze differs from its original custody.');
  const token: OriginalFrozenRoomSource = Object.freeze({ kind: 'original-frozen-room-source' });
  facet.frozenRoomSources.set(token, {
    engine: facet.engine,
    db: facet.db,
    facade: facet.facade,
    principals: facet.principals,
    source,
    before: pending.before,
    producerRoomFacts: pending.producerRoomFacts,
    roomCustody: pending.roomCustody,
    dueAt: pending.dueAt,
    selector: copyCurrentDocData(selector),
  });
  if (source.producerOrigin === 'operator')
    facet.originalRoomOperatorSources.set(token, {
      engine: facet.engine,
      db: facet.db,
      read: () => source,
    });
  if (source.producerOrigin === 'doc_token')
    facet.originalRoomTokenSources.set(token, {
      engine: facet.engine,
      db: facet.db,
      read: () => source,
    });
  facet.frozen.set(`${source.batchId}:${source.generation}`, token);
  facet.notifyRelay(source.documentId, source.batchId, source.generation);
}

/** Subscribe to confirmed eligible native Room identifiers, never source or claim authority. */
export function subscribeRelay(
  operationOwner: object,
  listener: (documentId: string, batchId: string, generation: string) => void
): () => void {
  const facet = readOriginalRoomOperationView(operationOwner);
  if (facet.pumpClosed) return () => {};
  if (typeof listener !== 'function') throw new Error('Room Relay listener required.');
  facet.relayListeners.add(listener);
  for (const [key, token] of [...facet.frozen]) {
    if (facet.pumpClosed || !facet.relayListeners.has(listener)) break;
    const own = facet.frozenRoomSources.get(token);
    if (
      !own ||
      facet.frozen.get(key) !== token ||
      facet.preparing.has(key) ||
      facet.preparationUnknown.has(key)
    )
      continue;
    try {
      listener(own.source.documentId, own.source.batchId, own.source.generation);
    } catch {} // Transport hints cannot replace confirmed native acceptance.
  }
  return () => {
    facet.relayListeners.delete(listener);
  };
}

/** Original private room-operation responsibility; exact constructor identity is required first. */
export function notifyRelay(
  operationOwner: object,
  documentId: string,
  batchId: string,
  generation: string
): void {
  const facet = readOriginalRoomOperationView(operationOwner);
  for (const listener of [...facet.relayListeners]) {
    if (facet.pumpClosed || !facet.relayListeners.has(listener)) continue;
    try {
      listener(documentId, batchId, generation);
    } catch {} // The owning transport retains its operational failure separately.
  }
}

/** Identifier hints revisit only this engine's retained original Room custody. */
export function hintRelay(
  operationOwner: object,
  documentId: string,
  batchId: string,
  generation: string
): boolean {
  const facet = readOriginalRoomOperationView(operationOwner);
  if (facet.pumpClosed) return false;
  if (facet.db.$client.inTransaction)
    throw new Error('Room Relay hint requires its inactive owning database.');
  for (const value of [documentId, batchId, generation])
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096) return false;
  const key = `${batchId}:${generation}`;
  if (facet.unavailable.has(key) || facet.preparing.has(key) || facet.preparationUnknown.has(key))
    return false;
  const pending = facet.pending.get(key);
  const token = facet.frozen.get(key);
  const frozen = token ? facet.frozenRoomSources.get(token) : undefined;
  if (
    frozen &&
    (frozen.engine !== facet.engine || frozen.db !== facet.db || frozen.facade !== facet.facade)
  )
    throw new Error('Room Relay hint found foreign frozen custody.');
  const source = pending?.source ?? frozen?.source;
  if (
    !source ||
    source.documentId !== documentId ||
    source.batchId !== batchId ||
    source.generation !== generation
  )
    return false;
  // IDs cannot supply a source, deadline, target or claim. Native freeze repeats
  // the original current facts; the sole scheduler still owns runtime pumping.
  facet.freezeDue();
  return true;
}

/** Earliest retained original deadline; this reveals no source or responder authority. */
export function nextDueAt(operationOwner: object): string | undefined {
  const facet = readOriginalRoomOperationView(operationOwner);
  return [...facet.pending]
    .filter(([key]) => !facet.unavailable.has(key))
    .map(([, value]) => value.dueAt)
    .sort()[0];
}

/** Wake only authentic committed custody. Native freeze repeats the original fixed SQL facts. */
export function freezeDue(operationOwner: object): void {
  const facet = readOriginalRoomOperationView(operationOwner);
  if (facet.db.$client.inTransaction)
    throw new Error('Room due wake requires its inactive owning database.');
  const now = withCheckboxReadOnlyGate(facet.db, () => facet.iso.call(new facet.Date(facet.now())));
  for (const [key, pending] of facet.pending) {
    if (facet.unavailable.has(key) || pending.dueAt > now) continue;
    facet.unavailable.add(key);
    const result = facet.facade.freezeProducerAcceptedRoomSource(pending.source);
    if (result.state !== 'confirmed') continue;
    facet.retainConfirmedFreeze(pending, result.value);
    facet.pending.delete(key);
    facet.unavailable.delete(key);
  }
}

/** Original private room-operation responsibility; exact constructor identity is required first. */
export function committed(operationOwner: object, tx: DbTransaction, now: string): void {
  const facet = readOriginalRoomOperationView(operationOwner);
  const draft = facet.drafts.get(tx);
  facet.drafts.delete(tx);
  facet.pendingLimits.delete(tx);
  if (!draft?.sealed || facet.db.$client.inTransaction)
    throw new Error('Room custody requires its confirmed outer commit.');
  if (draft.replay) {
    if (facet.pending.get(draft.replay.previousKey) !== draft.replay.previousPending)
      throw new Error('Original Room replay custody changed across commit.');
    facet.pending.delete(draft.replay.previousKey);
  }
  for (const pending of draft.sealed) {
    const key = `${pending.source.batchId}:${pending.source.generation}`;
    facet.pending.set(key, pending);
    if (Date.parse(pending.dueAt) > Date.parse(now)) continue;
    // Existing native freeze owns pending/waiting -> accepted/null-private-receipt.
    // No responder is acquired and no model dispatch occurs here.
    facet.unavailable.add(key);
    const result = facet.facade.freezeProducerAcceptedRoomSource(pending.source);
    if (result.state !== 'confirmed') facet.unavailable.add(key);
    else {
      facet.retainConfirmedFreeze(pending, result.value);
      facet.unavailable.delete(key);
      facet.pending.delete(key);
    }
  }
}

/** Original private room-operation responsibility; exact constructor identity is required first. */
export function abandoned(operationOwner: object, tx: DbTransaction): void {
  const facet = readOriginalRoomOperationView(operationOwner);
  facet.drafts.delete(tx);
  facet.pendingLimits.delete(tx);
}

/** Only the still-active original writer completion can request this fixed native optimization. */
export function cancelOriginalCheckboxUndoPair(
  operationOwner: object,
  store: DocChannelStore,
  owner: object,
  tx: DbTransaction,
  baseline: {
    generation: string;
    physical: Record<string, unknown>;
    channelBirth: Record<string, unknown>;
    now: string;
  }
): void {
  const facet = readOriginalRoomOperationView(operationOwner);
  requireOriginalRoomResponderOwner(
    facet.originalOwner,
    facet.responder,
    facet.engine,
    facet.db,
    facet.principals,
    facet.roomStore,
    facet.facade
  );
  requireDocChannelStoreDatabase(store, facet.db);
  if (facet.db.$client.inTransaction) throw new Error('Original undo cancellation cannot nest.');
  const own = readOriginalCheckboxCommittedStage(owner, store, tx);
  const evidence = validateCheckboxEvidence(own.intent);
  const committed = copyCurrentDocData({
    ...own.intent,
    status: 'committed',
    updatedAt: baseline.now,
    errorCode: null,
    evidence: { ...evidence, receipt: own.receipt },
  });
  requireOriginalCheckboxCompletionCommitted(owner, store, tx);
  // Native capture, transaction, exact CAS and commit are synchronous under the same canonical lease.
  const result = facet.facade.cancelOriginalCheckboxUndoPair({
    documentId: own.intent.documentId,
    intentId: own.intent.intentId,
    documentGeneration: baseline.generation,
    currentIntentJson: JSON.stringify(committed),
    physicalJson: JSON.stringify(baseline.physical),
    channelBirthJson: JSON.stringify(baseline.channelBirth),
  });
  requireOriginalCheckboxCompletionCommitted(owner, store, tx);
  if (result.state !== 'confirmed') return;
  for (const selector of result.value) {
    const key = `${selector.batchId}:${selector.generation}`;
    facet.unavailable.add(key);
    facet.pending.delete(key);
    facet.frozen.delete(key);
  }
}
