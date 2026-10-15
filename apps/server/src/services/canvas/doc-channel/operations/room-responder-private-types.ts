import type {
  CanvasChannelSendRequest,
  IngestReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import type { OriginalDownstreamRoomEmitter } from '../downstream/native-room-emitter.js';
import type { OriginalRoomCommittedData } from '../current/current-operation-types.js';
import type { Db, DbTransaction } from '@dorkos/db';
import type { FixedNativeRoomDocFacade } from '@dorkos/db/internal-server';
import type { RoomStore } from '../../../rooms/room-store.js';
import type { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import type {
  OriginalFrozenRoomSource,
  FrozenRoomSourceData,
  OriginalCommittedRoomResponder,
  OriginalRoomEmissionStage,
  PreparedRoomResponder,
} from '../current/current-operation-types.js';

/** Original private emission owner shape; type fields alone confer no membership. */
export interface ActiveEmissionOwner {
  db: Db;
  prepare: () => Promise<OriginalRoomEmissionStage>;
}

/** Original private emission owner shape; type fields alone confer no membership. */
export interface EmissionStageOwner {
  effectiveTargetSessionId: string;
  db: Db;
  token: OriginalCommittedRoomResponder;
  committed: OriginalRoomCommittedData;
  principal: import('../../../connectors/principal/server-principal.js').ServerPrincipalProof;
  source: Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
  principals: object;
  phase: 'prepared' | 'ready' | 'active' | 'retired';
  tx?: DbTransaction;
  refresh: () => void;
  require: () => void;
  readNativeBinding: (bindingId: string) => Readonly<Record<string, unknown>> | undefined;
  readNativeTarget: () => readonly Readonly<Record<string, unknown>>[];
  frameState: 'not_started' | 'open' | 'closed' | 'unknown';
  closeFailure?: Readonly<{ cause: unknown }>;
  run: (
    stage: OriginalRoomEmissionStage,
    emitter: OriginalDownstreamRoomEmitter,
    request: CanvasChannelSendRequest
  ) => { receipt: IngestReceipt };
}

/** Fixed original responder-emission maps, selected only by a private module key. */
export interface OriginalRoomResponderCustodyView {
  readonly committedRoomResponders: WeakMap<
    OriginalCommittedRoomResponder,
    OriginalRoomCommittedData
  >;
  readonly activeEmissionOwners: WeakMap<OriginalCommittedRoomResponder, ActiveEmissionOwner>;
  readonly emissionStages: WeakMap<OriginalRoomEmissionStage, EmissionStageOwner>;
  readonly originalEmissionFrames: WeakMap<
    OriginalRoomEmissionStage,
    { db: Db; tx: DbTransaction; emitter: OriginalDownstreamRoomEmitter }
  >;
  readonly closedRoomCommitments: WeakMap<
    object,
    Readonly<{
      runtime: object;
      prepared: PreparedRoomResponder;
      operation: object;
    }>
  >;
}

/** Original private prepared responder data. */
export interface OriginalPreparedRoomResponderOwner {
  runtime: object;
  runtimeHandle: object;
  source: OriginalFrozenRoomSource;
  own: FrozenRoomSourceData;
  nativeOperation: object;
  acquisition: object;
}
/** Constructor-fixed original commitment ports; public native/facade values cannot select this view. */
export interface OriginalRoomResponderCommitView extends OriginalRoomResponderCustodyView {
  readonly db: Db;
  readonly principals: ConnectorRuntimePrincipalService;
  readonly roomStore: RoomStore;
  readonly facade: FixedNativeRoomDocFacade;
  readonly claiming: WeakSet<PreparedRoomResponder>;
  readonly readPrepared: (
    runtime: object,
    prepared: PreparedRoomResponder,
    emissionStage?: OriginalRoomEmissionStage
  ) => OriginalPreparedRoomResponderOwner;
  readonly requireCurrentResponder: (
    runtime: object,
    prepared: PreparedRoomResponder,
    expectedCursor?: number,
    originalEmissionTime?: number,
    emissionStage?: OriginalRoomEmissionStage
  ) => void;
  readonly closePrepared: (prepared: PreparedRoomResponder) => void;
  readonly requireEmissionStage: (stage: OriginalRoomEmissionStage, db: Db) => EmissionStageOwner;
  readonly now: typeof Date.now;
  readonly Date: typeof Date;
  readonly iso: typeof Date.prototype.toISOString;
}
