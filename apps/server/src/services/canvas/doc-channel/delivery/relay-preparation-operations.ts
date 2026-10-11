import type { OriginalFrozenRelayDocumentSource } from './relay-native-types.js';
import { eq, sessionMessageAcceptanceReceipts, type DbTransaction } from '@dorkos/db';

import { type DocBatchRow } from '../store.js';

import {
  readDocBatchAuthority,
  docBatchDigest,
  verifyDocReceipt,
  refuseDocBatch,
  type DocBatchAuthority,
} from './batch-authority.js';

import { readOriginalRelayPreparationView } from './relay-authority.js';
import type { RoomWakeIdentity } from './relay-preparation-context.js';
/** Original installation-owned requireRoomIdentity operation. */
export function requireRoomIdentity(
  owner: object,
  batch: DocBatchRow,
  expected?: RoomWakeIdentity,
  tx?: DbTransaction
) {
  const view = readOriginalRelayPreparationView(owner);
  const { originalGrantStore } = view;
  const storedGrant = originalGrantStore?.getGrant(batch.grantId, tx);
  if (
    !storedGrant ||
    storedGrant.documentId !== batch.documentId ||
    storedGrant.routeId !== batch.routeId ||
    storedGrant.revision !== batch.grantRevision ||
    (storedGrant.normalizedRoute as { to?: string }).to !== 'room:self' ||
    (expected &&
      (batch.documentId !== expected.documentId ||
        (expected.openerAgentId !== undefined &&
          storedGrant.openerAgentId !== expected.openerAgentId) ||
        (expected.targetAgentId !== undefined &&
          storedGrant.targetAgentId !== expected.targetAgentId)))
  )
    refuseDocBatch('document_relay_source_changed');
}
/** Original installation-owned readRoomWake operation. */
export function readRoomWake(
  owner: object,
  batchId: string,
  generation: string,
  expected?: RoomWakeIdentity
) {
  const view = readOriginalRelayPreparationView(owner);
  const { access, originalStore, originalGrants, roomDue } = view;
  access.requireOpen();
  const before = originalStore.getBatch(batchId);
  if (!before || before.generation !== generation || !before.scope.startsWith('room:'))
    refuseDocBatch('document_batch_changed');
  requireRoomIdentity(owner, before, expected);
  // Native Room owns progress independently. A late identifier cannot relaunch it.
  if (
    [
      'dispatching',
      'turn_started',
      'turn_done',
      'failed',
      'cancelled',
      'in_doubt',
      'expired',
    ].includes(before.status)
  )
    return undefined;
  originalGrants.refreshGrantedAuthority(before.grantId);
  return originalStore.transaction((tx) => {
    const batch = originalStore.getBatch(batchId, tx);
    if (!batch || batch.generation !== generation || !batch.scope.startsWith('room:'))
      refuseDocBatch('document_batch_changed');
    requireRoomIdentity(owner, batch, expected, tx);
    if (
      [
        'dispatching',
        'turn_started',
        'turn_done',
        'failed',
        'cancelled',
        'in_doubt',
        'expired',
      ].includes(batch.status)
    )
      return undefined;
    if (!['pending', 'waiting', 'accepted'].includes(batch.status))
      refuseDocBatch('document_batch_changed');
    const { grant, target } = originalGrants.revalidateBatchGrant(batch, tx);
    if (
      (grant.normalizedRoute as { to?: string }).to !== 'room:self' ||
      target.scope !== batch.scope ||
      !grant.openerAgentId ||
      !target.agentId ||
      !roomDue
    )
      refuseDocBatch('document_relay_native_target_unavailable');
    access.requireExplicitOpenerAccess(grant.openerAgentId, target.agentId);
    return { batch, grant, target };
  });
}

/** Only the owning source transaction may reread its accepted generation and private receipt. */
export function readAccepted(
  owner: object,
  tx: DbTransaction,
  batchId: string,
  generation: string
): DocBatchAuthority {
  const view = readOriginalRelayPreparationView(owner);
  const { access, originalStore, originalGrants, native } = view;
  access.requireOpen();
  const batch = originalStore.getBatch(batchId, tx);
  if (!batch || batch.generation !== generation || batch.status !== 'accepted')
    refuseDocBatch('document_batch_changed');
  const authority = readDocBatchAuthority(originalStore, originalGrants, tx, batch);
  // readDocBatchAuthority already revalidates the approved exact target, immutable input,
  // current origin membership and grant. This additional check never widens its result.
  if (!authority.grant.openerAgentId || !authority.target.agentId)
    refuseDocBatch('document_relay_opener_required');
  access.requireExplicitOpenerAccess(authority.grant.openerAgentId, authority.target.agentId);
  if (!batch.admissionReceiptId) refuseDocBatch('document_receipt_missing');
  const receipt = tx
    .select()
    .from(sessionMessageAcceptanceReceipts)
    .where(eq(sessionMessageAcceptanceReceipts.id, batch.admissionReceiptId))
    .get();
  if (!receipt) refuseDocBatch('document_receipt_missing');
  if (
    receipt.state !== 'accepted' ||
    receipt.dispatchAttemptId !== null ||
    receipt.dispatchBootEpoch !== null ||
    receipt.dispatchClaimedAt !== null ||
    receipt.turnStartSeq !== null ||
    receipt.turnStartedAt !== null ||
    receipt.settledAt !== null ||
    receipt.settleOutcome !== null ||
    receipt.cancellationCode !== null
  )
    refuseDocBatch('document_receipt_already_claimed');
  verifyDocReceipt(authority, receipt);
  return authority;
}

// This captured read is an internal source prerequisite, not an ingress/claim/charge token.
// The pending native operation and source+receipt+charge CAS must still run before dispatch.
/** Original installation-owned currentAccepted operation. */
export function currentAccepted(
  owner: object,
  batchId: string,
  generation: string
): DocBatchAuthority {
  const view = readOriginalRelayPreparationView(owner);
  const { access, originalStore, originalGrants } = view;
  access.requireOpen();
  const initial = originalStore.getBatch(batchId);
  if (!initial || initial.generation !== generation) refuseDocBatch('document_batch_changed');
  originalGrants.refreshGrantedAuthority(initial.grantId);
  return originalStore.transaction((tx) => readAccepted(owner, tx, batchId, generation));
}
/** Original installation-owned prepareOriginalNativeSource operation. */
export function prepareOriginalNativeSource(
  owner: object,
  batchId: string,
  generation: string
): OriginalFrozenRelayDocumentSource {
  const view = readOriginalRelayPreparationView(owner);
  const {
    access,
    originalStore,
    originalGrants,
    nativePrincipals,
    ownDb,
    serverNativeRelayConstruction,
    adapter,
    native,
    originalRelaySources,
  } = view;
  if (!nativePrincipals || !ownDb || !serverNativeRelayConstruction || !adapter || !native)
    throw new Error('Original Relay native principal/installed adapter assembly unavailable.');
  const authority = currentAccepted(owner, batchId, generation),
    digest = docBatchDigest(authority);
  const token: OriginalFrozenRelayDocumentSource = Object.freeze({
    kind: 'original-frozen-relay-document-source',
  });
  const { batch, grant, target } = authority;
  if (!target.sessionId || !target.agentId || !target.runtime || !target.agentPath)
    refuseDocBatch('document_relay_native_target_unavailable');
  const facts = native.capture(
    {
      batchId: batch.batchId,
      generation: batch.generation,
      documentId: batch.documentId,
      routeId: batch.routeId,
      scope: batch.scope,
      grantId: grant.grantId,
      grantRevision: grant.revision,
      sessionId: target.sessionId,
      agentId: target.agentId,
      runtime: target.runtime,
      agentPath: target.agentPath,
      authorityDigest: digest,
    },
    new Date().toISOString()
  );
  originalRelaySources.set(token, {
    db: ownDb!,
    adapter,
    principals: nativePrincipals,
    authority,
    digest,
    native,
    facts,
    access,
    requireGranted: () => originalGrants.refreshGrantedAuthority(grant.grantId),
    refresh: () => currentAccepted(owner, batchId, generation),
  });
  return token;
}

/** Original installed receipt wake, guarded by the private installation key. */
export function wakeOriginalPreparedRelayReceipts(
  owner: object,
  sessionId: string,
  receiptIds: readonly string[]
) {
  const view = readOriginalRelayPreparationView(owner);
  const { originalStore, originalGrants, access, pendingWakes, rememberSinkFailure } = view;
  if (view.stopped) throw new Error('Original installed Relay source stopped');
  if (receiptIds.length > 100 || new Set(receiptIds).size !== receiptIds.length)
    throw new RangeError('Original Relay receipt selection differs');
  const selectedIds = Object.freeze([...receiptIds]);
  // Own the promise before any protected publisher/subscriber can reenter.
  const work = Promise.resolve()
    .then(async () => {
      if (view.stopped) throw new Error('Original installed Relay source stopped');
      const ordinary: string[] = [];
      for (const id of selectedIds) {
        const selected = originalStore.transaction((tx) => {
          const receipt = tx
            .select()
            .from(sessionMessageAcceptanceReceipts)
            .where(eq(sessionMessageAcceptanceReceipts.id, id))
            .get();
          if (
            !receipt ||
            receipt.sourceKind !== 'document_event_batch' ||
            receipt.sessionId !== sessionId
          )
            throw new Error('Original Relay receipt destination differs');
          // A concurrently committed native claim must not be fed to the generic pump.
          if (receipt.state !== 'accepted') return undefined;
          const batch = originalStore.getBatch(receipt.sourceId, tx);
          if (
            !batch ||
            batch.generation !== receipt.sourceGeneration ||
            batch.admissionReceiptId !== id
          )
            throw new Error('Original Relay receipt/source link differs');
          return {
            batchId: batch.batchId,
            generation: batch.generation,
            grantId: batch.grantId,
          };
        });
        if (!selected) continue;
        // Original grant maintenance occurs outside SQL, just as in original admission.
        originalGrants.refreshGrantedAuthority(selected.grantId);
        const authority = originalStore.transaction((tx) => {
          const batch = originalStore.getBatch(selected.batchId, tx);
          if (!batch || batch.generation !== selected.generation || batch.status !== 'accepted')
            throw new Error('Original Relay accepted source changed');
          const current = readDocBatchAuthority(originalStore, originalGrants, tx, batch);
          const receipt = tx
            .select()
            .from(sessionMessageAcceptanceReceipts)
            .where(eq(sessionMessageAcceptanceReceipts.id, id))
            .get();
          if (!receipt || receipt.state !== 'accepted')
            throw new Error('Original Relay receipt changed');
          verifyDocReceipt(current, receipt);
          return current;
        });
        if (
          !authority.grant.openerAgentId ||
          authority.target.runtime !== 'claude-code' ||
          !authority.target.agentId ||
          authority.batch.scope.startsWith('room:')
        ) {
          ordinary.push(id);
          continue;
        }
        // Fixed native assembly owns this source. Full original ACL/currentness is reread
        // before protected publication; DeliveredTo is not the exclusion/claim authority.
        const current = currentAccepted(owner, selected.batchId, selected.generation);
        await access.publishAcceptedDocumentWake({
          documentId: current.batch.documentId,
          batchId: current.batch.batchId,
          generation: current.batch.generation,
          openerAgentId: current.grant.openerAgentId!,
          targetAgentId: current.target.agentId!,
        });
      }
      return Object.freeze(ordinary);
    })
    .catch((cause) => {
      if (!view.wakeFailed) {
        view.wakeFailed = true;
        view.firstWakeCause = cause;
        rememberSinkFailure(cause);
      }
      throw cause;
    });
  pendingWakes.add(work);
  void work.then(
    () => pendingWakes.delete(work),
    () => pendingWakes.delete(work)
  );
  return work;
}
