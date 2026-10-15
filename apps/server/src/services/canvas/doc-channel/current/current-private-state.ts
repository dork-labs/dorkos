import { type TokenStreamState } from './token/current-token-stream-facet.js';
import { createOriginalDocPresenceLedger, type PresencePlan } from '../presence.js';
import { createOriginalEditorSelectionReader } from '../editor/selection-source.js';
import { createOriginalDocManagementReader } from '../management/snapshot-data.js';
import { createOriginalDocTokenFileSourceReader } from '../tokens/token-native-file-source.js';
import { createOriginalDocTokenCurrentReader } from '../tokens/token-native-current.js';
import { createOriginalDocTokenEventReader } from '../tokens/token-native-reads.js';
import type { OriginalDocTokenNativeFacts } from '../tokens/token-native-facts.js';
import { DocChannelTokenStore } from '../tokens/token-store.js';
import { CurrentRoomOperation } from '../operations/room-current-operation.js';
import { type Db, type DbTransaction } from '@dorkos/db';
import { type DocChannelStore } from '../store.js';
import { type DocChannelIngest } from '../ingest.js';
import { type DocChannelGrants } from '../grants.js';
import {
  type CurrentOperationScope,
  type CurrentDocOperationEngineCore,
} from './current-operation-types.js';
import {
  type DocChannelAuthorization,
  type DocChannelActor,
  type DocChannelAuthorityPorts,
} from '../authorization.js';

import type { PrivateCurrentEngineState } from './current-private-state-types.js';

/** Allocate only unrelated per-construction data/cells; the original private engine alone retains its actual state. */
function allocatePrivateCurrentEngineState(): PrivateCurrentEngineState {
  const documentSaves = new WeakMap<
    object,
    {
      store: DocChannelStore;
      grants: DocChannelGrants;
      actor: DocChannelActor;
      request: import('@dorkos/shared/schemas').CanvasDocumentSaveIdentity;
      authority: import('./current-operation-types.js').OriginalCurrentDocumentAuthority;
      fileSource: import('../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
      event: import('@dorkos/shared/canvas-channel-schemas').StoredPageEvent;
      hash: string;
      consumed: boolean;
    }
  >();
  const documentSaveInspections = new WeakMap<
    DbTransaction,
    {
      scope: object;
      request: import('@dorkos/shared/schemas').CanvasDocumentSaveIdentity;
      hash: string;
      path: string;
    }
  >();
  const documentSaveCompletions = new WeakMap<
    DbTransaction,
    { scope: object; hash: string; path: string }
  >();
  let tokenSourceDependencies:
    | {
        service: import('../service.js').DocChannelService;
        store: DocChannelStore;
        grants: DocChannelGrants;
      }
    | undefined;
  const restoredTokens = new WeakMap<
    import('./current-operation-types.js').OriginalNativeDocTokenScope,
    { store: DocChannelStore; grants: DocChannelGrants; hash: string }
  >();
  let tokenFileSourceReader: ReturnType<typeof createOriginalDocTokenFileSourceReader> | undefined;
  let tokenCurrentReader: ReturnType<typeof createOriginalDocTokenCurrentReader> | undefined;
  let tokenEventReader: ReturnType<typeof createOriginalDocTokenEventReader> | undefined;
  let managementReader: ReturnType<typeof createOriginalDocManagementReader> | undefined;
  let tokenStore: DocChannelTokenStore | undefined;
  let readTokenNativeFacts: ((documentId: string) => OriginalDocTokenNativeFacts) | undefined;
  const activeTokenOperations = new Set<Promise<unknown>>();
  const presenceLedger = createOriginalDocPresenceLedger();
  const presenceDocuments = new Map<
    string,
    {
      store: DocChannelStore;
      actor: DocChannelActor;
      birth: CurrentOperationScope['birth'];
      scope: string;
      callers: Map<string, DocChannelActor>;
    }
  >();
  const presenceNow = Date.now.bind(Date);
  const presenceSetTimeout = setTimeout;
  const presenceClearTimeout = clearTimeout;
  let presenceTimer!: ReturnType<typeof setTimeout> | undefined;
  let presenceTail: Promise<void> = Promise.resolve();
  let presenceFailure!: { cause: unknown } | undefined;
  const presenceFailures = new Map<string, { cause: unknown }>();
  const presenceFocusStages = new WeakMap<
    object,
    {
      store: DocChannelStore;
      ingest: DocChannelIngest;
      grants: DocChannelGrants;
      actor: DocChannelActor;
      plan: PresencePlan;
      caller: string;
      event: import('@dorkos/shared/canvas-channel-schemas').StoredPageEvent;
      fileSource: import('../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
    }
  >();
  const presenceFocusTransactions = new WeakMap<DbTransaction, object>();
  const tokenStreams = new WeakMap<
    import('./current-operation-types.js').OriginalNativeDocTokenStream,
    TokenStreamState
  >();
  const liveTokenStreams = new Set<TokenStreamState>();
  let tokenRoomPeerClosed = false;
  const tokenManifestOwners: { grants: DocChannelGrants; store: DocChannelStore }[] = [];
  let tokenNativeCloseFailure!: { cause: unknown } | undefined;
  const tokenStages = new WeakMap<
    import('./current-operation-types.js').OriginalDocTokenIssuanceStage,
    {
      store: DocChannelStore;
      grants: DocChannelGrants;
      authority: import('./current-operation-types.js').OriginalCurrentDocumentAuthority;
      state: 'prepared' | 'committing' | 'retired';
      fileSource: import('../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
    }
  >();
  let nativePrepare!: Db['$client']['prepare'];
  const documentAuthorities = new WeakMap<
    import('./current-operation-types.js').OriginalCurrentDocumentAuthority,
    {
      store: DocChannelStore;
      grants: DocChannelGrants;
      actor: DocChannelActor;
      documentId: string;
      grantIds: readonly string[];
      writeObservation?: import('../grant-policy.js').DocOriginalWriteObservation;
      baseline: unknown;
      data: import('./current-operation-types.js').OriginalCurrentDocumentData;
    }
  >();
  let core!: CurrentDocOperationEngineCore;
  const activeCurrent = new WeakSet<DbTransaction>();
  let currentEntry = false;
  const editorSelectionReader = createOriginalEditorSelectionReader();
  const editorSelections = new WeakMap<
    DbTransaction,
    {
      request: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelSelectionRequest;
      fileSource: import('../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
      source: ReturnType<ReturnType<typeof createOriginalEditorSelectionReader>['read']>;
    }
  >();
  let room: CurrentRoomOperation | undefined;
  const checkboxCommits = new WeakMap<
    DbTransaction,
    {
      owner: object;
      store: DocChannelStore;
      now: string;
      generation: string;
      physical: Record<string, unknown>;
      channelBirth: Record<string, unknown>;
      roomPrepared: boolean;
    }
  >();
  let roomPumpStopped = false;
  let roomConstruction: 'unstarted' | 'constructing' | 'ready' | 'failed' = 'unstarted';
  let roomConstructionFailure!: { cause: unknown } | undefined;
  let roomStop!: Promise<void> | undefined;
  let resolveRoomStop!: (() => void) | undefined;
  let rejectRoomStop!: ((cause: unknown) => void) | undefined;
  let roomStopStarted = false;
  let fixedPorts!: DocChannelAuthorityPorts;
  let authorization!: DocChannelAuthorization;
  let db!: Db;
  let scopes!: WeakMap<DbTransaction, CurrentOperationScope>;
  return {
    get documentSaves() {
      return documentSaves;
    },
    get documentSaveInspections() {
      return documentSaveInspections;
    },
    get documentSaveCompletions() {
      return documentSaveCompletions;
    },
    get tokenSourceDependencies() {
      return tokenSourceDependencies;
    },
    set tokenSourceDependencies(value: typeof tokenSourceDependencies) {
      tokenSourceDependencies = value;
    },
    get restoredTokens() {
      return restoredTokens;
    },
    get tokenFileSourceReader() {
      return tokenFileSourceReader;
    },
    set tokenFileSourceReader(value: typeof tokenFileSourceReader) {
      tokenFileSourceReader = value;
    },
    get tokenCurrentReader() {
      return tokenCurrentReader;
    },
    set tokenCurrentReader(value: typeof tokenCurrentReader) {
      tokenCurrentReader = value;
    },
    get tokenEventReader() {
      return tokenEventReader;
    },
    set tokenEventReader(value: typeof tokenEventReader) {
      tokenEventReader = value;
    },
    get managementReader() {
      return managementReader;
    },
    set managementReader(value: typeof managementReader) {
      managementReader = value;
    },
    get tokenStore() {
      return tokenStore;
    },
    set tokenStore(value: typeof tokenStore) {
      tokenStore = value;
    },
    get readTokenNativeFacts() {
      return readTokenNativeFacts;
    },
    set readTokenNativeFacts(value: typeof readTokenNativeFacts) {
      readTokenNativeFacts = value;
    },
    get activeTokenOperations() {
      return activeTokenOperations;
    },
    get presenceLedger() {
      return presenceLedger;
    },
    get presenceDocuments() {
      return presenceDocuments;
    },
    get presenceNow() {
      return presenceNow;
    },
    get presenceSetTimeout() {
      return presenceSetTimeout;
    },
    get presenceClearTimeout() {
      return presenceClearTimeout;
    },
    get presenceTimer() {
      return presenceTimer;
    },
    set presenceTimer(value: typeof presenceTimer) {
      presenceTimer = value;
    },
    get presenceTail() {
      return presenceTail;
    },
    set presenceTail(value: typeof presenceTail) {
      presenceTail = value;
    },
    get presenceFailure() {
      return presenceFailure;
    },
    set presenceFailure(value: typeof presenceFailure) {
      presenceFailure = value;
    },
    get presenceFailures() {
      return presenceFailures;
    },
    get presenceFocusStages() {
      return presenceFocusStages;
    },
    get presenceFocusTransactions() {
      return presenceFocusTransactions;
    },
    get tokenStreams() {
      return tokenStreams;
    },
    get liveTokenStreams() {
      return liveTokenStreams;
    },
    get tokenRoomPeerClosed() {
      return tokenRoomPeerClosed;
    },
    set tokenRoomPeerClosed(value: typeof tokenRoomPeerClosed) {
      tokenRoomPeerClosed = value;
    },
    get tokenManifestOwners() {
      return tokenManifestOwners;
    },
    get tokenNativeCloseFailure() {
      return tokenNativeCloseFailure;
    },
    set tokenNativeCloseFailure(value: typeof tokenNativeCloseFailure) {
      tokenNativeCloseFailure = value;
    },
    get tokenStages() {
      return tokenStages;
    },
    get nativePrepare() {
      return nativePrepare;
    },
    set nativePrepare(value: typeof nativePrepare) {
      nativePrepare = value;
    },
    get documentAuthorities() {
      return documentAuthorities;
    },
    get core() {
      return core;
    },
    set core(value: typeof core) {
      core = value;
    },
    get activeCurrent() {
      return activeCurrent;
    },
    get currentEntry() {
      return currentEntry;
    },
    set currentEntry(value: typeof currentEntry) {
      currentEntry = value;
    },
    get editorSelectionReader() {
      return editorSelectionReader;
    },
    get editorSelections() {
      return editorSelections;
    },
    get room() {
      return room;
    },
    set room(value: typeof room) {
      room = value;
    },
    get checkboxCommits() {
      return checkboxCommits;
    },
    get roomPumpStopped() {
      return roomPumpStopped;
    },
    set roomPumpStopped(value: typeof roomPumpStopped) {
      roomPumpStopped = value;
    },
    get roomConstruction() {
      return roomConstruction;
    },
    set roomConstruction(value: typeof roomConstruction) {
      roomConstruction = value;
    },
    get roomConstructionFailure() {
      return roomConstructionFailure;
    },
    set roomConstructionFailure(value: typeof roomConstructionFailure) {
      roomConstructionFailure = value;
    },
    get roomStop() {
      return roomStop;
    },
    set roomStop(value: typeof roomStop) {
      roomStop = value;
    },
    get resolveRoomStop() {
      return resolveRoomStop;
    },
    set resolveRoomStop(value: typeof resolveRoomStop) {
      resolveRoomStop = value;
    },
    get rejectRoomStop() {
      return rejectRoomStop;
    },
    set rejectRoomStop(value: typeof rejectRoomStop) {
      rejectRoomStop = value;
    },
    get roomStopStarted() {
      return roomStopStarted;
    },
    set roomStopStarted(value: typeof roomStopStarted) {
      roomStopStarted = value;
    },
    get fixedPorts() {
      return fixedPorts;
    },
    set fixedPorts(value: typeof fixedPorts) {
      fixedPorts = value;
    },
    get authorization() {
      return authorization;
    },
    set authorization(value: typeof authorization) {
      authorization = value;
    },
    get db() {
      return db;
    },
    set db(value: typeof db) {
      db = value;
    },
    get scopes() {
      return scopes;
    },
    set scopes(value: typeof scopes) {
      scopes = value;
    },
  };
}

/** Preserve the original writable accessor API while runtime-freezing its descriptor object. */
export function createPrivateCurrentEngineState(): PrivateCurrentEngineState {
  const state = allocatePrivateCurrentEngineState();
  return Object.freeze(state);
}
