import { updateAuthorizedOriginalDocPresence } from './authorization.js';
import {
  prepareAuthorizedOriginalDocumentSave,
  completeAuthorizedOriginalDocumentSave,
} from './authorization.js';
import { readOriginalDocumentFileSaveIdentity } from './writes/installation-file-writes.js';
import { copyCurrentDocData } from './current/current-operation-data.js';
import { CanvasChannelSelectionRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import { askAuthorizedOriginalDocSelection } from './authorization.js';
import { replayAuthorizedOriginalExpiredDocBatch } from './authorization.js';
import { readAuthorizedDocManagement } from './authorization.js';
import { inspectAuthorizedOriginalTokenInputReceipt } from './authorization.js';
import { bindAuthorizedOriginalTokenService } from './authorization.js';
import {
  drainDataAuthorizedOriginalTokenOwner,
  stateAuthorizedOriginalTokenStream,
  closedAuthorizedOriginalTokenStream,
  openAuthorizedOriginalTokenStream,
  nextAuthorizedOriginalTokenStream,
  closeAuthorizedOriginalTokenStream,
  restoreAuthorizedOriginalTokenScope,
  replayAuthorizedOriginalTokenScope,
  readAuthorizedOriginalTokenEvent,
} from './authorization.js';
import {
  admitAuthorizedOriginalTokenIngress,
  submitAuthorizedOriginalTokenIngress,
  issueAuthorizedOriginalDocToken,
  revokeAuthorizedOriginalDocToken,
} from './authorization.js';
import { requireAuthorizedDocumentInTransaction } from './authorization.js';
import {
  prepareAuthorizedCheckboxSource,
  completeAuthorizedCheckboxSource,
  publishAuthorizedCheckboxSource,
  abandonAuthorizedCheckboxSource,
} from './authorization.js';
import {
  pumpAuthorizedRoomDue,
  stopAuthorizedRoomPump,
  readAuthorizedRoomScenarioEvidence,
} from './authorization.js';
/** Current-authorized document channel reads and durable event acceptance. */
import {
  PageEventSchema,
  CanvasChannelBatchReplayRequestSchema,
  CanvasChannelGrantSchema,
  type CanvasChannelEventReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import { DocChannelIngest } from './ingest.js';
import {
  prepareAuthorizedRoomResponder,
  captureAuthorizedCurrentDocument,
  replayAuthorizedDocumentAuthority,
  inspectAuthorizedDocumentAuthority,
  submitAuthorizedDocumentAuthority,
  requireAuthorizedCurrentDocument,
  commitAuthorizedRoomResponder,
  readAuthorizedRoomDueAt,
  wakeAuthorizedRoomDue,
  hintAuthorizedRoomRelay,
  subscribeAuthorizedRoomRelay,
  maintainAuthorizedDocHistory,
  replayAuthorizedCurrentDoc,
  submitAuthorizedCurrentDocEvent,
  inspectCurrentDocReceipt,
  requireCurrentDocConstructorEngines,
} from './authorization.js';
import { captureCurrentDocConfiguration } from './current/current-operation-data.js';
import type {
  DocEventCondition,
  DocReceiptInspection,
  DocCurrentReplayResponse,
} from './current/current-operation-types.js';
const currentServiceBindings = new WeakMap<
  DocChannelService,
  {
    presence: (
      documentId: string,
      actor: DocChannelActor,
      raw: unknown
    ) => Promise<import('@dorkos/shared/canvas-channel-schemas').CanvasChannelPresenceResponse>;
    documentReplay: (
      authority: import('./current/current-operation-types.js').OriginalCurrentDocumentAuthority,
      since: number,
      limit: number
    ) => Promise<DocCurrentReplayResponse>;
    documentInspect: (
      authority: import('./current/current-operation-types.js').OriginalCurrentDocumentAuthority,
      eventId: string
    ) => Promise<DocReceiptInspection>;
    documentSubmit: (
      authority: import('./current/current-operation-types.js').OriginalCurrentDocumentAuthority,
      raw: unknown
    ) => Promise<CanvasChannelEventReceipt>;
    tokenOpenStream: (
      scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope,
      since: number
    ) => ReturnType<typeof openAuthorizedOriginalTokenStream>;
    tokenStreamNext: (
      stream: import('./current/current-operation-types.js').OriginalNativeDocTokenStream
    ) => ReturnType<typeof nextAuthorizedOriginalTokenStream>;
    tokenDrainData: () => ReturnType<typeof drainDataAuthorizedOriginalTokenOwner>;
    tokenStreamState: (
      stream: import('./current/current-operation-types.js').OriginalNativeDocTokenStream
    ) => Readonly<{ waiting: boolean; closed: boolean }>;
    tokenStreamClosed: (
      stream: import('./current/current-operation-types.js').OriginalNativeDocTokenStream
    ) => Promise<void>;
    tokenCloseStream: (
      stream: import('./current/current-operation-types.js').OriginalNativeDocTokenStream
    ) => void;
    restoreToken: (hash: string) => ReturnType<typeof restoreAuthorizedOriginalTokenScope>;
    tokenReplay: (
      scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope,
      since: number,
      limit: number,
      permission?: 'replay' | 'stream'
    ) => ReturnType<typeof replayAuthorizedOriginalTokenScope>;
    tokenEvent: (
      scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope,
      eventId: string,
      permission: 'replay' | 'stream'
    ) => ReturnType<typeof readAuthorizedOriginalTokenEvent>;
    tokenIngressCurrent: (
      scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope
    ) => ReturnType<typeof admitAuthorizedOriginalTokenIngress>;
    tokenSubmit: (
      scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope,
      raw: unknown
    ) => ReturnType<typeof submitAuthorizedOriginalTokenIngress>;
    revokeToken: (
      actor: DocChannelActor,
      documentId: string,
      tokenId: string
    ) => ReturnType<typeof revokeAuthorizedOriginalDocToken>;
    issueToken: (
      actor: DocChannelActor,
      request: unknown,
      grantIds: readonly string[]
    ) => ReturnType<typeof issueAuthorizedOriginalDocToken>;
    captureDocument: (
      documentId: string,
      actor: DocChannelActor,
      grantIds: readonly string[]
    ) => Promise<import('./current/current-operation-types.js').OriginalCurrentDocumentData>;
    requireTokenDependencies: (
      authorization: DocChannelAuthorization,
      store: DocChannelStore,
      grants: DocChannelGrants
    ) => void;
    requireGrantDependencies: (
      store: import('./store.js').DocChannelStore,
      grants: import('./grants.js').DocChannelGrants
    ) => void;
    requireDocumentInTransaction: (
      authority: import('./current/current-operation-types.js').OriginalCurrentDocumentAuthority,
      tx: import('@dorkos/db').DbTransaction
    ) => void;
    requireDocument: (
      authority: import('./current/current-operation-types.js').OriginalCurrentDocumentAuthority
    ) => Promise<import('./current/current-operation-types.js').OriginalCurrentDocumentData>;
    prepareRoomResponder: (
      runtime: object,
      holder: import('@dorkos/shared/agent-runtime').SseResponse,
      key: string
    ) => Promise<import('./current/current-operation-types.js').PreparedRoomResponder | undefined>;
    commitRoomResponder: (
      runtime: object,
      prepared: import('./current/current-operation-types.js').PreparedRoomResponder
    ) => import('./current/current-operation-types.js').OriginalCommittedRoomResponder;
    nextRoomDueAt: () => string | undefined;
    wakeRoomDue: () => void;
    hintRoomRelay: (documentId: string, batchId: string, generation: string) => boolean;
    subscribeRoomRelay: (
      listener: (documentId: string, batchId: string, generation: string) => void
    ) => () => void;
    pumpRoomDue: (
      registry: import('../../core/runtime-registry.js').RuntimeRegistry
    ) => Promise<void>;
    stopRoomPump: () => Promise<void>;
    readRoomScenarioEvidence: import('./current/current-operation-types.js').CurrentDocOperationEngineCore['readRoomScenarioEvidence'];
    prepareCheckbox: (owner: object) => void;
    completeCheckbox: (
      owner: object,
      tx: import('@dorkos/db').DbTransaction
    ) => Extract<import('./writes/checkbox-evidence.js').CheckboxReceipt, { status: 'changed' }>;
    publishCheckbox: (owner: object, tx: import('@dorkos/db').DbTransaction) => void;
    abandonCheckbox: (owner: object, tx: import('@dorkos/db').DbTransaction) => void;
    notifyCheckboxCommitted: () => undefined;
    maintainHistory: () => void;
    subscribeRoomDue: (listener: () => void) => () => void;
    replayExpired: (
      raw: unknown,
      actor: DocChannelActor
    ) => Promise<import('@dorkos/shared/canvas-channel-schemas').CanvasChannelBatchReplayResult>;
    management: (
      documentId: string,
      actor: DocChannelActor
    ) => Promise<import('@dorkos/shared/canvas-channel-schemas').CanvasChannelManagementSnapshot>;
    replay: (
      documentId: string,
      actor: DocChannelActor,
      since: number,
      limit: number
    ) => Promise<DocCurrentReplayResponse>;
    prepareDocumentSave: (
      scope: object,
      actor: DocChannelActor
    ) => Promise<import('./writes/normal-file-save.js').NormalFileSaveOutcome | undefined>;
    completeDocumentSave: (
      scope: object,
      actor: DocChannelActor
    ) => Promise<CanvasChannelEventReceipt>;
    selection: (raw: unknown, actor: DocChannelActor) => Promise<CanvasChannelEventReceipt>;
    submit: (
      documentId: string,
      raw: unknown,
      actor: DocChannelActor,
      condition: DocEventCondition
    ) => Promise<CanvasChannelEventReceipt>;
    inspect: (
      documentId: string,
      eventId: string,
      actor: DocChannelActor,
      condition: DocEventCondition
    ) => Promise<DocReceiptInspection>;
  }
>();
import { DocIngestRefusal } from './ingest-types.js';
import type { DocChannelGrants } from './grants.js';
import type { DocDeliveryRow } from './store.js';
import type { CanvasDocumentStore } from '../canvas-document-store.js';
import {
  DocChannelAuthorization,
  DocChannelNotFoundError,
  type DocChannelActor,
} from './authorization.js';
import { DocChannelStore, type DocChannelRow } from './store.js';

/** A current document's private channel data, returned only after scope authorization. */
export class DocChannelService {
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
    const captured = events ? captureCurrentDocConfiguration(events) : undefined;
    const currentEvents = captured
      ? Object.freeze({ ingest: captured.ingest, grants: captured.grants })
      : undefined;
    requireCurrentDocConstructorEngines(
      authorization,
      channels,
      currentEvents?.ingest,
      currentEvents?.grants
    );
    currentServiceBindings.set(this, {
      presence: (id, actor, raw) => {
        if (!currentEvents) throw new DocChannelNotFoundError();
        return updateAuthorizedOriginalDocPresence(
          authorization,
          channels,
          currentEvents.ingest,
          currentEvents.grants,
          id,
          actor,
          raw
        );
      },
      documentReplay: (authority, since, limit) => {
        if (!currentEvents) throw new DocChannelNotFoundError();
        return replayAuthorizedDocumentAuthority(
          authorization,
          channels,
          currentEvents.grants,
          authority,
          since,
          limit
        );
      },
      documentInspect: (authority, eventId) => {
        if (!currentEvents) throw new DocChannelNotFoundError();
        return inspectAuthorizedDocumentAuthority(
          authorization,
          channels,
          currentEvents.grants,
          authority,
          eventId
        );
      },
      documentSubmit: async (authority, raw) => {
        if (!currentEvents) throw new DocChannelNotFoundError();
        const result = await submitAuthorizedDocumentAuthority(
          authorization,
          channels,
          currentEvents.ingest,
          currentEvents.grants,
          authority,
          raw
        );
        if (result.receipt.status === 'recorded') {
          for (const listener of this.committedInputListeners) {
            try {
              listener();
            } catch {}
          }
        }
        const inspected = await inspectAuthorizedDocumentAuthority(
          authorization,
          channels,
          currentEvents.grants,
          authority,
          result.receipt.id
        );
        if (
          inspected.kind !== 'receipt' ||
          inspected.event.receipt.id !== result.receipt.id ||
          inspected.event.receipt.docSeq !== result.receipt.docSeq
        )
          throw new DocChannelNotFoundError();
        return Object.freeze({
          receipt: Object.freeze({ ...inspected.event.receipt, status: result.receipt.status }),
          deliveries: inspected.event.deliveries,
        });
      },
      restoreToken: (hash) => {
        if (!currentEvents) throw new DocChannelNotFoundError();
        return restoreAuthorizedOriginalTokenScope(
          authorization,
          channels,
          currentEvents.grants,
          hash
        );
      },
      tokenOpenStream: (scope, since) =>
        openAuthorizedOriginalTokenStream(authorization, scope, since),
      tokenStreamNext: (stream) => nextAuthorizedOriginalTokenStream(authorization, stream),
      tokenDrainData: () => drainDataAuthorizedOriginalTokenOwner(authorization),
      tokenStreamState: (stream) => stateAuthorizedOriginalTokenStream(authorization, stream),
      tokenStreamClosed: (stream) => closedAuthorizedOriginalTokenStream(authorization, stream),
      tokenCloseStream: (stream) => closeAuthorizedOriginalTokenStream(authorization, stream),
      tokenReplay: (scope, since, limit, permission) =>
        replayAuthorizedOriginalTokenScope(authorization, scope, since, limit, permission),
      tokenEvent: (scope, eventId, permission) =>
        readAuthorizedOriginalTokenEvent(authorization, scope, eventId, permission),
      tokenIngressCurrent: (scope) => admitAuthorizedOriginalTokenIngress(authorization, scope),
      tokenSubmit: async (scope, raw) => {
        if (!currentEvents) throw new DocChannelNotFoundError();
        const result = await submitAuthorizedOriginalTokenIngress(
          authorization,
          channels,
          currentEvents.ingest,
          currentEvents.grants,
          scope,
          raw
        );
        if (result.receipt.status === 'recorded')
          for (const listener of this.committedInputListeners) {
            try {
              listener();
            } catch {}
          }
        const inspected = await inspectAuthorizedOriginalTokenInputReceipt(
          authorization,
          scope,
          result.receipt.id
        );
        if (
          inspected.receipt.id !== result.receipt.id ||
          inspected.receipt.docSeq !== result.receipt.docSeq
        )
          throw new DocChannelNotFoundError();
        return Object.freeze({
          receipt: Object.freeze({ ...inspected.receipt, status: result.receipt.status }),
          deliveries: inspected.deliveries,
        });
      },
      revokeToken: (actor, documentId, tokenId) => {
        if (!currentEvents) throw new DocChannelNotFoundError();
        return revokeAuthorizedOriginalDocToken(
          authorization,
          channels,
          currentEvents.grants,
          actor,
          documentId,
          tokenId
        );
      },
      issueToken: (actor, request, grantIds) => {
        if (!currentEvents) throw new DocChannelNotFoundError();
        return issueAuthorizedOriginalDocToken(
          authorization,
          channels,
          currentEvents.grants,
          actor,
          request,
          grantIds
        );
      },
      captureDocument: (documentId, actor, grantIds) => {
        if (!currentEvents) throw new DocChannelNotFoundError();
        return captureAuthorizedCurrentDocument(
          authorization,
          channels,
          currentEvents.grants,
          documentId,
          actor,
          grantIds
        );
      },
      requireTokenDependencies: (candidateAuthorization, store, grants) => {
        if (
          candidateAuthorization !== authorization ||
          !currentEvents ||
          store !== channels ||
          grants !== currentEvents.grants
        )
          throw new DocChannelNotFoundError();
        requireCurrentDocConstructorEngines(authorization, channels, undefined, grants);
      },
      requireGrantDependencies: (store, grants) => {
        if (!currentEvents || channels !== store || currentEvents.grants !== grants)
          throw new DocChannelNotFoundError();
        requireCurrentDocConstructorEngines(authorization, channels, undefined, grants);
      },
      requireDocumentInTransaction: (authority, tx) => {
        if (!currentEvents) throw new DocChannelNotFoundError();
        requireAuthorizedDocumentInTransaction(
          authorization,
          channels,
          currentEvents.grants,
          authority,
          tx
        );
      },
      requireDocument: (authority) => {
        if (!currentEvents) throw new DocChannelNotFoundError();
        return requireAuthorizedCurrentDocument(
          authorization,
          channels,
          currentEvents.grants,
          authority
        );
      },
      commitRoomResponder: (runtime, prepared) =>
        commitAuthorizedRoomResponder(authorization, runtime, prepared),
      prepareRoomResponder: (runtime, holder, key) =>
        prepareAuthorizedRoomResponder(authorization, runtime, holder, key),
      nextRoomDueAt: () => readAuthorizedRoomDueAt(authorization),
      wakeRoomDue: () => wakeAuthorizedRoomDue(authorization),
      hintRoomRelay: (documentId, batchId, generation) => {
        if (!hintAuthorizedRoomRelay(authorization, documentId, batchId, generation)) return false;
        for (const listener of this.committedInputListeners) {
          try {
            listener();
          } catch {}
        }
        return true;
      },
      subscribeRoomRelay: (listener) => subscribeAuthorizedRoomRelay(authorization, listener),
      pumpRoomDue: (registry) => pumpAuthorizedRoomDue(authorization, registry),
      stopRoomPump: () => stopAuthorizedRoomPump(authorization),
      readRoomScenarioEvidence: (documentId, batchId, generation) =>
        readAuthorizedRoomScenarioEvidence(authorization, documentId, batchId, generation),
      prepareCheckbox: (owner) => prepareAuthorizedCheckboxSource(authorization, channels, owner),
      completeCheckbox: (owner, tx) => {
        if (!currentEvents) throw new DocChannelNotFoundError();
        return completeAuthorizedCheckboxSource(
          authorization,
          channels,
          currentEvents.grants,
          owner,
          tx
        );
      },
      publishCheckbox: (owner, tx) =>
        publishAuthorizedCheckboxSource(authorization, channels, owner, tx),
      abandonCheckbox: (owner, tx) => abandonAuthorizedCheckboxSource(authorization, owner, tx),
      notifyCheckboxCommitted: () => {
        for (const listener of this.committedInputListeners) {
          try {
            listener();
          } catch {}
        }
        return undefined;
      },
      maintainHistory: () => maintainAuthorizedDocHistory(authorization, channels),
      subscribeRoomDue: (listener) => {
        this.committedInputListeners.add(listener);
        return () => {
          this.committedInputListeners.delete(listener);
        };
      },
      replayExpired: async (raw, actor) => {
        const request = CanvasChannelBatchReplayRequestSchema.parse(copyCurrentDocData(raw));
        if (!currentEvents) throw new DocIngestRefusal('DOC_CHANNEL_UNAVAILABLE', 503);
        const result = await replayAuthorizedOriginalExpiredDocBatch(
          authorization,
          channels,
          currentEvents.ingest,
          currentEvents.grants,
          request,
          actor
        );
        if (result.status === 'pending') {
          for (const listener of this.committedInputListeners) {
            try {
              listener();
            } catch {}
          }
        }
        // Postcommit callbacks precede the original current receipt/disclosure gate.
        const inspected = await inspectCurrentDocReceipt(
          authorization,
          channels,
          result.documentId,
          result.eventId,
          actor,
          { expectedGeneration: request.expectedGeneration }
        );
        if (inspected.kind !== 'receipt' || inspected.event.receipt.id !== result.eventId)
          throw new DocChannelNotFoundError();
        return result;
      },
      management: (documentId, actor) =>
        readAuthorizedDocManagement(authorization, channels, documentId, actor),
      replay: (documentId, actor, since, limit) =>
        replayAuthorizedCurrentDoc(authorization, channels, documentId, actor, since, limit),
      prepareDocumentSave: (scope, actor) => {
        if (!currentEvents) throw new DocIngestRefusal('DOC_CHANNEL_UNAVAILABLE', 503);
        return prepareAuthorizedOriginalDocumentSave(
          authorization,
          channels,
          currentEvents.grants,
          scope,
          actor
        );
      },
      completeDocumentSave: async (scope, actor) => {
        if (!currentEvents) throw new DocIngestRefusal('DOC_CHANNEL_UNAVAILABLE', 503);
        const request = copyCurrentDocData(readOriginalDocumentFileSaveIdentity(scope, channels));
        const result = await completeAuthorizedOriginalDocumentSave(
          authorization,
          channels,
          currentEvents.ingest,
          currentEvents.grants,
          scope,
          actor
        );
        if (result.receipt.status === 'recorded') {
          for (const listener of this.committedInputListeners) {
            try {
              listener();
            } catch {}
          }
        }
        const inspected = await inspectCurrentDocReceipt(
          authorization,
          channels,
          request.documentId,
          request.eventId,
          actor,
          { expectedGeneration: request.expectedGeneration }
        );
        if (
          inspected.kind !== 'receipt' ||
          inspected.event.receipt.docSeq !== result.receipt.docSeq
        )
          throw new DocChannelNotFoundError();
        return Object.freeze({
          receipt: Object.freeze({ ...inspected.event.receipt, status: result.receipt.status }),
          deliveries: inspected.event.deliveries,
        });
      },
      selection: async (raw, actor) => {
        const request = CanvasChannelSelectionRequestSchema.parse(copyCurrentDocData(raw));
        if (!currentEvents) throw new DocIngestRefusal('DOC_CHANNEL_UNAVAILABLE', 503);
        const result = await askAuthorizedOriginalDocSelection(
          authorization,
          channels,
          currentEvents.ingest,
          currentEvents.grants,
          request,
          actor
        );
        if (result.receipt.status === 'recorded') {
          for (const listener of this.committedInputListeners) {
            try {
              listener();
            } catch {}
          }
        }
        const inspected = await inspectCurrentDocReceipt(
          authorization,
          channels,
          request.documentId,
          request.eventId,
          actor,
          { expectedGeneration: request.expectedGeneration }
        );
        if (
          inspected.kind !== 'receipt' ||
          inspected.event.receipt.id !== request.eventId ||
          inspected.event.receipt.docSeq !== result.receipt.docSeq
        )
          throw new DocChannelNotFoundError();
        return Object.freeze({
          receipt: Object.freeze({ ...inspected.event.receipt, status: result.receipt.status }),
          deliveries: inspected.event.deliveries,
        });
      },
      submit: async (documentId, raw, actor, condition) => {
        if (!currentEvents) throw new DocIngestRefusal('DOC_CHANNEL_UNAVAILABLE', 503);
        const result = await submitAuthorizedCurrentDocEvent(
          authorization,
          channels,
          currentEvents.ingest,
          currentEvents.grants,
          documentId,
          raw,
          actor,
          condition
        );
        if (result.receipt.status === 'recorded') {
          for (const listener of this.committedInputListeners) {
            try {
              listener();
            } catch {}
          }
        }
        // Listener/configured postcommit side effects precede a fresh fixed inspection/currentness boundary.
        const inspected = await inspectCurrentDocReceipt(
          authorization,
          channels,
          documentId,
          result.receipt.id,
          actor,
          condition
        );
        if (
          inspected.kind !== 'receipt' ||
          inspected.event.receipt.id !== result.receipt.id ||
          inspected.event.receipt.docSeq !== result.receipt.docSeq
        )
          throw new Error('Committed original receipt is no longer inspectable.');
        // Return only the freshly captured conditional inspection; no observable listener/getter/await remains.
        return Object.freeze({
          receipt: Object.freeze({ ...inspected.event.receipt, status: result.receipt.status }),
          deliveries: inspected.event.deliveries,
        });
      },
      inspect: (documentId, eventId, actor, condition) =>
        inspectCurrentDocReceipt(authorization, channels, documentId, eventId, actor, condition),
    });
    if (currentEvents)
      bindAuthorizedOriginalTokenService(authorization, this, channels, currentEvents.grants);
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

/** Prospective HTTP submit entry; mandatory generation condition is untrusted input, never an actor. */
export function submitCurrentDocEvent(
  service: DocChannelService,
  documentId: string,
  raw: unknown,
  actor: DocChannelActor,
  condition: DocEventCondition
): Promise<CanvasChannelEventReceipt> {
  const own = currentServiceBindings.get(service);
  if (!own) throw new Error('Current event submission requires its genuine service constructor.');
  return own.submit(documentId, raw, actor, condition);
}
/** Prospective qualified receipt/absence entry; generic404 never becomes absence. */
export function inspectServiceCurrentDocReceipt(
  service: DocChannelService,
  documentId: string,
  eventId: string,
  actor: DocChannelActor,
  condition: DocEventCondition
): Promise<DocReceiptInspection> {
  const own = currentServiceBindings.get(service);
  if (!own) throw new Error('Current receipt inspection requires its genuine service constructor.');
  return own.inspect(documentId, eventId, actor, condition);
}

/** Fixed replay entry for the actual HTTP owner; mutable public method replacement is not authority. */
export function replayServiceCurrentDoc(
  service: DocChannelService,
  documentId: string,
  actor: DocChannelActor,
  since = 0,
  limit = 200
): Promise<DocCurrentReplayResponse> {
  const own = currentServiceBindings.get(service);
  if (!own) throw new Error('Current replay requires its genuine service constructor.');
  return own.replay(documentId, actor, since, limit);
}

/** Fixed internal timer port. Public service method replacement cannot issue custody. */
export function currentRoomDueServicePort(service: DocChannelService) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new Error('Room due scheduler requires its genuine service constructor.');
  return Object.freeze({
    nextDueAt: own.nextRoomDueAt,
    wake: own.wakeRoomDue,
    hintRelay: own.hintRoomRelay,
    subscribeRelay: own.subscribeRoomRelay,
    pump: own.pumpRoomDue,
    stopPump: own.stopRoomPump,
    maintain: own.maintainHistory,
    subscribe: own.subscribeRoomDue,
  });
}

/** Prepare only a genuine original frozen Room source through this service constructor. */
export function prepareServiceOriginalRoomResponder(
  service: DocChannelService,
  runtime: object,
  holder: import('@dorkos/shared/agent-runtime').SseResponse,
  key: string
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new Error('Room preparation requires its genuine service constructor.');
  return own.prepareRoomResponder(runtime, holder, key);
}

/** Lookup-only original service-to-engine path; reflected service methods do not issue commit custody. */
export function commitServiceOriginalRoomResponder(
  service: DocChannelService,
  runtime: object,
  prepared: import('./current/current-operation-types.js').PreparedRoomResponder
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new Error('Room commit requires its genuine service constructor.');
  return own.commitRoomResponder(runtime, prepared);
}

/** Fixed original service capture; token crypto/storage cannot mint document authority. */
export function captureServiceCurrentDocument(
  service: DocChannelService,
  documentId: string,
  actor: DocChannelActor,
  approvedGrantIds: readonly string[] = []
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.captureDocument(documentId, actor, approvedGrantIds);
}
/** Require currentness of the service's original captured document authority. */
export function requireServiceCurrentDocument(
  service: DocChannelService,
  authority: import('./current/current-operation-types.js').OriginalCurrentDocumentAuthority
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.requireDocument(authority);
}

/** Replay through the service's original captured document authority. */
export function replayServiceDocumentAuthority(
  service: DocChannelService,
  authority: import('./current/current-operation-types.js').OriginalCurrentDocumentAuthority,
  since = 0,
  limit = 200
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.documentReplay(authority, since, limit);
}
/** Inspect an event through the service's original captured document authority. */
export function inspectServiceDocumentAuthority(
  service: DocChannelService,
  authority: import('./current/current-operation-types.js').OriginalCurrentDocumentAuthority,
  eventId: string
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.documentInspect(authority, eventId);
}
/** Submit through the service's original captured document authority. */
export function submitServiceDocumentAuthority(
  service: DocChannelService,
  authority: import('./current/current-operation-types.js').OriginalCurrentDocumentAuthority,
  raw: unknown
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.documentSubmit(authority, raw);
}

/** Fixed original local-provider diagnostics; no source/commit/principal authority is returned. */
export function readServiceOriginalRoomScenarioEvidence(
  service: DocChannelService,
  documentId: string,
  batchId: string,
  generation: string
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new Error('Original Room service required.');
  return own.readRoomScenarioEvidence(documentId, batchId, generation);
}

/** Original Checkbox constructor consumes only the same service's fixed private engine. */
export function prepareServiceOriginalCheckboxSource(
  service: DocChannelService,
  owner: object
): void {
  const own = currentServiceBindings.get(service);
  if (!own) throw new Error('Foreign original checkbox service.');
  own.prepareCheckbox(owner);
}
/** Complete the service-owned original checkbox source in its transaction. */
export function completeServiceOriginalCheckboxSource(
  service: DocChannelService,
  owner: object,
  tx: import('@dorkos/db').DbTransaction
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new Error('Foreign original checkbox service.');
  return own.completeCheckbox(owner, tx);
}
/** Publish the service-owned original checkbox completion. */
export function publishServiceOriginalCheckboxSource(
  service: DocChannelService,
  owner: object,
  tx: import('@dorkos/db').DbTransaction
): void {
  const own = currentServiceBindings.get(service);
  if (!own) throw new Error('Foreign original checkbox service.');
  own.publishCheckbox(owner, tx);
}
/** Abandon the service-owned original checkbox source in its transaction. */
export function abandonServiceOriginalCheckboxSource(
  service: DocChannelService,
  owner: object,
  tx: import('@dorkos/db').DbTransaction
): void {
  const own = currentServiceBindings.get(service);
  if (!own) throw new Error('Foreign original checkbox service.');
  own.abandonCheckbox(owner, tx);
}

/** Constructor-captured original notification; listener failures cannot change committed evidence. */
export function notifyServiceOriginalCheckboxCommitted(service: DocChannelService): undefined {
  const own = currentServiceBindings.get(service);
  if (!own) throw new Error('Foreign original checkbox service.');
  return own.notifyCheckboxCommitted();
}

/** Require the service's exact original checkbox grant dependencies. */
export function requireServiceOriginalCheckboxGrantDependencies(
  service: DocChannelService,
  store: import('./store.js').DocChannelStore,
  grants: import('./grants.js').DocChannelGrants
): void {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  own.requireGrantDependencies(store, grants);
}
/** Require the original document authority inside the supplied current transaction. */
export function requireServiceOriginalDocumentInTransaction(
  service: DocChannelService,
  authority: import('./current/current-operation-types.js').OriginalCurrentDocumentAuthority,
  tx: import('@dorkos/db').DbTransaction
): void {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  own.requireDocumentInTransaction(authority, tx);
}

/** Native token issue through the actual service constructor's retained engine and grants. */
export function issueServiceOriginalDocToken(
  service: DocChannelService,
  actor: DocChannelActor,
  request: unknown,
  approvedGrantIds: readonly string[]
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.issueToken(actor, request, approvedGrantIds);
}

/** Fixed genuine service child owns restoration, filtering and per-frame currentness. */
export function restoreServiceOriginalTokenScope(service: DocChannelService, hash: string) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.restoreToken(hash);
}
/** Replay the service-owned original native token scope. */
export function replayServiceOriginalTokenScope(
  service: DocChannelService,
  scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope,
  since = 0,
  limit = 200,
  permission: 'replay' | 'stream' = 'replay'
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.tokenReplay(scope, since, limit, permission);
}
/** Read an event from the service-owned original native token scope. */
export function readServiceOriginalTokenEvent(
  service: DocChannelService,
  scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope,
  eventId: string,
  permission: 'replay' | 'stream'
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.tokenEvent(scope, eventId, permission);
}

/** Open a stream for the service-owned original native token scope. */
export function openServiceOriginalTokenStream(
  service: DocChannelService,
  scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope,
  since = 0
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.tokenOpenStream(scope, since);
}
/** Read the next frame from the service-owned original token stream. */
export function nextServiceOriginalTokenStream(
  service: DocChannelService,
  stream: import('./current/current-operation-types.js').OriginalNativeDocTokenStream
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.tokenStreamNext(stream);
}
/** Close the service-owned original token stream. */
export function closeServiceOriginalTokenStream(
  service: DocChannelService,
  stream: import('./current/current-operation-types.js').OriginalNativeDocTokenStream
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.tokenCloseStream(stream);
}

/** Read whether the service-owned original token stream has closed. */
export function closedServiceOriginalTokenStream(
  service: DocChannelService,
  stream: import('./current/current-operation-types.js').OriginalNativeDocTokenStream
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.tokenStreamClosed(stream);
}

/** Original stream lifecycle DATA only; cannot issue/read/close a foreign stage. */
export function readServiceOriginalTokenStreamState(
  service: DocChannelService,
  stream: import('./current/current-operation-types.js').OriginalNativeDocTokenStream
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.tokenStreamState(stream);
}

/** Actual original native peer/operation closure DATA, never a resource waiver or operation issuer. */
export function readServiceOriginalTokenDrainData(service: DocChannelService) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.tokenDrainData();
}

/** Fixed constructor-owned operator revocation, separate from standalone bearer reads. */
export function revokeServiceOriginalDocToken(
  service: DocChannelService,
  actor: DocChannelActor,
  documentId: string,
  tokenId: string
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.revokeToken(actor, documentId, tokenId);
}

/** Ingest permission is independent of replay/stream; the opaque scope is never an actor. */
export function admitServiceOriginalTokenIngress(
  service: DocChannelService,
  scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.tokenIngressCurrent(scope);
}
/** Submit bearer ingress through the service-owned original token scope. */
export function submitServiceOriginalTokenIngress(
  service: DocChannelService,
  scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope,
  raw: unknown
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.tokenSubmit(scope, raw);
}

/** Lookup-only constructor tuple; no public method or caller checker supplies recovery custody. */
export function requireServiceOriginalTokenDependencies(
  service: DocChannelService,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants
): void {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  own.requireTokenDependencies(authorization, store, grants);
}

/** Read operator management DATA through the genuine service's retained current engine. */
export function readServiceOriginalDocManagement(
  service: DocChannelService,
  documentId: string,
  actor: DocChannelActor
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.management(documentId, actor);
}

/** Original authenticated editor command; this entry cannot be reached by a page event envelope. */
export function askServiceOriginalDocSelection(
  service: DocChannelService,
  raw: unknown,
  actor: DocChannelActor
): Promise<CanvasChannelEventReceipt> {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.selection(raw, actor);
}

/** Explicit operator review dispatches only the service's constructor-owned current replay path. */
export function replayServiceOriginalExpiredDocBatch(
  service: DocChannelService,
  raw: unknown,
  actor: DocChannelActor
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.replayExpired(raw, actor);
}

/** Fixed original service entry for the installation's actual normal-save scope. */
export function prepareServiceOriginalDocumentSave(
  service: DocChannelService,
  scope: object,
  actor: DocChannelActor
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.prepareDocumentSave(scope, actor);
}
/** Fixed completion never accepts a caller-supplied success result or reserved event. */
export function completeServiceOriginalDocumentSave(
  service: DocChannelService,
  scope: object,
  actor: DocChannelActor
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.completeDocumentSave(scope, actor);
}

/** Fixed original host presence entry; public method replacement cannot issue a viewer. */
export function updateServiceOriginalDocPresence(
  service: DocChannelService,
  documentId: string,
  actor: DocChannelActor,
  raw: unknown
) {
  const own = currentServiceBindings.get(service);
  if (!own) throw new DocChannelNotFoundError();
  return own.presence(documentId, actor, raw);
}
