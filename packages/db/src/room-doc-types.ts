/** Internal types only. No runtime value, custody mint, database or authority check. */
import type { NativeSpendReceipt } from './room-spend-witness.js';
import type { openProtectedRoomNativeDatabase } from './room-spend-native.js';
import type { RoomDocRow } from './room-doc-rows.js';
type Native = ReturnType<typeof openProtectedRoomNativeDatabase>;
export interface RoomDocInput {
  eventId: string;
  docSeq: number;
  envelopeHash: string;
  direction: string;
  type: string;
  payload: string;
  provenance: string;
  status: string;
  reason: string | null;
  ackOutcome: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  ackEvidence: string | null;
}

export interface RoomDocMemoryFact {
  identity: object;
  roomId: string;
  at: number;
  receipt?: NativeSpendReceipt;
}

export interface RoomDocSourceCommon {
  documentId: string;
  batchId: string;
  generation: string;
  sourceAttempt: number;
  admissionId: string;
  scope: string;
  roomId: string;
  grantId: string;
  grantRevision: number;
  routeId: string;
  routeHash: string;
  declarationHash: string;
  manifestHash: string | null;
  normalizedRouteJson: string;
  grantLimitsJson: string;
  approvalId: string;
  approvalInputHash: string;
  approvalEvidenceJson: string;
  producerEvidenceJson: string;
  originalSourceJson: string;
  originalSourceHash: string;
  inputEventIdsJson: string;
  effectivePayloadJson: string;
  inputFingerprint: string;
  authorityDigest: string;
  effectivePayloadDigest: string;
  targetAgentId: string;
  targetAuthorId: string;
  targetSessionId: string;
  targetRuntime: string;
  targetAgentPath: string;
  originalError: string | null;
  originalLease: string | null;
  originalUpdatedAt: string;
  inputs: readonly RoomDocInput[];
}

export interface RoomDocClaimFields {
  effectiveTargetSessionId: string;
  barrierIso: string;
  nowIso: string;
  atMs: number;
  globalFloorMs: number;
  documentFloorMs: number;
  globalCap: number | null;
  roomCap: number | null;
  documentCap: number;
  systemAuthorId: string;
  entryId: string;
  appBodyJson: string;
  cascadeRoot: string;
  rootRoomId: string;
  rootEntryId: string;
  entryDepth: number;
  frozenCeiling: number;
  expectedReadSeq: number;
  dispatchId: string;
  memoryFacts: readonly RoomDocMemoryFact[];
}

export type RoomDocNativeFrameState = {
  generation: number;
  state: 'open' | 'committing' | 'committed' | 'rolled_back' | 'unknown';
};

export type BarrierState = {
  data: Readonly<RoomDocClaimData>;
  status: 'prepared' | 'final_attempted' | 'rolled_back' | 'committed' | 'released' | 'unknown';
};

export type CommitState = {
  fact: RoomDocCommittedFact;
  data: Readonly<RoomDocClaimData>;
  rowId: number;
  generation: number;
  bootEpoch: string;
};

export interface OriginalReacquiredAcceptedRoomSource {
  readonly kind: 'original-reacquired-accepted-room-source';
}
export interface OriginalReacquiredPendingRoomSource {
  readonly kind: 'original-reacquired-pending-room-source';
}
export interface AcceptedRoomSourceKey {
  documentId: string;
  batchId: string;
  generation: string;
}
/** Comparison data, consumed only after the original server writer's private commit/lease witness. */
export interface OriginalCheckboxUndoPairData {
  documentId: string;
  intentId: string;
  documentGeneration: string;
  currentIntentJson: string;
  physicalJson: string;
  channelBirthJson: string;
}

export interface ServerNativeRoomConstruction {
  readonly kind: 'server-native-room-construction';
}

export interface FixedNativeRoomDocFacade {
  runOriginalCommittedRoomEmission<T>(
    commit: NativeRoomDocCommit,
    work: (queryDb: object, sourceDb: object) => T
  ): RoomDocEmissionOutcome<T>;
  cancelOriginalCheckboxUndoPair(
    data: OriginalCheckboxUndoPairData
  ): RoomDocOutcome<readonly AcceptedRoomSourceKey[]>;
  readDocPhysicalAndChannelBirth(documentId: string): {
    document?: RoomDocRow;
    channel?: RoomDocRow;
    identityIntents: readonly RoomDocRow[];
  };
  readOriginalDocGrant(grantId: string): RoomDocRow | undefined;
  readConsumedOriginalApproval(approvalId: string): RoomDocRow | undefined;
  readAppliedGlobalScopeAliases(cursor?: string): readonly RoomDocRow[];
  readGlobalScopeAliasHistory(cursor?: string): readonly RoomDocRow[];
  readCurrentOwnerAccount(): RoomDocRow | undefined;
  readCurrentRoomMembership(
    roomId: string,
    subjectKey: string
  ): { room?: RoomDocRow; authors: readonly RoomDocRow[]; members: readonly RoomDocRow[] };
  readOriginalRuntimeBinding(bindingId: string): RoomDocRow | undefined;
  readOriginalEmissionTargetBinding(
    source: Pick<
      RoomDocSourceData,
      'roomId' | 'targetAgentId' | 'targetSessionId' | 'targetRuntime'
    >
  ): readonly RoomDocRow[];
  readFrozenAcceptedRoomSource(key: AcceptedRoomSourceKey): RoomDocRow | undefined;
  readOrderedAcceptedRoomInputs(key: AcceptedRoomSourceKey): readonly RoomDocRow[];
  readAcceptedRoomStatusAndDeliverySlice(key: AcceptedRoomSourceKey): {
    batch?: RoomDocRow;
    events: readonly RoomDocRow[];
    deliveries: readonly RoomDocRow[];
  };
  reacquirePendingUnclaimedSource(
    key: AcceptedRoomSourceKey
  ): RoomDocOutcome<OriginalReacquiredPendingRoomSource>;
  readReacquiredPendingSource(
    token: OriginalReacquiredPendingRoomSource
  ): Readonly<RoomDocSourceData>;
  scanPendingUnclaimed(cursorAt?: string, cursorId?: string): readonly RoomDocRow[];
  reacquireAcceptedUnclaimedSource(
    key: AcceptedRoomSourceKey
  ): RoomDocOutcome<OriginalReacquiredAcceptedRoomSource>;
  readReacquiredAcceptedSource(
    token: OriginalReacquiredAcceptedRoomSource
  ): Readonly<RoomDocSourceData>;
  freezeProducerAcceptedRoomSource(
    source: RoomDocSourceData
  ): RoomDocOutcome<Readonly<AcceptedRoomSourceKey>>;
  prepareAcceptedBarrier(input: RoomDocClaimData): RoomDocOutcome<ConfirmedRoomBarrier>;
  commitPreparedRoomDoc(
    barrier: ConfirmedRoomBarrier,
    input: RoomDocClaimData
  ): RoomDocOutcome<NativeRoomDocCommit>;
  releaseKnownPreparedBarrier(barrier: ConfirmedRoomBarrier): RoomDocOutcome<ConfirmedRoomBarrier>;
  readCommittedFact(commit: NativeRoomDocCommit): RoomDocCommittedFact;
  recoverPreviousBoot(): RoomDocOutcome<void>;
  scanAcceptedUnclaimed(cursorAt?: string, cursorId?: string): readonly RoomDocRow[];
  observeProjectedStart(
    commit: NativeRoomDocCommit,
    turnId: string
  ): RoomDocOutcome<NativeRoomDocCommit>;
  markClaimUnknown(commit: NativeRoomDocCommit): RoomDocOutcome<NativeRoomDocCommit>;
  settleKnownTerminal(
    commit: NativeRoomDocCommit,
    outcome: 'turn_done' | 'failed' | 'cancelled'
  ): RoomDocOutcome<NativeRoomDocCommit>;
  pruneSettledRoomReceipts(): RoomDocOutcome<number>;
}

export interface RoomDocNativeOrigin {
  readonly kind: 'room-native-origin';
}

export interface ConfirmedRoomBarrier {
  readonly kind: 'room-doc-barrier';
}

export interface NativeRoomDocCommit {
  readonly kind: 'room-doc-commit';
}

export type RoomDocFence = { state: 'clear' | 'potential' | 'unavailable' };

export type RoomDocOutcome<T> = { state: 'confirmed'; value: T } | { state: 'refused' | 'unknown' };

export interface RoomDocCommittedFact {
  readonly identity: NativeRoomDocCommit;
  readonly roomId: string;
  readonly at: number;
  readonly receipt: NativeSpendReceipt;
  readonly sourceHash: string;
  readonly admissionId: string;
}

export interface RoomDocStorage {
  readRoomLimitData(
    origin: RoomDocNativeOrigin,
    sourceDb: object,
    roomId: string
  ): ReturnType<Native['readRoomLimitData']>;
  inspectAcceptedRoomDoc(
    origin: RoomDocNativeOrigin,
    sourceDb: object,
    input: RoomDocClaimData
  ): RoomDocOutcome<Readonly<RoomDocRow>>;
  prepareAcceptedBarrier(
    origin: RoomDocNativeOrigin,
    sourceDb: object,
    input: RoomDocClaimData
  ): RoomDocOutcome<ConfirmedRoomBarrier>;
  commitPreparedRoomDoc(
    origin: RoomDocNativeOrigin,
    sourceDb: object,
    barrier: ConfirmedRoomBarrier,
    input: RoomDocClaimData
  ): RoomDocOutcome<NativeRoomDocCommit>;
  releaseKnownPreparedBarrier(
    origin: RoomDocNativeOrigin,
    sourceDb: object,
    barrier: ConfirmedRoomBarrier
  ): RoomDocOutcome<ConfirmedRoomBarrier>;
  readCommittedFact(
    origin: RoomDocNativeOrigin,
    sourceDb: object,
    commit: NativeRoomDocCommit
  ): RoomDocCommittedFact;
}

export interface RoomDocSpendBridge {
  overlap(
    frame: object,
    receipts: readonly NativeSpendReceipt[],
    roomId: string,
    floor: number,
    at: number
  ): { global: number; room: number };
  issue(frame: object, roomId: string, at: number, rowId: number): NativeSpendReceipt;
  observe(): string;
}

export type RoomDocNativeReaders = Pick<
  FixedNativeRoomDocFacade,
  | 'readDocPhysicalAndChannelBirth'
  | 'readOriginalDocGrant'
  | 'readConsumedOriginalApproval'
  | 'readAppliedGlobalScopeAliases'
  | 'readGlobalScopeAliasHistory'
  | 'readCurrentOwnerAccount'
  | 'readCurrentRoomMembership'
  | 'readOriginalRuntimeBinding'
  | 'readOriginalEmissionTargetBinding'
  | 'readFrozenAcceptedRoomSource'
  | 'readOrderedAcceptedRoomInputs'
  | 'readAcceptedRoomStatusAndDeliverySlice'
>;
export type RoomDocObservedRow = {
  operation: import('./room-doc-statements.js').RoomDocNativeOperation;
  bindings: Record<string, unknown>;
  value: string;
};

export type RoomDocNative = Native;
export type ServerRoomConstructionState = {
  used: boolean;
  requireDb(db: object): void;
  facade: FixedNativeRoomDocFacade;
};
export type RoomDocStrictCounts = { global_count: number; room_count: number };

export type RoomDocServerConstructions = WeakMap<
  ServerNativeRoomConstruction,
  ServerRoomConstructionState
>;

export type RoomDocSourceData = RoomDocSourceCommon &
  (
    | { producerOrigin: 'runtime'; producerBindingId: string }
    | { producerOrigin: 'operator'; producerBindingId: null }
    | { producerOrigin: 'doc_token'; producerBindingId: null }
  );
export type RoomDocClaimData = RoomDocSourceData & RoomDocClaimFields;
export interface RoomDocOperatorEvidence {
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

export interface RoomDocTokenEvidence extends Omit<RoomDocOperatorEvidence, 'kind'> {
  kind: 'doc_token';
  tokenId: string;
  tokenHash: string;
  tokenCreatedAt: string;
  tokenExpiresAt: string;
  tokenIssuerJson: string;
}

export type RoomDocEmissionOutcome<T> =
  { state: 'confirmed'; value: T } | { state: 'refused' | 'unknown'; cause: unknown };
