import {
  readOriginalDocumentFileSaveCurrent,
  requireOriginalDocumentFileSaveCompleted,
} from '../../writes/installation-file-writes.js';
import { sameOriginalDocTokenData } from '../../tokens/token-native-comparison.js';
import {
  readCurrentDocAccessRows,
  auditCurrentDocFinalRows,
  readCurrentGrantSourceRows,
} from '../current-operation-row-audit.js';
import { readCurrentDocBirthRows } from '../current-operation-intentions.js';
import {
  captureNativePrincipalTime,
  readCurrentNativePrincipal,
} from '../../../../connectors/principal/runtime-principal-service.js';
import { type DbTransaction } from '@dorkos/db';
import { isServerPrincipal } from '../../../../connectors/principal/server-principal.js';
import { requireDocChannelStoreDatabase, type DocChannelStore } from '../../store.js';
import {
  captureCurrentDocumentGrantDependencies,
  documentDependenciesBeforeOriginalGrantInsertion,
  requireCurrentDocumentGrantFinal,
} from '../../grant-revalidation.js';
import {
  withCheckboxReadOnlyGate,
  checkboxAuthoritySync,
} from '../../writes/authority/authority-snapshot.js';
import { copyCurrentDocData, sameCurrentDocData } from '../current-operation-data.js';
import { DocIngestRefusal } from '../../ingest-data/ingest-types.js';
import { type CurrentOperationScope, type DocEventCondition } from '../current-operation-types.js';
import {
  DocChannelNotFoundError,
  DocChannelArchivedError,
  requireCurrentDocEngineOrigin,
  type DocChannelActor,
} from '../../authorization.js';
import { readOriginalCurrentEntryFacet } from '../current-operation-engine.js';
/** Read the current grant source rows without the mutable document sequence metadata. */
export function documentGrantRows(owner: object, documentId: string, tx: DbTransaction): unknown {
  readOriginalCurrentEntryFacet(owner);
  const rows = readCurrentGrantSourceRows(documentId, tx);
  const {
    nextDocSeq: _seq,
    updatedAt: _updated,
    receiptRetentionFloor: _floor,
    ...channelIdentity
  } = rows.channel;
  return copyCurrentDocData({ ...rows, channel: channelIdentity });
}
/** Build the original scope baseline from its captured document dependencies. */
export function documentScopeBaseline(
  owner: object,
  scope: CurrentOperationScope,
  dependencies: unknown
): unknown {
  readOriginalCurrentEntryFacet(owner);
  const {
    nextDocSeq: _seq,
    updatedAt: _updated,
    receiptRetentionFloor: _floor,
    ...channelIdentity
  } = scope.channelRow;
  return copyCurrentDocData({
    physical: scope.physicalRow,
    channel: channelIdentity,
    scope: scope.scope,
    dependencies,
  });
}
/** Check the document actor and requested access against the original current source. */
export function fixedCurrent(
  owner: object,
  documentId: string,
  actor: DocChannelActor,
  write: boolean,
  tx: DbTransaction | undefined,
  ready: boolean
): { id: string; scope: string } {
  const facet = readOriginalCurrentEntryFacet(owner);
  if (
    !isServerPrincipal(actor.principal) ||
    typeof facet.fixedPorts.principalCurrent !== 'function' ||
    checkboxAuthoritySync(facet.fixedPorts.principalCurrent(actor.principal)) !== true
  )
    throw new DocChannelNotFoundError();
  const claims = actor.principal.claims;
  if (checkboxAuthoritySync(facet.fixedPorts.ownsInstallation(claims)) !== true)
    throw new DocChannelNotFoundError();
  const result = readCurrentDocAccessRows(
    tx ?? facet.db,
    documentId,
    actor.principal,
    actor.surface,
    ready
  );
  if (result.roomId !== undefined) {
    const membership = checkboxAuthoritySync(
      facet.fixedPorts.roomMembership(result.roomId, claims)
    );
    if (!membership) throw new DocChannelNotFoundError();
    if (write && membership.archived) throw new DocChannelArchivedError();
  }
  return { id: result.id, scope: result.scope };
}

/** Run the original asynchronous document currentness preflight before admission. */
export async function preflightCurrent(
  owner: object,
  documentId: string,
  actor: DocChannelActor,
  write: boolean
): Promise<void> {
  const facet = readOriginalCurrentEntryFacet(owner);
  requireCurrentDocEngineOrigin(facet.authorization, facet.core, facet.db);
  const db = facet.db;
  withCheckboxReadOnlyGate(db, () => facet.fixedCurrent(documentId, actor, write, undefined, true));
  if (
    actor.principal.claims.kind === 'runtime' &&
    facet.fixedPorts.revalidateRuntime &&
    !(await facet.fixedPorts.revalidateRuntime(actor.principal))
  )
    throw new DocChannelNotFoundError();
  withCheckboxReadOnlyGate(db, () => facet.fixedCurrent(documentId, actor, write, undefined, true));
}
/** Enter the original document transaction scope after its actor and source checks. */
export function beginCurrent(
  owner: object,
  store: DocChannelStore,
  tx: DbTransaction,
  documentId: string,
  actor: DocChannelActor,
  write: boolean,
  requestedCondition: DocEventCondition | 'server-initial-replay',
  documentAuthority?: import('../current-operation-types.js').OriginalCurrentDocumentAuthority
): CurrentOperationScope {
  const facet = readOriginalCurrentEntryFacet(owner);
  requireCurrentDocEngineOrigin(facet.authorization, facet.core, facet.db);
  const db = facet.db;
  requireDocChannelStoreDatabase(store, db);
  if (facet.currentEntry || db.$client.inTransaction !== true || facet.scopes.has(tx))
    throw new Error('Current document operation requires its inactive genuine entry.');
  const identity = withCheckboxReadOnlyGate(db, () =>
    facet.fixedCurrent(documentId, actor, write, tx, true)
  );
  const rows = readCurrentDocBirthRows(tx, documentId);
  if (!rows) throw new DocChannelNotFoundError();
  const { physical, channel, birth, generation } = rows;
  // Only the private initial replay derives its own birth; submit/inspect remain condition-required.
  const condition =
    requestedCondition === 'server-initial-replay'
      ? Object.freeze({ expectedGeneration: generation })
      : requestedCondition;
  if (condition.expectedGeneration !== generation)
    throw new DocIngestRefusal('DOC_GENERATION_CHANGED', 409);
  const scope: CurrentOperationScope = {
    authorization: facet.authorization,
    engine: facet.core,
    db: facet.db,
    store,
    actor,
    documentId: identity.id,
    scope: identity.scope,
    write,
    birth,
    generation,
    physicalRow: copyCurrentDocData(physical),
    channelRow: copyCurrentDocData(channel),
    capturedFloor: channel.receiptRetentionFloor,
    condition,
    documentAuthority,
    absentAdmission: false,
  };
  if (documentAuthority) {
    const own = facet.documentAuthorities.get(documentAuthority);
    if (
      !own ||
      own.store !== store ||
      own.documentId !== documentId ||
      own.actor.principal !== actor.principal
    )
      throw new DocChannelNotFoundError();
    const dependencies = captureCurrentDocumentGrantDependencies(
      own.grants,
      store,
      documentId,
      own.actor,
      own.grantIds,
      tx,
      own.writeObservation
    );
    const priorDependencies = documentDependenciesBeforeOriginalGrantInsertion(
      own.grants,
      store,
      documentId,
      own.actor,
      own.grantIds,
      tx,
      dependencies
    );
    if (!sameCurrentDocData(own.baseline, facet.documentScopeBaseline(scope, priorDependencies)))
      throw new DocChannelNotFoundError();
    scope.documentGrantRows = facet.documentGrantRows(documentId, tx);
    scope.documentGrantSelection = {
      grants: own.grants,
      ids: own.grantIds,
      writeObservation: own.writeObservation,
    };
  }
  facet.currentEntry = true;
  facet.activeCurrent.add(tx);
  facet.scopes.set(tx, scope);
  return scope;
}
/** Recheck the original transaction scope and document source before completion. */
export function finalCurrent(owner: object, store: DocChannelStore, tx: DbTransaction): void {
  const facet = readOriginalCurrentEntryFacet(owner);
  const own = facet.scopes.get(tx);
  const db = facet.db;
  if (
    !own ||
    own.authorization !== facet.authorization ||
    own.store !== store ||
    !facet.activeCurrent.has(tx) ||
    !facet.currentEntry ||
    !db.$client.inTransaction
  )
    throw new Error('Current document operation is foreign or retired.');
  if (own.failure) throw own.failure.cause;
  requireDocChannelStoreDatabase(store, db);
  const checked = withCheckboxReadOnlyGate(db, () => {
    if (own.tokenScope) {
      const token = facet.restoredTokens.get(own.tokenScope);
      if (!token || token.store !== store || token.grants !== own.grants)
        throw new DocChannelNotFoundError();
      const current = facet.tokenNativeCurrent(token);
      if (
        current.header.documentId !== own.documentId ||
        current.header.generation !== own.generation ||
        !sameOriginalDocTokenData(current.data.grantIds, own.tokenGrantIds)
      )
        throw new DocChannelNotFoundError();
      return { id: current.header.documentId, scope: current.header.scope };
    }
    if (!own.actor) throw new DocChannelNotFoundError();
    const service = facet.fixedPorts.nativeRuntimePrincipals;
    const result = facet.fixedCurrent(own.documentId, own.actor, own.write, tx, true);
    if (own.documentGrantSelection) {
      const selection = own.documentGrantSelection;
      // Complete selected-grant policy before the final configured-time/read-only phase.
      captureCurrentDocumentGrantDependencies(
        selection.grants,
        store,
        own.documentId,
        own.actor,
        selection.ids,
        tx,
        selection.writeObservation
      );
    }
    const time =
      own.actor.principal.claims.kind === 'runtime' && service
        ? captureNativePrincipalTime(service, db, own.actor.principal)
        : undefined;
    if (own.documentGrantSelection) {
      const selection = own.documentGrantSelection;
      requireCurrentDocumentGrantFinal(selection.grants, store, own.documentId, selection.ids, tx);
    }
    if (
      own.actor.principal.claims.kind === 'runtime' &&
      (!service ||
        time === undefined ||
        !readCurrentNativePrincipal(service, db, own.actor.principal, tx, time))
    )
      throw new DocChannelNotFoundError();
    return result;
  });
  const presenceFocus = facet.presenceFocusTransactions.get(tx);
  if (presenceFocus) facet.requirePresenceFocus(presenceFocus, store);
  const selection = facet.editorSelections.get(tx);
  if (selection) {
    if (
      !selection.fileSource.canonicalFile ||
      !own.documentAuthority ||
      !sameCurrentDocData(
        selection.source,
        facet.editorSelectionReader.read(selection.fileSource.canonicalFile, selection.request)
      )
    )
      throw new DocChannelNotFoundError();
  }
  const duplicateSave = facet.documentSaveInspections.get(tx);
  if (duplicateSave) {
    const actual = readOriginalDocumentFileSaveCurrent(duplicateSave.scope, facet.db, store);
    if (
      actual.path !== duplicateSave.path ||
      !sameCurrentDocData(actual.request, duplicateSave.request)
    )
      throw new DocChannelNotFoundError();
    facet.editorSelectionReader.readFile(duplicateSave.path, duplicateSave.hash);
  }
  const saved = facet.documentSaveCompletions.get(tx);
  if (saved) {
    requireOriginalDocumentFileSaveCompleted(saved.scope, facet.db, store, saved.hash);
    facet.editorSelectionReader.readFile(saved.path, saved.hash);
  }
  // Fixed readonly SQL/data comparison only; no callback, clock or await follows.
  auditCurrentDocFinalRows(tx, own, checked);
  if (own.documentAuthority) {
    const captured = facet.documentAuthorities.get(own.documentAuthority);
    if (
      !captured ||
      captured.store !== store ||
      !sameCurrentDocData(own.documentGrantRows, facet.documentGrantRows(own.documentId, tx))
    )
      throw new DocChannelNotFoundError();
  }
}
/** Remove the original transaction from its private current-operation observations. */
export function retireCurrent(owner: object, tx: DbTransaction): void {
  const facet = readOriginalCurrentEntryFacet(owner);
  facet.presenceFocusTransactions.delete(tx);
  facet.editorSelections.delete(tx);
  facet.documentSaveInspections.delete(tx);
  facet.documentSaveCompletions.delete(tx);
  facet.scopes.delete(tx);
  facet.activeCurrent.delete(tx);
  facet.currentEntry = false;
}
