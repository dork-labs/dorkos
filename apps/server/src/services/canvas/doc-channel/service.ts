/** Current-authorized document channel reads and durable event acceptance. */
import {
  PageEventSchema,
  CanvasChannelGrantSchema,
  type CanvasChannelEventReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import { DocChannelIngest } from './ingest.js';

import type { DocCurrentReplayResponse } from './current/current-operation-types.js';
import { DocIngestRefusal } from './ingest-data/ingest-types.js';
import type { DocChannelGrants } from './grants.js';
import type { DocDeliveryRow } from './store.js';
import type { CanvasDocumentStore } from '../canvas-document-store.js';
import {
  DocChannelAuthorization,
  DocChannelNotFoundError,
  type DocChannelActor,
} from './authorization.js';
import { DocChannelStore, type DocChannelRow } from './store.js';

import { createIsolatedCurrentServiceBindings } from './binding/service-binding-operations.js';
import { constructOriginalCurrentService } from './binding/service-construction.js';
import type { OriginalServiceConstructionView } from './binding/service-binding-types.js';
const originalServiceBindings = createIsolatedCurrentServiceBindings();
const currentServiceBindings = originalServiceBindings.currentServiceBindings;
/** Original operation selected by actual private service constructor membership. */
export const submitCurrentDocEvent: typeof originalServiceBindings.submitCurrentDocEvent =
  originalServiceBindings.submitCurrentDocEvent;
/** Original operation selected by actual private service constructor membership. */
export const inspectServiceCurrentDocReceipt: typeof originalServiceBindings.inspectServiceCurrentDocReceipt =
  originalServiceBindings.inspectServiceCurrentDocReceipt;
/** Original operation selected by actual private service constructor membership. */
export const replayServiceCurrentDoc: typeof originalServiceBindings.replayServiceCurrentDoc =
  originalServiceBindings.replayServiceCurrentDoc;
/** Original operation selected by actual private service constructor membership. */
export const currentRoomDueServicePort: typeof originalServiceBindings.currentRoomDueServicePort =
  originalServiceBindings.currentRoomDueServicePort;
/** Original operation selected by actual private service constructor membership. */
export const prepareServiceOriginalRoomResponder: typeof originalServiceBindings.prepareServiceOriginalRoomResponder =
  originalServiceBindings.prepareServiceOriginalRoomResponder;
/** Original operation selected by actual private service constructor membership. */
export const commitServiceOriginalRoomResponder: typeof originalServiceBindings.commitServiceOriginalRoomResponder =
  originalServiceBindings.commitServiceOriginalRoomResponder;
/** Original operation selected by actual private service constructor membership. */
export const captureServiceCurrentDocument: typeof originalServiceBindings.captureServiceCurrentDocument =
  originalServiceBindings.captureServiceCurrentDocument;
/** Original operation selected by actual private service constructor membership. */
export const requireServiceCurrentDocument: typeof originalServiceBindings.requireServiceCurrentDocument =
  originalServiceBindings.requireServiceCurrentDocument;
/** Original operation selected by actual private service constructor membership. */
export const replayServiceDocumentAuthority: typeof originalServiceBindings.replayServiceDocumentAuthority =
  originalServiceBindings.replayServiceDocumentAuthority;
/** Original operation selected by actual private service constructor membership. */
export const inspectServiceDocumentAuthority: typeof originalServiceBindings.inspectServiceDocumentAuthority =
  originalServiceBindings.inspectServiceDocumentAuthority;
/** Original operation selected by actual private service constructor membership. */
export const submitServiceDocumentAuthority: typeof originalServiceBindings.submitServiceDocumentAuthority =
  originalServiceBindings.submitServiceDocumentAuthority;
/** Original operation selected by actual private service constructor membership. */
export const readServiceOriginalRoomScenarioEvidence: typeof originalServiceBindings.readServiceOriginalRoomScenarioEvidence =
  originalServiceBindings.readServiceOriginalRoomScenarioEvidence;
/** Original operation selected by actual private service constructor membership. */
export const prepareServiceOriginalCheckboxSource: typeof originalServiceBindings.prepareServiceOriginalCheckboxSource =
  originalServiceBindings.prepareServiceOriginalCheckboxSource;
/** Original operation selected by actual private service constructor membership. */
export const completeServiceOriginalCheckboxSource: typeof originalServiceBindings.completeServiceOriginalCheckboxSource =
  originalServiceBindings.completeServiceOriginalCheckboxSource;
/** Original operation selected by actual private service constructor membership. */
export const publishServiceOriginalCheckboxSource: typeof originalServiceBindings.publishServiceOriginalCheckboxSource =
  originalServiceBindings.publishServiceOriginalCheckboxSource;
/** Original operation selected by actual private service constructor membership. */
export const abandonServiceOriginalCheckboxSource: typeof originalServiceBindings.abandonServiceOriginalCheckboxSource =
  originalServiceBindings.abandonServiceOriginalCheckboxSource;
/** Original operation selected by actual private service constructor membership. */
export const notifyServiceOriginalCheckboxCommitted: typeof originalServiceBindings.notifyServiceOriginalCheckboxCommitted =
  originalServiceBindings.notifyServiceOriginalCheckboxCommitted;
/** Original operation selected by actual private service constructor membership. */
export const requireServiceOriginalCheckboxGrantDependencies: typeof originalServiceBindings.requireServiceOriginalCheckboxGrantDependencies =
  originalServiceBindings.requireServiceOriginalCheckboxGrantDependencies;
/** Original operation selected by actual private service constructor membership. */
export const requireServiceOriginalDocumentInTransaction: typeof originalServiceBindings.requireServiceOriginalDocumentInTransaction =
  originalServiceBindings.requireServiceOriginalDocumentInTransaction;
/** Original operation selected by actual private service constructor membership. */
export const issueServiceOriginalDocToken: typeof originalServiceBindings.issueServiceOriginalDocToken =
  originalServiceBindings.issueServiceOriginalDocToken;
/** Original operation selected by actual private service constructor membership. */
export const restoreServiceOriginalTokenScope: typeof originalServiceBindings.restoreServiceOriginalTokenScope =
  originalServiceBindings.restoreServiceOriginalTokenScope;
/** Original operation selected by actual private service constructor membership. */
export const replayServiceOriginalTokenScope: typeof originalServiceBindings.replayServiceOriginalTokenScope =
  originalServiceBindings.replayServiceOriginalTokenScope;
/** Original operation selected by actual private service constructor membership. */
export const readServiceOriginalTokenEvent: typeof originalServiceBindings.readServiceOriginalTokenEvent =
  originalServiceBindings.readServiceOriginalTokenEvent;
/** Original operation selected by actual private service constructor membership. */
export const openServiceOriginalTokenStream: typeof originalServiceBindings.openServiceOriginalTokenStream =
  originalServiceBindings.openServiceOriginalTokenStream;
/** Original operation selected by actual private service constructor membership. */
export const nextServiceOriginalTokenStream: typeof originalServiceBindings.nextServiceOriginalTokenStream =
  originalServiceBindings.nextServiceOriginalTokenStream;
/** Original operation selected by actual private service constructor membership. */
export const closeServiceOriginalTokenStream: typeof originalServiceBindings.closeServiceOriginalTokenStream =
  originalServiceBindings.closeServiceOriginalTokenStream;
/** Original operation selected by actual private service constructor membership. */
export const closedServiceOriginalTokenStream: typeof originalServiceBindings.closedServiceOriginalTokenStream =
  originalServiceBindings.closedServiceOriginalTokenStream;
/** Original operation selected by actual private service constructor membership. */
export const readServiceOriginalTokenStreamState: typeof originalServiceBindings.readServiceOriginalTokenStreamState =
  originalServiceBindings.readServiceOriginalTokenStreamState;
/** Original operation selected by actual private service constructor membership. */
export const readServiceOriginalTokenDrainData: typeof originalServiceBindings.readServiceOriginalTokenDrainData =
  originalServiceBindings.readServiceOriginalTokenDrainData;
/** Original operation selected by actual private service constructor membership. */
export const revokeServiceOriginalDocToken: typeof originalServiceBindings.revokeServiceOriginalDocToken =
  originalServiceBindings.revokeServiceOriginalDocToken;
/** Original operation selected by actual private service constructor membership. */
export const admitServiceOriginalTokenIngress: typeof originalServiceBindings.admitServiceOriginalTokenIngress =
  originalServiceBindings.admitServiceOriginalTokenIngress;
/** Original operation selected by actual private service constructor membership. */
export const submitServiceOriginalTokenIngress: typeof originalServiceBindings.submitServiceOriginalTokenIngress =
  originalServiceBindings.submitServiceOriginalTokenIngress;
/** Original operation selected by actual private service constructor membership. */
export const requireServiceOriginalTokenDependencies: typeof originalServiceBindings.requireServiceOriginalTokenDependencies =
  originalServiceBindings.requireServiceOriginalTokenDependencies;
/** Original operation selected by actual private service constructor membership. */
export const readServiceOriginalDocManagement: typeof originalServiceBindings.readServiceOriginalDocManagement =
  originalServiceBindings.readServiceOriginalDocManagement;
/** Original operation selected by actual private service constructor membership. */
export const askServiceOriginalDocSelection: typeof originalServiceBindings.askServiceOriginalDocSelection =
  originalServiceBindings.askServiceOriginalDocSelection;
/** Original operation selected by actual private service constructor membership. */
export const replayServiceOriginalExpiredDocBatch: typeof originalServiceBindings.replayServiceOriginalExpiredDocBatch =
  originalServiceBindings.replayServiceOriginalExpiredDocBatch;
/** Original operation selected by actual private service constructor membership. */
export const prepareServiceOriginalDocumentSave: typeof originalServiceBindings.prepareServiceOriginalDocumentSave =
  originalServiceBindings.prepareServiceOriginalDocumentSave;
/** Original operation selected by actual private service constructor membership. */
export const completeServiceOriginalDocumentSave: typeof originalServiceBindings.completeServiceOriginalDocumentSave =
  originalServiceBindings.completeServiceOriginalDocumentSave;
/** Original operation selected by actual private service constructor membership. */
export const updateServiceOriginalDocPresence: typeof originalServiceBindings.updateServiceOriginalDocPresence =
  originalServiceBindings.updateServiceOriginalDocPresence;

const constructionViews = new WeakMap<object, OriginalServiceConstructionView>();
const constructionApply = Reflect.apply;
const constructionGet = WeakMap.prototype.get;
const constructionSet = WeakMap.prototype.set;
/** Refuse every value except the exact original service constructor-private key before callback installation. */
export function readOriginalServiceConstructionView(
  owner: object
): OriginalServiceConstructionView {
  const view = constructionApply(constructionGet, constructionViews, [owner]) as
    OriginalServiceConstructionView | undefined;
  if (!view) throw new Error('Original service construction required');
  return view;
}
const originalDocPrivateConstructionFreeze = Object.freeze;

/** A current document's private channel data, returned only after scope authorization. */
export class DocChannelService {
  readonly #constructionKey = originalDocPrivateConstructionFreeze({});
  private readonly committedInputListeners = new Set<() => void>();
  /** Observe accepted input after its transaction commits; listeners receive no page data. */
  onCommittedInput(listener: () => void): () => void {
    this.committedInputListeners.add(listener);
    return () => this.committedInputListeners.delete(listener);
  }
  /** Compose current scope authority, persistence and optional event acceptance engines. */
  constructor(
    private readonly documents: CanvasDocumentStore,
    private readonly channels: DocChannelStore,
    private readonly authorization: DocChannelAuthorization,
    private readonly events?: { ingest: DocChannelIngest; grants: DocChannelGrants }
  ) {
    const createOriginalView = (
      service: DocChannelService
    ): Readonly<OriginalServiceConstructionView> =>
      originalDocPrivateConstructionFreeze<OriginalServiceConstructionView>({
        service,
        authorization,
        channels,
        events,
        get committedInputListeners() {
          return service.committedInputListeners;
        },
        bind: (binding) => {
          currentServiceBindings.set(service, binding);
        },
      });
    constructionApply(constructionSet, constructionViews, [
      this.#constructionKey,
      createOriginalView(this),
    ]);
    constructOriginalCurrentService(this.#constructionKey);
  }
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
    if (result.receipt.status === 'recorded') {
      for (const listener of this.committedInputListeners) {
        try {
          listener();
        } catch {
          // Committed acceptance survives a failed scheduling hint; boot and periodic recovery reread it.
        }
      }
    }
    return { receipt: result.receipt, deliveries: result.deliveries.map(publicDelivery) };
  }
  /** Replay a bounded own-DB page with full server birth and final private current access. */
  async replay(
    documentId: string,
    actor: DocChannelActor,
    since = 0,
    limit = 200
  ): Promise<DocCurrentReplayResponse> {
    const own = currentServiceBindings.get(this);
    if (!own) throw new Error('Current replay requires its genuine service constructor.');
    return own.replay(documentId, actor, since, limit);
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
