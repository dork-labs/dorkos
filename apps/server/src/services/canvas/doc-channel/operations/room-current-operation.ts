import { type RuntimeRegistry } from '../../../core/runtime-registry.js';
import { DetachedTurnLifecycle } from '../../../session/trigger-turn.js';
export { retireOriginalRoomResponderStream } from './room-responder-stream-retirement.js';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import { type Db, type DbTransaction } from '@dorkos/db';
import {
  consumeServerNativeRoomConstruction,
  type ServerNativeRoomConstruction,
  type FixedNativeRoomDocFacade,
} from '@dorkos/db/internal-server';
import { type RoomStore } from '../../../rooms/room-store.js';
import {
  requireNativePrincipalDatabase,
  type ConnectorRuntimePrincipalService,
} from '../../../connectors/principal/runtime-principal-service.js';
import { requireCurrentDocEngineOrigin, type DocChannelAuthorization } from '../authorization.js';
import { type DocIngestLimits } from '../current/accounting.js';
import { type DocChannelStore } from '../store.js';
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
import { OriginalRoomResponderOperation } from './room-responder-operation.js';
import * as sourceCustody from './room-operation-source-custody.js';
import {
  createOriginalRoomOperationPublicCustody,
  type OriginalRoomOperationPublicCustody,
} from './room-operation-public-custody.js';
import type {
  OriginalRoomOperationView,
  OriginalRoomOperationCustodyView,
} from './room-operation-private-types.js';
import * as room_operation_recovery from './room-operation-recovery.js';
import * as room_operation_acceptance from './room-operation-acceptance.js';
import * as room_operation_seal_audit from './room-operation-seal-audit.js';
import * as room_operation_responder from './room-operation-responder.js';
import * as room_operation_pump from './room-operation-pump.js';
import * as room_operation_relay from './room-operation-relay.js';

export {
  requireOriginalCommittedRoomResponder,
  requireCurrentOriginalCommittedRoomResponder,
  consumeOriginalCommittedRoomResponder,
  retireOriginalCommittedRoomResponder,
} from './room-responder-operation.js';

const originalDate = Date;
const originalDateNow = Date.now;
const originalIso = Date.prototype.toISOString;
const originalRoomPendingCounts = new WeakMap<object, (tx: DbTransaction) => number>();
const originalRoomResponderOwners = new WeakMap<
  CurrentRoomOperation,
  OriginalRoomResponderOwnerData
>();
const originalRoomReplayAvailability = new WeakMap<CurrentRoomOperation, () => boolean>();
const originalRoomOperatorSources = new WeakMap<
  object,
  {
    engine: CurrentDocOperationEngineCore;
    db: Db;
    read: () => Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
  }
>();
const originalRoomTokenSources = new WeakMap<
  object,
  {
    engine: CurrentDocOperationEngineCore;
    db: Db;
    read: () => Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
  }
>();
const frozenRoomSources = new WeakMap<OriginalFrozenRoomSource, FrozenRoomSourceData>();
const custodyKey = Object.freeze({});
const custodyViews = new WeakMap<object, OriginalRoomOperationCustodyView>();
const operationViews = new WeakMap<object, OriginalRoomOperationView>();
const operationApply = Reflect.apply;
const operationGet = WeakMap.prototype.get;
const operationSet = WeakMap.prototype.set;
operationApply(operationSet, custodyViews, [
  custodyKey,
  Object.freeze({
    originalRoomPendingCounts,
    originalRoomResponderOwners,
    originalRoomReplayAvailability,
    originalRoomOperatorSources,
    originalRoomTokenSources,
    frozenRoomSources,
  }),
]);
/** Select only original module maps by the unreachable module-private key. */
export function readOriginalRoomOperationCustodyView(
  owner: object
): OriginalRoomOperationCustodyView {
  const view = operationApply(operationGet, custodyViews, [owner]) as
    OriginalRoomOperationCustodyView | undefined;
  if (!view) throw new Error('Original room-operation source custody required');
  return view;
}
/** Select only an original constructor's fixed live private view before effects. */
export function readOriginalRoomOperationView(owner: object): OriginalRoomOperationView {
  const view = operationApply(operationGet, operationViews, [owner]) as
    OriginalRoomOperationView | undefined;
  if (!view) throw new Error('Original room-operation constructor required');
  return view;
}
/** Original public room-operation membership lookups. */
const originalRoomCurrentExplicitPublicBindings: Readonly<OriginalRoomOperationPublicCustody> =
  createOriginalRoomOperationPublicCustody(custodyKey);
/** Original public function reference with its exact named declaration contract. */
export const readOriginalRoomPendingWriteCount: OriginalRoomOperationPublicCustody['readOriginalRoomPendingWriteCount'] =
  originalRoomCurrentExplicitPublicBindings.readOriginalRoomPendingWriteCount;
/** Original public function reference with its exact named declaration contract. */
export const readOriginalRoomReplayAvailability: OriginalRoomOperationPublicCustody['readOriginalRoomReplayAvailability'] =
  originalRoomCurrentExplicitPublicBindings.readOriginalRoomReplayAvailability;
/** Original public function reference with its exact named declaration contract. */
export const requireOriginalRoomResponderOwner: OriginalRoomOperationPublicCustody['requireOriginalRoomResponderOwner'] =
  originalRoomCurrentExplicitPublicBindings.requireOriginalRoomResponderOwner;
/** Original public function reference with its exact named declaration contract. */
export const readOriginalRoomResponderFrozenSource: OriginalRoomOperationPublicCustody['readOriginalRoomResponderFrozenSource'] =
  originalRoomCurrentExplicitPublicBindings.readOriginalRoomResponderFrozenSource;
/** Original public function reference with its exact named declaration contract. */
export const readOriginalRoomOperatorSource: OriginalRoomOperationPublicCustody['readOriginalRoomOperatorSource'] =
  originalRoomCurrentExplicitPublicBindings.readOriginalRoomOperatorSource;
/** Original public function reference with its exact named declaration contract. */
export const readOriginalRoomTokenSource: OriginalRoomOperationPublicCustody['readOriginalRoomTokenSource'] =
  originalRoomCurrentExplicitPublicBindings.readOriginalRoomTokenSource;
/** Original public function reference with its exact named declaration contract. */
export const readOriginalFrozenRoomTarget: OriginalRoomOperationPublicCustody['readOriginalFrozenRoomTarget'] =
  originalRoomCurrentExplicitPublicBindings.readOriginalFrozenRoomTarget;
/** Original public function reference with its exact named declaration contract. */
export const requireOriginalRoomPrincipalService: OriginalRoomOperationPublicCustody['requireOriginalRoomPrincipalService'] =
  originalRoomCurrentExplicitPublicBindings.requireOriginalRoomPrincipalService;
const originalDocPrivateConstructionFreeze = Object.freeze;

/** Only an actual engine constructor may retain this object; no scope/identity registration API. */
export class CurrentRoomOperation {
  readonly #operationKey = originalDocPrivateConstructionFreeze({});
  readonly #facade: FixedNativeRoomDocFacade;
  readonly #drafts = new WeakMap<DbTransaction, TransactionDraft>();
  readonly #pendingLimits = new WeakMap<DbTransaction, Readonly<DocIngestLimits>>();
  readonly #pending = new Map<string, PendingSource>();
  readonly #unavailable = new Set<string>();
  readonly #frozen = new Map<string, OriginalFrozenRoomSource>();
  readonly #relayListeners = new Set<
    (documentId: string, batchId: string, generation: string) => void
  >();
  #pumpClosed = false;
  readonly #pumpWork = new Set<Promise<void>>();
  readonly #pumpHolders = new Set<DetachedTurnLifecycle>();
  readonly #pumpStreams = new Set<AsyncGenerator<import('@dorkos/shared/types').StreamEvent>>();
  #pumpStop: Promise<void> | undefined;
  readonly #pumpScenarioEvidence = new Map<
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
  >();
  /** Exact original source diagnostics only; absent/collected/non-TestMode evidence is UNKNOWN, never zero. */
  readScenarioEvidence(
    documentId: string,
    batchId: string,
    generation: string
  ):
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
    | undefined {
    return room_operation_pump.readScenarioEvidence(
      this.#operationKey,
      documentId,
      batchId,
      generation
    );
  }

  readonly #preparing = new Set<string>();
  readonly #preparationUnknown = new Set<string>();
  readonly #responder: OriginalRoomResponderOperation;
  readonly #db: Db;
  readonly #authorization: DocChannelAuthorization;
  readonly #engine: CurrentDocOperationEngineCore;
  readonly #principals: ConnectorRuntimePrincipalService;
  readonly #roomStore: RoomStore;
  constructor(
    authorization: DocChannelAuthorization,
    engine: CurrentDocOperationEngineCore,
    db: Db,
    principals: ConnectorRuntimePrincipalService,
    roomStore: RoomStore,
    custody: ServerNativeRoomConstruction
  ) {
    requireCurrentDocEngineOrigin(authorization, engine, db);
    requireNativePrincipalDatabase(principals, db);
    this.#facade = consumeServerNativeRoomConstruction(custody, db);
    // The original newly opened native construction owns its boot epoch and synchronous recovery.
    // Refusal/unknown never publishes a responder or reconstructs previous prepared authority.
    const recovery = this.#facade.recoverPreviousBoot();
    if (recovery.state !== 'confirmed')
      throw new Error(`Native Room previous-boot recovery ${recovery.state}; engine unavailable.`);

    this.#authorization = authorization;
    this.#engine = engine;
    this.#db = db;
    this.#principals = principals;
    this.#roomStore = roomStore;
    this.#responder = new OriginalRoomResponderOperation(
      this,
      engine,
      db,
      principals,
      roomStore,
      this.#facade
    );
    originalRoomResponderOwners.set(this, {
      delegate: this.#responder,
      authorization,
      engine,
      db,
      principals,
      roomStore,
      facade: this.#facade,
    });
    originalRoomPendingCounts.set(this, (tx) => this.#drafts.get(tx)?.sealed?.length ?? 0);

    const createOriginalView = (
      operation: CurrentRoomOperation
    ): Readonly<OriginalRoomOperationView> =>
      originalDocPrivateConstructionFreeze<OriginalRoomOperationView>({
        originalOwner: this,
        get facade() {
          return operation.#facade;
        },
        get drafts() {
          return operation.#drafts;
        },
        get pendingLimits() {
          return operation.#pendingLimits;
        },
        get pending() {
          return operation.#pending;
        },
        get unavailable() {
          return operation.#unavailable;
        },
        get frozen() {
          return operation.#frozen;
        },
        get relayListeners() {
          return operation.#relayListeners;
        },
        get pumpClosed() {
          return operation.#pumpClosed;
        },
        set pumpClosed(value: boolean) {
          operation.#pumpClosed = value;
        },
        get pumpWork() {
          return operation.#pumpWork;
        },
        get pumpHolders() {
          return operation.#pumpHolders;
        },
        get pumpStreams() {
          return operation.#pumpStreams;
        },
        get pumpStop() {
          return operation.#pumpStop;
        },
        set pumpStop(value: Promise<void> | undefined) {
          operation.#pumpStop = value;
        },
        get pumpScenarioEvidence() {
          return operation.#pumpScenarioEvidence;
        },
        get preparing() {
          return operation.#preparing;
        },
        get preparationUnknown() {
          return operation.#preparationUnknown;
        },
        get responder() {
          return operation.#responder;
        },
        get db() {
          return operation.#db;
        },
        get authorization() {
          return operation.#authorization;
        },
        get engine() {
          return operation.#engine;
        },
        get principals() {
          return operation.#principals;
        },
        get roomStore() {
          return operation.#roomStore;
        },
        readScenarioEvidence: (documentId, batchId, generation) =>
          operation.readScenarioEvidence(documentId, batchId, generation),
        reacquirePendingUnclaimed: () => operation.#reacquirePendingUnclaimed(),
        reacquireAcceptedUnclaimed: () => operation.#reacquireAcceptedUnclaimed(),
        pruneSettledReceipts: () => operation.pruneSettledReceipts(),
        prepare: (store, grants, tx) => operation.prepare(store, grants, tx),
        prepareReplay: (store, grants, tx, previousBatchId, now) =>
          operation.prepareReplay(store, grants, tx, previousBatchId, now),
        seal: (store, tx, limits) => operation.seal(store, tx, limits),
        checkPendingCapacity: (tx, documentId, limits) =>
          operation.#checkPendingCapacity(tx, documentId, limits),
        pendingCapsule: (pending) => operation.#pendingCapsule(pending),
        audit: (store, grants, tx) => operation.audit(store, grants, tx),
        prepareResponder: (runtime, holder, key) =>
          operation.prepareResponder(runtime, holder, key),
        prepareFrozenResponder: (runtime, holder, key, pair) =>
          operation.#prepareFrozenResponder(runtime, holder, key, pair),
        pump: (registry) => operation.pump(registry),
        stopPump: () => operation.stopPump(),
        runPump: (registry) => operation.#runPump(registry),
        commitResponder: (runtime, prepared) => operation.commitResponder(runtime, prepared),
        retainConfirmedFreeze: (pending, selector) =>
          operation.#retainConfirmedFreeze(pending, selector),
        subscribeRelay: (listener) => operation.subscribeRelay(listener),
        notifyRelay: (documentId, batchId, generation) =>
          operation.#notifyRelay(documentId, batchId, generation),
        hintRelay: (documentId, batchId, generation) =>
          operation.hintRelay(documentId, batchId, generation),
        nextDueAt: () => operation.nextDueAt(),
        freezeDue: () => operation.freezeDue(),
        committed: (tx, now) => operation.committed(tx, now),
        abandoned: (tx) => operation.abandoned(tx),
        cancelOriginalCheckboxUndoPair: (store, owner, tx, baseline) =>
          operation.cancelOriginalCheckboxUndoPair(store, owner, tx, baseline),
        originalRoomPendingCounts,
        originalRoomResponderOwners,
        originalRoomReplayAvailability,
        originalRoomOperatorSources,
        originalRoomTokenSources,
        frozenRoomSources,
        now: () => originalDateNow(),
        Date: originalDate,
        iso: originalIso,
        readCurrentFrozenRoomDestination: (own) =>
          sourceCustody.readCurrentFrozenRoomDestination(custodyKey, own),
      });
    operationApply(operationSet, operationViews, [this.#operationKey, createOriginalView(this)]);
    this.#reacquirePendingUnclaimed();
    this.#reacquireAcceptedUnclaimed();
    originalRoomReplayAvailability.set(this, () => !this.#pumpClosed);
  }
  #reacquirePendingUnclaimed(): void {
    return room_operation_recovery.reacquirePendingUnclaimed(this.#operationKey);
  }
  #reacquireAcceptedUnclaimed(): void {
    return room_operation_recovery.reacquireAcceptedUnclaimed(this.#operationKey);
  }
  /** Native maintenance only: package-owned cutoff and guard, never actor/time DTO authority. */
  pruneSettledReceipts(): void {
    return room_operation_recovery.pruneSettledReceipts(this.#operationKey);
  }
  prepare(store: DocChannelStore, grants: DocChannelGrants, tx: DbTransaction): void {
    return room_operation_acceptance.prepare(this.#operationKey, store, grants, tx);
  }
  /** Capture replay custody from the original expired rows before any replay effect. */
  prepareReplay(
    store: DocChannelStore,
    grants: DocChannelGrants,
    tx: DbTransaction,
    previousBatchId: string,
    now: string
  ): import('../store.js').DocBatchRow {
    return room_operation_acceptance.prepareReplay(
      this.#operationKey,
      store,
      grants,
      tx,
      previousBatchId,
      now
    );
  }
  seal(store: DocChannelStore, tx: DbTransaction, limits: DocIngestLimits): void {
    return room_operation_seal_audit.seal(this.#operationKey, store, tx, limits);
  }
  #checkPendingCapacity(tx: DbTransaction, documentId: string, limits: DocIngestLimits): void {
    return room_operation_seal_audit.checkPendingCapacity(
      this.#operationKey,
      tx,
      documentId,
      limits
    );
  }
  #pendingCapsule(pending: PendingSource): {
    document_id: string;
    batch_id: string;
    generation: string;
    source_json: string;
    source_hash: string;
    due_at: string;
    updated_at: string;
  } {
    return room_operation_seal_audit.pendingCapsule(this.#operationKey, pending);
  }
  audit(store: DocChannelStore, grants: DocChannelGrants, tx: DbTransaction): void {
    return room_operation_seal_audit.audit(this.#operationKey, store, grants, tx);
  }
  /** Original frozen target is selected privately; neither caller IDs nor a copied key issue source custody. */
  async prepareResponder(
    runtime: object,
    holder: SseResponse,
    key: string
  ): Promise<import('../current/current-operation-types.js').PreparedRoomResponder | undefined> {
    return room_operation_responder.prepareResponder(this.#operationKey, runtime, holder, key);
  }
  async #prepareFrozenResponder(
    runtime: object,
    holder: SseResponse,
    key: string,
    pair: readonly [string, OriginalFrozenRoomSource]
  ): Promise<PreparedRoomResponder | undefined> {
    return room_operation_responder.prepareFrozenResponder(
      this.#operationKey,
      runtime,
      holder,
      key,
      pair
    );
  }
  /** Owned due pump: fixed source selection, real lock acquisition, native claim/FIRST then same-entry stream. */
  pump(registry: RuntimeRegistry): Promise<void> {
    return room_operation_pump.pump(this.#operationKey, registry);
  }
  stopPump(): Promise<void> {
    return room_operation_pump.stopPump(this.#operationKey);
  }
  async #runPump(registry: RuntimeRegistry): Promise<void> {
    return room_operation_pump.runPump(this.#operationKey, registry);
  }
  commitResponder(
    runtime: object,
    prepared: PreparedRoomResponder
  ): OriginalCommittedRoomResponder {
    return room_operation_responder.commitResponder(this.#operationKey, runtime, prepared);
  }
  #retainConfirmedFreeze(
    pending: PendingSource,
    selector: Readonly<{ documentId: string; batchId: string; generation: string }>
  ): void {
    return room_operation_relay.retainConfirmedFreeze(this.#operationKey, pending, selector);
  }
  /** Subscribe to confirmed eligible native Room identifiers, never source or claim authority. */
  subscribeRelay(
    listener: (documentId: string, batchId: string, generation: string) => void
  ): () => void {
    return room_operation_relay.subscribeRelay(this.#operationKey, listener);
  }
  #notifyRelay(documentId: string, batchId: string, generation: string): void {
    return room_operation_relay.notifyRelay(this.#operationKey, documentId, batchId, generation);
  }
  /** Identifier hints revisit only this engine's retained original Room custody. */
  hintRelay(documentId: string, batchId: string, generation: string): boolean {
    return room_operation_relay.hintRelay(this.#operationKey, documentId, batchId, generation);
  }
  /** Earliest retained original deadline; this reveals no source or responder authority. */
  nextDueAt(): string | undefined {
    return room_operation_relay.nextDueAt(this.#operationKey);
  }
  /** Wake only authentic committed custody. Native freeze repeats the original fixed SQL facts. */
  freezeDue(): void {
    return room_operation_relay.freezeDue(this.#operationKey);
  }
  committed(tx: DbTransaction, now: string): void {
    return room_operation_relay.committed(this.#operationKey, tx, now);
  }
  abandoned(tx: DbTransaction): void {
    return room_operation_relay.abandoned(this.#operationKey, tx);
  }
  /** Only the still-active original writer completion can request this fixed native optimization. */
  cancelOriginalCheckboxUndoPair(
    store: DocChannelStore,
    owner: object,
    tx: DbTransaction,
    baseline: {
      generation: string;
      physical: Record<string, unknown>;
      channelBirth: Record<string, unknown>;
      now: string;
    }
  ): void {
    return room_operation_relay.cancelOriginalCheckboxUndoPair(
      this.#operationKey,
      store,
      owner,
      tx,
      baseline
    );
  }
}
