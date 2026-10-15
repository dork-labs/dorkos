import { DocChannelNotFoundError } from './authorization-data.js';
import {
  readOriginalAuthorizationOperationBinding,
  type DocChannelAuthorization,
  type DocChannelActor,
} from '../authorization.js';
import { type DbTransaction } from '@dorkos/db';
import { type CanvasChannelEventReceipt } from '@dorkos/shared/canvas-channel-schemas';
import { requireDocChannelStoreDatabase, type DocChannelStore } from '../store.js';
import { type DocChannelIngest } from '../ingest.js';
import { type DocChannelGrants } from '../grants.js';
import {
  type DocEventCondition,
  type DocReceiptInspection,
  type DocCurrentReplayResponse,
} from '../current/current-operation-types.js';

/** Submit through the original current-document authorization and ingress assembly. */
export function submitAuthorizedCurrentDocEvent(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  documentId: string,
  raw: unknown,
  actor: DocChannelActor,
  condition: DocEventCondition
): Promise<CanvasChannelEventReceipt> {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Current document operation requires genuine authorization.');
  return own.submit(store, ingest, grants, documentId, raw, actor, condition);
}
/** Qualified absence includes the full server-derived incarnation tuple and current retained receipt floor. */
export function inspectCurrentDocReceipt(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  documentId: string,
  eventId: string,
  actor: DocChannelActor,
  condition: DocEventCondition
): Promise<DocReceiptInspection> {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Current document operation requires genuine authorization.');
  return own.inspect(store, documentId, eventId, actor, condition);
}
/** Prepare the installed checkbox source under its captured authorization. */
export function prepareAuthorizedCheckboxSource(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  owner: object
): void {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Foreign checkbox document authority.');
  own.engine.prepareCheckbox(store, owner);
}
/** Complete the original checkbox source in the owning transaction. */
export function completeAuthorizedCheckboxSource(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  owner: object,
  tx: DbTransaction
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Foreign checkbox document authority.');
  return own.engine.completeCheckbox(store, grants, owner, tx);
}
/** Publish the original checkbox completion through its captured authorization. */
export function publishAuthorizedCheckboxSource(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  owner: object,
  tx: DbTransaction
): void {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Foreign checkbox document authority.');
  own.engine.publishCheckbox(store, owner, tx);
}
/** Abandon the original checkbox source in the owning transaction. */
export function abandonAuthorizedCheckboxSource(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  owner: object,
  tx: DbTransaction
): void {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Foreign checkbox document authority.');
  own.engine.abandonCheckbox(owner, tx);
}
/** Initial replay captures server birth through the original constructor-owned private engine. */
export function replayAuthorizedCurrentDoc(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  documentId: string,
  actor: DocChannelActor,
  since: number,
  limit: number
): Promise<DocCurrentReplayResponse> {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Current replay requires genuine authorization.');
  return own.replay(store, documentId, actor, since, limit);
}

/** Genuine original maintenance closure: callers supply no actor, clock, engine or facade. */
export function maintainAuthorizedDocHistory(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore
): void {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Document maintenance requires genuine authorization.');
  requireDocChannelStoreDatabase(store, own.db);
  own.engine.maintainHistory(store);
}

/** Fixed timer data/wake port from the genuine engine; never exposes engine, DB or source. */
export function readAuthorizedRoomDueAt(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization
): string | undefined {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Room due read requires genuine authorization.');
  return own.engine.nextRoomDueAt();
}
/** Revisit original committed custody only; no actor or source DTO is accepted. */
export function wakeAuthorizedRoomDue(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization
): void {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Room due wake requires genuine authorization.');
  own.engine.wakeRoomDue();
}

/** Resolve Relay identifiers through this authorization's original Room engine only. */
export function hintAuthorizedRoomRelay(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  documentId: string,
  batchId: string,
  generation: string
): boolean {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Room Relay hint requires genuine authorization.');
  return own.engine.hintRoomRelay(documentId, batchId, generation);
}

/** Subscribe only through the original authorization's native Room operation owner. */
export function subscribeAuthorizedRoomRelay(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  listener: (documentId: string, batchId: string, generation: string) => void
): () => void {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Room Relay subscription requires genuine authorization.');
  return own.engine.subscribeRoomRelay(listener);
}

/** Genuine private source routing only, never a caller-supplied source or principal. */
export function prepareAuthorizedRoomResponder(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  runtime: object,
  holder: import('@dorkos/shared/agent-runtime').SseResponse,
  key: string
): Promise<import('../current/current-operation-types.js').PreparedRoomResponder | undefined> {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Room preparation requires genuine authorization.');
  return own.engine.prepareRoomResponder(runtime, holder, key);
}

/** Original constructor engine commits only its own genuine prepared native entry. */
export function commitAuthorizedRoomResponder(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  runtime: object,
  prepared: import('../current/current-operation-types.js').PreparedRoomResponder
): import('../current/current-operation-types.js').OriginalCommittedRoomResponder {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Room commit requires genuine authorization.');
  return own.engine.commitRoomResponder(runtime, prepared);
}

/** Genuine owning document-only issuance and current read, including an empty dependency list. */
export function captureAuthorizedCurrentDocument(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  documentId: string,
  actor: DocChannelActor,
  grantIds: readonly string[]
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.captureDocument(store, grants, documentId, actor, grantIds);
}
/** Require currentness of the original captured document authority. */
export function requireAuthorizedCurrentDocument(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  authority: import('../current/current-operation-types.js').OriginalCurrentDocumentAuthority
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.requireDocument(store, grants, authority);
}

/** Replay through the original captured document authority. */
export function replayAuthorizedDocumentAuthority(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  authority: import('../current/current-operation-types.js').OriginalCurrentDocumentAuthority,
  since: number,
  limit: number
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.documentReplay(store, grants, authority, since, limit);
}
/** Inspect an event through the original captured document authority. */
export function inspectAuthorizedDocumentAuthority(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  authority: import('../current/current-operation-types.js').OriginalCurrentDocumentAuthority,
  eventId: string
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.documentInspect(store, grants, authority, eventId);
}
/** Submit an event through the original captured document authority. */
export function submitAuthorizedDocumentAuthority(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  authority: import('../current/current-operation-types.js').OriginalCurrentDocumentAuthority,
  raw: unknown
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.documentSubmit(store, ingest, grants, authority, raw);
}

/** Fixed original engine invocation; registry rows and timer hints never issue source custody. */
export function pumpAuthorizedRoomDue(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  registry: import('../../../core/runtime-registry.js').RuntimeRegistry
): Promise<void> {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Original Room authorization required.');
  return own.engine.pumpRoomDue(registry);
}

/** Stop the original authorization-owned Room pump. */
export function stopAuthorizedRoomPump(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization
): Promise<void> {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Original Room authorization required.');
  return own.engine.stopRoomPump();
}

/** Read scenario evidence from the original Room operation engine. */
export function readAuthorizedRoomScenarioEvidence(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  documentId: string,
  batchId: string,
  generation: string
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new Error('Original Room authorization required.');
  return own.engine.readRoomScenarioEvidence(documentId, batchId, generation);
}
