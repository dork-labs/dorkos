import {
  checkOriginalAuthorizationCurrent,
  requireOriginalAuthorizationScope,
  readOriginalAuthorizationRuntime,
  type OriginalAuthorizationCurrentPolicy,
} from './authorization/authorization-current-policy.js';
import {
  createOriginalAuthorizationPublicOperations,
  type OriginalAuthorizationPublicOperations,
} from './authorization/authorization-public-operations.js';
import {
  DocChannelNotFoundError,
  type DocChannelActor,
  type DocChannelAuthorityPorts,
  type OriginalAuthorizationOperationBinding,
} from './authorization/authorization-data.js';
import { createCurrentDocOperationEngine } from './current/current-operation-engine.js';

import { requireNativePrincipalDatabase } from '../../connectors/principal/runtime-principal-service.js';

/** Document authorization resolves private identity before disclosing channel data. */
import { eq, canvasDocuments, type Db, type DbTransaction } from '@dorkos/db';
import {
  isServerPrincipal,
  type ServerPrincipalProof,
} from '../../connectors/principal/server-principal.js';
import { type CanvasDocumentStore } from '../canvas-document-store.js';

import { requireDocChannelStoreDatabase, type DocChannelStore } from './store.js';
import { type DocChannelIngest, requireCurrentDocIngestEngine } from './ingest.js';

import { requireCurrentDocGrantEngine, type DocChannelGrants } from './grants.js';

import { captureCurrentDocConfiguration } from './current/current-operation-data.js';

import { type DocIngestAccess } from './ingest-data/ingest-types.js';
import {
  type CurrentOperationScope,
  type CurrentDocOperationEngineCore,
} from './current/current-operation-types.js';

const originalAuthorizationCurrentPolicies = new WeakMap<
  object,
  OriginalAuthorizationCurrentPolicy
>();
const originalCurrentPolicyGet = WeakMap.prototype.get;
const originalCurrentPolicySet = WeakMap.prototype.set;
const originalCurrentPolicyApply = Reflect.apply;
/** Refuse every key except the original constructor-private current policy key before effects. */
export function readOriginalAuthorizationCurrentPolicy(
  owner: object
): OriginalAuthorizationCurrentPolicy {
  const view = originalCurrentPolicyApply(
    originalCurrentPolicyGet,
    originalAuthorizationCurrentPolicies,
    [owner]
  ) as OriginalAuthorizationCurrentPolicy | undefined;
  if (!view) throw new DocChannelNotFoundError();
  return view;
}

const currentScopes = new WeakMap<DbTransaction, CurrentOperationScope>();
const currentAuthorizationBindings = new WeakMap<
  DocChannelAuthorization,
  OriginalAuthorizationOperationBinding
>();
const originalAuthorizationOperationKeys = new WeakMap<DocChannelAuthorization, object>();
const originalAuthorizationOperationBindings = new WeakMap<
  object,
  { authorization: DocChannelAuthorization; binding: OriginalAuthorizationOperationBinding }
>();
const originalAuthorizationApply = Reflect.apply;
const originalAuthorizationGet = WeakMap.prototype.get;
const originalAuthorizationSet = WeakMap.prototype.set;
/** Return original captured ports only for an inaccessible constructor key and its exact authorization. */
export function readOriginalAuthorizationOperationBinding(
  ownerKey: object | undefined,
  authorization: DocChannelAuthorization
): OriginalAuthorizationOperationBinding | undefined {
  const own =
    ownerKey === undefined
      ? undefined
      : originalAuthorizationApply(
          originalAuthorizationGet,
          originalAuthorizationOperationBindings,
          [ownerKey]
        );
  return own?.authorization === authorization ? own.binding : undefined;
}

export {
  DocChannelNotFoundError,
  DocChannelArchivedError,
  type DocChannelActor,
  type DocChannelAuthorityPorts,
} from './authorization/authorization-data.js';
const originalDocPrivateConstructionFreeze = Object.freeze;

/** No content, state, receipts or private tombstones are disclosed by this service. */
export class DocChannelAuthorization {
  readonly #currentPolicyKey = originalDocPrivateConstructionFreeze({});
  /** Use the same DB and document store the lifecycle writes through. */
  constructor(
    private readonly db: Db,
    private readonly documents: CanvasDocumentStore,
    private readonly ports: DocChannelAuthorityPorts
  ) {
    if (db.$client.inTransaction)
      throw new Error('Current authorization construction requires an inactive database.');
    const captured = captureCurrentDocConfiguration(ports);
    if (captured.nativeRuntimePrincipals)
      requireNativePrincipalDatabase(captured.nativeRuntimePrincipals, db);
    const createOriginalView = (
      owner: DocChannelAuthorization
    ): Readonly<OriginalAuthorizationCurrentPolicy> =>
      originalDocPrivateConstructionFreeze<OriginalAuthorizationCurrentPolicy>({
        get db() {
          return owner.db;
        },
        get documents() {
          return owner.documents;
        },
        get ports() {
          return owner.ports;
        },
        get currentRuntime() {
          const operation = owner.currentRuntime;
          return (proof: ServerPrincipalProof, tx?: DbTransaction): string | undefined =>
            originalCurrentPolicyApply(operation, owner, [proof, tx]);
        },
      });
    originalCurrentPolicyApply(originalCurrentPolicySet, originalAuthorizationCurrentPolicies, [
      this.#currentPolicyKey,
      createOriginalView(this),
    ]);
    const engine = createCurrentDocOperationEngine(this, db, documents, captured, currentScopes);
    currentAuthorizationBindings.set(this, {
      db,
      engine,
      selection: engine.selection,
      submit: engine.submit,
      inspect: engine.inspect,
      documentReplay: engine.documentReplay,
      documentInspect: engine.documentInspect,
      documentSubmit: engine.documentSubmit,
      captureDocument: engine.captureDocument,
      requireDocument: engine.requireDocument,
      replayExpired: engine.replayExpired,
      management: engine.management,
      replay: engine.replay,
      presence: engine.presence,
      final: engine.final,
    });
    const operationKey = {};
    originalAuthorizationApply(originalAuthorizationSet, originalAuthorizationOperationKeys, [
      this,
      operationKey,
    ]);
    originalAuthorizationApply(originalAuthorizationSet, originalAuthorizationOperationBindings, [
      operationKey,
      { authorization: this, binding: currentAuthorizationBindings.get(this)! },
    ]);
  }

  /** Revalidate asynchronous authority, then repeat all synchronous checks before disclosure. */
  async require(
    documentId: string,
    actor: DocChannelActor,
    write = false
  ): Promise<{ id: string; scope: string }> {
    this.requireCurrent(documentId, actor, write);
    if (
      actor.principal.claims.kind === 'runtime' &&
      this.ports.revalidateRuntime &&
      !(await this.ports.revalidateRuntime(actor.principal))
    )
      throw new DocChannelNotFoundError();
    return this.requireCurrent(documentId, actor, write);
  }

  /** Final synchronous gate for ingestion/dispatch inside the caller's SQLite transaction. */
  requireCurrent(
    documentId: string,
    actor: DocChannelActor,
    write = false,
    tx?: DbTransaction
  ): { id: string; scope: string } {
    return this.checkCurrent(documentId, actor, write, tx, true);
  }

  /** Operator-only recovery health access; no retained state or receipts are returned. */
  requireHealth(documentId: string, actor: DocChannelActor): { id: string; scope: string } {
    if (!isServerPrincipal(actor.principal) || actor.principal.claims.kind !== 'operator')
      throw new DocChannelNotFoundError();
    return this.checkCurrent(documentId, actor, false, undefined, false);
  }

  /** Authorize an existing stream scope before enumerating private document identities. */
  requireScopeCurrent(
    scope: string,
    actor: DocChannelActor,
    write = false,
    tx?: DbTransaction
  ): string {
    return requireOriginalAuthorizationScope(this.#currentPolicyKey, scope, actor, write, tx);
  }

  private checkCurrent(
    documentId: string,
    actor: DocChannelActor,
    write: boolean,
    tx: DbTransaction | undefined,
    ready: boolean
  ): { id: string; scope: string } {
    return checkOriginalAuthorizationCurrent(
      this.#currentPolicyKey,
      documentId,
      actor,
      write,
      tx,
      ready
    );
  }

  private currentRuntime(proof: ServerPrincipalProof, tx?: DbTransaction): string | undefined {
    return readOriginalAuthorizationRuntime(this.#currentPolicyKey, proof, tx);
  }
}

const originalAuthorizationPublicOperations = createOriginalAuthorizationPublicOperations(
  (authorization) =>
    originalAuthorizationApply(originalAuthorizationGet, originalAuthorizationOperationKeys, [
      authorization,
    ])
);

/** Submit through the original current-document authorization and ingress assembly. */
export const submitAuthorizedCurrentDocEvent =
  originalAuthorizationPublicOperations.submitAuthorizedCurrentDocEvent;
/** Qualified absence includes the full server-derived incarnation tuple and current retained receipt floor. */
export const inspectCurrentDocReceipt =
  originalAuthorizationPublicOperations.inspectCurrentDocReceipt;
/** Prepare the installed checkbox source under its captured authorization. */
export const prepareAuthorizedCheckboxSource =
  originalAuthorizationPublicOperations.prepareAuthorizedCheckboxSource;
/** Complete the original checkbox source in the owning transaction. */
export const completeAuthorizedCheckboxSource: OriginalAuthorizationPublicOperations['completeAuthorizedCheckboxSource'] =
  originalAuthorizationPublicOperations.completeAuthorizedCheckboxSource;
/** Publish the original checkbox completion through its captured authorization. */
export const publishAuthorizedCheckboxSource: OriginalAuthorizationPublicOperations['publishAuthorizedCheckboxSource'] =
  originalAuthorizationPublicOperations.publishAuthorizedCheckboxSource;
/** Abandon the original checkbox source in the owning transaction. */
export const abandonAuthorizedCheckboxSource: OriginalAuthorizationPublicOperations['abandonAuthorizedCheckboxSource'] =
  originalAuthorizationPublicOperations.abandonAuthorizedCheckboxSource;
/** Fixed final check used only by the original internal ingestor immediately before mutation. */
export function requireCurrentDocConstructorEngines(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  ingest?: DocChannelIngest,
  grants?: DocChannelGrants
): void {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own || own.db.$client.inTransaction)
    throw new Error('Current document constructor requires genuine inactive authorization.');
  requireDocChannelStoreDatabase(store, own.db);
  if (ingest) requireCurrentDocIngestEngine(ingest, store);
  if (grants) requireCurrentDocGrantEngine(grants, store, own.db);
}

/** Refuse an implementation not captured by this exact genuine constructor; reveals no DB or mutable registry. */
export function requireCurrentDocEngineOrigin(
  authorization: DocChannelAuthorization,
  engine: CurrentDocOperationEngineCore,
  db: Db
): void {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own || own.engine !== engine || own.db !== db)
    throw new Error('Current document engine has a foreign constructor origin.');
}

/** Read the ingress input retained by the exact current-document transaction. */
export function readCurrentDocIngressInput(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  tx: DbTransaction
) {
  const scope = currentScopes.get(tx);
  const own = scope ? { db: scope.db } : undefined;
  if (
    !scope ||
    !own ||
    scope.authorization !== authorization ||
    scope.store !== store ||
    !scope.event ||
    !own.db.$client.inTransaction
  )
    throw new Error('Current document input requires its genuine active scope.');
  requireCurrentDocEngineOrigin(authorization, scope!.engine, own.db);
  requireDocChannelStoreDatabase(store, own.db);
  const physical = tx
    .select({ title: canvasDocuments.title })
    .from(canvasDocuments)
    .where(eq(canvasDocuments.id, scope.documentId))
    .get();
  if (!physical) throw new DocChannelNotFoundError();
  return Object.freeze({
    documentId: scope.documentId,
    scope: scope.scope,
    documentLabel: physical.title,
    actor: scope.actor,
    tokenScope: scope.tokenScope,
    tokenGrantPreparation: scope.tokenGrantPreparation,
    tokenGrantIds: scope.tokenGrantIds,
    tokenManifestHash: scope.tokenManifestHash,
    originalWriteObservation: scope.originalWriteObservation,
    event: scope.event,
    access: scope.access,
    now: scope.now,
  });
}
/** Fixed constructor-owned entry; neither arbitrary work nor a caller checker is accepted. */
export function assertCurrentDocOperation(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  tx: DbTransaction
): void {
  const scope = currentScopes.get(tx);
  if (!scope || scope.authorization !== authorization)
    throw new Error('Current document operation requires genuine authorization.');
  requireCurrentDocEngineOrigin(authorization, scope.engine, scope.db);
  scope.engine.final(store, tx);
}

/** Checks only exact private entry engine identities; cannot register, mint or return a connection. */
export function requireCurrentDocEngines(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  tx: DbTransaction,
  ingest?: DocChannelIngest,
  grants?: DocChannelGrants
): void {
  const scope = currentScopes.get(tx);
  const own = scope ? { db: scope.db } : undefined;
  if (
    !scope ||
    !own ||
    scope.authorization !== authorization ||
    scope.store !== store ||
    !own.db.$client.inTransaction ||
    (ingest !== undefined && scope.ingest !== ingest) ||
    (grants !== undefined && scope.grants !== grants)
  )
    throw new Error('Current operation engine is foreign or retired.');
  requireCurrentDocEngineOrigin(authorization, scope!.engine, own.db);
  requireDocChannelStoreDatabase(store, own.db);
  if (scope.failure) throw scope.failure.cause;
}

/** Fixed DATA count from this exact engine's sealed Room intention; no caller count is accepted. */
export function readCurrentDocPendingRoomWriteCount(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  tx: DbTransaction
): number {
  requireCurrentDocEngines(authorization, store, tx);
  return currentScopes.get(tx)!.engine.roomPendingWrites(tx);
}

/** Read FILE observation DATA retained by this exact original replay scope; never accepts caller observation. */
export function readCurrentDocReplayWriteObservation(
  store: DocChannelStore,
  tx: DbTransaction,
  documentId: string,
  engine: CurrentDocOperationEngineCore
): import('./grant-policy.js').DocOriginalWriteObservation | undefined {
  const scope = currentScopes.get(tx);
  if (!scope || scope.store !== store || scope.documentId !== documentId || scope.engine !== engine)
    throw new Error('Replay observation requires its genuine current scope.');
  requireCurrentDocEngines(scope.authorization, store, tx);
  return scope.originalWriteObservation;
}

/** Readonly genuine-scope predicate used by the coalescer's PRIVATE creation capture. */
export function isCurrentDocQueueScope(
  store: DocChannelStore,
  tx: DbTransaction,
  event: import('./store.js').DocEventRow,
  access: DocIngestAccess,
  decision: import('./ingest-data/ingest-types.js').DocRouteDecision
): boolean {
  const scope = currentScopes.get(tx);
  if (
    !scope ||
    scope.store !== store ||
    !scope.event ||
    !scope.access ||
    scope.documentId !== event.documentId ||
    scope.event.id !== event.eventId ||
    scope.event.type !== event.type ||
    scope.access !== access ||
    event.direction !== 'upstream'
  )
    return false;
  const own = { db: scope.db };
  requireCurrentDocEngineOrigin(scope.authorization, scope.engine, scope.db);
  if (!own || !own.db.$client.inTransaction) return false;
  return scope.access.routes.some((route) => route === decision);
}

/** Read only an already-issued current store scope; this cannot register or extend one. */
export function readCurrentDocStoreOperation(
  store: DocChannelStore,
  tx: DbTransaction
): Readonly<{ documentId: string; eventId?: string }> | undefined {
  const scope = currentScopes.get(tx);
  if (!scope) return undefined;
  requireCurrentDocEngines(scope.authorization, store, tx);
  if (scope.failure) throw scope.failure.cause;
  return Object.freeze({ documentId: scope.documentId, eventId: scope.event?.id });
}
/** Reduction-only first-failure latch. Caught failures never restore a usable scope. */
export function failCurrentDocOperation(
  store: DocChannelStore,
  tx: DbTransaction,
  cause: unknown
): never {
  const scope = currentScopes.get(tx);
  if (scope && scope.store === store && !scope.failure) scope.failure = { cause };
  throw scope?.failure ? scope.failure.cause : cause;
}

/** Constructor-only attestation, with no getter, registrar, checker or returned connection. */

/** Initial replay captures server birth through the original constructor-owned private engine. */
export const replayAuthorizedCurrentDoc =
  originalAuthorizationPublicOperations.replayAuthorizedCurrentDoc;
/** Immutable HTTP/capability input data capture only; never issues a principal, engine, scope or permission. */
export function captureCurrentHttpDocActor(rawActor: DocChannelActor): DocChannelActor {
  const captured = captureCurrentDocConfiguration(rawActor);
  const actor = Object.freeze({ surface: captured.surface, principal: captured.principal });
  if (actor.surface !== 'http' && actor.surface !== 'capability')
    throw new DocChannelNotFoundError();
  return actor;
}

/** Genuine original maintenance closure: callers supply no actor, clock, engine or facade. */
export const maintainAuthorizedDocHistory =
  originalAuthorizationPublicOperations.maintainAuthorizedDocHistory;
/** Fixed timer data/wake port from the genuine engine; never exposes engine, DB or source. */
export const readAuthorizedRoomDueAt =
  originalAuthorizationPublicOperations.readAuthorizedRoomDueAt;
/** Revisit original committed custody only; no actor or source DTO is accepted. */
export const wakeAuthorizedRoomDue = originalAuthorizationPublicOperations.wakeAuthorizedRoomDue;
/** Resolve Relay identifiers through this authorization's original Room engine only. */
export const hintAuthorizedRoomRelay =
  originalAuthorizationPublicOperations.hintAuthorizedRoomRelay;
/** Subscribe only through the original authorization's native Room operation owner. */
export const subscribeAuthorizedRoomRelay =
  originalAuthorizationPublicOperations.subscribeAuthorizedRoomRelay;
/** Genuine private source routing only, never a caller-supplied source or principal. */
export const prepareAuthorizedRoomResponder =
  originalAuthorizationPublicOperations.prepareAuthorizedRoomResponder;
/** Original constructor engine commits only its own genuine prepared native entry. */
export const commitAuthorizedRoomResponder =
  originalAuthorizationPublicOperations.commitAuthorizedRoomResponder;
/** Genuine owning document-only issuance and current read, including an empty dependency list. */
export const captureAuthorizedCurrentDocument =
  originalAuthorizationPublicOperations.captureAuthorizedCurrentDocument;
/** Require currentness of the original captured document authority. */
export const requireAuthorizedCurrentDocument =
  originalAuthorizationPublicOperations.requireAuthorizedCurrentDocument;
/** Replay through the original captured document authority. */
export const replayAuthorizedDocumentAuthority =
  originalAuthorizationPublicOperations.replayAuthorizedDocumentAuthority;
/** Inspect an event through the original captured document authority. */
export const inspectAuthorizedDocumentAuthority =
  originalAuthorizationPublicOperations.inspectAuthorizedDocumentAuthority;
/** Submit an event through the original captured document authority. */
export const submitAuthorizedDocumentAuthority =
  originalAuthorizationPublicOperations.submitAuthorizedDocumentAuthority;
/** Fixed original engine invocation; registry rows and timer hints never issue source custody. */
export const pumpAuthorizedRoomDue = originalAuthorizationPublicOperations.pumpAuthorizedRoomDue;
/** Stop the original authorization-owned Room pump. */
export const stopAuthorizedRoomPump = originalAuthorizationPublicOperations.stopAuthorizedRoomPump;
/** Read scenario evidence from the original Room operation engine. */
export const readAuthorizedRoomScenarioEvidence =
  originalAuthorizationPublicOperations.readAuthorizedRoomScenarioEvidence;
/** Repeat only an actual original retained actor/document authority in the supplied same native transaction. */
export const requireAuthorizedDocumentInTransaction: OriginalAuthorizationPublicOperations['requireAuthorizedDocumentInTransaction'] =
  originalAuthorizationPublicOperations.requireAuthorizedDocumentInTransaction;
/** Fixed original engine issuance; no caller store/stage/transaction is accepted. */
export async function issueAuthorizedOriginalDocToken(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  actor: DocChannelActor,
  request: unknown,
  approvedGrantIds: readonly string[]
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  requireCurrentDocConstructorEngines(authorization, store, undefined, grants);
  const prepared = await own.engine.prepareTokenIssuance(
    store,
    grants,
    actor,
    request,
    approvedGrantIds
  );
  await own.engine.commitTokenIssuance(prepared.stage);
  // Recoverable secret is disclosed only after native insert, final source gate and commit.
  const { tokenHash: _hash, revokedAt: _revoked, ...response } = prepared.record;
  return Object.freeze({ ...response, token: prepared.token });
}

/** Fixed original constructor ingress for persistent native scopes; no actor input. */
export const restoreAuthorizedOriginalTokenScope =
  originalAuthorizationPublicOperations.restoreAuthorizedOriginalTokenScope;
/** Replay the original native token scope with its required permission. */
export const replayAuthorizedOriginalTokenScope =
  originalAuthorizationPublicOperations.replayAuthorizedOriginalTokenScope;
/** Read an authorized event from the original native token scope. */
export const readAuthorizedOriginalTokenEvent =
  originalAuthorizationPublicOperations.readAuthorizedOriginalTokenEvent;
/** Open a stream owned by the original native token scope. */
export const openAuthorizedOriginalTokenStream =
  originalAuthorizationPublicOperations.openAuthorizedOriginalTokenStream;
/** Read the next frame of the original authorization-owned token stream. */
export const nextAuthorizedOriginalTokenStream =
  originalAuthorizationPublicOperations.nextAuthorizedOriginalTokenStream;
/** Close the original authorization-owned token stream. */
export const closeAuthorizedOriginalTokenStream =
  originalAuthorizationPublicOperations.closeAuthorizedOriginalTokenStream;
/** Read whether the original token stream has closed. */
export const closedAuthorizedOriginalTokenStream =
  originalAuthorizationPublicOperations.closedAuthorizedOriginalTokenStream;
/** Read the state of the original authorization-owned token stream. */
export const stateAuthorizedOriginalTokenStream =
  originalAuthorizationPublicOperations.stateAuthorizedOriginalTokenStream;
/** Drain token-owner DATA through the original operation engine. */
export const drainDataAuthorizedOriginalTokenOwner =
  originalAuthorizationPublicOperations.drainDataAuthorizedOriginalTokenOwner;
/** Revocation is original operator/source authority; a bearer never restores an actor. */
export const revokeAuthorizedOriginalDocToken =
  originalAuthorizationPublicOperations.revokeAuthorizedOriginalDocToken;
/** Authenticate original opaque input scope before a standalone parser consumes any body. */
export const admitAuthorizedOriginalTokenIngress =
  originalAuthorizationPublicOperations.admitAuthorizedOriginalTokenIngress;
/** Submit bearer ingress through the original native token scope. */
export const submitAuthorizedOriginalTokenIngress =
  originalAuthorizationPublicOperations.submitAuthorizedOriginalTokenIngress;
/** Original service constructor establishes the single retained token recovery dependency tuple. */
export const bindAuthorizedOriginalTokenService =
  originalAuthorizationPublicOperations.bindAuthorizedOriginalTokenService;
/** Inspect the original token ingress receipt by event identity. */
export const inspectAuthorizedOriginalTokenInputReceipt =
  originalAuthorizationPublicOperations.inspectAuthorizedOriginalTokenInputReceipt;
/** Revalidate through the original authorization engine rather than reflected public methods. */
export const requireOriginalCurrentDocAccess: OriginalAuthorizationPublicOperations['requireOriginalCurrentDocAccess'] =
  originalAuthorizationPublicOperations.requireOriginalCurrentDocAccess;
/** Original constructor-owned operator management projection; no caller reader or authority callback. */
export const readAuthorizedDocManagement =
  originalAuthorizationPublicOperations.readAuthorizedDocManagement;
/** Accept a host selection only through this original authorization's private engine. */
export const askAuthorizedOriginalDocSelection =
  originalAuthorizationPublicOperations.askAuthorizedOriginalDocSelection;
/** Enter the exact original operator replay engine, never the reflected legacy batch helper. */
export const replayAuthorizedOriginalExpiredDocBatch =
  originalAuthorizationPublicOperations.replayAuthorizedOriginalExpiredDocBatch;
/** Original installed file owner invokes preparation with its actual retained HTTP actor. */
export const prepareAuthorizedOriginalDocumentSave =
  originalAuthorizationPublicOperations.prepareAuthorizedOriginalDocumentSave;
/** Only the genuine private file-save scope can complete this reserved host event. */
export const completeAuthorizedOriginalDocumentSave =
  originalAuthorizationPublicOperations.completeAuthorizedOriginalDocumentSave;
/** Authenticated host presence follows only the constructor-retained original engine. */
export const updateAuthorizedOriginalDocPresence =
  originalAuthorizationPublicOperations.updateAuthorizedOriginalDocPresence;
