import { readOriginalEngineViewRegistrationFacet } from './current-operation-engine.js';
import type { OriginalMountedPresenceFacet } from './presence/current-mounted-presence-context.js';
import type { OriginalEventAdmissionFacet } from './projection/current-event-admission-context.js';
import type { OriginalPresenceExpiryFacet } from './presence/current-presence-expiry-context.js';
import type { OriginalReadProjectionFacet } from './projection/current-read-projection-context.js';
import type { OriginalExpiredReplayFacet } from './replay/current-expired-replay-context.js';
import type { OriginalTokenStreamFacet } from './token/current-token-stream-facet.js';

/** Original read and presence view registration; private engine lookup precedes every registration. */
export function registerOriginalReadPresenceViews(engineOwner: object): void {
  const facet = readOriginalEngineViewRegistrationFacet(engineOwner);
  const { tokenStreamDelay, tokenStreamCancel } = facet;
  const { originalPresenceAppends } = facet.tokenCustody;
  facet.custody.registerOriginalTokenStreamFacet(
    engineOwner,
    facet.freeze<OriginalTokenStreamFacet>({
      tokenStreams: facet.state.tokenStreams,
      liveTokenStreams: facet.state.liveTokenStreams,
      readTokenReplay: (scope, since, limit, permission) =>
        facet.delegates.readTokenReplay(scope, since, limit, permission),
      roomPumpStopped: () => facet.state.roomPumpStopped,
      delay: tokenStreamDelay,
      cancel: tokenStreamCancel,
    })
  );
  facet.custody.registerOriginalExpiredReplayFacet(
    engineOwner,
    facet.freeze<OriginalExpiredReplayFacet>({
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
  facet.custody.registerOriginalReadProjectionFacet(
    engineOwner,
    facet.freeze<OriginalReadProjectionFacet>({
      get currentEntry() {
        return facet.state.currentEntry;
      },
      get tokenSourceDependencies() {
        return facet.state.tokenSourceDependencies;
      },
      get managementReader() {
        return facet.state.managementReader;
      },
      set managementReader(value) {
        facet.state.managementReader = value;
      },
      documentSaveInspections: facet.state.documentSaveInspections,
      retainTokenManifestOwner: (grants, store) => facet.retainTokenManifestOwner(grants, store),
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
  facet.custody.registerOriginalPresenceExpiryFacet(
    engineOwner,
    facet.freeze<OriginalPresenceExpiryFacet>({
      db: facet.state.db,
      authorization: facet.state.authorization,
      fixedPorts: facet.state.fixedPorts,
      core: facet.state.core,
      presenceDocuments: facet.state.presenceDocuments,
      presenceLedger: facet.state.presenceLedger,
      nativePrepare: facet.state.nativePrepare,
      presenceNow: facet.state.presenceNow,
      get roomPumpStopped() {
        return facet.state.roomPumpStopped;
      },
      get currentEntry() {
        return facet.state.currentEntry;
      },
      set currentEntry(value) {
        facet.state.currentEntry = value;
      },
      schedulePresence: () => facet.schedulePresence(),
    })
  );
  facet.custody.registerOriginalEventAdmissionFacet(
    engineOwner,
    facet.freeze<OriginalEventAdmissionFacet>({
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
  facet.custody.registerOriginalMountedPresenceFacet(
    engineOwner,
    facet.freeze<OriginalMountedPresenceFacet>({
      get roomPumpStopped() {
        return facet.state.roomPumpStopped;
      },
      get currentEntry() {
        return facet.state.currentEntry;
      },
      presenceLedger: facet.state.presenceLedger,
      presenceDocuments: facet.state.presenceDocuments,
      presenceFocusStages: facet.state.presenceFocusStages,
      presenceFailures: facet.state.presenceFailures,
      presenceNow: facet.state.presenceNow,
      schedulePresence: () => facet.schedulePresence(),
      originalPresenceAppends,
      submitCurrent: (...args) => facet.delegates.submitCurrent(...args),
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
