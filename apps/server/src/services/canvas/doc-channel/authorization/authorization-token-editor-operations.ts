import { DocChannelNotFoundError } from './authorization-data.js';
import {
  requireCurrentDocConstructorEngines,
  readOriginalAuthorizationOperationBinding,
  type DocChannelAuthorization,
  type DocChannelActor,
} from '../authorization.js';
import { type DbTransaction } from '@dorkos/db';
import { type CanvasChannelEventReceipt } from '@dorkos/shared/canvas-channel-schemas';
import { type DocChannelStore } from '../store.js';
import { type DocChannelIngest } from '../ingest.js';
import { type DocChannelGrants } from '../grants.js';

/** Repeat only an actual original retained actor/document authority in the supplied same native transaction. */
export function requireAuthorizedDocumentInTransaction(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  authority: import('../current/current-operation-types.js').OriginalCurrentDocumentAuthority,
  tx: DbTransaction
): void {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  own.engine.requireDocumentInTransaction(store, grants, authority, tx);
}

/** Fixed original constructor ingress for persistent native scopes; no actor input. */
export function restoreAuthorizedOriginalTokenScope(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  hash: string
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  requireCurrentDocConstructorEngines(authorization, store, undefined, grants);
  return own.engine.restoreTokenScope(store, grants, hash);
}
/** Replay the original native token scope with its required permission. */
export function replayAuthorizedOriginalTokenScope(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope,
  since: number,
  limit: number,
  permission: 'replay' | 'stream' = 'replay'
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenReplay(scope, since, limit, permission);
}
/** Read an authorized event from the original native token scope. */
export function readAuthorizedOriginalTokenEvent(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope,
  eventId: string,
  permission: 'replay' | 'stream'
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenEvent(scope, eventId, permission);
}

/** Open a stream owned by the original native token scope. */
export function openAuthorizedOriginalTokenStream(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope,
  since: number
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenOpenStream(scope, since);
}
/** Read the next frame of the original authorization-owned token stream. */
export function nextAuthorizedOriginalTokenStream(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  stream: import('../current/current-operation-types.js').OriginalNativeDocTokenStream
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenStreamNext(stream);
}
/** Close the original authorization-owned token stream. */
export function closeAuthorizedOriginalTokenStream(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  stream: import('../current/current-operation-types.js').OriginalNativeDocTokenStream
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenCloseStream(stream);
}

/** Read whether the original token stream has closed. */
export function closedAuthorizedOriginalTokenStream(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  stream: import('../current/current-operation-types.js').OriginalNativeDocTokenStream
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenStreamClosed(stream);
}

/** Read the state of the original authorization-owned token stream. */
export function stateAuthorizedOriginalTokenStream(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  stream: import('../current/current-operation-types.js').OriginalNativeDocTokenStream
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenStreamState(stream);
}

/** Drain token-owner DATA through the original operation engine. */
export function drainDataAuthorizedOriginalTokenOwner(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenDrainData();
}

/** Revocation is original operator/source authority; a bearer never restores an actor. */
export function revokeAuthorizedOriginalDocToken(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  actor: DocChannelActor,
  documentId: string,
  tokenId: string
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  requireCurrentDocConstructorEngines(authorization, store, undefined, grants);
  return own.engine.revokeToken(store, grants, actor, documentId, tokenId);
}

/** Authenticate original opaque input scope before a standalone parser consumes any body. */
export function admitAuthorizedOriginalTokenIngress(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenIngressCurrent(scope);
}
/** Submit bearer ingress through the original native token scope. */
export function submitAuthorizedOriginalTokenIngress(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope,
  raw: unknown
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  requireCurrentDocConstructorEngines(authorization, store, ingest, grants);
  return own.engine.submitToken(store, ingest, grants, scope, raw);
}

/** Original service constructor establishes the single retained token recovery dependency tuple. */
export function bindAuthorizedOriginalTokenService(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  service: import('../service.js').DocChannelService,
  store: DocChannelStore,
  grants: DocChannelGrants
): void {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  own.engine.bindTokenService(service, store, grants);
}

/** Inspect the original token ingress receipt by event identity. */
export function inspectAuthorizedOriginalTokenInputReceipt(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope,
  eventId: string
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.inspectTokenInputReceipt(scope, eventId);
}

/** Revalidate through the original authorization engine rather than reflected public methods. */
export function requireOriginalCurrentDocAccess(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  documentId: string,
  actor: DocChannelActor,
  write = false,
  tx?: DbTransaction
): { id: string; scope: string } {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.requireCurrentAccess(documentId, actor, write, tx);
}

/** Original constructor-owned operator management projection; no caller reader or authority callback. */
export function readAuthorizedDocManagement(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  documentId: string,
  actor: DocChannelActor
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.management(store, documentId, actor);
}

/** Accept a host selection only through this original authorization's private engine. */
export function askAuthorizedOriginalDocSelection(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  raw: unknown,
  actor: DocChannelActor
): Promise<CanvasChannelEventReceipt> {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.selection(store, ingest, grants, raw, actor);
}

/** Enter the exact original operator replay engine, never the reflected legacy batch helper. */
export function replayAuthorizedOriginalExpiredDocBatch(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  raw: unknown,
  actor: DocChannelActor
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.replayExpired(store, ingest, grants, raw, actor);
}

/** Original installed file owner invokes preparation with its actual retained HTTP actor. */
export function prepareAuthorizedOriginalDocumentSave(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  scope: object,
  actor: DocChannelActor
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.prepareDocumentSave(store, grants, scope, actor);
}
/** Only the genuine private file-save scope can complete this reserved host event. */
export function completeAuthorizedOriginalDocumentSave(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  scope: object,
  actor: DocChannelActor
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.completeDocumentSave(store, ingest, grants, scope, actor);
}

/** Authenticated host presence follows only the constructor-retained original engine. */
export function updateAuthorizedOriginalDocPresence(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  documentId: string,
  actor: DocChannelActor,
  raw: unknown
) {
  const own = readOriginalAuthorizationOperationBinding(ownerKey, authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.presence(store, ingest, grants, documentId, actor, raw);
}
