/** Durable agent events, state CAS and exact per-input acknowledgements without a routing/wake port. */
import { randomUUID } from 'node:crypto';
import { and, eq, canvasDocDeliveries, sql, type Db, type DbTransaction } from '@dorkos/db';
import {
  CanvasChannelAppAckSchema,
  CanvasChannelSendRequestSchema,
  CanvasChannelPatchStateRequestSchema,
  CanvasChannelStateSchema,
  type CanvasChannelSendRequest,
  type CanvasChannelPatchStateRequest,
  type CanvasChannelJsonValue,
  type IngestReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../../core/approvals/approval-input-hash.js';
import {
  isServerPrincipal,
  type ServerPrincipalProof,
} from '../../../connectors/principal/server-principal.js';
import type { DocChannelActor } from '../authorization.js';
import {
  DocChannelStore,
  requireOriginalNativeDownstreamStore,
  type DocBatchRow,
  type DocEventRow,
} from '../store.js';
import { patchDocState } from './state.js';

import {
  requireNativePrincipalDatabase,
  requireSameOriginalNativePrincipalPorts,
} from '../../../connectors/principal/runtime-principal-service.js';
import type {
  OriginalCommittedRoomResponder,
  PreparedRoomResponder,
  OriginalRoomEmissionStage,
} from '../current/current-operation-types.js';
import {
  prepareOriginalRoomResponderEmission,
  refreshOriginalRoomEmissionStage,
  readOriginalRoomEmissionPrincipal,
  readOriginalRoomEmissionSource,
  requireOriginalRoomEmissionTransaction,
  requireOriginalRoomEmissionPrincipalPort,
  retireOriginalRoomEmissionStage,
  executeOriginalRoomResponderEmission,
  requireOriginalRoomEmissionFrameTransaction,
  requireOriginalRoomEmissionStageClosed,
} from '../operations/room-responder-operation.js';
import type { OriginalDownstreamRoomEmitter } from './native-room-emitter.js';

interface PreparedOriginalEmission {
  request: CanvasChannelSendRequest;
  ack: ReturnType<typeof CanvasChannelAppAckSchema.parse> | undefined;
  principal: ServerPrincipalProof;
  source: ReturnType<typeof readOriginalRoomEmissionSource>;
  now: string;
}
interface OriginalEmitterBinding {
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
const originalEmitters = new WeakMap<OriginalDownstreamRoomEmitter, OriginalEmitterBinding>();
const originalEmitterStores = new WeakSet<DocChannelStore>();

/** Lookup-only actual captured child closure. No stop, reporter or exception-class inference. */
export function requireOriginalDownstreamRoomEmissionClosed(
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
export function requireOriginalDownstreamEmissionTransaction(
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
export function requireOriginalDownstreamRoomEmitterOwner(
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
export function sendOriginalDownstreamRoomInsideFrame(
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
export function sendOriginalRoomResponderEvent(
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
export function sendOriginalRoomResponderScriptStep(
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
export function requireOriginalRoomEmitterPrincipalPort(
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

/** Verified document-only write authority; senderKey is server-derived and never projected to pages. */
export interface DocDownstreamAccess {
  id: string;
  scope: string;
  senderKey: string;
  evidence: Record<string, CanvasChannelJsonValue>;
}
/** Async preflight precedes a synchronous final gate in the guarded SQLite transaction. */
export interface DocDownstreamAuthority {
  prepare(documentId: string, actor: DocChannelActor, ackBatchId?: string): Promise<void>;
  requireWriteCurrent(
    documentId: string,
    actor: DocChannelActor,
    tx: DbTransaction
  ): DocDownstreamAccess;
  /** Grant/batch responder gate, not owning-scope or transcript authority. Refuse rooms until an admitted responder is recorded. */
  requireResponderCurrent(
    documentId: string,
    batch: DocBatchRow,
    actor: DocChannelActor,
    tx: DbTransaction
  ): DocDownstreamAccess;
}
/** Typed downstream refusal with no private payload in its message. */
export class DocDownstreamError extends Error {
  /** Build a disclosure-safe channel refusal. */
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
  }
}
function synchronous<T>(value: T): T {
  if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
    void Promise.resolve(value).catch(() => {});
    throw new DocDownstreamError('INVALID_DOWNSTREAM_AUTHORITY', 404);
  }
  return value;
}
/** Agent-originated persistence. No dispatcher, retry, admission or runtime wake callback exists here. */
export class DocChannelDownstream {
  /** One original downstream child is born with its native origin, SAME Db/store/principal core. */
  static createInstallationDownstream(
    db: Db,
    store: DocChannelStore,
    authority: DocDownstreamAuthority,
    principals: object,
    clock: () => Date = () => new Date(),
    senderLimit = 60
  ) {
    requireNativePrincipalDatabase(principals, db);
    const source = requireOriginalNativeDownstreamStore(store, db);
    if (originalEmitterStores.has(store))
      throw new DocDownstreamError('ORIGINAL_DOWNSTREAM_ALREADY_CONSTRUCTED', 409);
    const downstream = new DocChannelDownstream(store, authority, clock, senderLimit);
    const emitter = Object.freeze(Object.create(null)) as OriginalDownstreamRoomEmitter;
    const own: OriginalEmitterBinding = {
      db,
      principals,
      source,
      retired: false,
      pending: new Set(),
      stages: new Set(),
      prepared: new WeakMap(),
      send: (stage, raw) => downstream.#sendNativeRoom(emitter, stage, raw),
      inside: (stage, tx, request) =>
        downstream.#sendNativeRoomInsideFrame(emitter, stage, tx, request),
    };
    originalEmitterStores.add(store);
    originalEmitters.set(emitter, own);
    return Object.freeze({ downstream, emitter, stop: () => stopOriginalEmitter(emitter) });
  }

  readonly #store: DocChannelStore;
  readonly #authority: DocDownstreamAuthority;
  readonly #clock: () => Date;
  readonly #senderLimit: number;
  /** Compose durable storage and current narrow authority. Notifications consume committed log rows separately. */
  constructor(
    store: DocChannelStore,
    authority: DocDownstreamAuthority,
    clock: () => Date = () => new Date(),
    senderLimit = 60
  ) {
    if (!Number.isSafeInteger(senderLimit) || senderLimit < 1 || senderLimit > 60)
      throw new RangeError('Invalid downstream rate limit.');
    this.#store = store;
    this.#authority = Object.freeze({
      prepare: authority.prepare.bind(authority),
      requireWriteCurrent: authority.requireWriteCurrent.bind(authority),
      requireResponderCurrent: authority.requireResponderCurrent.bind(authority),
    });
    this.#clock = clock;
    this.#senderLimit = senderLimit;
  }
  /** Persist one authorized downstream event, settling only the exact named ack inputs when applicable. */
  async send(raw: unknown, actor: DocChannelActor): Promise<{ receipt: IngestReceipt }> {
    const request = CanvasChannelSendRequestSchema.parse(raw);
    const ack =
      request.type === 'app.ack' ? CanvasChannelAppAckSchema.parse(request.payload) : undefined;
    this.#actor(actor);
    const replyBatchId =
      request.type === 'agent.reply' ? this.#replyBatch(request, actor)?.batchId : undefined;
    await this.#authority.prepare(request.documentId, actor, ack?.batchId ?? replyBatchId);
    return this.#atomic(() =>
      this.#store.transaction((tx) => {
        const batch = ack
          ? this.#store.getBatch(ack.batchId, tx)
          : replyBatchId
            ? this.#replyBatch(request, actor, tx)
            : undefined;
        if (replyBatchId && batch?.batchId !== replyBatchId)
          throw new DocDownstreamError('INVALID_AGENT_REPLY_CORRELATION', 409);
        if (ack && (!batch || batch.documentId !== request.documentId))
          throw new DocDownstreamError('CANVAS_DOCUMENT_NOT_FOUND', 404);
        const access = synchronous(
          ack || replyBatchId
            ? this.#authority.requireResponderCurrent(request.documentId, batch!, actor, tx)
            : this.#authority.requireWriteCurrent(request.documentId, actor, tx)
        );
        this.#current(request, access, tx);
        if (
          ack &&
          (batch!.routeId !== ack.routeId ||
            ack.eventIds.some((id) => !batch!.inputEventIds.includes(id)))
        )
          throw new DocDownstreamError('INVALID_APP_ACK_CORRELATION', 409);
        const hash = hashApprovalInput(request);
        const existing = this.#duplicate(request.documentId, request.eventId, hash, tx);
        if (existing) return { receipt: this.#receipt(existing, true) };
        const now = this.#clock().toISOString();
        this.#rate(access, now, tx);
        if (ack) {
          // Validate every correlation before the first mutation; a mixed invalid list rolls back entirely.
          const deliveries = ack.eventIds.map((id) =>
            this.#store
              .listDeliveries(request.documentId, id, tx)
              .find(
                (delivery) => delivery.routeId === ack.routeId && delivery.batchId === ack.batchId
              )
          );
          if (
            deliveries.some(
              (delivery) =>
                !delivery || (delivery.ackOutcome && delivery.ackOutcome !== ack.outcome)
            )
          )
            throw new DocDownstreamError('INVALID_APP_ACK_CORRELATION', 409);
          for (const delivery of deliveries) {
            if (delivery!.ackOutcome) continue;
            tx.update(canvasDocDeliveries)
              .set({
                ackOutcome: ack.outcome,
                acknowledgedAt: now,
                acknowledgedBy: access.senderKey,
                ackEvidence: {
                  ...access.evidence,
                  downstreamEventId: request.eventId,
                  batchId: ack.batchId,
                  routeId: ack.routeId,
                  generation: batch!.generation,
                },
                updatedAt: now,
              })
              .where(
                and(
                  eq(canvasDocDeliveries.documentId, request.documentId),
                  eq(canvasDocDeliveries.eventId, delivery!.eventId),
                  eq(canvasDocDeliveries.routeId, ack.routeId)
                )
              )
              .run();
          }
        }
        return {
          receipt: this.#receipt(
            this.#append(
              request.documentId,
              request.eventId,
              request.type,
              request.payload,
              hash,
              request,
              access,
              now,
              tx
            ),
            false
          ),
        };
      })
    );
  }
  #replyBatch(
    request: CanvasChannelSendRequest,
    actor: DocChannelActor,
    tx?: DbTransaction
  ): DocBatchRow | undefined {
    const claims = actor.principal.claims;
    if (claims.kind !== 'runtime') return undefined;
    const payload = request.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const ids = (payload as { inReplyTo?: unknown }).inReplyTo;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== 'string') ||
      new Set(ids).size !== ids.length
    )
      return undefined;
    const candidates = new Map<string, DocBatchRow>();
    for (const delivery of this.#store.listDeliveries(request.documentId, ids[0]!, tx)) {
      if (!delivery.batchId) continue;
      const batch = this.#store.getBatch(delivery.batchId, tx);
      if (
        !batch ||
        batch.documentId !== request.documentId ||
        !batch.scope.startsWith('session:') ||
        !ids.every((id) => batch.inputEventIds.includes(id))
      )
        continue;
      const grant = this.#store.getGrant(batch.grantId, tx);
      if (
        !grant ||
        grant.targetAgentId !== claims.agentId ||
        grant.targetRuntime !== claims.runtime
      )
        continue;
      if (
        !ids.every((id) =>
          this.#store
            .listDeliveries(request.documentId, id, tx)
            .some((row) => row.batchId === batch.batchId && row.routeId === batch.routeId)
        )
      )
        continue;
      candidates.set(batch.batchId, batch);
    }
    // Before preflight, select only an identifier; disclose ambiguity after current responder authorization.
    if (tx && candidates.size > 1)
      throw new DocDownstreamError('INVALID_AGENT_REPLY_CORRELATION', 409);
    return candidates.values().next().value;
  }
  async #sendNativeRoom(
    emitter: OriginalDownstreamRoomEmitter,
    stage: OriginalRoomEmissionStage,
    raw: unknown
  ): Promise<{ receipt: IngestReceipt }> {
    const own = originalEmitters.get(emitter)!;
    const request = CanvasChannelSendRequestSchema.parse(raw);
    const ack =
      request.type === 'app.ack' ? CanvasChannelAppAckSchema.parse(request.payload) : undefined;
    const principal = readOriginalRoomEmissionPrincipal(stage, own.db);
    const source = readOriginalRoomEmissionSource(stage, own.db);
    this.#actor({ surface: 'capability', principal });
    if (
      request.documentId !== source.documentId ||
      request.roomId !== source.roomId ||
      source.scope !== `room:${source.roomId}`
    )
      throw new DocDownstreamError('INVALID_NATIVE_ROOM_CORRELATION', 409);
    const ids = source.inputs.map((input) => input.eventId);
    if (ack) {
      if (
        ack.batchId !== source.batchId ||
        ack.routeId !== source.routeId ||
        ack.eventIds.some((id) => !ids.includes(id))
      )
        throw new DocDownstreamError('INVALID_APP_ACK_CORRELATION', 409);
    } else {
      const reply = request.payload as { inReplyTo?: unknown };
      if (
        !reply ||
        typeof reply !== 'object' ||
        !Array.isArray(reply.inReplyTo) ||
        !reply.inReplyTo.length ||
        new Set(reply.inReplyTo).size !== reply.inReplyTo.length ||
        reply.inReplyTo.some((id) => typeof id !== 'string' || !ids.includes(id))
      )
        throw new DocDownstreamError('INVALID_NATIVE_ROOM_REPLY_CORRELATION', 409);
    }
    // All original awaited preflight happened in prepare. Capture configured clock before final native refresh.
    const now = this.#clock().toISOString();
    refreshOriginalRoomEmissionStage(stage, own.db);
    if (own.retired) throw new DocDownstreamError('ORIGINAL_DOWNSTREAM_EMITTER_RETIRED', 409);
    if (own.prepared.has(stage))
      throw new DocDownstreamError('ORIGINAL_DOWNSTREAM_STAGE_REENTRY', 409);
    own.prepared.set(stage, { request, ack, principal, source, now });
    try {
      return executeOriginalRoomResponderEmission(stage, emitter, request);
    } finally {
      own.prepared.delete(stage);
    }
  }
  #sendNativeRoomInsideFrame(
    emitter: OriginalDownstreamRoomEmitter,
    stage: OriginalRoomEmissionStage,
    tx: DbTransaction,
    request: CanvasChannelSendRequest
  ): { receipt: IngestReceipt } {
    const own = originalEmitters.get(emitter)!;
    const prepared = own.prepared.get(stage);
    if (!prepared || prepared.request !== request)
      throw new DocDownstreamError('ORIGINAL_DOWNSTREAM_STAGE_REQUIRED', 409);
    const { ack, principal, source, now } = prepared;
    return this.#atomic(() => {
      if (own.active) throw new DocDownstreamError('ORIGINAL_DOWNSTREAM_TRANSACTION_REENTRY', 409);
      own.active = { stage, tx, principal };
      try {
        requireOriginalRoomEmissionTransaction(stage, own.db, tx, principal, emitter);
        const batch = own.source.getBatch(source.batchId, tx);
        const channel = own.source.getChannel(source.documentId, tx);
        if (
          !batch ||
          batch.generation !== source.generation ||
          batch.documentId !== source.documentId ||
          batch.routeId !== source.routeId ||
          batch.grantId !== source.grantId ||
          batch.grantRevision !== source.grantRevision ||
          !channel ||
          channel.closedAt ||
          channel.scope !== source.scope
        )
          throw new DocDownstreamError('INVALID_NATIVE_ROOM_CORRELATION', 409);
        const claims = principal.claims;
        if (claims.kind !== 'runtime')
          throw new DocDownstreamError('CANVAS_DOCUMENT_NOT_FOUND', 404);
        const access: DocDownstreamAccess = {
          id: source.documentId,
          scope: source.scope,
          senderKey: `runtime:${claims.runtime}:${claims.agentId}`,
          evidence: {
            agentId: claims.agentId,
            runtime: claims.runtime,
            sessionId: claims.canonicalSessionId,
            agentPath: claims.agentPath,
            bindingId: claims.bindingId,
            grantId: source.grantId,
            grantRevision: source.grantRevision,
            batchId: source.batchId,
            generation: source.generation,
            admissionId: source.admissionId,
            originalSourceHash: source.originalSourceHash,
          },
        };
        const hash = hashApprovalInput(request);
        const existing = own.source.getEvent(source.documentId, request.eventId, tx);
        if (existing) {
          if (existing.envelopeHash !== hash || existing.direction !== 'downstream')
            throw new DocDownstreamError('DOC_EVENT_ID_CONFLICT', 409);
          requireOriginalRoomEmissionTransaction(stage, own.db, tx, principal, emitter);
          return { receipt: this.#receipt(existing, true) };
        }
        this.#rate(access, now, tx);
        const deliveries = ack
          ? ack.eventIds.map((id) =>
              own.source
                .listDeliveries(source.documentId, id, tx)
                .find((row) => row.routeId === source.routeId && row.batchId === source.batchId)
            )
          : [];
        if (deliveries.some((row) => !row || (row.ackOutcome && row.ackOutcome !== ack!.outcome)))
          throw new DocDownstreamError('INVALID_APP_ACK_CORRELATION', 409);
        // Fixed last native/current source/FIRST gate; no awaited/configured callback follows before mutations.
        requireOriginalRoomEmissionTransaction(stage, own.db, tx, principal, emitter);
        for (const row of deliveries) {
          if (row!.ackOutcome) continue;
          tx.update(canvasDocDeliveries)
            .set({
              ackOutcome: ack!.outcome,
              acknowledgedAt: now,
              acknowledgedBy: access.senderKey,
              ackEvidence: {
                ...access.evidence,
                downstreamEventId: request.eventId,
                routeId: source.routeId,
              },
              updatedAt: now,
            })
            .where(
              and(
                eq(canvasDocDeliveries.documentId, source.documentId),
                eq(canvasDocDeliveries.eventId, row!.eventId),
                eq(canvasDocDeliveries.routeId, source.routeId)
              )
            )
            .run();
        }
        const event = own.source.appendEvent(
          this.#event(
            source.documentId,
            request.eventId,
            request.type,
            request.payload,
            hash,
            request,
            access,
            now
          ),
          tx
        );
        requireOriginalRoomEmissionTransaction(stage, own.db, tx, principal, emitter);
        return { receipt: this.#receipt(event, false) };
      } finally {
        own.active = undefined;
      }
    });
  }
  /** Advance separate JSON state and append its patch atomically; retries return the original revision. */
  async patchState(
    raw: unknown,
    actor: DocChannelActor
  ): Promise<{ receipt: IngestReceipt; stateRev: number }> {
    const request = CanvasChannelPatchStateRequestSchema.parse(raw);
    this.#actor(actor);
    await this.#authority.prepare(request.documentId, actor);
    return this.#atomic(() =>
      this.#store.transaction((tx) => {
        const access = synchronous(
          this.#authority.requireWriteCurrent(request.documentId, actor, tx)
        );
        this.#current(request, access, tx);
        const hash = hashApprovalInput(request);
        const existing = this.#duplicate(request.documentId, request.eventId, hash, tx);
        if (existing) {
          const payload = existing.payload as { stateRev?: unknown };
          if (existing.type !== 'state.changed' || !Number.isSafeInteger(payload?.stateRev))
            throw new DocDownstreamError('INVALID_STATE_RECEIPT', 409);
          return { receipt: this.#receipt(existing, true), stateRev: payload.stateRev as number };
        }
        const now = this.#clock().toISOString();
        this.#rate(access, now, tx);
        const channel = this.#store.getChannel(request.documentId, tx)!;
        if (channel.stateRev !== request.expectedStateRev)
          throw new DocDownstreamError('DOC_STATE_REV_CONFLICT', 409);
        if (request.expectedStateRev >= Number.MAX_SAFE_INTEGER)
          throw new DocDownstreamError('DOC_STATE_REV_LIMIT', 409);
        let state;
        try {
          state = patchDocState(CanvasChannelStateSchema.parse(channel.state), request.operations);
        } catch {
          throw new DocDownstreamError('INVALID_DOC_STATE_PATCH', 422);
        }
        const stateRev = request.expectedStateRev + 1;
        const payload = { operations: request.operations, stateRev };
        const event = this.#store.replaceState(
          {
            documentId: request.documentId,
            expectedStateRev: request.expectedStateRev,
            state,
            event: this.#event(
              request.documentId,
              request.eventId,
              'state.changed',
              payload,
              hash,
              request,
              access,
              now
            ),
          },
          tx
        );
        return { receipt: this.#receipt(event, false), stateRev };
      })
    );
  }
  #actor(actor: DocChannelActor): void {
    if (actor.surface !== 'capability' || !isServerPrincipal(actor.principal))
      throw new DocDownstreamError('CANVAS_DOCUMENT_NOT_FOUND', 404);
  }
  #current(
    request: { documentId: string; roomId?: string },
    access: DocDownstreamAccess,
    tx: DbTransaction
  ): void {
    const channel = this.#store.getChannel(request.documentId, tx);
    if (
      access.id !== request.documentId ||
      !channel ||
      channel.closedAt ||
      channel.scope !== access.scope ||
      (request.roomId !== undefined && access.scope !== `room:${request.roomId}`) ||
      !access.senderKey
    )
      throw new DocDownstreamError('CANVAS_DOCUMENT_NOT_FOUND', 404);
  }
  #duplicate(
    documentId: string,
    eventId: string,
    hash: string,
    tx: DbTransaction
  ): DocEventRow | undefined {
    const existing = this.#store.getEvent(documentId, eventId, tx);
    if (existing && (existing.envelopeHash !== hash || existing.direction !== 'downstream'))
      throw new DocDownstreamError('DOC_EVENT_ID_CONFLICT', 409);
    return existing;
  }
  #rate(access: DocDownstreamAccess, now: string, tx: DbTransaction): void {
    const cutoff = new Date(Date.parse(now) - 60_000).toISOString();
    const row = tx.get<{ count: number }>(sql`SELECT count(*) AS count FROM canvas_doc_events
      WHERE document_id=${access.id} AND direction='downstream' AND received_at>${cutoff}
      AND json_extract(provenance,'$.senderKey')=${access.senderKey}`)!;
    if (row.count >= this.#senderLimit)
      throw new DocDownstreamError('DOC_DOWNSTREAM_RATE_LIMIT', 429);
  }
  #event(
    documentId: string,
    eventId: string,
    type: string,
    payload: CanvasChannelJsonValue,
    hash: string,
    request: CanvasChannelSendRequest | CanvasChannelPatchStateRequest,
    access: DocDownstreamAccess,
    now: string
  ) {
    return {
      documentId,
      eventId,
      direction: 'downstream' as const,
      type,
      payload,
      envelopeHash: hash,
      envelopeBytes: Buffer.byteLength(JSON.stringify(request)),
      provenance: { source: 'doc-channel-agent', senderKey: access.senderKey },
      receivedAt: now,
    };
  }
  #append(
    documentId: string,
    eventId: string,
    type: string,
    payload: CanvasChannelJsonValue,
    hash: string,
    request: CanvasChannelSendRequest,
    access: DocDownstreamAccess,
    now: string,
    tx: DbTransaction
  ) {
    return this.#store.appendEvent(
      this.#event(documentId, eventId, type, payload, hash, request, access, now),
      tx
    );
  }
  #receipt(event: DocEventRow, duplicate: boolean): IngestReceipt {
    return {
      id: event.eventId,
      status: duplicate ? 'duplicate' : 'recorded',
      docSeq: event.docSeq,
    };
  }
  #atomic<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string' &&
        error.code.startsWith('SQLITE_')
      )
        throw new DocDownstreamError('DOC_EVENT_STORAGE_FAILURE', 507);
      throw error;
    }
  }
}
