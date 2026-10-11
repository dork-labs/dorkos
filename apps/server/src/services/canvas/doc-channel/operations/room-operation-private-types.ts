import type { RuntimeRegistry } from '../../../core/runtime-registry.js';
import type { DetachedTurnLifecycle } from '../../../session/trigger-turn.js';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import type { Db, DbTransaction } from '@dorkos/db';
import type { FixedNativeRoomDocFacade } from '@dorkos/db/internal-server';
import type { RoomStore } from '../../../rooms/room-store.js';
import type { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import type { DocChannelAuthorization } from '../authorization.js';
import type { DocIngestLimits } from '../current/accounting.js';
import type { DocChannelStore } from '../store.js';
import type { DocChannelGrants } from '../grants.js';
import type {
  OriginalRoomResponderOwnerData,
  OriginalFrozenRoomSource,
  CurrentDocOperationEngineCore,
  FrozenRoomSourceData,
  OriginalCommittedRoomResponder,
  PreparedRoomResponder,
  PendingRoomSource as PendingSource,
  RoomTransactionDraft as TransactionDraft,
} from '../current/current-operation-types.js';
import type { OriginalRoomResponderOperation } from './room-responder-operation.js';
import type { CurrentRoomOperation } from './room-current-operation.js';

/** Original room-operation private state projection; no caller structure establishes membership. */
export interface OriginalRoomOperationView {
  readonly originalOwner: CurrentRoomOperation;
  readonly facade: FixedNativeRoomDocFacade;
  readonly drafts: WeakMap<DbTransaction, TransactionDraft>;
  readonly pendingLimits: WeakMap<DbTransaction, Readonly<DocIngestLimits>>;
  readonly pending: Map<string, PendingSource>;
  readonly unavailable: Set<string>;
  readonly frozen: Map<string, OriginalFrozenRoomSource>;
  readonly relayListeners: Set<(documentId: string, batchId: string, generation: string) => void>;
  pumpClosed: boolean;
  readonly pumpWork: Set<Promise<void>>;
  readonly pumpHolders: Set<DetachedTurnLifecycle>;
  readonly pumpStreams: Set<AsyncGenerator<import('@dorkos/shared/types').StreamEvent>>;
  pumpStop: Promise<void> | undefined;
  readonly pumpScenarioEvidence: Map<
    string,
    {
      documentId: string;
      batchId: string;
      generation: string;
      sessionId: string;
      runtime?: WeakRef<object>;
      stream?: WeakRef<object>;
      scenarioStarts?: number;
      retired?: boolean;
      operationFailure?: { cause: unknown };
      cleanupClosed?: boolean;
    }
  >;
  readonly preparing: Set<string>;
  readonly preparationUnknown: Set<string>;
  readonly responder: OriginalRoomResponderOperation;
  readonly db: Db;
  readonly authorization: DocChannelAuthorization;
  readonly engine: CurrentDocOperationEngineCore;
  readonly principals: ConnectorRuntimePrincipalService;
  readonly roomStore: RoomStore;
  readonly readScenarioEvidence: (
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
        retired: boolean | undefined;
        operationFailed: boolean;
        cleanupClosed: boolean;
      }>
    | undefined;
  readonly reacquirePendingUnclaimed: () => void;
  readonly reacquireAcceptedUnclaimed: () => void;
  readonly pruneSettledReceipts: () => void;
  readonly prepare: (store: DocChannelStore, grants: DocChannelGrants, tx: DbTransaction) => void;
  readonly prepareReplay: (
    store: DocChannelStore,
    grants: DocChannelGrants,
    tx: DbTransaction,
    previousBatchId: string,
    now: string
  ) => import('../store.js').DocBatchRow;
  readonly seal: (store: DocChannelStore, tx: DbTransaction, limits: DocIngestLimits) => void;
  readonly checkPendingCapacity: (
    tx: DbTransaction,
    documentId: string,
    limits: DocIngestLimits
  ) => void;
  readonly pendingCapsule: (pending: PendingSource) => {
    document_id: string;
    batch_id: string;
    generation: string;
    source_json: string;
    source_hash: string;
    due_at: string;
    updated_at: string;
  };
  readonly audit: (store: DocChannelStore, grants: DocChannelGrants, tx: DbTransaction) => void;
  readonly prepareResponder: (
    runtime: object,
    holder: SseResponse,
    key: string
  ) => Promise<import('../current/current-operation-types.js').PreparedRoomResponder | undefined>;
  readonly prepareFrozenResponder: (
    runtime: object,
    holder: SseResponse,
    key: string,
    pair: readonly [string, OriginalFrozenRoomSource]
  ) => Promise<PreparedRoomResponder | undefined>;
  readonly pump: (registry: RuntimeRegistry) => Promise<void>;
  readonly stopPump: () => Promise<void>;
  readonly runPump: (registry: RuntimeRegistry) => Promise<void>;
  readonly commitResponder: (
    runtime: object,
    prepared: PreparedRoomResponder
  ) => OriginalCommittedRoomResponder;
  readonly retainConfirmedFreeze: (
    pending: PendingSource,
    selector: Readonly<{ documentId: string; batchId: string; generation: string }>
  ) => void;
  readonly subscribeRelay: (
    listener: (documentId: string, batchId: string, generation: string) => void
  ) => () => void;
  readonly notifyRelay: (documentId: string, batchId: string, generation: string) => void;
  readonly hintRelay: (documentId: string, batchId: string, generation: string) => boolean;
  readonly nextDueAt: () => string | undefined;
  readonly freezeDue: () => void;
  readonly committed: (tx: DbTransaction, now: string) => void;
  readonly abandoned: (tx: DbTransaction) => void;
  readonly cancelOriginalCheckboxUndoPair: (
    store: DocChannelStore,
    owner: object,
    tx: DbTransaction,
    baseline: {
      generation: string;
      physical: Record<string, unknown>;
      channelBirth: Record<string, unknown>;
      now: string;
    }
  ) => void;
  readonly originalRoomPendingCounts: WeakMap<object, (tx: DbTransaction) => number>;
  readonly originalRoomResponderOwners: WeakMap<
    CurrentRoomOperation,
    OriginalRoomResponderOwnerData
  >;
  readonly originalRoomReplayAvailability: WeakMap<CurrentRoomOperation, () => boolean>;
  readonly originalRoomOperatorSources: WeakMap<
    object,
    {
      engine: CurrentDocOperationEngineCore;
      db: Db;
      read: () => Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
    }
  >;
  readonly originalRoomTokenSources: WeakMap<
    object,
    {
      engine: CurrentDocOperationEngineCore;
      db: Db;
      read: () => Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
    }
  >;
  readonly frozenRoomSources: WeakMap<OriginalFrozenRoomSource, FrozenRoomSourceData>;
  readonly readCurrentFrozenRoomDestination: (own: FrozenRoomSourceData) => string;
  readonly now: () => number;
  readonly Date: typeof Date;
  readonly iso: typeof Date.prototype.toISOString;
}
/** Fixed original module membership maps, selected only by its private key. */
export interface OriginalRoomOperationCustodyView {
  readonly originalRoomPendingCounts: WeakMap<object, (tx: DbTransaction) => number>;
  readonly originalRoomResponderOwners: WeakMap<
    CurrentRoomOperation,
    OriginalRoomResponderOwnerData
  >;
  readonly originalRoomReplayAvailability: WeakMap<CurrentRoomOperation, () => boolean>;
  readonly originalRoomOperatorSources: WeakMap<
    object,
    {
      engine: CurrentDocOperationEngineCore;
      db: Db;
      read: () => Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
    }
  >;
  readonly originalRoomTokenSources: WeakMap<
    object,
    {
      engine: CurrentDocOperationEngineCore;
      db: Db;
      read: () => Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
    }
  >;
  readonly frozenRoomSources: WeakMap<OriginalFrozenRoomSource, FrozenRoomSourceData>;
}
