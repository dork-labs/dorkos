/** EXTERNAL proposed internal fixed request condition; no shared export or authority token. */
import type { CanvasChannelEventReceipt } from '@dorkos/shared/canvas-channel-schemas';
export interface DocEventCondition {
  readonly expectedGeneration: string;
  readonly originalReceiptRetentionFloor?: number;
}
export interface DocDocumentBirth {
  readonly physicalId: string;
  readonly openedAt: string;
  readonly documentId: string;
  readonly createdAt: string;
}
export type DocReceiptInspection =
  | {
      readonly kind: 'receipt';
      readonly generation: string;
      readonly birth: DocDocumentBirth;
      readonly event: CanvasChannelEventReceipt;
    }
  | {
      readonly kind: 'absent';
      readonly generation: string;
      readonly birth: DocDocumentBirth;
      readonly eventId: string;
      readonly receiptRetentionFloor: number;
    };

/** Private replay result includes the complete server-derived physical/channel birth. */
export type DocCurrentReplayResponse =
  import('@dorkos/shared/canvas-channel-schemas').CanvasChannelReplayResponse & {
    readonly incarnation: import('@dorkos/shared/canvas-doc-incarnation').CanvasDocIncarnation;
    /** Internal authenticated stored-origin data only; never a load ticket or grant. Missing Room origin refuses extension. */
    readonly mcpOrigin?: {
      readonly canonicalSessionId: string;
      readonly serverName: string;
      readonly uri: string;
      readonly physicalRevision: number;
      readonly declaration: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelDeclaration;
      readonly declarationHash: string;
    };
  };

// Type-only identity of existing engine scopes; no constructor or issuer moves here.
import type { Db, DbTransaction, canvasDocuments } from '@dorkos/db';
import type { PageEvent } from '@dorkos/shared/canvas-channel-schemas';
import type { DocChannelAuthorization, DocChannelActor } from '../authorization.js';
import type { DocChannelStore } from '../store.js';
import type { DocChannelIngest } from '../ingest.js';
import type { DocChannelGrants } from '../grants.js';
import type { DocIngestAccess } from '../ingest-types.js';
interface CurrentOperationCommon {
  authorization: DocChannelAuthorization;
  engine: CurrentDocOperationEngineCore;
  db: Db;
  store: DocChannelStore;
  documentId: string;
  scope: string;
  write: boolean;
  birth: DocDocumentBirth;
  generation: string;
  physicalRow: typeof canvasDocuments.$inferSelect;
  channelRow: import('../store.js').DocChannelRow;
  capturedFloor: number;
  condition: DocEventCondition;
  // HTTP still parses PageEventSchema; host events enter only via original checkbox private custody.
  event?: import('@dorkos/shared/canvas-channel-schemas').StoredPageEvent;
  ingest?: DocChannelIngest;
  grants?: DocChannelGrants;
  access?: DocIngestAccess;
  now?: string;
  absentAdmission: boolean;
  acceptedDocSeq?: number;
  documentGrantSelection?: {
    grants: DocChannelGrants;
    ids: readonly string[];
    writeObservation?: import('../grant-policy.js').DocOriginalWriteObservation;
  };
  documentAuthority?: OriginalCurrentDocumentAuthority;
  documentGrantRows?: unknown;
  originalWriteObservation?: import('../grant-policy.js').DocOriginalWriteObservation;
  failure?: { cause: unknown };
}

export type CurrentOperationScope = CurrentOperationCommon &
  (
    | {
        actor: DocChannelActor;
        tokenScope?: never;
        tokenGrantPreparation?: never;
        tokenGrantIds?: never;
        tokenManifestHash?: never;
      }
    | {
        actor?: never;
        tokenScope: OriginalNativeDocTokenScope;
        tokenGrantPreparation: OriginalDocTokenGrantPreparation;
        tokenGrantIds: readonly string[];
        tokenManifestHash: string | null;
      }
  );
export interface OriginalDocTokenGrantPreparation {
  readonly kind: 'original-doc-token-grant-preparation';
}
export interface OriginalRoomTokenProducer extends Omit<OriginalRoomOperatorProducer, 'kind'> {
  readonly kind: 'doc_token';
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly tokenCreatedAt: string;
  readonly tokenExpiresAt: string;
  readonly tokenIssuerJson: string;
}
export interface OriginalDocTokenRevocationStage {
  readonly kind: 'original-doc-token-revocation-stage';
}
export interface OriginalNativeDocTokenScope {
  readonly kind: 'original-native-doc-token-scope';
}
export interface OriginalNativeDocTokenStream {
  readonly kind: 'original-native-doc-token-stream';
}
export type OriginalNativeDocTokenPage = ReturnType<
  ReturnType<
    typeof import('../tokens/token-native-reads.js').createOriginalDocTokenEventReader
  >['page']
>;
export interface CurrentDocOperationEngineCore {
  roomPendingWrites: (tx: DbTransaction) => number;
  readonly presence: (
    store: DocChannelStore,
    ingest: DocChannelIngest,
    grants: DocChannelGrants,
    documentId: string,
    actor: DocChannelActor,
    raw: unknown
  ) => Promise<import('@dorkos/shared/canvas-channel-schemas').CanvasChannelPresenceResponse>;

  readonly requireCurrentAccess: (
    documentId: string,
    actor: DocChannelActor,
    write: boolean,
    tx?: DbTransaction
  ) => { id: string; scope: string };

  readonly bindTokenService: (
    service: import('../service.js').DocChannelService,
    store: DocChannelStore,
    grants: DocChannelGrants
  ) => void;
  readonly revokeToken: (
    store: DocChannelStore,
    grants: DocChannelGrants,
    actor: DocChannelActor,
    documentId: string,
    tokenId: string
  ) => Promise<Readonly<{ tokenId: string; revokedAt: string }>>;
  readonly tokenIngressCurrent: (
    scope: OriginalNativeDocTokenScope
  ) => Promise<Readonly<{ documentId: string; generation: string }>>;
  readonly inspectTokenInputReceipt: (
    scope: OriginalNativeDocTokenScope,
    eventId: string
  ) => Promise<CanvasChannelEventReceipt>;
  readonly submitToken: (
    store: DocChannelStore,
    ingest: DocChannelIngest,
    grants: DocChannelGrants,
    scope: OriginalNativeDocTokenScope,
    raw: unknown
  ) => ReturnType<CurrentDocOperationEngineCore['submit']>;
  readonly captureRoomTokenProducer: (
    store: DocChannelStore,
    tx: DbTransaction
  ) => OriginalRoomTokenProducer;
  readonly requireRoomTokenSource: (source: object) => void;
  readonly tokenDrainData: () => Readonly<{
    roomPeerClosed: boolean;
    roomConstructed: boolean;
    activeTokenOperations: number;
    liveTokenStreams: number;
  }>;
  readonly tokenOpenStream: (
    scope: OriginalNativeDocTokenScope,
    since: number
  ) => Promise<OriginalNativeDocTokenStream>;
  readonly tokenStreamNext: (
    stream: OriginalNativeDocTokenStream
  ) => Promise<OriginalNativeDocTokenPage | undefined>;
  readonly tokenStreamState: (
    stream: OriginalNativeDocTokenStream
  ) => Readonly<{ waiting: boolean; closed: boolean }>;
  readonly tokenStreamClosed: (stream: OriginalNativeDocTokenStream) => Promise<void>;
  readonly tokenCloseStream: (stream: OriginalNativeDocTokenStream) => void;
  readonly restoreTokenScope: (
    store: DocChannelStore,
    grants: DocChannelGrants,
    hash: string
  ) => Promise<OriginalNativeDocTokenScope>;
  readonly tokenReplay: (
    scope: OriginalNativeDocTokenScope,
    since: number,
    limit: number,
    permission?: 'replay' | 'stream'
  ) => Promise<OriginalNativeDocTokenPage>;
  readonly tokenEvent: (
    scope: OriginalNativeDocTokenScope,
    eventId: string,
    permission: 'replay' | 'stream'
  ) => Promise<import('../tokens/token-native-facts.js').OriginalDocTokenNativeRow | undefined>;
  readonly documentReplay: (
    store: DocChannelStore,
    grants: DocChannelGrants,
    authority: OriginalCurrentDocumentAuthority,
    since: number,
    limit: number
  ) => Promise<DocCurrentReplayResponse>;
  readonly documentInspect: (
    store: DocChannelStore,
    grants: DocChannelGrants,
    authority: OriginalCurrentDocumentAuthority,
    eventId: string
  ) => Promise<DocReceiptInspection>;
  readonly documentSubmit: (
    store: DocChannelStore,
    ingest: DocChannelIngest,
    grants: DocChannelGrants,
    authority: OriginalCurrentDocumentAuthority,
    raw: unknown
  ) => ReturnType<CurrentDocOperationEngineCore['submit']>;
  readonly prepareTokenIssuance: (
    store: DocChannelStore,
    grants: DocChannelGrants,
    actor: DocChannelActor,
    request: unknown,
    grantIds: readonly string[]
  ) => Promise<{
    stage: OriginalDocTokenIssuanceStage;
    token: string;
    record: import('../tokens/token-store.js').OriginalStoredDocTokenData['record'];
  }>;
  readonly commitTokenIssuance: (stage: OriginalDocTokenIssuanceStage) => Promise<void>;
  readonly captureDocument: (
    store: DocChannelStore,
    grants: DocChannelGrants,
    documentId: string,
    actor: DocChannelActor,
    grantIds: readonly string[]
  ) => Promise<OriginalCurrentDocumentData>;
  readonly requireDocumentInTransaction: (
    store: DocChannelStore,
    grants: DocChannelGrants,
    authority: OriginalCurrentDocumentAuthority,
    tx: DbTransaction
  ) => void;
  readonly requireDocument: (
    store: DocChannelStore,
    grants: DocChannelGrants,
    authority: OriginalCurrentDocumentAuthority
  ) => Promise<OriginalCurrentDocumentData>;
  readonly captureRoomOperatorProducer: (
    store: DocChannelStore,
    tx: DbTransaction
  ) => Readonly<OriginalRoomOperatorProducer>;
  readonly requireRoomOperatorSource: (source: object) => void;
  readonly requireRoomOperatorNativeSource: (
    source: object,
    stage: Parameters<
      typeof import('../operations/room-responder-operation.js').requireOriginalRoomEmissionFrameTransaction
    >[0],
    tx: DbTransaction,
    emitter: import('../downstream/native-room-emitter.js').OriginalDownstreamRoomEmitter
  ) => void;
  readonly prepareCheckbox: (store: DocChannelStore, owner: object) => void;
  readonly completeCheckbox: (
    store: DocChannelStore,
    grants: DocChannelGrants,
    owner: object,
    tx: DbTransaction
  ) => Extract<import('../writes/checkbox-evidence.js').CheckboxReceipt, { status: 'changed' }>;
  readonly publishCheckbox: (store: DocChannelStore, owner: object, tx: DbTransaction) => void;
  readonly abandonCheckbox: (owner: object, tx: DbTransaction) => void;
  readonly maintainHistory: (store: DocChannelStore) => void;
  readonly commitRoomResponder: (
    runtime: object,
    prepared: PreparedRoomResponder
  ) => OriginalCommittedRoomResponder;
  readonly prepareRoomResponder: (
    runtime: object,
    holder: import('@dorkos/shared/agent-runtime').SseResponse,
    key: string
  ) => Promise<PreparedRoomResponder | undefined>;
  readonly nextRoomDueAt: () => string | undefined;
  readonly wakeRoomDue: () => void;
  readonly hintRoomRelay: (documentId: string, batchId: string, generation: string) => boolean;
  readonly subscribeRoomRelay: (
    listener: (documentId: string, batchId: string, generation: string) => void
  ) => () => void;
  readonly pumpRoomDue: (
    registry: import('../../../core/runtime-registry.js').RuntimeRegistry
  ) => Promise<void>;
  readonly stopRoomPump: () => Promise<void>;
  readonly readRoomScenarioEvidence: (
    documentId: string,
    batchId: string,
    generation: string
  ) =>
    | Readonly<{
        documentId: string;
        batchId: string;
        generation: string;
        sessionId: string;
        scenarioStarts: number;
        retired?: boolean;
        operationFailed?: boolean;
        cleanupClosed?: boolean;
      }>
    | undefined;
  readonly prepareDocumentSave: (
    store: DocChannelStore,
    grants: DocChannelGrants,
    scope: object,
    actor: DocChannelActor
  ) => Promise<import('../writes/normal-file-save.js').NormalFileSaveOutcome | undefined>;
  readonly completeDocumentSave: (
    store: DocChannelStore,
    ingest: DocChannelIngest,
    grants: DocChannelGrants,
    scope: object,
    actor: DocChannelActor
  ) => Promise<CanvasChannelEventReceipt>;
  readonly selection: (
    store: DocChannelStore,
    ingest: DocChannelIngest,
    grants: DocChannelGrants,
    raw: unknown,
    actor: DocChannelActor
  ) => Promise<CanvasChannelEventReceipt>;
  readonly submit: (
    store: DocChannelStore,
    ingest: DocChannelIngest,
    grants: DocChannelGrants,
    documentId: string,
    raw: unknown,
    actor: DocChannelActor,
    condition: DocEventCondition
  ) => Promise<CanvasChannelEventReceipt>;
  readonly inspect: (
    store: DocChannelStore,
    documentId: string,
    eventId: string,
    actor: DocChannelActor,
    condition: DocEventCondition
  ) => Promise<DocReceiptInspection>;
  readonly replayExpired: (
    store: DocChannelStore,
    ingest: DocChannelIngest,
    grants: DocChannelGrants,
    raw: unknown,
    actor: DocChannelActor
  ) => Promise<import('@dorkos/shared/canvas-channel-schemas').CanvasChannelBatchReplayResult>;
  readonly management: (
    store: DocChannelStore,
    documentId: string,
    actor: DocChannelActor
  ) => Promise<import('@dorkos/shared/canvas-channel-schemas').CanvasChannelManagementSnapshot>;
  readonly replay: (
    store: DocChannelStore,
    documentId: string,
    actor: DocChannelActor,
    since: number,
    limit: number
  ) => Promise<DocCurrentReplayResponse>;
  readonly final: (store: DocChannelStore, tx: DbTransaction) => void;
}

// Type-only placement; genuine registry/closures/original claims stay in grant-revalidation.
export interface DocGrantedRoute {
  route: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelRoute;
  grantId?: string;
  grantRevision?: number;
  allowedTypes?: string[];
  targetSessionId?: string | null;
  reason?: string;
}
export interface CurrentGrantSourceClaims {
  authorization: DocChannelAuthorization;
  grants: import('../store.js').DocGrantRow[];
  approvals: (typeof import('@dorkos/db').approvals.$inferSelect)[];
  channel: import('../store.js').DocChannelRow;
}
export interface CurrentGrantConstructorBinding {
  store: DocChannelStore;
  db: Db;
  documentFinal: (documentId: string, grantIds: readonly string[], tx: DbTransaction) => void;
  documentDependencies: (
    documentId: string,
    actor: import('../grant-policy.js').DocGrantActor,
    grantIds: readonly string[],
    tx: DbTransaction,
    observed?: import('../grant-policy.js').DocOriginalWriteObservation
  ) => import('../grant-revalidation.js').OriginalCurrentDocumentGrantDependencies;
  refresh: (documentId: string, actor: import('../grant-policy.js').DocGrantActor) => void;
  prepare: (
    authorization: DocChannelAuthorization,
    tx: DbTransaction,
    observed?: import('../grant-policy.js').DocOriginalWriteObservation
  ) => DocIngestAccess;
  audit: (authorization: DocChannelAuthorization, tx: DbTransaction) => void;
  roomSource: (
    authorization: DocChannelAuthorization,
    tx: DbTransaction,
    routeId: string
  ) => ReturnType<typeof import('./current-operation-intentions.js').selectOriginalRoomGrantSource>;
}

// Literal constructor parameter shape only; private captured services remain in the original class.
export interface DocGrantCurrentServices {
  db: Db;
  store: DocChannelStore;
  authority: import('../grant-policy.js').DocGrantAuthority;
  now?: () => Date;
}

export interface CurrentQueueRouteIntention {
  batch?: import('../store.js').DocBatchRow;
  delivery: typeof import('@dorkos/db').canvasDocDeliveries.$inferSelect;
  inputs?: ReturnType<
    typeof import('./current-operation-intentions.js').buildCurrentRoomInputIntention
  >;
}
export interface CurrentQueueIntent {
  store: DocChannelStore;
  eventId: string;
  routes: Map<string, CurrentQueueRouteIntention>;
  superseded: {
    original: import('../store.js').DocEventRow;
    delivery: typeof import('@dorkos/db').canvasDocDeliveries.$inferSelect;
  }[];
}

export interface OriginalQueueIdentity {
  store: DocChannelStore;
  eventId: string;
  batchId: string;
  generation: string;
}

export interface DocBatchSlice {
  batch: import('../store.js').DocBatchRow;
  context: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelDocEventsContext;
  overflowIds: string[];
}

/** Opaque original confirmed freeze custody; object shape alone has no membership. */
export interface OriginalFrozenRoomSource {
  readonly kind: 'original-frozen-room-source';
}
/** Opaque genuine SDK preparation; this is not committed start authority. */
export interface PreparedRoomResponder {
  readonly kind: 'prepared-room-responder';
}

/** Data shapes only. Actual engine/source issuance stays in the constructor-owned helper WeakMaps. */
export interface OriginalRoomPreEffectWitness {
  document: Record<string, unknown>;
  channelBirth: Record<string, unknown>;
  grant: Record<string, unknown>;
  approval: Record<string, unknown>;
  owner: Record<string, unknown>;
}
/** Immutable native operator data; no principal/permission is issued by this shape. */
export interface OriginalRoomOperatorProducer {
  kind: 'operator';
  owner: { kind: 'user'; userId: string } | { kind: 'local_install'; installationId: string };
  operatorAuthorId: string;
  operatorNaturalKey: string;
  operatorLinkedOwnerKey: string | null;
  birth: {
    documentId: string;
    scope: string;
    roomId: string;
    authorId: string;
    openedAt: string;
    channelCreatedAt: string;
    openerAgentId: string | null;
    declarationHash: string;
    manifestHash: string | null;
  };
}
export interface OriginalRoomRouteDraft {
  before: Readonly<OriginalRoomPreEffectWitness>;
  producerRoomFacts?: NonNullable<
    ReturnType<typeof import('../../../rooms/service/room-core.js').readOriginalRoomDispatchFacts>
  >;
  roomCustody?: import('../../../rooms/service/room-core.js').OriginalRoomDispatchCustody;
  original: ReturnType<
    typeof import('../grant-revalidation.js').readCurrentOriginalRoomGrantSource
  >;
  producer:
    | OriginalRoomOperatorProducer
    | OriginalRoomTokenProducer
    | NonNullable<
        ReturnType<
          typeof import('../../../connectors/principal/runtime-principal-service.js').readCurrentNativePrincipalSource
        >
      >['binding'];
  target: NonNullable<
    ReturnType<typeof import('../../../rooms/room-store.js').readRoomStoreGrantedDocTargetBinding>
  >;
  admissionId: string;
  physical: typeof import('@dorkos/db').canvasDocuments.$inferSelect;
  serializedGrant: { route: string; limits: string; evidence: string };
}
export interface PendingRoomSource {
  before: Readonly<OriginalRoomPreEffectWitness>;
  producerRoomFacts?: OriginalRoomRouteDraft['producerRoomFacts'];
  roomCustody?: import('../../../rooms/service/room-core.js').OriginalRoomDispatchCustody;
  source: Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
  dueAt: string;
  producer: OriginalRoomRouteDraft['producer'];
}
export interface RoomTransactionDraft {
  store: import('../store.js').DocChannelStore;
  eventId: string;
  routes: Map<string, OriginalRoomRouteDraft>;
  sealed?: readonly PendingRoomSource[];
  replay?: {
    previousKey: string;
    previousPending: PendingRoomSource | undefined;
    intention: CurrentQueueRouteIntention;
  };
}
export interface FrozenRoomSourceData {
  effectiveTargetSessionId?: string;
  before: Readonly<OriginalRoomPreEffectWitness>;
  producerRoomFacts?: OriginalRoomRouteDraft['producerRoomFacts'];
  engine: CurrentDocOperationEngineCore;
  db: import('@dorkos/db').Db;
  facade: import('@dorkos/db/internal-server').FixedNativeRoomDocFacade;
  principals: import('../../../connectors/principal/runtime-principal-service.js').ConnectorRuntimePrincipalService;
  source: Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
  roomCustody?: import('../../../rooms/service/room-core.js').OriginalRoomDispatchCustody;
  dueAt: string;
  selector: Readonly<{ documentId: string; batchId: string; generation: string }>;
}

/** Opaque original native COMMIT + private SAMEbudget FIRST; caller data cannot mint it. */
export interface OriginalCommittedRoomResponder {
  readonly kind: 'original-committed-room-responder';
}

/** Pure constructor tuple shape; original owning WeakMap remains in the helper. */
export interface OriginalRoomResponderOwnerData {
  delegate: import('../operations/room-responder-operation.js').OriginalRoomResponderOperation;
  authorization: import('../authorization.js').DocChannelAuthorization;
  engine: CurrentDocOperationEngineCore;
  db: import('@dorkos/db').Db;
  principals: import('../../../connectors/principal/runtime-principal-service.js').ConnectorRuntimePrincipalService;
  roomStore: import('../../../rooms/room-store.js').RoomStore;
  facade: import('@dorkos/db/internal-server').FixedNativeRoomDocFacade;
}

/** Pure private registry shape. Its actual constructors/WeakMap remain in the owning delegate. */
export interface OriginalRoomCommittedData {
  runtime: object;
  prepared: PreparedRoomResponder;
  operation: object;
  requireCurrent(): void;
  consume(): Readonly<{
    content: string;
    commit: import('@dorkos/db/internal-server').NativeRoomDocCommit;
  }>;
  retire(): void;
  consumed?: boolean;
  project(
    projector: import('../../../session/session-state-projector.js').SessionStateProjector,
    event: import('@dorkos/shared/session-stream').SessionEvent
  ): void;
  terminal(
    projector: import('../../../session/session-state-projector.js').SessionStateProjector,
    event: import('@dorkos/shared/session-stream').SessionEvent,
    outcome: 'turn_done' | 'failed' | 'cancelled' | undefined
  ): void;
}

/** Original owning-engine document custody; copied shape never satisfies its private registry. */
export interface OriginalCurrentDocumentAuthority {
  readonly kind: 'original-current-document-authority';
}
export interface OriginalCurrentDocumentData {
  readonly authority: OriginalCurrentDocumentAuthority;
  readonly documentId: string;
  readonly scope: string;
  readonly generation: string;
  readonly birth: DocDocumentBirth;
}

/** Opaque original active native responder emission; caller data cannot acquire membership. */
export interface OriginalRoomEmissionStage {
  readonly kind: 'original-room-emission-stage';
}

/** Only the original document engine can retain membership in this issuance stage. */
export interface OriginalDocTokenIssuanceStage {
  readonly kind: 'original-doc-token-issuance-stage';
}
