/** Internal page-event acceptance. The host supplies a synchronous, verified authority callback. */
import { randomUUID } from 'node:crypto';
import type { DbTransaction } from '@dorkos/db';
import {
  PageEventSchema,
  matchesCanvasChannelEvent,
  type IngestReceipt,
  type PageEvent,
} from '@dorkos/shared/canvas-channel-schemas';
import { DocChannelStore, DocChannelClosedError } from './store.js';
import { envelopeIdentity } from './envelope.js';
import { DOC_EVENTS_PROMPT_BYTES, docEventsPromptBytes } from './prompt.js';
import { queueInput } from './coalescer.js';
import { DocIngestRefusal, type DocIngestAuthority } from './ingest-types.js';
import {
  checkIngestCapacity,
  backfillEnvelopeAccounting,
  DOC_INGEST_LIMITS,
  type DocIngestLimits,
} from './accounting.js';

/** Durable accepted input with route receipts; publication can occur only after this returns. */
export interface DocIngestResult {
  receipt: IngestReceipt;
  deliveries: ReturnType<DocChannelStore['listDeliveries']>;
}

/** Synchronous ingest/coalescer entry point, with no HTTP, grant creation or runtime side effects. */
export class DocChannelIngest {
  private readonly limits: DocIngestLimits;
  /** Build over the shared channel store; lower limits are useful for installation policy and tests. */
  constructor(
    private readonly store: DocChannelStore,
    private readonly clock: () => Date = () => new Date(),
    limits: Partial<DocIngestLimits> = {}
  ) {
    this.limits = { ...DOC_INGEST_LIMITS };
    for (const key of Object.keys(this.limits) as (keyof DocIngestLimits)[]) {
      const value = limits[key] ?? this.limits[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > this.limits[key])
        throw new RangeError('Invalid ingest limit.');
      this.limits[key] = value;
    }
  }

  /** Parse strict upstream data and commit acceptance only after current authority is rechecked. */
  accept(raw: unknown, authority: DocIngestAuthority): DocIngestResult {
    const parsed = PageEventSchema.safeParse(raw);
    if (!parsed.success) throw new DocIngestRefusal('INVALID_DOC_EVENT', 400);
    const event = parsed.data;
    const identity = envelopeIdentity(event);
    const now = this.clock().toISOString();
    try {
      return this.store.transaction((tx) =>
        this.acceptInTransaction(event, identity, now, authority, tx)
      );
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string' &&
        error.code.startsWith('SQLITE_')
      )
        throw new DocIngestRefusal('DOC_EVENT_STORAGE_FAILURE', 507);
      throw error;
    }
  }

  private acceptInTransaction(
    event: PageEvent,
    identity: ReturnType<typeof envelopeIdentity>,
    now: string,
    authority: DocIngestAuthority,
    tx: DbTransaction
  ): DocIngestResult {
    const access = authority(tx);
    const channel = this.store.getChannel(access.documentId, tx);
    if (!channel || channel.closedAt !== null) throw new DocChannelClosedError(access.documentId);
    if (channel.scope !== access.scope) throw new DocIngestRefusal('DOC_IDENTITY_CHANGED', 409);
    const existing = this.store.getEvent(access.documentId, event.id, tx);
    if (existing) {
      if (existing.envelopeHash !== identity.hash)
        throw new DocIngestRefusal('DOC_EVENT_ID_CONFLICT', 409);
      return {
        receipt: { id: event.id, status: 'duplicate', docSeq: existing.docSeq },
        deliveries: this.store.listDeliveries(access.documentId, event.id, tx),
      };
    }
    if (identity.bytes > Math.min(access.envelopeBytes ?? 16384, 16384))
      throw new DocIngestRefusal('DOC_EVENT_TOO_LARGE', 413);
    try {
      const validation: unknown = access.validatePayload?.(event.type, event.payload);
      if (
        validation &&
        (typeof validation === 'object' || typeof validation === 'function') &&
        'then' in validation
      ) {
        void Promise.resolve(validation).catch(() => {});
        throw new Error('Document payload validation must be synchronous.');
      }
    } catch {
      throw new DocIngestRefusal('INVALID_DOC_EVENT_PAYLOAD', 422);
    }
    const matching = access.routes.filter(({ route }) =>
      matchesCanvasChannelEvent(route.on, event.type)
    );
    // Even one input must fit the actual future renderer, including server labels and escaping.
    for (const { route, grantId } of matching) {
      if (!grantId || route.to === 'log' || route.turn.mode === 'none') continue;
      if (
        docEventsPromptBytes({
          documentId: access.documentId,
          documentLabel: access.documentLabel,
          scope: access.scope,
          batchId: randomUUID(),
          routeId: route.id,
          grantId,
          events: [
            { id: event.id, type: event.type, payload: event.payload, docSeq: channel.nextDocSeq },
          ],
        }) > DOC_EVENTS_PROMPT_BYTES
      )
        throw new DocIngestRefusal('DOC_EVENT_CONTEXT_TOO_LARGE', 413);
    }
    backfillEnvelopeAccounting(this.store, tx);
    checkIngestCapacity(
      tx,
      access.documentId,
      now,
      identity.bytes,
      access.eventsPerMinute,
      this.limits,
      matching.some(
        ({ route, grantId, grantRevision }) =>
          !!grantId && !!grantRevision && route.to !== 'log' && route.turn.mode !== 'none'
      )
    );
    const saved = this.store.appendEvent(
      {
        documentId: access.documentId,
        eventId: event.id,
        direction: 'upstream',
        type: event.type,
        payload: event.payload,
        envelopeHash: identity.hash,
        envelopeBytes: identity.bytes,
        coalesceKey: event.coalesceKey ?? null,
        clientTs: event.ts ?? null,
        receivedAt: now,
        provenance: access.provenance,
      },
      tx
    );
    for (const decision of matching) {
      const { route } = decision;
      if (
        route.to === 'log' ||
        route.turn.mode === 'none' ||
        !decision.grantId ||
        !decision.grantRevision
      )
        this.store.insertDelivery(
          {
            documentId: saved.documentId,
            eventId: saved.eventId,
            routeId: route.id,
            status: route.to === 'log' || route.turn.mode === 'none' ? 'routed' : 'saved',
            reason:
              route.to === 'log' || route.turn.mode === 'none'
                ? 'no_turn'
                : (decision.reason ?? 'approval_required'),
            updatedAt: now,
          },
          tx
        );
      else queueInput(this.store, tx, access, decision, saved, now);
    }
    return {
      receipt: { id: event.id, status: 'recorded', docSeq: saved.docSeq },
      deliveries: this.store.listDeliveries(access.documentId, event.id, tx),
    };
  }
}
