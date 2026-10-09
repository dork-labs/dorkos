import { executeDocumentWork } from '../storage/store-transaction.js';
import type {
  CanvasChannelSendRequest,
  IngestReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  requireOriginalDownstreamEmissionTransaction,
  sendOriginalDownstreamRoomInsideFrame,
  type OriginalDownstreamRoomEmitter,
} from '../downstream/native-room-emitter.js';
import { readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import {
  isOriginalNativeTestModeRuntime,
  prepareTestModeOriginalLockedRoomResponder,
  readTestModePreparedRoomResponder,
  retireTestModePreparedRoomResponder,
  readTestModeOriginalRoomResponderStream,
} from '../../../runtimes/test-mode/test-mode-runtime.js';
import { projectOriginalRoomDestinationData } from '../current/current-operation-data.js';
import type { OriginalRoomCommittedData } from '../current/current-operation-types.js';

import { projectOriginalRoomClaimData } from '../current/current-operation-data.js';
import {
  peekProjector,
  requireOriginalSessionProjection,
  type SessionStateProjector,
} from '../../../session/session-state-projector.js';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { readClaudeOriginalRoomResponderStream } from '../../../runtimes/claude-code/claude-code-runtime.js';
import { readCodexOriginalRoomResponderStream } from '../../../runtimes/codex/codex-runtime.js';
import { readOpenCodeOriginalRoomResponderStream } from '../../../runtimes/opencode/opencode-runtime.js';
import {
  prepareClaudeOriginalLockedRoomResponder,
  retireClaudePreparedRoomResponder,
} from '../../../runtimes/claude-code/claude-code-runtime.js';
import {
  prepareCodexOriginalLockedRoomResponder,
  retireCodexPreparedRoomResponder,
} from '../../../runtimes/codex/codex-runtime.js';
import {
  prepareOpenCodeOriginalLockedRoomResponder,
  retireOpenCodePreparedRoomResponder,
} from '../../../runtimes/opencode/opencode-runtime.js';
import { createRoomStoreDocBudgetCompanion } from '../../../rooms/service/room-core.js';
import { readRoomDocBudgetFirst } from '../../../rooms/limits/turn-budget.js';

import {
  captureOriginalPreparedNativeTime,
  resolveOriginalNativePrincipal,
  requireSameOriginalNativePrincipalPorts,
  readOriginalPreparedNativePrincipal,
  captureOriginalRoomEmissionPrincipal,
  readOriginalRoomEmissionPrincipalBinding,
} from '../../../connectors/principal/runtime-principal-service.js';

import { readClaudePreparedRoomResponder } from '../../../runtimes/claude-code/claude-code-runtime.js';

import { readCodexPreparedRoomResponder } from '../../../runtimes/codex/codex-runtime.js';
import { readOpenCodePreparedRoomResponder } from '../../../runtimes/opencode/opencode-runtime.js';
/** Internal original acceptance custody. Copied package data never grants SDK authority. */
const originalDate = Date;
const originalDateNow = Date.now;
const originalIso = Date.prototype.toISOString;
import { randomUUID } from 'node:crypto';
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
import { copyCurrentDocData, sameCurrentDocData } from '../current/current-operation-data.js';

import {
  requireOriginalRoomResponderOwner,
  readOriginalRoomResponderFrozenSource,
  type CurrentRoomOperation,
} from './room-current-operation.js';

const committedRoomResponders = new WeakMap<
  OriginalCommittedRoomResponder,
  OriginalRoomCommittedData
>();
interface ActiveEmissionOwner {
  db: Db;
  prepare: () => Promise<OriginalRoomEmissionStage>;
}
interface EmissionStageOwner {
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
const activeEmissionOwners = new WeakMap<OriginalCommittedRoomResponder, ActiveEmissionOwner>();
const emissionStages = new WeakMap<OriginalRoomEmissionStage, EmissionStageOwner>();
const originalEmissionFrames = new WeakMap<
  OriginalRoomEmissionStage,
  { db: Db; tx: DbTransaction; emitter: OriginalDownstreamRoomEmitter }
>();
function requireEmissionStage(stage: OriginalRoomEmissionStage, db: Db): EmissionStageOwner {
  const own = emissionStages.get(stage);
  if (
    !own ||
    own.db !== db ||
    own.phase === 'retired' ||
    !db.$client.open ||
    committedRoomResponders.get(own.token) !== own.committed ||
    own.committed.consumed !== true
  )
    throw new Error('Original active Room emission is unavailable.');
  return own;
}
/** Only the consumed original native COMMIT/FIRST entry can prepare an emission stage. */
export function prepareOriginalRoomResponderEmission(
  token: OriginalCommittedRoomResponder,
  runtime: object,
  prepared: PreparedRoomResponder,
  operation: object,
  db: Db
): Promise<OriginalRoomEmissionStage> {
  const committed = committedRoomResponders.get(token),
    owner = activeEmissionOwners.get(token);
  if (
    !committed ||
    !owner ||
    owner.db !== db ||
    db.$client.inTransaction ||
    committed.consumed !== true ||
    committed.runtime !== runtime ||
    committed.prepared !== prepared ||
    committed.operation !== operation
  )
    throw new Error('Foreign original Room emission entry.');
  return owner.prepare();
}
/** Native configured time is refreshed after awaited sender preflight, before SQL entry. */
export function refreshOriginalRoomEmissionStage(stage: OriginalRoomEmissionStage, db: Db): void {
  const own = requireEmissionStage(stage, db);
  if (db.$client.inTransaction || own.tx || own.phase === 'active')
    throw new Error('Original Room emission refresh requires inactive SQL.');
  own.refresh();
  requireEmissionStage(stage, db);
  own.phase = 'ready';
}
/** Fixed currentness tail only; no configured clock or await executes in this original SQL stage. */
export function requireOriginalRoomEmissionTransaction(
  stage: OriginalRoomEmissionStage,
  db: Db,
  tx: DbTransaction,
  principal: import('../../../connectors/principal/server-principal.js').ServerPrincipalProof,
  emitter: OriginalDownstreamRoomEmitter
): void {
  const own = requireEmissionStage(stage, db);
  if (
    !db.$client.inTransaction ||
    own.principal !== principal ||
    !['ready', 'active'].includes(own.phase) ||
    (own.tx && own.tx !== tx)
  )
    throw new Error('Foreign original Room emission transaction.');
  requireOriginalRoomEmissionFrameTransaction(stage, db, tx, emitter);
  requireOriginalDownstreamEmissionTransaction(emitter, stage, db, tx, principal);
  own.tx = tx;
  own.phase = 'active';
  own.require();
  requireEmissionStage(stage, db);
  requireOriginalDownstreamEmissionTransaction(emitter, stage, db, tx, principal);
}
/** Only this engine's actual native Room frame creates the synchronous scoped sender handle. */
export function requireOriginalRoomEmissionFrameTransaction(
  stage: OriginalRoomEmissionStage,
  db: Db,
  tx: DbTransaction,
  emitter: OriginalDownstreamRoomEmitter
): void {
  const own = requireEmissionStage(stage, db),
    frame = originalEmissionFrames.get(stage);
  if (
    own.frameState !== 'open' ||
    !db.$client.inTransaction ||
    !frame ||
    frame.db !== db ||
    frame.tx !== tx ||
    frame.emitter !== emitter
  )
    throw new Error('Original Room emission requires its generated native frame transaction.');
}
/** Fixed constructor-owned native statement, not a mutable generated query builder. */
export function readOriginalRoomEmissionRuntimeBindingRow(
  stage: OriginalRoomEmissionStage,
  db: Db,
  tx: DbTransaction,
  emitter: OriginalDownstreamRoomEmitter,
  bindingId: string
) {
  requireOriginalRoomEmissionFrameTransaction(stage, db, tx, emitter);
  return requireEmissionStage(stage, db).readNativeBinding(bindingId);
}
/** Exact stage-bound original statement; copied selectors cannot select a different target. */
export function readOriginalRoomEmissionTargetBindingRow(
  stage: OriginalRoomEmissionStage,
  db: Db,
  tx: DbTransaction,
  emitter: OriginalDownstreamRoomEmitter,
  roomId: string,
  agentId: string,
  sessionId: string,
  runtime: string
): readonly Readonly<{
  roomId: string;
  targetAuthorId: string;
  targetAgentId: string;
  targetSessionId: string;
  targetRuntime: string;
  targetAgentPath: string;
}>[] {
  requireOriginalRoomEmissionFrameTransaction(stage, db, tx, emitter);
  const own = requireEmissionStage(stage, db),
    source = own.source;
  if (
    roomId !== source.roomId ||
    agentId !== source.targetAgentId ||
    sessionId !== own.effectiveTargetSessionId ||
    runtime !== source.targetRuntime
  )
    throw new Error('Original native target selectors changed.');
  const rows = own.readNativeTarget();
  if (rows.length > 2) throw new Error('Original native target read exceeded its fixed limit.');
  const copied = rows.map((row) => {
    const {
      roomId,
      targetAuthorId,
      targetAgentId,
      targetSessionId,
      targetRuntime,
      targetAgentPath,
    } = row;
    if (
      typeof roomId !== 'string' ||
      typeof targetAuthorId !== 'string' ||
      typeof targetAgentId !== 'string' ||
      typeof targetSessionId !== 'string' ||
      typeof targetRuntime !== 'string' ||
      typeof targetAgentPath !== 'string' ||
      roomId !== source.roomId ||
      targetAuthorId !== source.targetAuthorId ||
      targetAgentId !== source.targetAgentId ||
      targetSessionId !== own.effectiveTargetSessionId ||
      targetRuntime !== source.targetRuntime ||
      targetAgentPath !== source.targetAgentPath
    )
      throw new Error('Original native target row disagrees with committed source.');
    return Object.freeze({
      roomId,
      targetAuthorId,
      targetAgentId,
      targetSessionId,
      targetRuntime,
      targetAgentPath,
    });
  });
  requireOriginalRoomEmissionFrameTransaction(stage, db, tx, emitter);
  return Object.freeze(copied);
}
/** Emit through the exact original Room stage and installed downstream emitter. */
export function executeOriginalRoomResponderEmission(
  stage: OriginalRoomEmissionStage,
  emitter: OriginalDownstreamRoomEmitter,
  request: CanvasChannelSendRequest
): { receipt: IngestReceipt } {
  const own = emissionStages.get(stage);
  if (!own) throw new Error('Unknown original Room emission stage.');
  requireEmissionStage(stage, own.db);
  if (own.db.$client.inTransaction || own.phase !== 'ready' || own.frameState !== 'not_started')
    throw new Error('Original Room emission entry cannot reenter.');
  return own.run(stage, emitter, request);
}
/** Cleanup witness only. Ordinary refused sends are safely closed; UNKNOWN preserves its raw cause. */
export function requireOriginalRoomEmissionStageClosed(
  stage: OriginalRoomEmissionStage,
  db: Db
): void {
  const own = emissionStages.get(stage);
  if (!own || own.db !== db) throw new Error('Foreign original Room emission cleanup.');
  if (own.frameState === 'unknown') throw own.closeFailure?.cause;
  if (own.phase !== 'retired' || !['not_started', 'closed'].includes(own.frameState))
    throw new Error('Original Room emission is not positively retired and closed.');
}
/** Actual original principal and immutable correlation DATA, never reconstructed actor claims. */
export function requireOriginalRoomEmissionPrincipalPort(
  stage: OriginalRoomEmissionStage,
  db: Db,
  principals: object
): void {
  requireSameOriginalNativePrincipalPorts(requireEmissionStage(stage, db).principals, principals);
}
/** Read the principal retained by the exact original Room emission stage. */
export function readOriginalRoomEmissionPrincipal(stage: OriginalRoomEmissionStage, db: Db) {
  return requireEmissionStage(stage, db).principal;
}
/** Read copied source DATA from the exact original Room emission stage. */
export function readOriginalRoomEmissionSource(stage: OriginalRoomEmissionStage, db: Db) {
  const source = requireEmissionStage(stage, db).source;
  return copyCurrentDocData({
    documentId: source.documentId,
    batchId: source.batchId,
    generation: source.generation,
    scope: source.scope,
    roomId: source.roomId,
    grantId: source.grantId,
    grantRevision: source.grantRevision,
    routeId: source.routeId,
    admissionId: source.admissionId,
    originalSourceHash: source.originalSourceHash,
    targetAgentId: source.targetAgentId,
    targetAuthorId: source.targetAuthorId,
    targetSessionId: requireEmissionStage(stage, db).effectiveTargetSessionId,
    originalTargetSessionId: source.targetSessionId,
    targetRuntime: source.targetRuntime,
    targetAgentPath: source.targetAgentPath,
    inputs: source.inputs.map((input) => ({ eventId: input.eventId, docSeq: input.docSeq })),
  });
}
/** Retire the emission stage bound to the exact original database. */
export function retireOriginalRoomEmissionStage(stage: OriginalRoomEmissionStage, db: Db): void {
  const own = emissionStages.get(stage);
  if (!own || own.db !== db) throw new Error('Foreign original Room emission retirement.');
  own.phase = 'retired';
}
/** Lookup-only original commit/entry association, never a caller registrar or readiness boolean. */
export function requireOriginalCommittedRoomResponder(
  token: OriginalCommittedRoomResponder | undefined,
  runtime: object,
  prepared: PreparedRoomResponder,
  operation: object
): void {
  const own = token && committedRoomResponders.get(token);
  if (
    !own ||
    own.consumed ||
    own.runtime !== runtime ||
    own.prepared !== prepared ||
    own.operation !== operation
  )
    throw new Error('Room committed start authority is not available.');
}
/** Recheck original source/native authority without consuming its once-only effect. */
export function requireCurrentOriginalCommittedRoomResponder(
  token: OriginalCommittedRoomResponder,
  runtime: object,
  prepared: PreparedRoomResponder,
  operation: object
): void {
  requireOriginalCommittedRoomResponder(token, runtime, prepared, operation);
  const own = committedRoomResponders.get(token)!;
  own.requireCurrent();
  requireOriginalCommittedRoomResponder(token, runtime, prepared, operation);
  if (committedRoomResponders.get(token) !== own)
    throw new Error('Original Room commitment changed during currentness.');
}
/** Only original constructor-issued COMMIT/FIRST custody can be consumed by its exact installed SDK entry. */
export function consumeOriginalCommittedRoomResponder(
  token: OriginalCommittedRoomResponder,
  runtime: object,
  prepared: PreparedRoomResponder,
  operation: object
) {
  const own = committedRoomResponders.get(token);
  if (
    !own ||
    own.consumed ||
    own.runtime !== runtime ||
    own.prepared !== prepared ||
    own.operation !== operation
  )
    throw new Error('Room start requires its original committed responder.');
  own.consumed = true; // Once, even if final currentness refuses.
  return own.consume();
}

const closedRoomCommitments = new WeakMap<
  object,
  Readonly<{
    runtime: object;
    prepared: PreparedRoomResponder;
    operation: object;
  }>
>();
/** Retire only the exact original unconsumed commitment; no model retry or budget refund. */
export function retireOriginalCommittedRoomResponder(
  token: OriginalCommittedRoomResponder,
  runtime: object,
  prepared: PreparedRoomResponder,
  operation: object
): void {
  const own = committedRoomResponders.get(token);
  const closed = closedRoomCommitments.get(token);
  if (!own) {
    if (
      closed?.runtime === runtime &&
      closed.prepared === prepared &&
      closed.operation === operation
    )
      return;
    throw new Error('Room retirement requires its original committed responder.');
  }
  if (own.runtime !== runtime || own.prepared !== prepared || own.operation !== operation)
    throw new Error('Room retirement requires its original committed responder.');
  committedRoomResponders.delete(token);
  closedRoomCommitments.set(token, { runtime, prepared, operation });
  own.retire();
}

/** Own original Room responder preparation, commitment and native lifecycle custody. */
export class OriginalRoomResponderOperation {
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
    const read = isOriginalNativeTestModeRuntime(runtime)
      ? readTestModePreparedRoomResponder(runtime, prepared)
      : type === 'claude-code'
        ? readClaudePreparedRoomResponder(runtime, prepared)
        : type === 'codex'
          ? readCodexPreparedRoomResponder(runtime, prepared)
          : readOpenCodePreparedRoomResponder(runtime, prepared);
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
        if (isOriginalNativeTestModeRuntime(runtime))
          await retireTestModePreparedRoomResponder(runtime, prepared);
        else if (type === 'claude-code') await retireClaudePreparedRoomResponder(runtime, prepared);
        else if (type === 'codex') await retireCodexPreparedRoomResponder(runtime, prepared);
        else await retireOpenCodePreparedRoomResponder(runtime, prepared);
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
    if (isOriginalNativeTestModeRuntime(runtime))
      await retireTestModePreparedRoomResponder(runtime, prepared);
    else if (type === 'claude-code') await retireClaudePreparedRoomResponder(runtime, prepared);
    else if (type === 'codex') await retireCodexPreparedRoomResponder(runtime, prepared);
    else await retireOpenCodePreparedRoomResponder(runtime, prepared);
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
    const read = isOriginalNativeTestModeRuntime(runtime)
      ? readTestModePreparedRoomResponder(runtime, prepared)
      : type === 'claude-code'
        ? readClaudePreparedRoomResponder(runtime, prepared)
        : type === 'codex'
          ? readCodexPreparedRoomResponder(runtime, prepared)
          : readOpenCodePreparedRoomResponder(runtime, prepared);
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
    runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
    const own = this.#readPrepared(runtime, prepared),
      source = own.own.source;
    const effectiveTargetSessionId = own.own.effectiveTargetSessionId;
    if (!effectiveTargetSessionId)
      throw new Error('Original Room preparation has no captured destination.');
    if (this.#claiming.has(prepared)) throw new Error('Original Room claim has already begun.');
    this.#claiming.add(prepared);
    const companion = createRoomStoreDocBudgetCompanion(
      this.#roomStore,
      this.#db,
      source.roomId,
      source.targetAgentId,
      effectiveTargetSessionId,
      source.targetRuntime
    );
    const owner = companion.begin(source.originalSourceHash, source.roomId);
    const policy = companion.readDestinationPolicy(owner);
    companion.readGlobal(owner);
    companion.readRoom(owner);
    // Destination membership, never the historical producer cursor.
    const membership = this.#facade.readCurrentRoomMembership(
      source.roomId,
      source.targetAgentPath
    );
    const destination = projectOriginalRoomDestinationData(
      membership,
      this.#facade.readCurrentRoomMembership(source.roomId, 'system'),
      source.targetAuthorId
    );
    const entryId = randomUUID(),
      dispatchId = randomUUID();
    const at = originalDateNow(),
      nowIso = originalIso.call(new originalDate(at));
    const data = projectOriginalRoomClaimData(source, own.own.producerRoomFacts, {
      nowIso,
      at,
      effectiveTargetSessionId,
      systemAuthorId: destination.systemAuthorId,
      entryId,
      dispatchId,
      maxAgentDepth: policy.maxAgentDepth,
      expectedReadSeq: destination.expectedReadSeq,
    });
    this.#requireCurrentResponder(runtime, prepared, data.expectedReadSeq);
    const barrier = companion.prepare(owner, data);
    if (barrier.state !== 'confirmed')
      throw new Error('Original Room claim barrier was not confirmed.');
    // A new fixed capture after every observable pre-frame cut; native repeats full SQL/CAS inside BEGIN.
    this.#requireCurrentResponder(runtime, prepared, data.expectedReadSeq);
    // Capture the owning budget clock after the native barrier, so its commit window includes it.
    companion.readClock(owner);
    const result = companion.commit(owner, data);
    if (result.state !== 'confirmed') throw new Error('Original Room commit was not confirmed.');
    const commit = result.value;
    const committedMember = this.#facade
      .readCurrentRoomMembership(source.roomId, source.targetAgentPath)
      .members.find((row) => row.author_id === source.targetAuthorId);
    const committedCursor = committedMember?.last_read_seq;
    if (!Number.isSafeInteger(committedCursor) || Number(committedCursor) < 0) {
      try {
        this.#facade.markClaimUnknown(commit);
      } catch {}
      throw new Error('Original committed destination cursor is unavailable.');
    }
    if (!readRoomDocBudgetFirst(companion, commit)) {
      this.#facade.markClaimUnknown(commit);
      throw new Error('Original Room commit lacks SAMEbudget FIRST.');
    }
    try {
      this.#requireCurrentResponder(runtime, prepared, Number(committedCursor));
    } catch (cause) {
      try {
        this.#facade.markClaimUnknown(commit);
      } catch {}
      throw cause;
    }
    const token: OriginalCommittedRoomResponder = Object.freeze({
      kind: 'original-committed-room-responder',
    });
    committedRoomResponders.set(token, {
      runtime,
      prepared,
      operation: own.nativeOperation,
      requireCurrent: () => {
        this.#requireCurrentResponder(runtime, prepared, Number(committedCursor));
        if (!readRoomDocBudgetFirst(companion, commit))
          throw new Error('Original Room FIRST recognition changed.');
      },
      project: (projector, event) => {
        requireOriginalSessionProjection(projector, event);
        if (peekProjector(effectiveTargetSessionId) !== projector || event.type !== 'turn_start')
          throw new Error('Original destination projection changed.');
        this.#requireCurrentResponder(runtime, prepared, Number(committedCursor));
        const result = this.#facade.observeProjectedStart(
          commit,
          `${effectiveTargetSessionId}:${event.seq}`
        );
        if (result.state !== 'confirmed')
          throw new Error('Original projected start was not confirmed.');
      },
      terminal: (projector, event, outcome) => {
        requireOriginalSessionProjection(projector, event);
        try {
          if (
            peekProjector(effectiveTargetSessionId) !== projector ||
            event.type !== 'turn_end' ||
            outcome === undefined
          )
            throw new Error('Original terminal evidence is unavailable.');
          this.#requireCurrentResponder(runtime, prepared, Number(committedCursor));
          const result = this.#facade.settleKnownTerminal(commit, outcome);
          if (result.state !== 'confirmed')
            throw new Error('Original terminal settlement was not confirmed.');
        } catch (cause) {
          try {
            this.#facade.markClaimUnknown(commit);
          } catch {}
          throw cause;
        } finally {
          this.#closePrepared(prepared);
        }
      },
      retire: () => {
        this.#closePrepared(prepared);
        this.#facade.markClaimUnknown(commit);
      },
      consume: () => {
        try {
          this.#requireCurrentResponder(runtime, prepared, Number(committedCursor));
          if (!readRoomDocBudgetFirst(companion, commit))
            throw new Error('Original Room FIRST recognition changed.');
          return Object.freeze({ content: 'Document update', commit });
        } catch (cause) {
          try {
            this.#facade.markClaimUnknown(commit);
          } catch {}
          throw cause;
        }
      },
    });
    const committedOwner = committedRoomResponders.get(token)!;
    activeEmissionOwners.set(token, {
      db: this.#db,
      prepare: async () => {
        if (
          this.#db.$client.inTransaction ||
          committedRoomResponders.get(token) !== committedOwner ||
          committedOwner.consumed !== true
        )
          throw new Error('Original Room emission cannot prepare.');
        committedOwner.requireCurrent();
        const resolved = await resolveOriginalNativePrincipal(
          this.#principals,
          own.nativeOperation
        );
        if (resolved.status !== 'resolved')
          throw new Error('Original Room emission principal retired.');
        committedOwner.requireCurrent();
        let time = captureOriginalPreparedNativeTime(
          this.#principals,
          this.#db,
          own.nativeOperation
        );
        const stage: OriginalRoomEmissionStage = Object.freeze({
          kind: 'original-room-emission-stage',
        });
        const requireFixed = () => {
          // Clock capture exists during preparation too; only the actual private frame selects native SQL.
          const original = emissionStages.get(stage),
            frame = originalEmissionFrames.get(stage);
          if (original?.frameState === 'unknown') throw original.closeFailure?.cause;
          if (
            (original?.frameState === 'open' && !frame) ||
            (frame && original?.frameState !== 'open')
          )
            throw new Error('Original emission frame lifecycle changed.');
          this.#requireCurrentResponder(
            runtime,
            prepared,
            Number(committedCursor),
            time,
            frame ? stage : undefined
          );
          if (!readRoomDocBudgetFirst(companion, commit))
            throw new Error('Original Room emission FIRST retired.');
        };
        requireFixed();
        emissionStages.set(stage, {
          db: this.#db,
          token,
          committed: committedOwner,
          principal: resolved.principal,
          source: source,
          effectiveTargetSessionId,
          principals: this.#principals,
          phase: 'prepared',
          frameState: 'not_started',
          run: (actualStage, emitter, request) => {
            const activeStage = requireEmissionStage(actualStage, this.#db);
            activeStage.frameState = 'open';
            try {
              const outcome = this.#facade.runOriginalCommittedRoomEmission(
                commit,
                (queryDb, sourceDb) => {
                  if (sourceDb !== this.#db)
                    throw new Error('Original Room emission database changed.');
                  return executeDocumentWork(queryDb as DbTransaction, (tx) => {
                    originalEmissionFrames.set(actualStage, { db: this.#db, tx, emitter });
                    try {
                      return sendOriginalDownstreamRoomInsideFrame(
                        emitter,
                        actualStage,
                        tx,
                        request
                      );
                    } finally {
                      originalEmissionFrames.delete(actualStage);
                    }
                  });
                }
              );
              activeStage.frameState = outcome.state === 'unknown' ? 'unknown' : 'closed';
              if (outcome.state !== 'confirmed') {
                if (outcome.state === 'unknown')
                  activeStage.closeFailure = Object.freeze({ cause: outcome.cause });
                throw outcome.cause;
              }
              return outcome.value;
            } catch (cause) {
              if (activeStage.frameState === 'open') {
                activeStage.frameState = 'unknown';
                activeStage.closeFailure = Object.freeze({ cause });
              }
              throw cause;
            } finally {
              originalEmissionFrames.delete(actualStage);
            }
          },
          refresh: () => {
            committedOwner.requireCurrent();
            time = captureOriginalPreparedNativeTime(
              this.#principals,
              this.#db,
              own.nativeOperation
            );
            requireFixed();
            time = captureOriginalRoomEmissionPrincipal(
              this.#principals,
              this.#db,
              own.nativeOperation,
              stage
            );
          },
          require: requireFixed,
          readNativeBinding: (bindingId) => this.#facade.readOriginalRuntimeBinding(bindingId),
          readNativeTarget: () => this.#facade.readOriginalEmissionTargetBinding(source),
        });
        return stage;
      },
    });
    return token;
  }
}

/** Only SDK constructor-created raw iterators can identify their private committed entry. */
function readOriginalStream(stream: object, event?: import('@dorkos/shared/types').StreamEvent) {
  return (
    readClaudeOriginalRoomResponderStream(undefined, stream, event) ??
    readCodexOriginalRoomResponderStream(undefined, stream, event) ??
    readOpenCodeOriginalRoomResponderStream(undefined, stream, event) ??
    readTestModeOriginalRoomResponderStream(undefined, stream, event)
  );
}
/** Observe a stamped projection from the original Room responder stream. */
export function observeOriginalRoomResponderProjection(
  stream: object,
  projector: SessionStateProjector,
  stamped: SessionEvent
): void {
  const read = readOriginalStream(stream);
  if (!read) return;
  const own = committedRoomResponders.get(read.committed);
  if (
    !own ||
    own.runtime !== read.runtime ||
    own.prepared !== read.prepared ||
    own.operation !== read.operation
  )
    throw new Error('Original stream commitment changed.');
  own.project(projector, stamped);
}
/** Settle the original Room responder projection using its stamped event. */
export function settleOriginalRoomResponderProjection(
  stream: object,
  projector: SessionStateProjector,
  stamped: SessionEvent,
  event?: import('@dorkos/shared/types').StreamEvent
): void {
  const read = readOriginalStream(stream, event);
  if (!read) return;
  const own = committedRoomResponders.get(read.committed);
  if (
    !own ||
    own.runtime !== read.runtime ||
    own.prepared !== read.prepared ||
    own.operation !== read.operation
  )
    throw new Error('Original stream terminal commitment changed.');
  try {
    own.terminal(projector, stamped, event?.type === 'done' ? read.outcome : undefined);
  } finally {
    closedRoomCommitments.set(read.committed, {
      runtime: own.runtime,
      prepared: own.prepared,
      operation: own.operation,
    });
    committedRoomResponders.delete(read.committed);
  }
}
