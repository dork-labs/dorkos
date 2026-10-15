import { readOriginalEngineViewRegistrationFacet } from './current-operation-engine.js';
import type { OriginalRoomRetirementFacet } from './room/current-room-retirement-context.js';
import type { OriginalDocumentCaptureFacet } from './projection/current-document-capture-context.js';
import type { OriginalRoomProducerFacet } from './room/current-room-producer-context.js';

/** Original Room lifecycle view registration; private engine lookup precedes every registration. */
export function registerOriginalRoomLifecycleViews(engineOwner: object): void {
  const facet = readOriginalEngineViewRegistrationFacet(engineOwner);
  const {
    MaintenanceDate,
    maintenanceNow,
    maintenanceParse,
    maintenanceIso,
    tokenScalarJson,
    tokenOwnDescriptor,
    tokenOwnKeys,
    tokenUtf8Bytes,
  } = facet;
  const { originalTokenIssues, originalTokenRevocations } = facet.tokenCustody;
  facet.custody.registerOriginalRoomProducerFacet(
    engineOwner,
    facet.freeze<OriginalRoomProducerFacet>({
      get roomPumpStopped() {
        return facet.state.roomPumpStopped;
      },
      get readTokenNativeFacts() {
        return facet.state.readTokenNativeFacts;
      },
      set readTokenNativeFacts(value) {
        facet.state.readTokenNativeFacts = value;
      },
      get tokenNativeCloseFailure() {
        return facet.state.tokenNativeCloseFailure;
      },
      set tokenNativeCloseFailure(value) {
        facet.state.tokenNativeCloseFailure = value;
      },
      retainTokenManifestOwner: (grants, store) => facet.retainTokenManifestOwner(grants, store),
      originalTokenStore: () => facet.originalTokenStore(),
      tokenStages: facet.state.tokenStages,
      originalTokenIssues,
      originalTokenRevocations,
      MaintenanceDate,
      maintenanceNow,
      maintenanceParse,
      maintenanceIso,
      tokenScalarJson,
      tokenOwnDescriptor,
      tokenOwnKeys,
      tokenUtf8Bytes,
      get tokenStore() {
        return facet.state.tokenStore;
      },
      get tokenCurrentReader() {
        return facet.state.tokenCurrentReader;
      },
      set tokenCurrentReader(value) {
        facet.state.tokenCurrentReader = value;
      },
      get tokenEventReader() {
        return facet.state.tokenEventReader;
      },
      set tokenEventReader(value) {
        facet.state.tokenEventReader = value;
      },
      get tokenSourceDependencies() {
        return facet.state.tokenSourceDependencies;
      },
      get currentEntry() {
        return facet.state.currentEntry;
      },
      set currentEntry(value) {
        facet.state.currentEntry = value;
      },
      restoredTokens: facet.state.restoredTokens,
      activeCurrent: facet.state.activeCurrent,
      scopes: facet.state.scopes,
      tokenNativeCurrent: (own) => facet.delegates.tokenNativeCurrent(own),
      prepareTokenNativeRead: (own) => facet.delegates.prepareTokenNativeRead(own),
      initializeTokenReaders: () => facet.delegates.initializeTokenReaders(),
      nativePrepare: facet.state.nativePrepare,
      fixedCurrent: (id, actor, write, tx, ready) =>
        facet.delegates.fixedCurrent(id, actor, write, tx, ready),
      operatorRows: (id, roomId, key, tx) => facet.delegates.operatorRows(id, roomId, key, tx),
      requireOperatorRows: (producer, tx) => facet.delegates.requireOperatorRows(producer, tx),
      db: facet.state.db,
      authorization: facet.state.authorization,
      fixedPorts: facet.state.fixedPorts,
      core: facet.state.core,
      get room() {
        return facet.state.room;
      },
      get tokenFileSourceReader() {
        return facet.state.tokenFileSourceReader;
      },
      set tokenFileSourceReader(value) {
        facet.state.tokenFileSourceReader = value;
      },
      preflightCurrent: (id, actor, write) => facet.delegates.preflightCurrent(id, actor, write),
      captureDocument: (store, grants, id, actor, ids, authority, source) =>
        facet.delegates.captureDocument(store, grants, id, actor, ids, authority, source),
      readDocumentAuthority: (store, grants, authority) =>
        facet.delegates.readDocumentAuthority(store, grants, authority),
      ensureRoom: () => facet.delegates.ensureRoom(),
      beginCurrent: (store, tx, id, actor, write, condition, authority) =>
        facet.delegates.beginCurrent(store, tx, id, actor, write, condition, authority),
      finalCurrent: (store, tx) => facet.delegates.finalCurrent(store, tx),
      retireCurrent: (tx) => facet.delegates.retireCurrent(tx),
    })
  );
  facet.custody.registerOriginalDocumentCaptureFacet(
    engineOwner,
    facet.freeze<OriginalDocumentCaptureFacet>({
      get roomPumpStopped() {
        return facet.state.roomPumpStopped;
      },
      get currentEntry() {
        return facet.state.currentEntry;
      },
      set currentEntry(value) {
        facet.state.currentEntry = value;
      },
      presenceLedger: facet.state.presenceLedger,
      requirePresenceFocusPreflight: (stage, store) =>
        facet.delegates.requirePresenceFocusPreflight(stage, store),
      presenceFocusStages: facet.state.presenceFocusStages,
      presenceFocusTransactions: facet.state.presenceFocusTransactions,
      documentSaves: facet.state.documentSaves,
      documentSaveCompletions: facet.state.documentSaveCompletions,
      documentAuthorities: facet.state.documentAuthorities,
      editorSelections: facet.state.editorSelections,
      scopes: facet.state.scopes,
      activeCurrent: facet.state.activeCurrent,
      editorSelectionReader: facet.state.editorSelectionReader,
      documentSaveInspections: facet.state.documentSaveInspections,
      restoredTokens: facet.state.restoredTokens,
      tokenNativeCurrent: (own) => facet.delegates.tokenNativeCurrent(own),
      requirePresenceFocus: (stage, store) => facet.delegates.requirePresenceFocus(stage, store),
      fixedCurrent: (id, actor, write, tx, ready) =>
        facet.delegates.fixedCurrent(id, actor, write, tx, ready),
      documentGrantRows: (id, tx) => facet.delegates.documentGrantRows(id, tx),
      documentScopeBaseline: (scope, dependencies) =>
        facet.delegates.documentScopeBaseline(scope, dependencies),
      checkboxCommits: facet.state.checkboxCommits,
      db: facet.state.db,
      authorization: facet.state.authorization,
      fixedPorts: facet.state.fixedPorts,
      core: facet.state.core,
      get room() {
        return facet.state.room;
      },
      get tokenFileSourceReader() {
        return facet.state.tokenFileSourceReader;
      },
      set tokenFileSourceReader(value) {
        facet.state.tokenFileSourceReader = value;
      },
      preflightCurrent: (id, actor, write) => facet.delegates.preflightCurrent(id, actor, write),
      captureDocument: (store, grants, id, actor, ids, authority, source, event) =>
        facet.delegates.captureDocument(store, grants, id, actor, ids, authority, source, event),
      readDocumentAuthority: (store, grants, authority) =>
        facet.delegates.readDocumentAuthority(store, grants, authority),
      ensureRoom: () => facet.delegates.ensureRoom(),
      beginCurrent: (store, tx, id, actor, write, condition, authority) =>
        facet.delegates.beginCurrent(store, tx, id, actor, write, condition, authority),
      finalCurrent: (store, tx) => facet.delegates.finalCurrent(store, tx),
      retireCurrent: (tx) => facet.delegates.retireCurrent(tx),
    })
  );
  facet.custody.registerOriginalRoomRetirementFacet(
    engineOwner,
    facet.freeze<OriginalRoomRetirementFacet>({
      get roomPumpStopped() {
        return facet.state.roomPumpStopped;
      },
      get readTokenNativeFacts() {
        return facet.state.readTokenNativeFacts;
      },
      set readTokenNativeFacts(value) {
        facet.state.readTokenNativeFacts = value;
      },
      get tokenNativeCloseFailure() {
        return facet.state.tokenNativeCloseFailure;
      },
      set tokenNativeCloseFailure(value) {
        facet.state.tokenNativeCloseFailure = value;
      },
      retainTokenManifestOwner: (grants, store) => facet.retainTokenManifestOwner(grants, store),
      originalTokenStore: () => facet.originalTokenStore(),
      tokenStages: facet.state.tokenStages,
      originalTokenIssues,
      originalTokenRevocations,
      MaintenanceDate,
      maintenanceNow,
      maintenanceParse,
      maintenanceIso,
      tokenScalarJson,
      tokenOwnDescriptor,
      tokenOwnKeys,
      tokenUtf8Bytes,
      get roomConstruction() {
        return facet.state.roomConstruction;
      },
      set roomConstruction(value) {
        facet.state.roomConstruction = value;
      },
      get roomConstructionFailure() {
        return facet.state.roomConstructionFailure;
      },
      set roomConstructionFailure(value) {
        facet.state.roomConstructionFailure = value;
      },
      get roomStop() {
        return facet.state.roomStop;
      },
      get roomStopStarted() {
        return facet.state.roomStopStarted;
      },
      set roomStopStarted(value) {
        facet.state.roomStopStarted = value;
      },
      get rejectRoomStop() {
        return facet.state.rejectRoomStop;
      },
      get resolveRoomStop() {
        return facet.state.resolveRoomStop;
      },
      get tokenRoomPeerClosed() {
        return facet.state.tokenRoomPeerClosed;
      },
      set tokenRoomPeerClosed(value) {
        facet.state.tokenRoomPeerClosed = value;
      },
      get currentEntry() {
        return facet.state.currentEntry;
      },
      set currentEntry(value) {
        facet.state.currentEntry = value;
      },
      get presenceFailure() {
        return facet.state.presenceFailure;
      },
      activeTokenOperations: facet.state.activeTokenOperations,
      presenceLedger: facet.state.presenceLedger,
      presenceDocuments: facet.state.presenceDocuments,
      tokenManifestOwners: facet.state.tokenManifestOwners,
      editorSelectionReader: facet.state.editorSelectionReader,
      finishRoomStop: () => facet.delegates.finishRoomStop(),
      db: facet.state.db,
      authorization: facet.state.authorization,
      fixedPorts: facet.state.fixedPorts,
      core: facet.state.core,
      get room() {
        return facet.state.room;
      },
      set room(value) {
        facet.state.room = value;
      },
      get tokenFileSourceReader() {
        return facet.state.tokenFileSourceReader;
      },
      set tokenFileSourceReader(value) {
        facet.state.tokenFileSourceReader = value;
      },
      preflightCurrent: (id, actor, write) => facet.delegates.preflightCurrent(id, actor, write),
      captureDocument: (store, grants, id, actor, ids, authority, source) =>
        facet.delegates.captureDocument(store, grants, id, actor, ids, authority, source),
      readDocumentAuthority: (store, grants, authority) =>
        facet.delegates.readDocumentAuthority(store, grants, authority),
      ensureRoom: () => facet.delegates.ensureRoom(),
      beginCurrent: (store, tx, id, actor, write, condition, authority) =>
        facet.delegates.beginCurrent(store, tx, id, actor, write, condition, authority),
      finalCurrent: (store, tx) => facet.delegates.finalCurrent(store, tx),
      retireCurrent: (tx) => facet.delegates.retireCurrent(tx),
    })
  );
}
