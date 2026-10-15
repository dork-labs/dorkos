import { randomUUID } from 'node:crypto';
import type { Db, DbTransaction } from '@dorkos/db';
import {
  CanvasChannelAppAckSchema,
  type CanvasChannelSendRequest,
  type IngestReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import type { ServerPrincipalProof } from '../../../connectors/principal/server-principal.js';
import {
  requireNativePrincipalDatabase,
  requireSameOriginalNativePrincipalPorts,
} from '../../../connectors/principal/runtime-principal-service.js';
import { requireOriginalNativeDownstreamStore, type DocChannelStore } from '../store.js';
import type {
  OriginalCommittedRoomResponder,
  PreparedRoomResponder,
  OriginalRoomEmissionStage,
} from '../current/current-operation-types.js';
import {
  prepareOriginalRoomResponderEmission,
  readOriginalRoomEmissionSource,
  requireOriginalRoomEmissionPrincipalPort,
  retireOriginalRoomEmissionStage,
  requireOriginalRoomEmissionFrameTransaction,
  requireOriginalRoomEmissionStageClosed,
} from '../operations/room-responder-operation.js';
import type { OriginalDownstreamRoomEmitter } from './native-room-emitter.js';
import { DocDownstreamError } from './service.js';
/** Original privately prepared native emission cells; a DATA shape does not register custody. */
export interface PreparedOriginalEmission {
  request: CanvasChannelSendRequest;
  ack: ReturnType<typeof CanvasChannelAppAckSchema.parse> | undefined;
  principal: ServerPrincipalProof;
  source: ReturnType<typeof readOriginalRoomEmissionSource>;
  now: string;
}
/** Original emitter owner cells retained only by the actual isolated registry. */
export interface OriginalEmitterBinding {
  db: Db;
  principals: object;
  retired: boolean;
  stop?: Promise<void>;
  source: ReturnType<typeof requireOriginalNativeDownstreamStore>;
  active?: { stage: OriginalRoomEmissionStage; tx: DbTransaction; principal: ServerPrincipalProof };
  stages: Set<OriginalRoomEmissionStage>;
  prepared: WeakMap<OriginalRoomEmissionStage, PreparedOriginalEmission>;
  pending: Set<Promise<{ receipt: IngestReceipt }>>;
  inside: (
    stage: OriginalRoomEmissionStage,
    tx: DbTransaction,
    request: CanvasChannelSendRequest
  ) => { receipt: IngestReceipt };
  send: (stage: OriginalRoomEmissionStage, raw: unknown) => Promise<{ receipt: IngestReceipt }>;
}
/** Allocate unrelated emitter custody; only the original service module retains its actual instance. */
export function createIsolatedDownstreamEmitterCustody() {
  const originalEmitters = new WeakMap<OriginalDownstreamRoomEmitter, OriginalEmitterBinding>();
  const originalEmitterStores = new WeakMap<DocChannelStore, OriginalDownstreamRoomEmitter>();

  /** Lookup-only actual captured child closure. No stop, reporter or exception-class inference. */
  function requireOriginalDownstreamRoomEmissionClosed(
    emitter: OriginalDownstreamRoomEmitter,
    db: Db
  ): void {
    const own = originalEmitters.get(emitter);
    if (!own || own.db !== db) throw new Error('Original downstream child/SAME database required');
    if (own.active || own.pending.size !== 0)
      throw new Error('Original downstream emission remains active');
    // Closed stages are removed only after the original engine-owned closed witness
    // positively succeeds. Retained stages include UNKNOWN raw causes, even undefined.
    for (const stage of own.stages) requireOriginalRoomEmissionStageClosed(stage, db);
  }

  /** Only the actual captured sender callback can establish a native final-transaction context. */
  function requireOriginalDownstreamEmissionTransaction(
    emitter: OriginalDownstreamRoomEmitter,
    stage: OriginalRoomEmissionStage,
    db: Db,
    tx: DbTransaction,
    principal: ServerPrincipalProof
  ): void {
    const own = originalEmitters.get(emitter);
    if (
      !own ||
      own.retired ||
      own.db !== db ||
      own.active?.stage !== stage ||
      own.active.tx !== tx ||
      own.active.principal !== principal
    )
      throw new DocDownstreamError('ORIGINAL_DOWNSTREAM_TRANSACTION_REQUIRED', 409);
    requireOriginalRoomEmissionPrincipalPort(stage, db, own.principals);
  }

  /** Fixed original installation-child lookup checks SAME constructor-owned principal core. */
  function requireOriginalDownstreamRoomEmitterOwner(
    emitter: OriginalDownstreamRoomEmitter,
    db: Db,
    principals: object
  ): void {
    const own = originalEmitters.get(emitter);
    if (!own || own.db !== db || own.retired)
      throw new DocDownstreamError('ORIGINAL_DOWNSTREAM_EMITTER_REQUIRED', 409);
    requireNativePrincipalDatabase(principals, db);
    requireSameOriginalNativePrincipalPorts(own.principals, principals);
  }

  /** Only an actual original engine-generated Room frame may invoke the captured synchronous child. */
  function sendOriginalDownstreamRoomInsideFrame(
    emitter: OriginalDownstreamRoomEmitter,
    stage: OriginalRoomEmissionStage,
    tx: DbTransaction,
    request: CanvasChannelSendRequest
  ): { receipt: IngestReceipt } {
    const own = originalEmitters.get(emitter);
    if (!own || own.retired || own.prepared.get(stage)?.request !== request)
      throw new DocDownstreamError('ORIGINAL_DOWNSTREAM_FRAME_REQUIRED', 409);
    requireOriginalRoomEmissionFrameTransaction(stage, own.db, tx, emitter);
    return own.inside(stage, tx, request);
  }

  /** The native lane supplies its actual committed tuple, never a page actor or source DTO. */
  function sendOriginalRoomResponderEvent(
    emitter: OriginalDownstreamRoomEmitter,
    token: OriginalCommittedRoomResponder,
    runtime: object,
    prepared: PreparedRoomResponder,
    operation: object,
    raw: unknown
  ): Promise<{ receipt: IngestReceipt }> {
    return enqueueOriginalRoomResponderEvent(emitter, token, runtime, prepared, operation, raw);
  }
  /** Fixed TestMode script: correlation comes from the original stage, never its model prompt. */
  function sendOriginalRoomResponderScriptStep(
    emitter: OriginalDownstreamRoomEmitter,
    token: OriginalCommittedRoomResponder,
    runtime: object,
    prepared: PreparedRoomResponder,
    operation: object,
    step: 'ack-first' | 'reply-second'
  ): Promise<{ receipt: IngestReceipt }> {
    if (step !== 'ack-first' && step !== 'reply-second')
      return Promise.reject(new DocDownstreamError('INVALID_ORIGINAL_ROOM_SCRIPT_STEP', 409));
    return enqueueOriginalRoomResponderEvent(
      emitter,
      token,
      runtime,
      prepared,
      operation,
      undefined,
      step
    );
  }
  /** Original installation child recognition before a runtime captures its opaque emitter. */
  function requireOriginalRoomEmitterPrincipalPort(
    emitter: OriginalDownstreamRoomEmitter,
    principals: object
  ): void {
    const own = originalEmitters.get(emitter);
    if (!own || own.retired)
      throw new DocDownstreamError('ORIGINAL_DOWNSTREAM_EMITTER_REQUIRED', 409);
    requireSameOriginalNativePrincipalPorts(own.principals, principals);
  }

  /** The native lane supplies its actual committed token/runtime/prepared/op, never a page DTO. */
  function enqueueOriginalRoomResponderEvent(
    emitter: OriginalDownstreamRoomEmitter,
    token: OriginalCommittedRoomResponder,
    runtime: object,
    prepared: PreparedRoomResponder,
    operation: object,
    raw: unknown,
    script?: 'ack-first' | 'reply-second'
  ): Promise<{ receipt: IngestReceipt }> {
    const own = originalEmitters.get(emitter);
    if (!own || own.retired)
      return Promise.reject(new DocDownstreamError('ORIGINAL_DOWNSTREAM_EMITTER_REQUIRED', 409));
    // Register the complete preparation/send/retirement promise before owner callbacks can reenter stop.
    const promise = Promise.resolve().then(async () => {
      if (own.retired) throw new DocDownstreamError('ORIGINAL_DOWNSTREAM_EMITTER_RETIRED', 409);
      const stage = await prepareOriginalRoomResponderEmission(
        token,
        runtime,
        prepared,
        operation,
        own.db
      );
      own.stages.add(stage);
      let failed = false;
      let first: unknown;
      let result: { receipt: IngestReceipt } | undefined;
      try {
        requireOriginalRoomEmissionPrincipalPort(stage, own.db, own.principals);
        if (own.retired) throw new DocDownstreamError('ORIGINAL_DOWNSTREAM_EMITTER_RETIRED', 409);
        let request = raw;
        if (script !== undefined) {
          const source = readOriginalRoomEmissionSource(stage, own.db);
          if (source.inputs.length !== 2 || source.inputs[0].eventId === source.inputs[1].eventId)
            throw new DocDownstreamError('ORIGINAL_ROOM_SCRIPT_REQUIRES_TWO_INPUTS', 409);
          const eventId = randomUUID();
          request =
            script === 'ack-first'
              ? {
                  documentId: source.documentId,
                  roomId: source.roomId,
                  eventId,
                  type: 'app.ack',
                  payload: {
                    batchId: source.batchId,
                    routeId: source.routeId,
                    eventIds: [source.inputs[0].eventId],
                    outcome: 'handled',
                  },
                }
              : {
                  documentId: source.documentId,
                  roomId: source.roomId,
                  eventId,
                  type: 'agent.reply',
                  payload: {
                    inReplyTo: [source.inputs[1].eventId],
                    text: 'Original native second-input reply',
                  },
                };
        }
        result = await own.send(stage, request);
      } catch (cause) {
        failed = true;
        first = cause;
      } finally {
        try {
          retireOriginalRoomEmissionStage(stage, own.db);
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
        try {
          requireOriginalRoomEmissionStageClosed(stage, own.db);
          own.stages.delete(stage);
        } catch (cause) {
          own.retired = true;
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
      }
      if (failed) throw first;
      return result!;
    });
    own.pending.add(promise);
    void promise.then(
      () => {
        own.pending.delete(promise);
      },
      () => {
        own.pending.delete(promise);
      }
    );
    return promise;
  }

  /** Captured installation cleanup retires new sends then drains actual pending original sends. */
  function stopOriginalEmitter(emitter: OriginalDownstreamRoomEmitter): Promise<void> {
    const own = originalEmitters.get(emitter)!;
    if (own.stop) return own.stop;
    own.retired = true;
    own.stop = Promise.allSettled([...own.pending]).then(() => {
      // Ordinary settled sender refusals are drained. Only original native close witnesses decide custody.
      let failed = false;
      let first: unknown;
      for (const stage of own.stages) {
        try {
          requireOriginalRoomEmissionStageClosed(stage, own.db);
          own.stages.delete(stage);
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
      }
      if (failed) throw first;
    });
    return own.stop;
  }

  return Object.freeze({
    originalEmitters,
    originalEmitterStores,
    stopOriginalEmitter,
    requireOriginalDownstreamRoomEmissionClosed,
    requireOriginalDownstreamEmissionTransaction,
    requireOriginalDownstreamRoomEmitterOwner,
    sendOriginalDownstreamRoomInsideFrame,
    sendOriginalRoomResponderEvent,
    sendOriginalRoomResponderScriptStep,
    requireOriginalRoomEmitterPrincipalPort,
  });
}
