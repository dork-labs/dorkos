import { type CurrentRoomOperation } from '../operations/room-current-operation.js';
import type { CurrentDocOperationEngineCore } from '../current/current-operation-types.js';
import {
  enterOriginalCheckboxGrantOperation,
  type OriginalCheckboxGrantPreparation,
} from '../writes/checkbox/checkbox-grant-preparation.js';
import { type CanvasChannelDeclaration } from '@dorkos/shared/canvas-channel-schemas';
import { type DocRouteGrantRequest } from '../grant-policy.js';
import { selectOriginalRoomGrantSource } from '../current/current-operation-intentions.js';
import { approvals, type Db, type DbTransaction } from '@dorkos/db';
import { DocChannelStore } from '../store.js';
import {
  DocRouteGrantError,
  type DocGrantActor,
  type DocOriginalWriteObservation,
} from '../grant-policy.js';
import { readOriginalCheckboxCompletionStage } from '../writes/completion.js';
import {
  readCurrentDocIngressInput,
  readCurrentDocReplayWriteObservation,
  type DocChannelAuthorization,
} from '../authorization.js';
import { copyCurrentDocData, sameCurrentDocData } from '../current/current-operation-data.js';
import { readOriginalGrantCustody } from '../grant-revalidation.js';
import type { DocChannelGrants, DocChannelGrantRevalidation } from '../grant-revalidation.js';
import type {
  OriginalCurrentDocumentGrantDependencies,
  DocGrantResult,
  OriginalTokenWriteObservation,
} from './grant-private-contracts.js';

/** Compare only the exact constructor-owned insertion against the prior source snapshot.
 * All other grant/approval rows remain in the complete original census. */
export function documentDependenciesBeforeOriginalGrantInsertion(
  custodyOwner: object,
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  documentId: string,
  actor: DocGrantActor,
  grantIds: readonly string[],
  tx: DbTransaction,
  dependencies: OriginalCurrentDocumentGrantDependencies
): OriginalCurrentDocumentGrantDependencies {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.originalGrantInsertions.get(tx);
  if (!own) return dependencies;
  if (
    own.grants !== grants ||
    own.store !== store ||
    own.documentId !== documentId ||
    own.actor.principal !== actor.principal ||
    own.actor.surface !== actor.surface ||
    grantIds.length
  )
    throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
  const rows = dependencies.originalRows;
  const inserted = rows.grants.filter((row) => row.grantId === own.grant.grantId);
  if (inserted.length !== 1 || !sameCurrentDocData(inserted[0], own.grant))
    throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
  if (own.approval) {
    const linked = rows.approvals.filter((row) => row.id === own.approval!.id);
    if (linked.length !== 1 || !sameCurrentDocData(linked[0], own.approval))
      throw new DocRouteGrantError('GRANT_EVIDENCE_MISMATCH');
  }
  return copyCurrentDocData({
    ...dependencies,
    originalRows: {
      ...rows,
      grants: rows.grants.filter((row) => row.grantId !== own.grant.grantId),
      approvals: own.approval
        ? rows.approvals.filter((row) => row.id !== own.approval!.id)
        : rows.approvals,
    },
  });
}

/** Project current route readiness through the original constructor-owned grant validators. */
export function readOriginalCurrentDocReplayRouting(
  custodyOwner: object,
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  documentId: string,
  actor: DocGrantActor,
  tx: DbTransaction,
  room?: CurrentRoomOperation,
  engine?: CurrentDocOperationEngineCore
): import('@dorkos/shared/canvas-channel-schemas').CanvasChannelRouting {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.originalReplayRouting.get(grants);
  const binding = facet.currentGrantBindings.get(grants);
  if (!own || !binding || binding.store !== store)
    throw new Error('Replay routing requires the original grant constructor.');
  requireCurrentDocGrantEngine(custodyOwner, grants, store, binding.db);
  if (!engine) throw new Error('Replay routing requires its original current engine.');
  const observed = readCurrentDocReplayWriteObservation(store, tx, documentId, engine);
  return own(documentId, actor, tx, room, engine, observed);
}

/** Fixed genuine constructor entry; caller does not supply route authority or a checker. */
export function prepareCurrentDocGrantRoutes(
  custodyOwner: object,
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  tx: DbTransaction
): import('../ingest-data/ingest-types.js').DocIngestAccess {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.currentGrantBindings.get(grants);
  if (!own || own.store !== store)
    throw new Error('Current route selection requires its genuine grant store.');
  requireCurrentDocGrantEngine(custodyOwner, grants, store, own.db);
  return own.prepare(authorization, tx);
}

/** Only the active original completion stage supplies checked FILE observation DATA. */
export function prepareCurrentDocCheckboxGrantRoutes(
  custodyOwner: object,
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  owner: object,
  tx: DbTransaction
): import('../ingest-data/ingest-types.js').DocIngestAccess {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.currentGrantBindings.get(grants);
  if (!own || own.store !== store)
    throw new Error('Checkbox route selection requires its genuine grant store.');
  requireCurrentDocGrantEngine(custodyOwner, grants, store, own.db);
  const original = readOriginalCheckboxCompletionStage(owner, store, tx);
  const input = readCurrentDocIngressInput(authorization, store, tx);
  if (
    original.data.subject.kind !== 'live' ||
    !input.actor ||
    input.tokenScope ||
    input.documentId !== original.data.access.documentId ||
    input.actor.principal !== original.data.subject.actor.principal ||
    input.actor.surface !== original.data.subject.actor.surface
  )
    throw new Error('Checkbox route selection differs from its original producer.');
  return own.prepare(authorization, tx, original.data.writeObservation);
}

/** Exact original SQL rows and consumed approvals, audited after all admission writes. */
export function auditCurrentDocGrantRows(
  custodyOwner: object,
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  tx: DbTransaction
): void {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.currentGrantBindings.get(grants);
  if (!own || own.store !== store)
    throw new Error('Current grant audit requires its genuine grant store.');
  requireCurrentDocGrantEngine(custodyOwner, grants, store, own.db);
  own.audit(authorization, tx);
}

/** Commit observed manifest reductions through captured genuine core before admission, preserving thrown undefined. */
export function refreshCurrentDocGrantAuthority(
  custodyOwner: object,
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  documentId: string,
  actor: DocGrantActor
): void {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.currentGrantBindings.get(grants);
  if (!own || own.store !== store)
    throw new Error('Current grant refresh requires its genuine store.');
  requireCurrentDocGrantEngine(custodyOwner, grants, store, own.db);
  own.refresh(documentId, actor);
}

/** Original pre-effect data from this genuine current grant constructor; cannot issue or extend authority. */
export function readCurrentOriginalRoomGrantSource(
  custodyOwner: object,
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  tx: DbTransaction,
  routeId: string
): ReturnType<typeof selectOriginalRoomGrantSource> {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.currentGrantBindings.get(grants);
  if (!own || own.store !== store)
    throw new Error('Original Room source requires its genuine grant store.');
  requireCurrentDocGrantEngine(custodyOwner, grants, store, own.db);
  return own.roomSource(authorization, tx, routeId);
}

/** Fixed document-only dependencies; no batch, opener resurrection or caller-supplied authority. */
export function captureCurrentDocumentGrantDependencies(
  custodyOwner: object,
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  documentId: string,
  actor: DocGrantActor,
  grantIds: readonly string[],
  tx: DbTransaction,
  observed?: DocOriginalWriteObservation
): OriginalCurrentDocumentGrantDependencies {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.currentGrantBindings.get(grants);
  if (!own || own.store !== store)
    throw new Error('Document dependencies require original grants.');
  requireCurrentDocGrantEngine(custodyOwner, grants, store, own.db);
  return own.documentDependencies(documentId, actor, grantIds, tx, observed);
}

/** Last owner-clock phase followed only by native row/data guards; no supplied numeric time. */
export function requireCurrentDocumentGrantFinal(
  custodyOwner: object,
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  documentId: string,
  grantIds: readonly string[],
  tx: DbTransaction
): void {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.currentGrantBindings.get(grants);
  if (!own || own.store !== store)
    throw new Error('Document final expiry requires original grants.');
  requireCurrentDocGrantEngine(custodyOwner, grants, store, own.db);
  own.documentFinal(documentId, grantIds, tx);
}

/** Fixed constructor-owned FILE/manifest observation DATA, always outside SQL.
 * The original token engine must bind it to authenticated native source facts.
 */
export function readOriginalTokenDocumentManifest(
  custodyOwner: object,
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  db: Db,
  documentId: string
): string | null {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.originalTokenManifestReads.get(grants);
  if (!own || own.db !== db || own.store !== store || typeof documentId !== 'string' || !documentId)
    throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
  requireCurrentDocGrantEngine(custodyOwner, grants, store, db);
  return own.read(documentId);
}

/** Fixed owning manifest-FD close witness, distinct from ordinary validation refusal. */
export function requireOriginalTokenDocumentManifestClosed(
  custodyOwner: object,
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  db: Db
): void {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.originalTokenManifestReads.get(grants);
  if (!own || own.db !== db || own.store !== store)
    throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
  own.closed();
}

/** Original constructor-bound manifest preparation DATA; never grants bearer authority by itself. */
export function prepareOriginalTokenGrantInput(
  custodyOwner: object,
  grants: import('../grants.js').DocChannelGrants,
  store: DocChannelStore,
  db: Db,
  documentId: string,
  observed: OriginalTokenWriteObservation
) {
  const facet = readOriginalGrantCustody(custodyOwner);
  requireCurrentDocGrantEngine(custodyOwner, grants, store, db);
  const own = facet.originalTokenGrantPreparers.get(grants);
  if (!own || own.db !== db || own.store !== store)
    throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
  return own.prepare(documentId, observed);
}

/** Fixed original grant background reads; reflection cannot replace captured class/SQL/currentness. */
export function requireOriginalDocumentRelayGrants(
  custodyOwner: object,
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore
) {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.originalRelayGrantReads.get(grants);
  if (!own || own.store !== store) throw new Error('DOCUMENT_RELAY_ORIGINAL_GRANTS_REQUIRED');
  requireCurrentDocGrantEngine(custodyOwner, grants, store, own.db);
  return own.calls;
}

/** Exact constructor provenance only; never returns a connection, checker or authority token. */
export function requireCurrentDocGrantEngine(
  custodyOwner: object,
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  expected: Db
): void {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.currentGrantEngines.get(grants);
  if (!own || own.store !== store || own.db !== expected)
    throw new Error('Current document operation requires its genuine grant constructor.');
}

/** The original owning FILE preparation invokes this captured private grant core, never reflected public methods. */
export function grantOriginalPreparedCheckboxRoute(
  custodyOwner: object,
  grants: DocChannelGrants,
  db: Db,
  store: DocChannelStore,
  helper: OriginalCheckboxGrantPreparation,
  request: DocRouteGrantRequest,
  actor: DocGrantActor,
  token?: string
): DocGrantResult {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.originalPreparedGrantCalls.get(grants);
  if (!own || own.db !== db || own.store !== store)
    throw new Error('Foreign original FILE grant constructor.');
  enterOriginalCheckboxGrantOperation(helper, grants, request, actor);
  return own.grant(helper, request, actor, token);
}

/** Invoke only the original grant constructor's configuration closure. */
export function configureOriginalDocChannel(
  custodyOwner: object,
  grants: DocChannelGrants,
  documentId: string,
  declaration: CanvasChannelDeclaration,
  actor: DocGrantActor,
  openerAgentId?: string
): void {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.originalGrantMutations.get(grants);
  if (!own) throw new DocRouteGrantError('DOC_CHANNEL_UNAVAILABLE');
  own.configure(documentId, declaration, actor, openerAgentId);
}

/** Invoke only the original grant constructor's exact approval operation. */
export function approveOriginalDocRoute(
  custodyOwner: object,
  grants: DocChannelGrants,
  request: DocRouteGrantRequest,
  actor: DocGrantActor,
  token?: string
): DocGrantResult {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.originalGrantMutations.get(grants);
  if (!own) throw new DocRouteGrantError('DOC_CHANNEL_UNAVAILABLE');
  return own.grant(request, actor, token);
}

/** Invoke only the original grant constructor's revocation closure. */
export function revokeOriginalDocRoute(
  custodyOwner: object,
  grants: DocChannelGrants,
  documentId: string,
  grantId: string,
  actor: DocGrantActor
): void {
  const facet = readOriginalGrantCustody(custodyOwner);
  const own = facet.originalGrantMutations.get(grants);
  if (!own) throw new DocRouteGrantError('DOC_CHANNEL_UNAVAILABLE');
  own.revoke(documentId, grantId, actor);
}

/** Revalidate only the explicitly selected original route and its owning session transport. */
export function readOriginalReviewedDocReplayRoute(
  custodyOwner: object,
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  documentId: string,
  actor: DocGrantActor,
  tx: DbTransaction,
  grantId: string,
  observed?: DocOriginalWriteObservation,
  inputs?: readonly { type: string; payload: unknown }[],
  room?: CurrentRoomOperation,
  engine?: CurrentDocOperationEngineCore
) {
  const facet = readOriginalGrantCustody(custodyOwner);
  const binding = facet.currentGrantBindings.get(grants),
    read = facet.originalReviewedReplayRoutes.get(grants);
  if (!binding || binding.store !== store || !read)
    throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
  requireCurrentDocGrantEngine(custodyOwner, grants, store, binding.db);
  return read(documentId, actor, tx, grantId, observed, inputs, room, engine);
}
