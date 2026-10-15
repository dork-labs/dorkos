import { readOriginalEngineViewRegistrationFacet } from './current-operation-engine.js';
import type { OriginalCurrentEntryFacet } from './projection/current-entry-context.js';
import type { OriginalEditorSaveSelectionFacet } from './projection/current-editor-save-selection-context.js';
import type { OriginalTokenNativeInputFacet } from './token/current-token-native-input-context.js';
import type { OriginalTokenIssuanceFacet } from './token/current-token-issuance-context.js';

/** Original token and current-entry view registration; private engine lookup precedes every registration. */
export function registerOriginalTokenEntryViews(engineOwner: object): void {
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
  facet.custody.registerOriginalTokenIssuanceFacet(
    engineOwner,
    facet.freeze<OriginalTokenIssuanceFacet>({
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
  facet.custody.registerOriginalTokenNativeInputFacet(
    engineOwner,
    facet.freeze<OriginalTokenNativeInputFacet>({
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
  facet.custody.registerOriginalEditorSaveSelectionFacet(
    engineOwner,
    facet.freeze<OriginalEditorSaveSelectionFacet>({
      get roomPumpStopped() {
        return facet.state.roomPumpStopped;
      },
      get currentEntry() {
        return facet.state.currentEntry;
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
      editorSelectionReader: facet.state.editorSelectionReader,
      submitCurrent: (...args) => facet.delegates.submitCurrent(...args),
      inspectCurrent: (...args) => facet.delegates.inspectCurrent(...args),
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
  facet.custody.registerOriginalCurrentEntryFacet(
    engineOwner,
    facet.freeze<OriginalCurrentEntryFacet>({
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
}
