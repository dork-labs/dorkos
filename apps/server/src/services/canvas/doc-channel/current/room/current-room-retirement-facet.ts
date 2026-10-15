import { requireOriginalTokenDocumentManifestClosed } from '../../grant-revalidation.js';
import { CurrentRoomOperation } from '../../operations/room-current-operation.js';
import { retainDocHistory } from '../../retention.js';

import { requireDocChannelStoreDatabase, type DocChannelStore } from '../../store.js';
import { requireCurrentDocEngineOrigin } from '../../authorization.js';
import { readOriginalRoomRetirementFacet } from '../current-operation-engine.js';
/** Finish Room retirement after the original active token operations settle. */
export function finishRoomStop(owner: object): void {
  const facet = readOriginalRoomRetirementFacet(owner);
  if (!facet.roomStop || facet.roomStopStarted) return;
  facet.roomStopStarted = true;
  void Promise.allSettled([...facet.activeTokenOperations]).then(() => {
    facet.presenceLedger.stop();
    facet.presenceDocuments.clear();
    for (let index = 0; index < facet.tokenManifestOwners.length; index++) {
      const { grants, store } = facet.tokenManifestOwners[index]!;
      try {
        requireOriginalTokenDocumentManifestClosed(grants, store, facet.db);
      } catch (cause) {
        if (!facet.tokenNativeCloseFailure) facet.tokenNativeCloseFailure = { cause };
      }
    }
    try {
      facet.tokenFileSourceReader?.requireClosed();
      facet.editorSelectionReader.requireClosed();
    } catch (cause) {
      if (!facet.tokenNativeCloseFailure) facet.tokenNativeCloseFailure = { cause };
    }
    const failure =
      facet.roomConstructionFailure ?? facet.tokenNativeCloseFailure ?? facet.presenceFailure;
    const settle = () => {
      if (failure) facet.rejectRoomStop!(failure.cause);
      else facet.resolveRoomStop!();
    };
    // A token FD UNKNOWN retains its cause/Db, but never skips retirement of the independent original Room peer.
    try {
      const closing = facet.room?.stopPump();
      if (closing)
        void closing.then(
          () => {
            facet.tokenRoomPeerClosed = true;
            settle();
          },
          (cause) => {
            facet.rejectRoomStop!(failure ? failure.cause : cause);
          }
        );
      else {
        facet.tokenRoomPeerClosed = facet.roomConstructionFailure === undefined;
        settle();
      }
    } catch (cause) {
      facet.rejectRoomStop!(failure ? failure.cause : cause);
    }
  });
}
/** Lazily construct the original Room operation while retaining its first construction failure. */
export function ensureRoom(owner: object): CurrentRoomOperation | undefined {
  const facet = readOriginalRoomRetirementFacet(owner);
  if (facet.roomConstructionFailure) throw facet.roomConstructionFailure.cause;
  if (facet.roomConstruction === 'constructing')
    throw new Error('Original Room construction is already in progress.');
  if (facet.roomPumpStopped) return undefined;
  const ports = facet.fixedPorts;
  if (!facet.room && ports.roomConstruction) {
    if (!ports.nativeRuntimePrincipals || !ports.originalRoomStore)
      throw new Error('Room construction requires its genuine principal service and Store.');
    facet.roomConstruction = 'constructing';
    try {
      const room = new CurrentRoomOperation(
        facet.authorization,
        facet.core,
        facet.db,
        ports.nativeRuntimePrincipals,
        ports.originalRoomStore,
        ports.roomConstruction
      );
      facet.room = room;
      facet.roomConstruction = 'ready';
      // Accepted-source callbacks may have retired scheduling while this exact constructor ran.
      if (facet.roomPumpStopped) {
        facet.finishRoomStop();
        return undefined;
      }
    } catch (cause) {
      facet.roomConstruction = 'failed';
      facet.roomConstructionFailure = { cause };
      if (facet.roomPumpStopped) facet.finishRoomStop();
      // A partially consumed native construction is UNKNOWN and is never retried.
      throw cause;
    }
  }
  return facet.roomPumpStopped ? undefined : facet.room;
}
/** Maintain document history through the original database, engine and transaction guards. */
export function maintainHistory(owner: object, store: DocChannelStore): void {
  const facet = readOriginalRoomRetirementFacet(owner);
  requireDocChannelStoreDatabase(store, facet.db);
  requireCurrentDocEngineOrigin(facet.authorization, facet.core, facet.db);
  if (facet.db.$client.inTransaction || facet.currentEntry)
    throw new Error('Current document maintenance cannot nest.');
  facet.currentEntry = true;
  try {
    // Native eligibility uses only its constructor-owned package clock. This
    // captured host timestamp applies solely to ordinary Doc retention.
    const now = Reflect.apply(
      facet.maintenanceIso,
      new facet.MaintenanceDate(Reflect.apply(facet.maintenanceNow, facet.MaintenanceDate, [])),
      []
    );
    facet.ensureRoom()?.pruneSettledReceipts();
    requireDocChannelStoreDatabase(store, facet.db);
    if (facet.db.$client.inTransaction)
      throw new Error('Native pruning left an active transaction.');
    retainDocHistory(store, now);
  } finally {
    facet.currentEntry = false;
  }
}
