/** Current-authorized document channel reads and durable event acceptance. */
import { type CanvasChannelEventReceipt } from '@dorkos/shared/canvas-channel-schemas';

import type {
  DocEventCondition,
  DocReceiptInspection,
  DocCurrentReplayResponse,
} from '../current/current-operation-types.js';

import type { DocChannelGrants } from '../grants.js';

import {
  DocChannelAuthorization,
  DocChannelNotFoundError,
  type DocChannelActor,
} from '../authorization.js';
import { DocChannelStore } from '../store.js';

import type { DocChannelService } from '../service.js';
import type { OriginalCurrentServiceBinding } from './service-binding-types.js';
/** Isolated original service membership; actual instance and registrar remain root-private. */
export function createIsolatedCurrentServiceBindings() {
  const currentServiceBindings = new WeakMap<DocChannelService, OriginalCurrentServiceBinding>();
  /** Prospective HTTP submit entry; mandatory generation condition is untrusted input, never an actor. */
  function submitCurrentDocEvent(
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
  function inspectServiceCurrentDocReceipt(
    service: DocChannelService,
    documentId: string,
    eventId: string,
    actor: DocChannelActor,
    condition: DocEventCondition
  ): Promise<DocReceiptInspection> {
    const own = currentServiceBindings.get(service);
    if (!own)
      throw new Error('Current receipt inspection requires its genuine service constructor.');
    return own.inspect(documentId, eventId, actor, condition);
  }

  /** Fixed replay entry for the actual HTTP owner; mutable public method replacement is not authority. */
  function replayServiceCurrentDoc(
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
  function currentRoomDueServicePort(service: DocChannelService) {
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
  function prepareServiceOriginalRoomResponder(
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
  function commitServiceOriginalRoomResponder(
    service: DocChannelService,
    runtime: object,
    prepared: import('../current/current-operation-types.js').PreparedRoomResponder
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new Error('Room commit requires its genuine service constructor.');
    return own.commitRoomResponder(runtime, prepared);
  }

  /** Fixed original service capture; token crypto/storage cannot mint document authority. */
  function captureServiceCurrentDocument(
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
  function requireServiceCurrentDocument(
    service: DocChannelService,
    authority: import('../current/current-operation-types.js').OriginalCurrentDocumentAuthority
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.requireDocument(authority);
  }

  /** Replay through the service's original captured document authority. */
  function replayServiceDocumentAuthority(
    service: DocChannelService,
    authority: import('../current/current-operation-types.js').OriginalCurrentDocumentAuthority,
    since = 0,
    limit = 200
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.documentReplay(authority, since, limit);
  }
  /** Inspect an event through the service's original captured document authority. */
  function inspectServiceDocumentAuthority(
    service: DocChannelService,
    authority: import('../current/current-operation-types.js').OriginalCurrentDocumentAuthority,
    eventId: string
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.documentInspect(authority, eventId);
  }
  /** Submit through the service's original captured document authority. */
  function submitServiceDocumentAuthority(
    service: DocChannelService,
    authority: import('../current/current-operation-types.js').OriginalCurrentDocumentAuthority,
    raw: unknown
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.documentSubmit(authority, raw);
  }

  /** Fixed original local-provider diagnostics; no source/commit/principal authority is returned. */
  function readServiceOriginalRoomScenarioEvidence(
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
  function prepareServiceOriginalCheckboxSource(service: DocChannelService, owner: object): void {
    const own = currentServiceBindings.get(service);
    if (!own) throw new Error('Foreign original checkbox service.');
    own.prepareCheckbox(owner);
  }
  /** Complete the service-owned original checkbox source in its transaction. */
  function completeServiceOriginalCheckboxSource(
    service: DocChannelService,
    owner: object,
    tx: import('@dorkos/db').DbTransaction
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new Error('Foreign original checkbox service.');
    return own.completeCheckbox(owner, tx);
  }
  /** Publish the service-owned original checkbox completion. */
  function publishServiceOriginalCheckboxSource(
    service: DocChannelService,
    owner: object,
    tx: import('@dorkos/db').DbTransaction
  ): void {
    const own = currentServiceBindings.get(service);
    if (!own) throw new Error('Foreign original checkbox service.');
    own.publishCheckbox(owner, tx);
  }
  /** Abandon the service-owned original checkbox source in its transaction. */
  function abandonServiceOriginalCheckboxSource(
    service: DocChannelService,
    owner: object,
    tx: import('@dorkos/db').DbTransaction
  ): void {
    const own = currentServiceBindings.get(service);
    if (!own) throw new Error('Foreign original checkbox service.');
    own.abandonCheckbox(owner, tx);
  }

  /** Constructor-captured original notification; listener failures cannot change committed evidence. */
  function notifyServiceOriginalCheckboxCommitted(service: DocChannelService): undefined {
    const own = currentServiceBindings.get(service);
    if (!own) throw new Error('Foreign original checkbox service.');
    return own.notifyCheckboxCommitted();
  }

  /** Require the service's exact original checkbox grant dependencies. */
  function requireServiceOriginalCheckboxGrantDependencies(
    service: DocChannelService,
    store: import('../store.js').DocChannelStore,
    grants: import('../grants.js').DocChannelGrants
  ): void {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    own.requireGrantDependencies(store, grants);
  }
  /** Require the original document authority inside the supplied current transaction. */
  function requireServiceOriginalDocumentInTransaction(
    service: DocChannelService,
    authority: import('../current/current-operation-types.js').OriginalCurrentDocumentAuthority,
    tx: import('@dorkos/db').DbTransaction
  ): void {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    own.requireDocumentInTransaction(authority, tx);
  }

  /** Native token issue through the actual service constructor's retained engine and grants. */
  function issueServiceOriginalDocToken(
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
  function restoreServiceOriginalTokenScope(service: DocChannelService, hash: string) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.restoreToken(hash);
  }
  /** Replay the service-owned original native token scope. */
  function replayServiceOriginalTokenScope(
    service: DocChannelService,
    scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope,
    since = 0,
    limit = 200,
    permission: 'replay' | 'stream' = 'replay'
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.tokenReplay(scope, since, limit, permission);
  }
  /** Read an event from the service-owned original native token scope. */
  function readServiceOriginalTokenEvent(
    service: DocChannelService,
    scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope,
    eventId: string,
    permission: 'replay' | 'stream'
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.tokenEvent(scope, eventId, permission);
  }

  /** Open a stream for the service-owned original native token scope. */
  function openServiceOriginalTokenStream(
    service: DocChannelService,
    scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope,
    since = 0
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.tokenOpenStream(scope, since);
  }
  /** Read the next frame from the service-owned original token stream. */
  function nextServiceOriginalTokenStream(
    service: DocChannelService,
    stream: import('../current/current-operation-types.js').OriginalNativeDocTokenStream
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.tokenStreamNext(stream);
  }
  /** Close the service-owned original token stream. */
  function closeServiceOriginalTokenStream(
    service: DocChannelService,
    stream: import('../current/current-operation-types.js').OriginalNativeDocTokenStream
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.tokenCloseStream(stream);
  }

  /** Read whether the service-owned original token stream has closed. */
  function closedServiceOriginalTokenStream(
    service: DocChannelService,
    stream: import('../current/current-operation-types.js').OriginalNativeDocTokenStream
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.tokenStreamClosed(stream);
  }

  /** Original stream lifecycle DATA only; cannot issue/read/close a foreign stage. */
  function readServiceOriginalTokenStreamState(
    service: DocChannelService,
    stream: import('../current/current-operation-types.js').OriginalNativeDocTokenStream
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.tokenStreamState(stream);
  }

  /** Actual original native peer/operation closure DATA, never a resource waiver or operation issuer. */
  function readServiceOriginalTokenDrainData(service: DocChannelService) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.tokenDrainData();
  }

  /** Fixed constructor-owned operator revocation, separate from standalone bearer reads. */
  function revokeServiceOriginalDocToken(
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
  function admitServiceOriginalTokenIngress(
    service: DocChannelService,
    scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.tokenIngressCurrent(scope);
  }
  /** Submit bearer ingress through the service-owned original token scope. */
  function submitServiceOriginalTokenIngress(
    service: DocChannelService,
    scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope,
    raw: unknown
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.tokenSubmit(scope, raw);
  }

  /** Lookup-only constructor tuple; no public method or caller checker supplies recovery custody. */
  function requireServiceOriginalTokenDependencies(
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
  function readServiceOriginalDocManagement(
    service: DocChannelService,
    documentId: string,
    actor: DocChannelActor
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.management(documentId, actor);
  }

  /** Original authenticated editor command; this entry cannot be reached by a page event envelope. */
  function askServiceOriginalDocSelection(
    service: DocChannelService,
    raw: unknown,
    actor: DocChannelActor
  ): Promise<CanvasChannelEventReceipt> {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.selection(raw, actor);
  }

  /** Explicit operator review dispatches only the service's constructor-owned current replay path. */
  function replayServiceOriginalExpiredDocBatch(
    service: DocChannelService,
    raw: unknown,
    actor: DocChannelActor
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.replayExpired(raw, actor);
  }

  /** Fixed original service entry for the installation's actual normal-save scope. */
  function prepareServiceOriginalDocumentSave(
    service: DocChannelService,
    scope: object,
    actor: DocChannelActor
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.prepareDocumentSave(scope, actor);
  }
  /** Fixed completion never accepts a caller-supplied success result or reserved event. */
  function completeServiceOriginalDocumentSave(
    service: DocChannelService,
    scope: object,
    actor: DocChannelActor
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.completeDocumentSave(scope, actor);
  }

  /** Fixed original host presence entry; public method replacement cannot issue a viewer. */
  function updateServiceOriginalDocPresence(
    service: DocChannelService,
    documentId: string,
    actor: DocChannelActor,
    raw: unknown
  ) {
    const own = currentServiceBindings.get(service);
    if (!own) throw new DocChannelNotFoundError();
    return own.presence(documentId, actor, raw);
  }

  return Object.freeze({
    currentServiceBindings,
    submitCurrentDocEvent,
    inspectServiceCurrentDocReceipt,
    replayServiceCurrentDoc,
    currentRoomDueServicePort,
    prepareServiceOriginalRoomResponder,
    commitServiceOriginalRoomResponder,
    captureServiceCurrentDocument,
    requireServiceCurrentDocument,
    replayServiceDocumentAuthority,
    inspectServiceDocumentAuthority,
    submitServiceDocumentAuthority,
    readServiceOriginalRoomScenarioEvidence,
    prepareServiceOriginalCheckboxSource,
    completeServiceOriginalCheckboxSource,
    publishServiceOriginalCheckboxSource,
    abandonServiceOriginalCheckboxSource,
    notifyServiceOriginalCheckboxCommitted,
    requireServiceOriginalCheckboxGrantDependencies,
    requireServiceOriginalDocumentInTransaction,
    issueServiceOriginalDocToken,
    restoreServiceOriginalTokenScope,
    replayServiceOriginalTokenScope,
    readServiceOriginalTokenEvent,
    openServiceOriginalTokenStream,
    nextServiceOriginalTokenStream,
    closeServiceOriginalTokenStream,
    closedServiceOriginalTokenStream,
    readServiceOriginalTokenStreamState,
    readServiceOriginalTokenDrainData,
    revokeServiceOriginalDocToken,
    admitServiceOriginalTokenIngress,
    submitServiceOriginalTokenIngress,
    requireServiceOriginalTokenDependencies,
    readServiceOriginalDocManagement,
    askServiceOriginalDocSelection,
    replayServiceOriginalExpiredDocBatch,
    prepareServiceOriginalDocumentSave,
    completeServiceOriginalDocumentSave,
    updateServiceOriginalDocPresence,
  });
}
