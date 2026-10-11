import type { TokenStreamState } from './token/current-token-stream-facet.js';
import type { createOriginalDocPresenceLedger, PresencePlan } from '../presence.js';
import type { createOriginalEditorSelectionReader } from '../editor/selection-source.js';
import type { createOriginalDocManagementReader } from '../management/snapshot-data.js';
import type { createOriginalDocTokenFileSourceReader } from '../tokens/token-native-file-source.js';
import type { createOriginalDocTokenCurrentReader } from '../tokens/token-native-current.js';
import type { createOriginalDocTokenEventReader } from '../tokens/token-native-reads.js';
import type { OriginalDocTokenNativeFacts } from '../tokens/token-native-facts.js';
import type { DocChannelTokenStore } from '../tokens/token-store.js';
import type { CurrentRoomOperation } from '../operations/room-current-operation.js';
import type { Db, DbTransaction } from '@dorkos/db';
import type { DocChannelStore } from '../store.js';
import type { DocChannelIngest } from '../ingest.js';
import type { DocChannelGrants } from '../grants.js';
import type {
  CurrentOperationScope,
  CurrentDocOperationEngineCore,
} from './current-operation-types.js';
import type {
  DocChannelAuthorization,
  DocChannelActor,
  DocChannelAuthorityPorts,
} from '../authorization.js';

/** Exact named accessor contract; readonly denotes original getter-only properties, not mutable cells. */
export interface PrivateCurrentEngineState {
  readonly documentSaves: WeakMap<
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
  >;
  readonly documentSaveInspections: WeakMap<
    DbTransaction,
    {
      scope: object;
      request: import('@dorkos/shared/schemas').CanvasDocumentSaveIdentity;
      hash: string;
      path: string;
    }
  >;
  readonly documentSaveCompletions: WeakMap<
    DbTransaction,
    { scope: object; hash: string; path: string }
  >;
  tokenSourceDependencies:
    | {
        service: import('../service.js').DocChannelService;
        store: DocChannelStore;
        grants: DocChannelGrants;
      }
    | undefined;
  readonly restoredTokens: WeakMap<
    import('./current-operation-types.js').OriginalNativeDocTokenScope,
    { store: DocChannelStore; grants: DocChannelGrants; hash: string }
  >;
  tokenFileSourceReader: ReturnType<typeof createOriginalDocTokenFileSourceReader> | undefined;
  tokenCurrentReader: ReturnType<typeof createOriginalDocTokenCurrentReader> | undefined;
  tokenEventReader: ReturnType<typeof createOriginalDocTokenEventReader> | undefined;
  managementReader: ReturnType<typeof createOriginalDocManagementReader> | undefined;
  tokenStore: DocChannelTokenStore | undefined;
  readTokenNativeFacts: ((documentId: string) => OriginalDocTokenNativeFacts) | undefined;
  readonly activeTokenOperations: Set<Promise<unknown>>;
  readonly presenceLedger: ReturnType<typeof createOriginalDocPresenceLedger>;
  readonly presenceDocuments: Map<
    string,
    {
      store: DocChannelStore;
      actor: DocChannelActor;
      birth: CurrentOperationScope['birth'];
      scope: string;
      callers: Map<string, DocChannelActor>;
    }
  >;
  readonly presenceNow: typeof Date.now;
  readonly presenceSetTimeout: typeof setTimeout;
  readonly presenceClearTimeout: typeof clearTimeout;
  presenceTimer: ReturnType<typeof setTimeout> | undefined;
  presenceTail: Promise<void>;
  presenceFailure: { cause: unknown } | undefined;
  readonly presenceFailures: Map<string, { cause: unknown }>;
  readonly presenceFocusStages: WeakMap<
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
  >;
  readonly presenceFocusTransactions: WeakMap<DbTransaction, object>;
  readonly tokenStreams: WeakMap<
    import('./current-operation-types.js').OriginalNativeDocTokenStream,
    TokenStreamState
  >;
  readonly liveTokenStreams: Set<TokenStreamState>;
  tokenRoomPeerClosed: boolean;
  readonly tokenManifestOwners: { grants: DocChannelGrants; store: DocChannelStore }[];
  tokenNativeCloseFailure: { cause: unknown } | undefined;
  readonly tokenStages: WeakMap<
    import('./current-operation-types.js').OriginalDocTokenIssuanceStage,
    {
      store: DocChannelStore;
      grants: DocChannelGrants;
      authority: import('./current-operation-types.js').OriginalCurrentDocumentAuthority;
      state: 'prepared' | 'committing' | 'retired';
      fileSource: import('../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
    }
  >;
  nativePrepare: Db['$client']['prepare'];
  readonly documentAuthorities: WeakMap<
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
  >;
  core: CurrentDocOperationEngineCore;
  readonly activeCurrent: WeakSet<DbTransaction>;
  currentEntry: boolean;
  readonly editorSelectionReader: ReturnType<typeof createOriginalEditorSelectionReader>;
  readonly editorSelections: WeakMap<
    DbTransaction,
    {
      request: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelSelectionRequest;
      fileSource: import('../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
      source: ReturnType<ReturnType<typeof createOriginalEditorSelectionReader>['read']>;
    }
  >;
  room: CurrentRoomOperation | undefined;
  readonly checkboxCommits: WeakMap<
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
  >;
  roomPumpStopped: boolean;
  roomConstruction: 'unstarted' | 'constructing' | 'ready' | 'failed';
  roomConstructionFailure: { cause: unknown } | undefined;
  roomStop: Promise<void> | undefined;
  resolveRoomStop: (() => void) | undefined;
  rejectRoomStop: ((cause: unknown) => void) | undefined;
  roomStopStarted: boolean;
  fixedPorts: DocChannelAuthorityPorts;
  authorization: DocChannelAuthorization;
  db: Db;
  scopes: WeakMap<DbTransaction, CurrentOperationScope>;
}
