/** Current-authorized document channel reads and durable event acceptance. */
import {
  PageEventSchema,
  CanvasChannelGrantSchema,
  CanvasChannelReplayResponseSchema,
  type CanvasChannelEventReceipt,
  type CanvasChannelReplayResponse,
  type CanvasChannelRouting,
} from '@dorkos/shared/canvas-channel-schemas';
import { DocChannelIngest } from './ingest.js';
import { DocIngestRefusal } from './ingest-types.js';
import type { DocChannelGrants } from './grants.js';
import { DocRouteGrantError } from './grant-policy.js';
import { replayDocChannel } from './replay.js';
import type { DocDeliveryRow } from './store.js';
import type { CanvasDocumentStore } from '../canvas-document-store.js';
import {
  DocChannelAuthorization,
  DocChannelNotFoundError,
  DocChannelArchivedError,
  type DocChannelActor,
} from './authorization.js';
import { DocChannelStore, type DocChannelRow } from './store.js';

/** A current document's private channel data, returned only after scope authorization. */
export class DocChannelService {
  /** Compose current scope authority, persistence and optional event acceptance engines. */
  constructor(
    private readonly documents: CanvasDocumentStore,
    private readonly channels: DocChannelStore,
    private readonly authorization: DocChannelAuthorization,
    private readonly events?: { ingest: DocChannelIngest; grants: DocChannelGrants }
  ) {}
  /** Read live channel state after authorizing the current physical document. */
  async readChannel(documentId: string, actor: DocChannelActor): Promise<DocChannelRow> {
    const identity = await this.authorization.require(documentId, actor);
    this.authorization.requireCurrent(documentId, actor);
    const channel = this.channels.getChannel(identity.id);
    if (!channel || channel.closedAt !== null || channel.scope !== identity.scope)
      throw new DocChannelNotFoundError();
    return channel;
  }
  /** Read only recovery health for an authorized operator while admission is blocked. */
  readHealth(
    documentId: string,
    actor: DocChannelActor
  ): { status: 'ready' | 'in_doubt'; reasons: string[] } {
    this.authorization.requireHealth(documentId, actor);
    return this.documents.lifecycle.health(documentId);
  }
  /** Recheck lifecycle and scope before any later mutating operation. */
  async requireWrite(
    documentId: string,
    actor: DocChannelActor
  ): Promise<{ id: string; scope: string }> {
    await this.authorization.require(documentId, actor, true);
    const identity = this.authorization.requireCurrent(documentId, actor, true);
    const channel = this.channels.getChannel(identity.id);
    if (
      !channel ||
      channel.closedAt !== null ||
      channel.scope !== identity.scope ||
      this.documents.lookupIdentity(identity.id)?.scope !== identity.scope
    )
      throw new DocChannelNotFoundError();
    return identity;
  }
  /** Accept untrusted HTTP event data after current access and durable grant refresh. */
  async ingestEvent(
    documentId: string,
    raw: unknown,
    actor: DocChannelActor
  ): Promise<CanvasChannelEventReceipt> {
    const identity = await this.requireWrite(documentId, actor);
    documentId = identity.id;
    if (!this.events) throw new DocIngestRefusal('DOC_CHANNEL_UNAVAILABLE', 503);
    // Size precedes schema parsing so overlarge valid JSON gets 413, not a generic malformed refusal.
    if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 16384)
      throw new DocIngestRefusal('DOC_EVENT_TOO_LARGE', 413);
    const parsed = PageEventSchema.safeParse(raw);
    if (!parsed.success) throw new DocIngestRefusal('INVALID_DOC_EVENT', 400);
    let refreshError: unknown;
    try {
      this.events.grants.refreshAuthority(documentId, actor);
    } catch (error) {
      refreshError = error;
    }
    const result = this.events.ingest.accept(parsed.data, (tx) => {
      const current = this.authorization.requireCurrent(documentId, actor, true, tx);
      const document = this.documents.get(current.scope, current.id);
      if (!document) throw new DocChannelNotFoundError();
      // Existing identity is checked by ingest before schema/rate accounting. Its receipt survives later app edits.
      if (this.channels.getEvent(current.id, parsed.data.id, tx))
        return {
          documentId: current.id,
          scope: current.scope,
          documentLabel: document.title,
          provenance: { transport: 'http', trust: 'app_untrusted' },
          routes: [],
        };
      if (refreshError) throw refreshError;
      const limits = this.events!.grants.getEffectiveLimits(documentId, actor, tx);
      const routes = this.events!.grants.getCurrentRoutes(documentId, parsed.data.type, actor, tx);
      for (const route of routes) {
        if (route.grantId && !route.reason) {
          const grant = this.channels.getGrant(route.grantId, tx);
          const checked = CanvasChannelGrantSchema.shape.limits.safeParse(grant?.limits);
          if (!checked.success) throw new DocIngestRefusal('DOC_ROUTE_LIMITS_INVALID', 403);
          const bounded = checked.data;
          limits.envelopeBytes = Math.min(limits.envelopeBytes, bounded.envelopeBytes);
          limits.eventsPerMinute = Math.min(limits.eventsPerMinute, bounded.eventsPerMinute);
        }
      }
      return {
        documentId: current.id,
        scope: current.scope,
        documentLabel: document.title,
        provenance: { transport: 'http', trust: 'app_untrusted' },
        routes,
        envelopeBytes: limits.envelopeBytes,
        eventsPerMinute: limits.eventsPerMinute,
        validatePayload: (type, payload) => {
          this.events!.grants.validateEventPayload(documentId, type, payload, actor, tx);
          return undefined;
        },
      };
    });
    return { receipt: result.receipt, deliveries: result.deliveries.map(publicDelivery) };
  }
  /** Replay one bounded page after current authorization, with honest payload and receipt floors. */
  async replay(
    documentId: string,
    actor: DocChannelActor,
    since = 0,
    limit = 200
  ): Promise<CanvasChannelReplayResponse> {
    await this.authorization.require(documentId, actor);
    let routingAvailable = true;
    if (this.events) {
      try {
        this.events.grants.refreshAuthority(documentId, actor);
      } catch (error) {
        if (!(error instanceof DocRouteGrantError) && !(error instanceof DocChannelArchivedError))
          throw error;
        routingAvailable = false;
      }
    }
    let routing: CanvasChannelRouting = {
      enabled: false,
      approvedEventTypes: [],
      destinationLabel: 'Actions unavailable',
    };
    const snapshot = replayDocChannel(
      this.channels,
      (tx) => {
        const identity = this.authorization.requireCurrent(documentId, actor, false, tx);
        if (routingAvailable && this.events) {
          try {
            const routes = this.events.grants.getCurrentRoutes(documentId, undefined, actor, tx);
            // Cross-target Relay and room admission remain unavailable until their distinct transport gates land.
            const ready = routes.filter(
              (row) =>
                row.grantId &&
                !row.reason &&
                (row.route.to === 'log' ||
                  (identity.scope.startsWith('session:') &&
                    row.targetSessionId !== null &&
                    row.targetSessionId !== undefined &&
                    this.documents.lifecycle.resolveScope(`session:${row.targetSessionId}`) ===
                      identity.scope))
            );
            const types = [...new Set(ready.flatMap((row) => row.allowedTypes ?? []))];
            routing = {
              enabled: types.length > 0,
              approvedEventTypes: types,
              destinationLabel: ready.some((row) => row.route.to !== 'log')
                ? 'This document’s agent'
                : ready.length
                  ? 'Saved in this document'
                  : 'Approval needed',
            };
          } catch (error) {
            if (
              !(error instanceof DocRouteGrantError) &&
              !(error instanceof DocChannelArchivedError)
            )
              throw error;
          }
        }

        return {
          ...identity,
          documentId: identity.id,
          documentLabel: '',
          provenance: {},
          routes: [],
        };
      },
      since,
      limit
    );
    return CanvasChannelReplayResponseSchema.parse({
      ...snapshot,
      routing,
      receipts: snapshot.receipts.map((row) => ({
        receipt: { id: row.id, status: 'recorded', docSeq: row.docSeq },
        deliveries: row.deliveries.map(publicDelivery),
        payloadAvailable: row.payloadAvailable,
      })),
    });
  }
  /** Inspect one retained receipt without disclosing raw payload, provenance or other viewers. */
  async receipt(
    documentId: string,
    eventId: string,
    actor: DocChannelActor
  ): Promise<CanvasChannelEventReceipt> {
    await this.authorization.require(documentId, actor);
    return this.channels.transaction((tx) => {
      const identity = this.authorization.requireCurrent(documentId, actor, false, tx);
      const event = this.channels.getEvent(identity.id, eventId, tx);
      if (!event) throw new DocChannelNotFoundError();
      return {
        receipt: { id: event.eventId, status: 'recorded' as const, docSeq: event.docSeq },
        deliveries: this.channels.listDeliveries(identity.id, eventId, tx).map(publicDelivery),
        payloadAvailable: event.payloadPrunedAt === null,
      };
    });
  }
}

/** Strip private actor and approval evidence before a receipt crosses the HTTP boundary. */
function publicDelivery(row: DocDeliveryRow) {
  return {
    eventId: row.eventId,
    routeId: row.routeId,
    batchId: row.batchId,
    status: row.status,
    turnId: row.turnId,
    reason: row.reason,
    updatedAt: row.updatedAt,
    ackOutcome: row.ackOutcome,
    acknowledgedAt: row.acknowledgedAt,
  };
}
