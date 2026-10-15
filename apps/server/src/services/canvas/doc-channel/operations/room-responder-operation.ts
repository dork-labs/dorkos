import {
  readOriginalRuntimePreparedResponder,
  retireOriginalRuntimePreparedResponder,
} from './room-operation-responder.js';
import { agentPause, AgentPausedError } from '../../../mesh/pause/agent-pause.js';
import { type OriginalDownstreamRoomEmitter } from '../downstream/native-room-emitter.js';
import { readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import {
  isOriginalNativeTestModeRuntime,
  prepareTestModeOriginalLockedRoomResponder,
} from '../../../runtimes/test-mode/test-mode-runtime.js';
import type { OriginalRoomCommittedData } from '../current/current-operation-types.js';
import { prepareClaudeOriginalLockedRoomResponder } from '../../../runtimes/claude-code/claude-code-runtime.js';
import { prepareCodexOriginalLockedRoomResponder } from '../../../runtimes/codex/codex-runtime.js';
import { prepareOpenCodeOriginalLockedRoomResponder } from '../../../runtimes/opencode/opencode-runtime.js';
import {
  captureOriginalPreparedNativeTime,
  readOriginalPreparedNativePrincipal,
  readOriginalRoomEmissionPrincipalBinding,
} from '../../../connectors/principal/runtime-principal-service.js';
import { type Db, type DbTransaction } from '@dorkos/db';
import { type FixedNativeRoomDocFacade } from '@dorkos/db/internal-server';
import {
  readRoomStoreGrantedDocTargetBindingInsideOriginalEmission,
  type RoomStore,
} from '../../../rooms/room-store.js';
import { type ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import type {
  OriginalFrozenRoomSource,
  CurrentDocOperationEngineCore,
  FrozenRoomSourceData,
  OriginalCommittedRoomResponder,
  OriginalRoomEmissionStage,
  PreparedRoomResponder,
} from '../current/current-operation-types.js';
import { sameCurrentDocData } from '../current/current-operation-data.js';
import {
  requireOriginalRoomResponderOwner,
  readOriginalRoomResponderFrozenSource,
  type CurrentRoomOperation,
} from './room-current-operation.js';
import * as custody from './room-responder-emission-custody.js';
import {
  createOriginalRoomResponderPublicOperations,
  createIsolatedRoomCapabilityResponderCustody,
  type OriginalRoomResponderPublicOperations,
} from './room-responder-public-operations.js';
import { commitOriginalRoomResponder } from './room-responder-commitment.js';
import type {
  ActiveEmissionOwner,
  EmissionStageOwner,
  OriginalRoomResponderCustodyView,
  OriginalRoomResponderCommitView,
} from './room-responder-private-types.js';

const originalDate = Date;
const originalDateNow = Date.now;
const originalIso = Date.prototype.toISOString;
const committedRoomResponders = new WeakMap<
  OriginalCommittedRoomResponder,
  OriginalRoomCommittedData
>();
const activeEmissionOwners = new WeakMap<OriginalCommittedRoomResponder, ActiveEmissionOwner>();
const emissionStages = new WeakMap<OriginalRoomEmissionStage, EmissionStageOwner>();
const originalEmissionFrames = new WeakMap<
  OriginalRoomEmissionStage,
  { db: Db; tx: DbTransaction; emitter: OriginalDownstreamRoomEmitter }
>();
const closedRoomCommitments = new WeakMap<
  object,
  Readonly<{
    runtime: object;
    prepared: PreparedRoomResponder;
    operation: object;
  }>
>();
const custodyKey = Object.freeze({});
const capabilityCustody = createIsolatedRoomCapabilityResponderCustody(custodyKey);
/** Lookup-only original capability responder selection, never a caller registration port. */
export const resolveOriginalRoomCapabilityResponder = capabilityCustody.resolve;
const custodyViews = new WeakMap<object, OriginalRoomResponderCustodyView>();
const commitViews = new WeakMap<object, OriginalRoomResponderCommitView>();
const commitApply = Reflect.apply;
const commitGet = WeakMap.prototype.get;
const commitSet = WeakMap.prototype.set;
commitApply(commitSet, custodyViews, [
  custodyKey,
  Object.freeze({
    committedRoomResponders,
    activeEmissionOwners,
    emissionStages,
    originalEmissionFrames,
    closedRoomCommitments,
  }),
]);
/** Require the original private module selector before reading emission maps. */
export function readOriginalRoomResponderCustodyView(
  owner: object
): OriginalRoomResponderCustodyView {
  const view = commitApply(commitGet, custodyViews, [owner]) as
    OriginalRoomResponderCustodyView | undefined;
  if (!view) throw new Error('Original responder emission custody required');
  return view;
}
/** Require the exact constructor-private commitment selector before native effects. */
export function readOriginalRoomResponderCommitView(
  owner: object
): OriginalRoomResponderCommitView {
  const view = commitApply(commitGet, commitViews, [owner]) as
    OriginalRoomResponderCommitView | undefined;
  if (!view) throw new Error('Original responder commitment custody required');
  return view;
}
/** Original public emission operations retain actual private map membership. */
const originalRoomResponderExplicitPublicBindings: Readonly<OriginalRoomResponderPublicOperations> =
  createOriginalRoomResponderPublicOperations(custodyKey);
/** Original public function reference with its exact named declaration contract. */
export const prepareOriginalRoomResponderEmission: OriginalRoomResponderPublicOperations['prepareOriginalRoomResponderEmission'] =
  originalRoomResponderExplicitPublicBindings.prepareOriginalRoomResponderEmission;
/** Original public function reference with its exact named declaration contract. */
export const refreshOriginalRoomEmissionStage: OriginalRoomResponderPublicOperations['refreshOriginalRoomEmissionStage'] =
  originalRoomResponderExplicitPublicBindings.refreshOriginalRoomEmissionStage;
/** Original public function reference with its exact named declaration contract. */
export const requireOriginalRoomEmissionTransaction: OriginalRoomResponderPublicOperations['requireOriginalRoomEmissionTransaction'] =
  originalRoomResponderExplicitPublicBindings.requireOriginalRoomEmissionTransaction;
/** Original public function reference with its exact named declaration contract. */
export const requireOriginalRoomEmissionFrameTransaction: OriginalRoomResponderPublicOperations['requireOriginalRoomEmissionFrameTransaction'] =
  originalRoomResponderExplicitPublicBindings.requireOriginalRoomEmissionFrameTransaction;
/** Original public function reference with its exact named declaration contract. */
export const readOriginalRoomEmissionRuntimeBindingRow: OriginalRoomResponderPublicOperations['readOriginalRoomEmissionRuntimeBindingRow'] =
  originalRoomResponderExplicitPublicBindings.readOriginalRoomEmissionRuntimeBindingRow;
/** Original public function reference with its exact named declaration contract. */
export const readOriginalRoomEmissionTargetBindingRow: OriginalRoomResponderPublicOperations['readOriginalRoomEmissionTargetBindingRow'] =
  originalRoomResponderExplicitPublicBindings.readOriginalRoomEmissionTargetBindingRow;
/** Original public function reference with its exact named declaration contract. */
export const executeOriginalRoomResponderEmission: OriginalRoomResponderPublicOperations['executeOriginalRoomResponderEmission'] =
  originalRoomResponderExplicitPublicBindings.executeOriginalRoomResponderEmission;
/** Original public function reference with its exact named declaration contract. */
export const requireOriginalRoomEmissionStageClosed: OriginalRoomResponderPublicOperations['requireOriginalRoomEmissionStageClosed'] =
  originalRoomResponderExplicitPublicBindings.requireOriginalRoomEmissionStageClosed;
/** Original public function reference with its exact named declaration contract. */
export const requireOriginalRoomEmissionPrincipalPort: OriginalRoomResponderPublicOperations['requireOriginalRoomEmissionPrincipalPort'] =
  originalRoomResponderExplicitPublicBindings.requireOriginalRoomEmissionPrincipalPort;
/** Original public function reference with its exact named declaration contract. */
export const readOriginalRoomEmissionPrincipal: OriginalRoomResponderPublicOperations['readOriginalRoomEmissionPrincipal'] =
  originalRoomResponderExplicitPublicBindings.readOriginalRoomEmissionPrincipal;
/** Original public function reference with its exact named declaration contract. */
export const readOriginalRoomEmissionSource: OriginalRoomResponderPublicOperations['readOriginalRoomEmissionSource'] =
  originalRoomResponderExplicitPublicBindings.readOriginalRoomEmissionSource;
/** Original public function reference with its exact named declaration contract. */
export const retireOriginalRoomEmissionStage: OriginalRoomResponderPublicOperations['retireOriginalRoomEmissionStage'] =
  originalRoomResponderExplicitPublicBindings.retireOriginalRoomEmissionStage;
/** Original public function reference with its exact named declaration contract. */
export const requireOriginalCommittedRoomResponder: OriginalRoomResponderPublicOperations['requireOriginalCommittedRoomResponder'] =
  originalRoomResponderExplicitPublicBindings.requireOriginalCommittedRoomResponder;
/** Original public function reference with its exact named declaration contract. */
export const requireCurrentOriginalCommittedRoomResponder: OriginalRoomResponderPublicOperations['requireCurrentOriginalCommittedRoomResponder'] =
  originalRoomResponderExplicitPublicBindings.requireCurrentOriginalCommittedRoomResponder;
/** Original public function reference with its exact named declaration contract. */
export const consumeOriginalCommittedRoomResponder: OriginalRoomResponderPublicOperations['consumeOriginalCommittedRoomResponder'] =
  originalRoomResponderExplicitPublicBindings.consumeOriginalCommittedRoomResponder;
/** Original public function reference with its exact named declaration contract. */
export const retireOriginalCommittedRoomResponder: OriginalRoomResponderPublicOperations['retireOriginalCommittedRoomResponder'] =
  originalRoomResponderExplicitPublicBindings.retireOriginalCommittedRoomResponder;
/** Original public function reference with its exact named declaration contract. */
export const observeOriginalRoomResponderProjection: OriginalRoomResponderPublicOperations['observeOriginalRoomResponderProjection'] =
  originalRoomResponderExplicitPublicBindings.observeOriginalRoomResponderProjection;
/** Original public function reference with its exact named declaration contract. */
export const settleOriginalRoomResponderProjection: OriginalRoomResponderPublicOperations['settleOriginalRoomResponderProjection'] =
  originalRoomResponderExplicitPublicBindings.settleOriginalRoomResponderProjection;

const originalDocPrivateConstructionFreeze = Object.freeze;

/** Own original Room responder preparation, commitment and native lifecycle custody. */
export class OriginalRoomResponderOperation {
  readonly #commitKey = originalDocPrivateConstructionFreeze({});
  readonly #helper: CurrentRoomOperation;
  readonly #engine: CurrentDocOperationEngineCore;
  readonly #db: Db;
  readonly #principals: ConnectorRuntimePrincipalService;
  readonly #roomStore: RoomStore;
  readonly #facade: FixedNativeRoomDocFacade;
  readonly #claiming = new WeakSet<PreparedRoomResponder>();
  readonly #prepared = new WeakMap<
    import('../current/current-operation-types.js').PreparedRoomResponder,
    {
      runtime: object;
      runtimeHandle: object;
      source: OriginalFrozenRoomSource;
      own: FrozenRoomSourceData;
      nativeOperation: object;
      acquisition: object;
    }
  >();
  readonly #closedPrepared = new WeakMap<
    PreparedRoomResponder,
    { runtime: object; runtimeHandle: object }
  >();
  #closePrepared(prepared: PreparedRoomResponder): void {
    const own = this.#prepared.get(prepared);
    if (own)
      this.#closedPrepared.set(prepared, {
        runtime: own.runtime,
        runtimeHandle: own.runtimeHandle,
      });
    capabilityCustody.retire(this.#db, prepared);
    this.#prepared.delete(prepared);
  }
  constructor(
    helper: CurrentRoomOperation,
    engine: CurrentDocOperationEngineCore,
    db: Db,
    principals: ConnectorRuntimePrincipalService,
    roomStore: RoomStore,
    facade: FixedNativeRoomDocFacade
  ) {
    this.#helper = helper;
    this.#engine = engine;
    this.#db = db;
    this.#principals = principals;
    this.#roomStore = roomStore;
    this.#facade = facade;
    const createOriginalView = (
      responder: OriginalRoomResponderOperation
    ): Readonly<OriginalRoomResponderCommitView> =>
      originalDocPrivateConstructionFreeze<OriginalRoomResponderCommitView>({
        db,
        principals,
        roomStore,
        facade,
        claiming: this.#claiming,
        readPrepared: (runtime, prepared, emissionStage) =>
          responder.#readPrepared(runtime, prepared, emissionStage),
        requireCurrentResponder: (
          runtime,
          prepared,
          expectedCursor,
          originalEmissionTime,
          emissionStage
        ) =>
          responder.#requireCurrentResponder(
            runtime,
            prepared,
            expectedCursor,
            originalEmissionTime,
            emissionStage
          ),
        closePrepared: (prepared) => responder.#closePrepared(prepared),
        requireEmissionStage: (stage, db) => custody.requireEmissionStage(custodyKey, stage, db),
        now: () => originalDateNow(),
        Date: originalDate,
        iso: originalIso,
        committedRoomResponders,
        activeEmissionOwners,
        emissionStages,
        originalEmissionFrames,
        closedRoomCommitments,
      });
    commitApply(commitSet, commitViews, [this.#commitKey, createOriginalView(this)]);
  }
  #requireOwner(): void {
    requireOriginalRoomResponderOwner(
      this.#helper,
      this,
      this.#engine,
      this.#db,
      this.#principals,
      this.#roomStore,
      this.#facade
    );
  }
  retainPrepared(
    runtime: object,
    source: OriginalFrozenRoomSource,
    prepared: PreparedRoomResponder,
    runtimeHandle: object = runtime
  ): void {
    this.#requireOwner();
    const own = readOriginalRoomResponderFrozenSource(this.#helper, this, source);
    const type = own.source.targetRuntime;
    const read = readOriginalRuntimePreparedResponder(runtime, prepared, type);
    if (!read || read.source !== source || this.#db.$client.inTransaction)
      throw new Error('Prepared Room source is not original.');
    this.#requireOwner();
    if ((readOriginalRegisteredRuntime(runtimeHandle) ?? runtimeHandle) !== runtime)
      throw new Error('Original prepared runtime selection retired during setup.');
    this.#prepared.set(prepared, {
      runtime,
      runtimeHandle,
      source,
      own,
      nativeOperation: read.nativeOperation,
      acquisition: read.acquisition,
    });
  }
  async prepare(
    runtime: object,
    holder: import('@dorkos/shared/agent-runtime').SseResponse,
    key: string,
    source: OriginalFrozenRoomSource
  ): Promise<PreparedRoomResponder | undefined> {
    const runtimeHandle = runtime;
    runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
    this.#requireOwner();
    const own = readOriginalRoomResponderFrozenSource(this.#helper, this, source);
    const type = own.source.targetRuntime;
    const prepared = isOriginalNativeTestModeRuntime(runtime)
      ? await prepareTestModeOriginalLockedRoomResponder(runtime, holder, key, source)
      : type === 'claude-code'
        ? await prepareClaudeOriginalLockedRoomResponder(runtime, holder, key, source)
        : type === 'codex'
          ? await prepareCodexOriginalLockedRoomResponder(runtime, holder, key, source)
          : type === 'opencode'
            ? await prepareOpenCodeOriginalLockedRoomResponder(runtime, holder, key, source)
            : undefined;
    if (!prepared) return undefined;
    try {
      this.retainPrepared(runtime, source, prepared, runtimeHandle);
      return prepared;
    } catch (cause) {
      try {
        await retireOriginalRuntimePreparedResponder(runtime, prepared, type);
      } catch {} // Original failure wins, including undefined.
      throw cause;
    }
  }
  async retirePrepared(runtime: object, prepared: PreparedRoomResponder): Promise<void> {
    this.#requireOwner();
    const own = this.#prepared.get(prepared);
    // Cleanup recognizes the original selection identity even after its authority retires.
    if (!own) {
      const closed = this.#closedPrepared.get(prepared);
      if (closed && (closed.runtime === runtime || closed.runtimeHandle === runtime)) return;
      throw new Error('Prepared retirement is foreign.');
    }
    if (own.runtime !== runtime && own.runtimeHandle !== runtime)
      throw new Error('Prepared retirement is foreign.');
    runtime = own.runtime;
    this.#closePrepared(prepared);
    const type = own.own.source.targetRuntime;
    await retireOriginalRuntimePreparedResponder(runtime, prepared, type);
  }
  #readPrepared(
    runtime: object,
    prepared: PreparedRoomResponder,
    emissionStage?: OriginalRoomEmissionStage
  ) {
    if (emissionStage) {
      const frame = originalEmissionFrames.get(emissionStage);
      if (!frame) throw new Error('Original emission prepared frame unavailable.');
      requireOriginalRoomEmissionFrameTransaction(emissionStage, this.#db, frame.tx, frame.emitter);
    }
    runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
    this.#requireOwner();
    const own = this.#prepared.get(prepared);
    if (
      !own ||
      own.runtime !== runtime ||
      (readOriginalRegisteredRuntime(own.runtimeHandle) ?? own.runtimeHandle) !== runtime ||
      own.own.engine !== this.#engine ||
      own.own.db !== this.#db ||
      own.own.facade !== this.#facade
    )
      throw new Error('Room responder lacks original prepared custody.');
    const type = own.own.source.targetRuntime;
    const read = readOriginalRuntimePreparedResponder(runtime, prepared, type);
    if (
      !read ||
      read.source !== own.source ||
      read.nativeOperation !== own.nativeOperation ||
      read.acquisition !== own.acquisition ||
      this.#prepared.get(prepared) !== own ||
      (!emissionStage && this.#db.$client.inTransaction)
    )
      throw new Error('Room prepared entry/acquisition changed.');
    return own;
  }
  /** Exact private preparation/source association; a target/session DTO never selects a source. */
  requirePreparedSource(
    runtime: object,
    prepared: PreparedRoomResponder,
    source: OriginalFrozenRoomSource
  ): void {
    if (this.#readPrepared(runtime, prepared).source !== source)
      throw new Error('Prepared responder belongs to a different original source.');
  }
  #requireCurrentResponder(
    runtime: object,
    prepared: PreparedRoomResponder,
    expectedCursor?: number,
    originalEmissionTime?: number,
    emissionStage?: OriginalRoomEmissionStage
  ): void {
    const own = this.#readPrepared(runtime, prepared, emissionStage),
      source = own.own.source;
    const effectiveTargetSessionId = own.own.effectiveTargetSessionId;
    if (!effectiveTargetSessionId)
      throw new Error('Original Room preparation has no captured destination.');
    const emissionFrame = emissionStage && originalEmissionFrames.get(emissionStage);
    if (source.producerOrigin === 'operator') {
      if (emissionStage) {
        if (!emissionStage || !emissionFrame)
          throw new Error('Original operator emission has no generated native transaction.');
        this.#engine.requireRoomOperatorNativeSource(
          own.source,
          emissionStage,
          emissionFrame.tx,
          emissionFrame.emitter
        );
      } else this.#engine.requireRoomOperatorSource(own.source);
    }
    if (source.producerOrigin === 'doc_token' && !emissionStage)
      this.#engine.requireRoomTokenSource(own.source);
    // Within an original emission frame the native fixed token row gate repeats the retained signed origin;
    // no public/native token reader is dispatched into that frame.
    // All configured clock work occurs before the fixed original SQL/native/lock tail.
    const time =
      originalEmissionTime ??
      captureOriginalPreparedNativeTime(this.#principals, this.#db, own.nativeOperation);
    const physical = this.#facade.readDocPhysicalAndChannelBirth(source.documentId);
    if (!physical.document || !physical.channel || physical.channel.closed_at !== null)
      throw new Error('Original Room physical/channel lifetime ended.');
    const originalBirth = own.own.before.channelBirth;
    const before = {
      document: physical.document,
      channelBirth: Object.fromEntries(
        Object.keys(originalBirth).map((key) => [key, physical.channel![key]])
      ),
      grant: this.#facade.readOriginalDocGrant(source.grantId),
      approval: this.#facade.readConsumedOriginalApproval(source.approvalId),
      owner: this.#facade.readCurrentOwnerAccount(),
    };
    const currentMembership = this.#facade.readCurrentRoomMembership(
      source.roomId,
      source.targetAgentPath
    );
    const currentMember = currentMembership.members.find(
      (row) => row.author_id === source.targetAuthorId
    );
    if (
      !currentMember ||
      (expectedCursor !== undefined && currentMember.last_read_seq !== expectedCursor)
    )
      throw new Error('Original Room destination cursor changed.');
    const target =
      emissionStage && emissionFrame
        ? readRoomStoreGrantedDocTargetBindingInsideOriginalEmission(
            this.#roomStore,
            this.#db,
            emissionStage,
            emissionFrame.tx,
            emissionFrame.emitter,
            source.roomId,
            source.targetAgentId,
            effectiveTargetSessionId,
            source.targetRuntime
          )
        : (() => {
            const rows = this.#facade.readOriginalEmissionTargetBinding(source);
            return rows.length === 1 ? rows[0] : undefined;
          })();
    if (
      !sameCurrentDocData(before, own.own.before) ||
      !target ||
      target.targetAuthorId !== source.targetAuthorId ||
      target.targetAgentPath !== source.targetAgentPath ||
      target.targetSessionId !== effectiveTargetSessionId ||
      this.#prepared.get(prepared) !== own
    )
      throw new Error('Original Room source/approved target changed.');
    const binding =
      emissionStage && emissionFrame
        ? readOriginalRoomEmissionPrincipalBinding(
            this.#principals,
            this.#db,
            own.nativeOperation,
            emissionStage,
            emissionFrame.tx,
            emissionFrame.emitter
          )
        : readOriginalPreparedNativePrincipal(
            this.#principals,
            this.#db,
            own.nativeOperation,
            time,
            this.#db
          );
    if (
      !binding ||
      binding.canonicalSessionId !== effectiveTargetSessionId ||
      binding.agentPath !== source.targetAgentPath ||
      binding.runtime !== source.targetRuntime
    )
      throw new Error('Original prepared Room principal retired.');
  }
  /** Genuine native frame and private SAMEbudget FIRST precede any model start. */
  commitResponder(
    runtime: object,
    prepared: PreparedRoomResponder
  ): OriginalCommittedRoomResponder {
    const own = this.#readPrepared(runtime, prepared);
    const paused = agentPause()?.pausedAgentOfTurn({ cwd: own.own.source.targetAgentPath });
    if (paused) {
      agentPause()?.recordHeld(paused, {
        via: 'turn',
        sessionId: own.own.effectiveTargetSessionId ?? own.own.source.targetSessionId,
        runtime: own.own.source.targetRuntime,
      });
      throw new AgentPausedError(paused);
    }
    const token = commitOriginalRoomResponder(this.#commitKey, runtime, prepared);
    capabilityCustody.register(this.#commitKey, token, runtime, prepared);
    return token;
  }
}
