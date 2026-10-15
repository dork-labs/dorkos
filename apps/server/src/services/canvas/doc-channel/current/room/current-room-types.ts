import type {
  CurrentDocOperationEngineCore,
  CurrentQueueRouteIntention,
  OriginalRoomTokenProducer,
} from '../current-operation-types.js';

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
    ReturnType<
      typeof import('../../../../rooms/service/room-core.js').readOriginalRoomDispatchFacts
    >
  >;
  roomCustody?: import('../../../../rooms/service/room-core.js').OriginalRoomDispatchCustody;
  original: ReturnType<
    typeof import('../../grant-revalidation.js').readCurrentOriginalRoomGrantSource
  >;
  producer:
    | OriginalRoomOperatorProducer
    | OriginalRoomTokenProducer
    | NonNullable<
        ReturnType<
          typeof import('../../../../connectors/principal/runtime-principal-service.js').readCurrentNativePrincipalSource
        >
      >['binding'];
  target: NonNullable<
    ReturnType<
      typeof import('../../../../rooms/room-store.js').readRoomStoreGrantedDocTargetBinding
    >
  >;
  admissionId: string;
  physical: typeof import('@dorkos/db').canvasDocuments.$inferSelect;
  serializedGrant: { route: string; limits: string; evidence: string };
}
export interface PendingRoomSource {
  before: Readonly<OriginalRoomPreEffectWitness>;
  producerRoomFacts?: OriginalRoomRouteDraft['producerRoomFacts'];
  roomCustody?: import('../../../../rooms/service/room-core.js').OriginalRoomDispatchCustody;
  source: Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
  dueAt: string;
  producer: OriginalRoomRouteDraft['producer'];
}
export interface RoomTransactionDraft {
  store: import('../../store.js').DocChannelStore;
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
  principals: import('../../../../connectors/principal/runtime-principal-service.js').ConnectorRuntimePrincipalService;
  source: Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
  roomCustody?: import('../../../../rooms/service/room-core.js').OriginalRoomDispatchCustody;
  dueAt: string;
  selector: Readonly<{ documentId: string; batchId: string; generation: string }>;
}

/** Opaque original native COMMIT + private SAMEbudget FIRST; caller data cannot mint it. */
export interface OriginalCommittedRoomResponder {
  readonly kind: 'original-committed-room-responder';
}

/** Pure constructor tuple shape; original owning WeakMap remains in the helper. */
export interface OriginalRoomResponderOwnerData {
  delegate: import('../../operations/room-responder-operation.js').OriginalRoomResponderOperation;
  authorization: import('../../authorization.js').DocChannelAuthorization;
  engine: CurrentDocOperationEngineCore;
  db: import('@dorkos/db').Db;
  principals: import('../../../../connectors/principal/runtime-principal-service.js').ConnectorRuntimePrincipalService;
  roomStore: import('../../../../rooms/room-store.js').RoomStore;
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
    projector: import('../../../../session/session-state-projector.js').SessionStateProjector,
    event: import('@dorkos/shared/session-stream').SessionEvent
  ): void;
  terminal(
    projector: import('../../../../session/session-state-projector.js').SessionStateProjector,
    event: import('@dorkos/shared/session-stream').SessionEvent,
    outcome: 'turn_done' | 'failed' | 'cancelled' | undefined
  ): void;
}
