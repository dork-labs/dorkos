/** Durable agent events, state CAS and exact per-input acknowledgements without a routing/wake port. */
import { and, eq, canvasDocDeliveries, sql, type DbTransaction } from '@dorkos/db';
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
import { isServerPrincipal } from '../../../connectors/principal/server-principal.js';
import type { DocChannelActor } from '../authorization.js';
import { DocChannelStore, type DocBatchRow, type DocEventRow } from '../store.js';
import { patchDocState } from './state.js';

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
  /** Compose durable storage and current narrow authority. Notifications consume committed log rows separately. */
  constructor(
    private readonly store: DocChannelStore,
    private readonly authority: DocDownstreamAuthority,
    private readonly clock: () => Date = () => new Date(),
    private readonly senderLimit = 60
  ) {
    if (!Number.isSafeInteger(senderLimit) || senderLimit < 1 || senderLimit > 60)
      throw new RangeError('Invalid downstream rate limit.');
  }
  /** Persist one authorized downstream event, settling only the exact named ack inputs when applicable. */
  async send(raw: unknown, actor: DocChannelActor): Promise<{ receipt: IngestReceipt }> {
    const request = CanvasChannelSendRequestSchema.parse(raw);
    const ack =
      request.type === 'app.ack' ? CanvasChannelAppAckSchema.parse(request.payload) : undefined;
    this.actor(actor);
    await this.authority.prepare(request.documentId, actor, ack?.batchId);
    return this.atomic(() =>
      this.store.transaction((tx) => {
        const batch = ack ? this.store.getBatch(ack.batchId, tx) : undefined;
        if (ack && (!batch || batch.documentId !== request.documentId))
          throw new DocDownstreamError('CANVAS_DOCUMENT_NOT_FOUND', 404);
        const access = synchronous(
          ack
            ? this.authority.requireResponderCurrent(request.documentId, batch!, actor, tx)
            : this.authority.requireWriteCurrent(request.documentId, actor, tx)
        );
        this.current(request, access, tx);
        if (
          ack &&
          (batch!.routeId !== ack.routeId ||
            ack.eventIds.some((id) => !batch!.inputEventIds.includes(id)))
        )
          throw new DocDownstreamError('INVALID_APP_ACK_CORRELATION', 409);
        const hash = hashApprovalInput(request);
        const existing = this.duplicate(request.documentId, request.eventId, hash, tx);
        if (existing) return { receipt: this.receipt(existing, true) };
        const now = this.clock().toISOString();
        this.rate(access, now, tx);
        if (ack) {
          // Validate every correlation before the first mutation; a mixed invalid list rolls back entirely.
          const deliveries = ack.eventIds.map((id) =>
            this.store
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
          receipt: this.receipt(
            this.append(
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
  /** Advance separate JSON state and append its patch atomically; retries return the original revision. */
  async patchState(
    raw: unknown,
    actor: DocChannelActor
  ): Promise<{ receipt: IngestReceipt; stateRev: number }> {
    const request = CanvasChannelPatchStateRequestSchema.parse(raw);
    this.actor(actor);
    await this.authority.prepare(request.documentId, actor);
    return this.atomic(() =>
      this.store.transaction((tx) => {
        const access = synchronous(
          this.authority.requireWriteCurrent(request.documentId, actor, tx)
        );
        this.current(request, access, tx);
        const hash = hashApprovalInput(request);
        const existing = this.duplicate(request.documentId, request.eventId, hash, tx);
        if (existing) {
          const payload = existing.payload as { stateRev?: unknown };
          if (existing.type !== 'state.changed' || !Number.isSafeInteger(payload?.stateRev))
            throw new DocDownstreamError('INVALID_STATE_RECEIPT', 409);
          return { receipt: this.receipt(existing, true), stateRev: payload.stateRev as number };
        }
        const now = this.clock().toISOString();
        this.rate(access, now, tx);
        const channel = this.store.getChannel(request.documentId, tx)!;
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
        const event = this.store.replaceState(
          {
            documentId: request.documentId,
            expectedStateRev: request.expectedStateRev,
            state,
            event: this.event(
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
        return { receipt: this.receipt(event, false), stateRev };
      })
    );
  }
  private actor(actor: DocChannelActor): void {
    if (actor.surface !== 'capability' || !isServerPrincipal(actor.principal))
      throw new DocDownstreamError('CANVAS_DOCUMENT_NOT_FOUND', 404);
  }
  private current(
    request: { documentId: string; roomId?: string },
    access: DocDownstreamAccess,
    tx: DbTransaction
  ): void {
    const channel = this.store.getChannel(request.documentId, tx);
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
  private duplicate(
    documentId: string,
    eventId: string,
    hash: string,
    tx: DbTransaction
  ): DocEventRow | undefined {
    const existing = this.store.getEvent(documentId, eventId, tx);
    if (existing && (existing.envelopeHash !== hash || existing.direction !== 'downstream'))
      throw new DocDownstreamError('DOC_EVENT_ID_CONFLICT', 409);
    return existing;
  }
  private rate(access: DocDownstreamAccess, now: string, tx: DbTransaction): void {
    const cutoff = new Date(Date.parse(now) - 60_000).toISOString();
    const row = tx.get<{ count: number }>(sql`SELECT count(*) AS count FROM canvas_doc_events
      WHERE document_id=${access.id} AND direction='downstream' AND received_at>${cutoff}
      AND json_extract(provenance,'$.senderKey')=${access.senderKey}`)!;
    if (row.count >= this.senderLimit)
      throw new DocDownstreamError('DOC_DOWNSTREAM_RATE_LIMIT', 429);
  }
  private event(
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
  private append(
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
    return this.store.appendEvent(
      this.event(documentId, eventId, type, payload, hash, request, access, now),
      tx
    );
  }
  private receipt(event: DocEventRow, duplicate: boolean): IngestReceipt {
    return {
      id: event.eventId,
      status: duplicate ? 'duplicate' : 'recorded',
      docSeq: event.docSeq,
    };
  }
  private atomic<T>(work: () => T): T {
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
