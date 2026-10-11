import type {
  CanvasChannelSendRequest,
  IngestReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  requireOriginalDownstreamEmissionTransaction,
  type OriginalDownstreamRoomEmitter,
} from '../downstream/native-room-emitter.js';
import { readTestModeOriginalRoomResponderStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import { type SessionStateProjector } from '../../../session/session-state-projector.js';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { readClaudeOriginalRoomResponderStream } from '../../../runtimes/claude-code/claude-code-runtime.js';
import { readCodexOriginalRoomResponderStream } from '../../../runtimes/codex/codex-runtime.js';
import { readOpenCodeOriginalRoomResponderStream } from '../../../runtimes/opencode/opencode-runtime.js';
import { requireSameOriginalNativePrincipalPorts } from '../../../connectors/principal/runtime-principal-service.js';
import { type Db, type DbTransaction } from '@dorkos/db';
import type {
  OriginalCommittedRoomResponder,
  OriginalRoomEmissionStage,
  PreparedRoomResponder,
} from '../current/current-operation-types.js';
import { copyCurrentDocData } from '../current/current-operation-data.js';
import { readOriginalRoomResponderCustodyView } from './room-responder-operation.js';
import type { EmissionStageOwner } from './room-responder-private-types.js';

/** Original private emission helper; exact private membership is checked first. */
export function requireEmissionStage(
  custodyOwner: object,
  stage: OriginalRoomEmissionStage,
  db: Db
): EmissionStageOwner {
  const facet = readOriginalRoomResponderCustodyView(custodyOwner);
  const own = facet.emissionStages.get(stage);
  if (
    !own ||
    own.db !== db ||
    own.phase === 'retired' ||
    !db.$client.open ||
    facet.committedRoomResponders.get(own.token) !== own.committed ||
    own.committed.consumed !== true
  )
    throw new Error('Original active Room emission is unavailable.');
  return own;
}

/** Only the consumed original native COMMIT/FIRST entry can prepare an emission stage. */
export function prepareOriginalRoomResponderEmission(
  custodyOwner: object,
  token: OriginalCommittedRoomResponder,
  runtime: object,
  prepared: PreparedRoomResponder,
  operation: object,
  db: Db
): Promise<OriginalRoomEmissionStage> {
  const facet = readOriginalRoomResponderCustodyView(custodyOwner);
  const committed = facet.committedRoomResponders.get(token),
    owner = facet.activeEmissionOwners.get(token);
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
export function refreshOriginalRoomEmissionStage(
  custodyOwner: object,
  stage: OriginalRoomEmissionStage,
  db: Db
): void {
  readOriginalRoomResponderCustodyView(custodyOwner);
  const own = requireEmissionStage(custodyOwner, stage, db);
  if (db.$client.inTransaction || own.tx || own.phase === 'active')
    throw new Error('Original Room emission refresh requires inactive SQL.');
  own.refresh();
  requireEmissionStage(custodyOwner, stage, db);
  own.phase = 'ready';
}

/** Fixed currentness tail only; no configured clock or await executes in this original SQL stage. */
export function requireOriginalRoomEmissionTransaction(
  custodyOwner: object,
  stage: OriginalRoomEmissionStage,
  db: Db,
  tx: DbTransaction,
  principal: import('../../../connectors/principal/server-principal.js').ServerPrincipalProof,
  emitter: OriginalDownstreamRoomEmitter
): void {
  readOriginalRoomResponderCustodyView(custodyOwner);
  const own = requireEmissionStage(custodyOwner, stage, db);
  if (
    !db.$client.inTransaction ||
    own.principal !== principal ||
    !['ready', 'active'].includes(own.phase) ||
    (own.tx && own.tx !== tx)
  )
    throw new Error('Foreign original Room emission transaction.');
  requireOriginalRoomEmissionFrameTransaction(custodyOwner, stage, db, tx, emitter);
  requireOriginalDownstreamEmissionTransaction(emitter, stage, db, tx, principal);
  own.tx = tx;
  own.phase = 'active';
  own.require();
  requireEmissionStage(custodyOwner, stage, db);
  requireOriginalDownstreamEmissionTransaction(emitter, stage, db, tx, principal);
}

/** Only this engine's actual native Room frame creates the synchronous scoped sender handle. */
export function requireOriginalRoomEmissionFrameTransaction(
  custodyOwner: object,
  stage: OriginalRoomEmissionStage,
  db: Db,
  tx: DbTransaction,
  emitter: OriginalDownstreamRoomEmitter
): void {
  const facet = readOriginalRoomResponderCustodyView(custodyOwner);
  const own = requireEmissionStage(custodyOwner, stage, db),
    frame = facet.originalEmissionFrames.get(stage);
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
  custodyOwner: object,
  stage: OriginalRoomEmissionStage,
  db: Db,
  tx: DbTransaction,
  emitter: OriginalDownstreamRoomEmitter,
  bindingId: string
) {
  readOriginalRoomResponderCustodyView(custodyOwner);
  requireOriginalRoomEmissionFrameTransaction(custodyOwner, stage, db, tx, emitter);
  return requireEmissionStage(custodyOwner, stage, db).readNativeBinding(bindingId);
}

/** Exact stage-bound original statement; copied selectors cannot select a different target. */
export function readOriginalRoomEmissionTargetBindingRow(
  custodyOwner: object,
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
  const facet = readOriginalRoomResponderCustodyView(custodyOwner);
  requireOriginalRoomEmissionFrameTransaction(custodyOwner, stage, db, tx, emitter);
  const own = requireEmissionStage(custodyOwner, stage, db),
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
  requireOriginalRoomEmissionFrameTransaction(custodyOwner, stage, db, tx, emitter);
  return Object.freeze(copied);
}

/** Emit through the exact original Room stage and installed downstream emitter. */
export function executeOriginalRoomResponderEmission(
  custodyOwner: object,
  stage: OriginalRoomEmissionStage,
  emitter: OriginalDownstreamRoomEmitter,
  request: CanvasChannelSendRequest
): { receipt: IngestReceipt } {
  const facet = readOriginalRoomResponderCustodyView(custodyOwner);
  const own = facet.emissionStages.get(stage);
  if (!own) throw new Error('Unknown original Room emission stage.');
  requireEmissionStage(custodyOwner, stage, own.db);
  if (own.db.$client.inTransaction || own.phase !== 'ready' || own.frameState !== 'not_started')
    throw new Error('Original Room emission entry cannot reenter.');
  return own.run(stage, emitter, request);
}

/** Cleanup witness only. Ordinary refused sends are safely closed; UNKNOWN preserves its raw cause. */
export function requireOriginalRoomEmissionStageClosed(
  custodyOwner: object,
  stage: OriginalRoomEmissionStage,
  db: Db
): void {
  const facet = readOriginalRoomResponderCustodyView(custodyOwner);
  const own = facet.emissionStages.get(stage);
  if (!own || own.db !== db) throw new Error('Foreign original Room emission cleanup.');
  if (own.frameState === 'unknown') throw own.closeFailure?.cause;
  if (own.phase !== 'retired' || !['not_started', 'closed'].includes(own.frameState))
    throw new Error('Original Room emission is not positively retired and closed.');
}

/** Actual original principal and immutable correlation DATA, never reconstructed actor claims. */
export function requireOriginalRoomEmissionPrincipalPort(
  custodyOwner: object,
  stage: OriginalRoomEmissionStage,
  db: Db,
  principals: object
): void {
  readOriginalRoomResponderCustodyView(custodyOwner);
  requireSameOriginalNativePrincipalPorts(
    requireEmissionStage(custodyOwner, stage, db).principals,
    principals
  );
}

/** Read the principal retained by the exact original Room emission stage. */
export function readOriginalRoomEmissionPrincipal(
  custodyOwner: object,
  stage: OriginalRoomEmissionStage,
  db: Db
) {
  readOriginalRoomResponderCustodyView(custodyOwner);
  return requireEmissionStage(custodyOwner, stage, db).principal;
}

/** Read copied source DATA from the exact original Room emission stage. */
export function readOriginalRoomEmissionSource(
  custodyOwner: object,
  stage: OriginalRoomEmissionStage,
  db: Db
) {
  readOriginalRoomResponderCustodyView(custodyOwner);
  const source = requireEmissionStage(custodyOwner, stage, db).source;
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
    targetSessionId: requireEmissionStage(custodyOwner, stage, db).effectiveTargetSessionId,
    originalTargetSessionId: source.targetSessionId,
    targetRuntime: source.targetRuntime,
    targetAgentPath: source.targetAgentPath,
    inputs: source.inputs.map((input) => ({ eventId: input.eventId, docSeq: input.docSeq })),
  });
}

/** Retire the emission stage bound to the exact original database. */
export function retireOriginalRoomEmissionStage(
  custodyOwner: object,
  stage: OriginalRoomEmissionStage,
  db: Db
): void {
  const facet = readOriginalRoomResponderCustodyView(custodyOwner);
  const own = facet.emissionStages.get(stage);
  if (!own || own.db !== db) throw new Error('Foreign original Room emission retirement.');
  own.phase = 'retired';
}

/** Lookup-only original commit/entry association, never a caller registrar or readiness boolean. */
export function requireOriginalCommittedRoomResponder(
  custodyOwner: object,
  token: OriginalCommittedRoomResponder | undefined,
  runtime: object,
  prepared: PreparedRoomResponder,
  operation: object
): void {
  const facet = readOriginalRoomResponderCustodyView(custodyOwner);
  const own = token && facet.committedRoomResponders.get(token);
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
  custodyOwner: object,
  token: OriginalCommittedRoomResponder,
  runtime: object,
  prepared: PreparedRoomResponder,
  operation: object
): void {
  const facet = readOriginalRoomResponderCustodyView(custodyOwner);
  requireOriginalCommittedRoomResponder(custodyOwner, token, runtime, prepared, operation);
  const own = facet.committedRoomResponders.get(token)!;
  own.requireCurrent();
  requireOriginalCommittedRoomResponder(custodyOwner, token, runtime, prepared, operation);
  if (facet.committedRoomResponders.get(token) !== own)
    throw new Error('Original Room commitment changed during currentness.');
}

/** Only original constructor-issued COMMIT/FIRST custody can be consumed by its exact installed SDK entry. */
export function consumeOriginalCommittedRoomResponder(
  custodyOwner: object,
  token: OriginalCommittedRoomResponder,
  runtime: object,
  prepared: PreparedRoomResponder,
  operation: object
) {
  const facet = readOriginalRoomResponderCustodyView(custodyOwner);
  const own = facet.committedRoomResponders.get(token);
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

/** Retire only the exact original unconsumed commitment; no model retry or budget refund. */
export function retireOriginalCommittedRoomResponder(
  custodyOwner: object,
  token: OriginalCommittedRoomResponder,
  runtime: object,
  prepared: PreparedRoomResponder,
  operation: object
): void {
  const facet = readOriginalRoomResponderCustodyView(custodyOwner);
  const own = facet.committedRoomResponders.get(token);
  const closed = facet.closedRoomCommitments.get(token);
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
  facet.committedRoomResponders.delete(token);
  facet.closedRoomCommitments.set(token, { runtime, prepared, operation });
  own.retire();
}

/** Only SDK constructor-created raw iterators can identify their private committed entry. */
export function readOriginalStream(
  custodyOwner: object,
  stream: object,
  event?: import('@dorkos/shared/types').StreamEvent
):
  | ReturnType<typeof readClaudeOriginalRoomResponderStream>
  | ReturnType<typeof readCodexOriginalRoomResponderStream>
  | ReturnType<typeof readOpenCodeOriginalRoomResponderStream>
  | ReturnType<typeof readTestModeOriginalRoomResponderStream> {
  readOriginalRoomResponderCustodyView(custodyOwner);
  return (
    readClaudeOriginalRoomResponderStream(undefined, stream, event) ??
    readCodexOriginalRoomResponderStream(undefined, stream, event) ??
    readOpenCodeOriginalRoomResponderStream(undefined, stream, event) ??
    readTestModeOriginalRoomResponderStream(undefined, stream, event)
  );
}

/** Observe a stamped projection from the original Room responder stream. */
export function observeOriginalRoomResponderProjection(
  custodyOwner: object,
  stream: object,
  projector: SessionStateProjector,
  stamped: SessionEvent
): void {
  const facet = readOriginalRoomResponderCustodyView(custodyOwner);
  const read = readOriginalStream(custodyOwner, stream);
  if (!read) return;
  const own = facet.committedRoomResponders.get(read.committed);
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
  custodyOwner: object,
  stream: object,
  projector: SessionStateProjector,
  stamped: SessionEvent,
  event?: import('@dorkos/shared/types').StreamEvent
): void {
  const facet = readOriginalRoomResponderCustodyView(custodyOwner);
  const read = readOriginalStream(custodyOwner, stream, event);
  if (!read) return;
  const own = facet.committedRoomResponders.get(read.committed);
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
    facet.closedRoomCommitments.set(read.committed, {
      runtime: own.runtime,
      prepared: own.prepared,
      operation: own.operation,
    });
    facet.committedRoomResponders.delete(read.committed);
  }
}
