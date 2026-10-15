import {
  finishRoomStop,
  ensureRoom,
  maintainHistory,
} from './room/current-room-retirement-facet.js';
import {
  completeCheckbox,
  readDocumentAuthority,
  captureDocument,
} from './projection/current-document-capture-facet.js';
import {
  operatorRows,
  requireOperatorRows,
  captureRoomOperatorProducer,
  captureRoomTokenProducer,
  requireRoomTokenSource,
  requireRoomOperatorSource,
} from './room/current-room-producer-facet.js';
import {
  documentGrantRows,
  documentScopeBaseline,
  fixedCurrent,
  preflightCurrent,
  beginCurrent,
  finalCurrent,
  retireCurrent,
} from './projection/current-entry-facet.js';
import {
  prepareDocumentSave,
  completeDocumentSave,
  selectionCurrent,
} from './projection/current-editor-save-selection-facet.js';
import {
  tokenNativeCurrent,
  prepareTokenNativeRead,
  initializeTokenReaders,
  restoreTokenScope,
  readTokenReplay,
  readTokenEvent,
  inspectTokenInputReceipt,
  submitTokenCurrent,
} from './token/current-token-native-input-facet.js';
import {
  revokeToken,
  prepareTokenIssuance,
  commitTokenIssuance,
} from './token/current-token-issuance-facet.js';
import {
  updatePresence,
  focusPresence,
  requirePresenceFocusPreflight,
  requirePresenceFocus,
} from './presence/current-mounted-presence-facet.js';
import { submitCurrent } from './projection/current-event-admission-facet.js';
import {
  retireKnownPresence,
  expirePresenceNative,
} from './presence/current-presence-expiry-facet.js';
import {
  observeReplayFileSource,
  managementCurrent,
  replayCurrent,
  inspectCurrent,
} from './projection/current-read-projection-facet.js';
import { replayExpiredCurrent } from './replay/current-expired-replay-facet.js';
import {
  openTokenStream,
  closeTokenStream,
  retireTokenStream,
  nextTokenStream,
  type TokenStreamState,
} from './token/current-token-stream-facet.js';
import { createOriginalEditorSelectionReader } from '../editor/selection-source.js';
import { CurrentRoomOperation } from '../operations/room-current-operation.js';
import { type DbTransaction } from '@dorkos/db';
import { type CanvasChannelEventReceipt } from '@dorkos/shared/canvas-channel-schemas';
import { type DocChannelStore } from '../store.js';
import { type DocChannelIngest } from '../ingest.js';
import { type DocChannelGrants } from '../grants.js';
import {
  type CurrentOperationScope,
  type DocCurrentReplayResponse,
  type DocEventCondition,
  type DocReceiptInspection,
} from './current-operation-types.js';
import { type DocChannelActor } from '../authorization.js';

/** Pure per-construction delegates; every callable still enters an independently guarded original facet with the captured unreachable engine. */
export function createPrivateEngineDelegateCalls(engineOwner: object) {
  return Object.freeze({
    completeCheckbox: (
      store: DocChannelStore,
      grants: DocChannelGrants,
      owner: object,
      tx: DbTransaction
    ) => {
      return completeCheckbox(engineOwner, store, grants, owner, tx);
    },
    readDocumentAuthority: (
      store: DocChannelStore,
      grants: DocChannelGrants,
      authority: import('./current-operation-types.js').OriginalCurrentDocumentAuthority
    ) => {
      return readDocumentAuthority(engineOwner, store, grants, authority);
    },
    documentGrantRows: (documentId: string, tx: DbTransaction): unknown => {
      return documentGrantRows(engineOwner, documentId, tx);
    },
    documentScopeBaseline: (scope: CurrentOperationScope, dependencies: unknown): unknown => {
      return documentScopeBaseline(engineOwner, scope, dependencies);
    },
    captureDocument: (
      store: DocChannelStore,
      grants: DocChannelGrants,
      documentId: string,
      rawActor: DocChannelActor,
      rawIds: readonly string[],
      authority?: import('./current-operation-types.js').OriginalCurrentDocumentAuthority,
      nativeFileSource?: import('../tokens/token-native-file-source.js').OriginalDocTokenFileSource,
      selectOriginalEvent?: import('@dorkos/shared/canvas-channel-schemas').StoredPageEvent
    ): Promise<import('./current-operation-types.js').OriginalCurrentDocumentData> => {
      return captureDocument(
        engineOwner,
        store,
        grants,
        documentId,
        rawActor,
        rawIds,
        authority,
        nativeFileSource,
        selectOriginalEvent
      );
    },
    tokenNativeCurrent: (own: {
      store: DocChannelStore;
      grants: DocChannelGrants;
      hash: string;
    }) => {
      return tokenNativeCurrent(engineOwner, own);
    },
    prepareTokenNativeRead: (own: {
      store: DocChannelStore;
      grants: DocChannelGrants;
      hash: string;
    }) => {
      return prepareTokenNativeRead(engineOwner, own);
    },
    initializeTokenReaders: (): void => {
      return initializeTokenReaders(engineOwner);
    },
    restoreTokenScope: (store: DocChannelStore, grants: DocChannelGrants, hash: string) => {
      return restoreTokenScope(engineOwner, store, grants, hash);
    },
    openTokenStream: (
      scope: import('./current-operation-types.js').OriginalNativeDocTokenScope,
      since: number
    ) => {
      return openTokenStream(engineOwner, scope, since);
    },
    closeTokenStream: (
      stream: import('./current-operation-types.js').OriginalNativeDocTokenStream
    ): void => {
      return closeTokenStream(engineOwner, stream);
    },
    retireTokenStream: (state: TokenStreamState): void => {
      return retireTokenStream(engineOwner, state);
    },
    nextTokenStream: (
      stream: import('./current-operation-types.js').OriginalNativeDocTokenStream
    ) => {
      return nextTokenStream(engineOwner, stream);
    },
    readTokenReplay: (
      scope: import('./current-operation-types.js').OriginalNativeDocTokenScope,
      since: number,
      limit: number,
      permission: 'replay' | 'stream' = 'replay'
    ) => {
      return readTokenReplay(engineOwner, scope, since, limit, permission);
    },
    readTokenEvent: (
      scope: import('./current-operation-types.js').OriginalNativeDocTokenScope,
      eventId: string,
      permission: 'replay' | 'stream'
    ) => {
      return readTokenEvent(engineOwner, scope, eventId, permission);
    },
    inspectTokenInputReceipt: (
      scope: import('./current-operation-types.js').OriginalNativeDocTokenScope,
      eventId: string
    ) => {
      return inspectTokenInputReceipt(engineOwner, scope, eventId);
    },
    submitTokenCurrent: (
      store: DocChannelStore,
      ingest: DocChannelIngest,
      grants: DocChannelGrants,
      tokenScope: import('./current-operation-types.js').OriginalNativeDocTokenScope,
      raw: unknown
    ) => {
      return submitTokenCurrent(engineOwner, store, ingest, grants, tokenScope, raw);
    },
    revokeToken: (
      store: DocChannelStore,
      grants: DocChannelGrants,
      rawActor: DocChannelActor,
      documentId: string,
      tokenId: string
    ) => {
      return revokeToken(engineOwner, store, grants, rawActor, documentId, tokenId);
    },
    prepareTokenIssuance: (
      store: DocChannelStore,
      grants: DocChannelGrants,
      rawActor: DocChannelActor,
      rawRequest: unknown,
      grantIds: readonly string[]
    ) => {
      return prepareTokenIssuance(engineOwner, store, grants, rawActor, rawRequest, grantIds);
    },
    commitTokenIssuance: (
      stage: import('./current-operation-types.js').OriginalDocTokenIssuanceStage
    ) => {
      return commitTokenIssuance(engineOwner, stage);
    },
    updatePresence: (
      store: DocChannelStore,
      documentId: string,
      actor: DocChannelActor,
      request?: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelPresenceRequest,
      retiredCallers: ReadonlySet<string> = new Set()
    ) => {
      return updatePresence(engineOwner, store, documentId, actor, request, retiredCallers);
    },
    focusPresence: (
      store: DocChannelStore,
      ingest: DocChannelIngest,
      grants: DocChannelGrants,
      documentId: string,
      actor: DocChannelActor,
      request: Extract<
        import('@dorkos/shared/canvas-channel-schemas').CanvasChannelPresenceRequest,
        { action: 'focus' }
      >
    ) => {
      return focusPresence(engineOwner, store, ingest, grants, documentId, actor, request);
    },
    requirePresenceFocusPreflight: (stage: object, store: DocChannelStore): void => {
      return requirePresenceFocusPreflight(engineOwner, stage, store);
    },
    requirePresenceFocus: (stage: object, store: DocChannelStore): void => {
      return requirePresenceFocus(engineOwner, stage, store);
    },
    retireKnownPresence: (
      documentId: string
    ): Readonly<{ retired: boolean; callers: ReadonlySet<string> }> => {
      return retireKnownPresence(engineOwner, documentId);
    },
    expirePresenceNative: (
      documentId: string,
      own: {
        store: DocChannelStore;
        actor: DocChannelActor;
        birth: CurrentOperationScope['birth'];
        scope: string;
        callers: Map<string, DocChannelActor>;
      },
      retiredCallers: ReadonlySet<string>
    ): void => {
      return expirePresenceNative(engineOwner, documentId, own, retiredCallers);
    },
    finishRoomStop: (): void => {
      return finishRoomStop(engineOwner);
    },
    ensureRoom: (): CurrentRoomOperation | undefined => {
      return ensureRoom(engineOwner);
    },
    maintainHistory: (store: DocChannelStore): void => {
      return maintainHistory(engineOwner, store);
    },
    operatorRows: (documentId: string, roomId: string, key: string, tx?: DbTransaction) => {
      return operatorRows(engineOwner, documentId, roomId, key, tx);
    },
    requireOperatorRows: (
      producer:
        | import('./current-operation-types.js').OriginalRoomOperatorProducer
        | import('./current-operation-types.js').OriginalRoomTokenProducer,
      tx?: DbTransaction
    ): void => {
      return requireOperatorRows(engineOwner, producer, tx);
    },
    captureRoomOperatorProducer: (store: DocChannelStore, tx: DbTransaction) => {
      return captureRoomOperatorProducer(engineOwner, store, tx);
    },
    captureRoomTokenProducer: (store: DocChannelStore, tx: DbTransaction) => {
      return captureRoomTokenProducer(engineOwner, store, tx);
    },
    requireRoomTokenSource: (token: object): void => {
      return requireRoomTokenSource(engineOwner, token);
    },
    requireRoomOperatorSource: (token: object): void => {
      return requireRoomOperatorSource(engineOwner, token);
    },
    fixedCurrent: (
      documentId: string,
      actor: DocChannelActor,
      write: boolean,
      tx: DbTransaction | undefined,
      ready: boolean
    ): { id: string; scope: string } => {
      return fixedCurrent(engineOwner, documentId, actor, write, tx, ready);
    },
    preflightCurrent: (
      documentId: string,
      actor: DocChannelActor,
      write: boolean
    ): Promise<void> => {
      return preflightCurrent(engineOwner, documentId, actor, write);
    },
    beginCurrent: (
      store: DocChannelStore,
      tx: DbTransaction,
      documentId: string,
      actor: DocChannelActor,
      write: boolean,
      requestedCondition: DocEventCondition | 'server-initial-replay',
      documentAuthority?: import('./current-operation-types.js').OriginalCurrentDocumentAuthority
    ): CurrentOperationScope => {
      return beginCurrent(
        engineOwner,
        store,
        tx,
        documentId,
        actor,
        write,
        requestedCondition,
        documentAuthority
      );
    },
    finalCurrent: (store: DocChannelStore, tx: DbTransaction): void => {
      return finalCurrent(engineOwner, store, tx);
    },
    retireCurrent: (tx: DbTransaction): void => {
      return retireCurrent(engineOwner, tx);
    },
    replayExpiredCurrent: (
      store: DocChannelStore,
      ingest: DocChannelIngest,
      grants: DocChannelGrants,
      raw: unknown,
      rawActor: DocChannelActor
    ): Promise<import('@dorkos/shared/canvas-channel-schemas').CanvasChannelBatchReplayResult> => {
      return replayExpiredCurrent(engineOwner, store, ingest, grants, raw, rawActor);
    },
    observeReplayFileSource: (
      store: DocChannelStore,
      documentId: string,
      grants?: DocChannelGrants
    ) => {
      return observeReplayFileSource(engineOwner, store, documentId, grants);
    },
    managementCurrent: (store: DocChannelStore, documentId: string, rawActor: DocChannelActor) => {
      return managementCurrent(engineOwner, store, documentId, rawActor);
    },
    replayCurrent: (
      store: DocChannelStore,
      documentId: string,
      rawActor: DocChannelActor,
      since: number,
      limit: number,
      documentAuthority?: import('./current-operation-types.js').OriginalCurrentDocumentAuthority
    ): Promise<DocCurrentReplayResponse> => {
      return replayCurrent(
        engineOwner,
        store,
        documentId,
        rawActor,
        since,
        limit,
        documentAuthority
      );
    },
    inspectCurrent: (
      store: DocChannelStore,
      documentId: string,
      eventId: string,
      rawActor: DocChannelActor,
      rawCondition: DocEventCondition,
      documentAuthority?: import('./current-operation-types.js').OriginalCurrentDocumentAuthority,
      duplicateSave?: {
        scope: object;
        request: import('@dorkos/shared/schemas').CanvasDocumentSaveIdentity;
        hash: string;
        path: string;
      }
    ): Promise<DocReceiptInspection> => {
      return inspectCurrent(
        engineOwner,
        store,
        documentId,
        eventId,
        rawActor,
        rawCondition,
        documentAuthority,
        duplicateSave
      );
    },
    prepareDocumentSave: (
      store: DocChannelStore,
      grants: DocChannelGrants,
      handle: object,
      rawActor: DocChannelActor
    ) => {
      return prepareDocumentSave(engineOwner, store, grants, handle, rawActor);
    },
    completeDocumentSave: (
      store: DocChannelStore,
      ingest: DocChannelIngest,
      grants: DocChannelGrants,
      handle: object,
      rawActor: DocChannelActor
    ) => {
      return completeDocumentSave(engineOwner, store, ingest, grants, handle, rawActor);
    },
    selectionCurrent: (
      store: DocChannelStore,
      ingest: DocChannelIngest,
      grants: DocChannelGrants,
      raw: unknown,
      rawActor: DocChannelActor
    ): Promise<CanvasChannelEventReceipt> => {
      return selectionCurrent(engineOwner, store, ingest, grants, raw, rawActor);
    },
    submitCurrent: (
      store: DocChannelStore,
      ingest: DocChannelIngest,
      grants: DocChannelGrants,
      documentId: string,
      raw: unknown,
      rawActor: DocChannelActor,
      rawCondition: DocEventCondition,
      documentAuthority?: import('./current-operation-types.js').OriginalCurrentDocumentAuthority,
      selection?: {
        request: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelSelectionRequest;
        fileSource: import('../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
        source: ReturnType<ReturnType<typeof createOriginalEditorSelectionReader>['read']>;
      },
      documentSave?: object,
      presenceFocus?: object
    ): Promise<CanvasChannelEventReceipt> => {
      return submitCurrent(
        engineOwner,
        store,
        ingest,
        grants,
        documentId,
        raw,
        rawActor,
        rawCondition,
        documentAuthority,
        selection,
        documentSave,
        presenceFocus
      );
    },
  });
}
