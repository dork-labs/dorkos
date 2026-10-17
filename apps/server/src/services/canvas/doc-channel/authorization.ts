import { createCurrentDocOperationEngine } from './current/current-operation-engine.js';

import {
  requireNativePrincipalDatabase,
  type ConnectorRuntimePrincipalService,
} from '../../connectors/principal/runtime-principal-service.js';

/** Document authorization resolves private identity before disclosing channel data. */
import {
  agents,
  eq,
  sessionMetadata,
  canvasDocuments,
  canvasDocChannels,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import {
  isServerPrincipal,
  type ServerPrincipalProof,
  type ServerPrincipalClaims,
} from '../../connectors/principal/server-principal.js';
import { parseScope } from '../scopes.js';
import { type CanvasDocumentStore } from '../canvas-document-store.js';
import { type CanvasChannelEventReceipt } from '@dorkos/shared/canvas-channel-schemas';
import { requireDocChannelStoreDatabase, type DocChannelStore } from './store.js';
import { type DocChannelIngest, requireCurrentDocIngestEngine } from './ingest.js';

import { requireCurrentDocGrantEngine, type DocChannelGrants } from './grants.js';

import { captureCurrentDocConfiguration } from './current/current-operation-data.js';

import { type DocIngestAccess } from './ingest-types.js';
import {
  type CurrentOperationScope,
  type CurrentDocOperationEngineCore,
  type DocEventCondition,
  type DocReceiptInspection,
  type DocCurrentReplayResponse,
} from './current/current-operation-types.js';

const currentScopes = new WeakMap<DbTransaction, CurrentOperationScope>();
const currentAuthorizationBindings = new WeakMap<
  DocChannelAuthorization,
  {
    db: Db;
    engine: CurrentDocOperationEngineCore;
    selection: import('./current/current-operation-types.js').CurrentDocOperationEngineCore['selection'];
    submit: (
      store: DocChannelStore,
      ingest: DocChannelIngest,
      grants: DocChannelGrants,
      documentId: string,
      event: unknown,
      actor: DocChannelActor,
      condition: DocEventCondition
    ) => Promise<CanvasChannelEventReceipt>;
    inspect: (
      store: DocChannelStore,
      documentId: string,
      eventId: string,
      actor: DocChannelActor,
      condition: DocEventCondition
    ) => Promise<DocReceiptInspection>;
    documentReplay: CurrentDocOperationEngineCore['documentReplay'];
    documentInspect: CurrentDocOperationEngineCore['documentInspect'];
    documentSubmit: CurrentDocOperationEngineCore['documentSubmit'];
    captureDocument: CurrentDocOperationEngineCore['captureDocument'];
    requireDocument: CurrentDocOperationEngineCore['requireDocument'];
    replayExpired: CurrentDocOperationEngineCore['replayExpired'];
    management: CurrentDocOperationEngineCore['management'];
    replay: CurrentDocOperationEngineCore['replay'];
    presence: CurrentDocOperationEngineCore['presence'];
    final: (store: DocChannelStore, tx: DbTransaction) => void;
  }
>();

/** The same refusal for an absent document and one the caller cannot reach. */
export class DocChannelNotFoundError extends Error {
  readonly code = 'CANVAS_DOCUMENT_NOT_FOUND';
  readonly status = 404;
  /** Build a disclosure-safe document refusal. */
  constructor(options?: ErrorOptions) {
    super('The document is not available.', options);
  }
}
/** An authorized room remains readable while its writes are stopped. */
export class DocChannelArchivedError extends Error {
  readonly code = 'ROOM_ARCHIVED';
  readonly status = 409;
  /** Build the existing archived-room refusal. */
  constructor() {
    super('This room is archived');
  }
}
/** Server-resolved entry surface; nothing here is read from a page envelope. */
export interface DocChannelActor {
  surface: 'http' | 'capability';
  principal: ServerPrincipalProof;
}
/** Scope checks supplied by the existing owner and room authority services. */
export interface DocChannelAuthorityPorts {
  /** Original installation constructor scalar; never a principal or issuer. */
  readonly originalInstallationId?: string;
  readonly originalRoomRepoStore?: import('../../rooms/repo/room-repo-store.js').RoomRepoStore;
  readonly roomConstruction?: import('@dorkos/db/internal-server').ServerNativeRoomConstruction;
  readonly originalRoomStore?: import('../../rooms/room-store.js').RoomStore;
  readonly nativeRuntimePrincipals?: ConnectorRuntimePrincipalService;
  ownsInstallation(claims: ServerPrincipalClaims): boolean;
  /** Resolve the verified owner or agent to an author and require current membership. */
  roomMembership(roomId: string, claims: ServerPrincipalClaims): { archived: boolean } | undefined;
  /** Synchronous current principal check, including runtime binding revocation; required before every disclosure or mutation. */
  principalCurrent: (proof: ServerPrincipalProof) => boolean;
  /** Optional live runtime principal recheck, beyond synchronous stored binding checks. */
  revalidateRuntime?: (proof: ServerPrincipalProof) => Promise<boolean>;
}
/** No content, state, receipts or private tombstones are disclosed by this service. */
export class DocChannelAuthorization {
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
    if (
      !isServerPrincipal(actor.principal) ||
      typeof this.ports.principalCurrent !== 'function' ||
      !this.ports.principalCurrent(actor.principal) ||
      !this.ports.ownsInstallation(actor.principal.claims)
    )
      throw new DocChannelNotFoundError();
    let canonical: string;
    try {
      canonical = this.documents.lifecycle.resolveScope(scope);
    } catch {
      throw new DocChannelNotFoundError();
    }
    const parsed = parseScope(canonical);
    const claims = actor.principal.claims;
    if (parsed.kind === 'unknown') throw new DocChannelNotFoundError();
    const runtimeScope =
      claims.kind === 'runtime' ? this.currentRuntime(actor.principal, tx) : undefined;
    if (claims.kind === 'runtime' && !runtimeScope) throw new DocChannelNotFoundError();
    if (claims.kind === 'agent') {
      const executor = tx ?? this.db;
      const agent = executor.select().from(agents).where(eq(agents.id, claims.agentId)).get();
      if (!agent || agent.status !== 'active' || agent.projectPath !== claims.agentPath)
        throw new DocChannelNotFoundError();
    }
    if (parsed.kind === 'session') {
      if (
        claims.kind !== 'operator' &&
        (actor.surface !== 'capability' || runtimeScope !== canonical)
      )
        throw new DocChannelNotFoundError();
    } else {
      const membership = this.ports.roomMembership(parsed.id, claims);
      if (!membership) throw new DocChannelNotFoundError();
      if (write && membership.archived) throw new DocChannelArchivedError();
    }
    return canonical;
  }

  private checkCurrent(
    documentId: string,
    actor: DocChannelActor,
    write: boolean,
    tx: DbTransaction | undefined,
    ready: boolean
  ): { id: string; scope: string } {
    if (
      !isServerPrincipal(actor.principal) ||
      typeof this.ports.principalCurrent !== 'function' ||
      !this.ports.principalCurrent(actor.principal)
    )
      throw new DocChannelNotFoundError();
    const claims = actor.principal.claims;
    if (!this.ports.ownsInstallation(claims)) throw new DocChannelNotFoundError();
    const executor = tx ?? this.db;
    const identity = executor
      .select({ id: canvasDocuments.id, scope: canvasDocuments.scope })
      .from(canvasDocuments)
      .where(eq(canvasDocuments.id, documentId))
      .get();
    const channel = executor
      .select({ scope: canvasDocChannels.scope, closedAt: canvasDocChannels.closedAt })
      .from(canvasDocChannels)
      .where(eq(canvasDocChannels.documentId, documentId))
      .get();
    if (!identity || !channel || channel.closedAt !== null) throw new DocChannelNotFoundError();
    let scope: string;
    try {
      if (ready) this.documents.lifecycle.assertReady(documentId);
      scope = ready ? this.documents.lifecycle.resolveScope(identity.scope) : identity.scope;
    } catch (cause) {
      // Keep the reduction-only cause private so transient recovery cannot cancel accepted work.
      throw new DocChannelNotFoundError({ cause });
    }
    if (channel.scope !== scope) throw new DocChannelNotFoundError();
    const parsed = parseScope(scope);
    if (parsed.kind === 'unknown') throw new DocChannelNotFoundError();
    const runtimeScope =
      claims.kind === 'runtime' ? this.currentRuntime(actor.principal, tx) : undefined;
    if (claims.kind === 'runtime' && !runtimeScope) throw new DocChannelNotFoundError();
    if (claims.kind === 'agent') {
      const agent = executor.select().from(agents).where(eq(agents.id, claims.agentId)).get();
      if (!agent || agent.status !== 'active' || agent.projectPath !== claims.agentPath)
        throw new DocChannelNotFoundError();
    }
    if (parsed.kind === 'session') {
      if (claims.kind !== 'operator' && (actor.surface !== 'capability' || runtimeScope !== scope))
        throw new DocChannelNotFoundError();
    } else {
      const membership = this.ports.roomMembership(parsed.id, claims);
      if (!membership) throw new DocChannelNotFoundError();
      if (write && membership.archived) throw new DocChannelArchivedError();
    }
    return { id: identity.id, scope };
  }

  private currentRuntime(proof: ServerPrincipalProof, tx?: DbTransaction): string | undefined {
    const claims = proof.claims;
    if (claims.kind !== 'runtime') return undefined;
    let canonical: string;
    try {
      canonical = this.documents.lifecycle.resolveScope(`session:${claims.canonicalSessionId}`);
    } catch {
      return undefined;
    }
    const executor = tx ?? this.db;
    const session = executor
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, canonical.slice(8)))
      .get();
    const agent = executor.select().from(agents).where(eq(agents.id, claims.agentId)).get();
    if (
      session?.runtime !== claims.runtime ||
      session.agentPath !== claims.agentPath ||
      agent?.projectPath !== claims.agentPath ||
      agent.runtime !== claims.runtime ||
      agent.status !== 'active'
    )
      return undefined;
    return canonical;
  }
}

/** Submit through the original current-document authorization and ingress assembly. */
export function submitAuthorizedCurrentDocEvent(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  documentId: string,
  raw: unknown,
  actor: DocChannelActor,
  condition: DocEventCondition
): Promise<CanvasChannelEventReceipt> {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Current document operation requires genuine authorization.');
  return own.submit(store, ingest, grants, documentId, raw, actor, condition);
}
/** Qualified absence includes the full server-derived incarnation tuple and current retained receipt floor. */
export function inspectCurrentDocReceipt(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  documentId: string,
  eventId: string,
  actor: DocChannelActor,
  condition: DocEventCondition
): Promise<DocReceiptInspection> {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Current document operation requires genuine authorization.');
  return own.inspect(store, documentId, eventId, actor, condition);
}
/** Prepare the installed checkbox source under its captured authorization. */
export function prepareAuthorizedCheckboxSource(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  owner: object
): void {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Foreign checkbox document authority.');
  own.engine.prepareCheckbox(store, owner);
}
/** Complete the original checkbox source in the owning transaction. */
export function completeAuthorizedCheckboxSource(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  owner: object,
  tx: DbTransaction
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Foreign checkbox document authority.');
  return own.engine.completeCheckbox(store, grants, owner, tx);
}
/** Publish the original checkbox completion through its captured authorization. */
export function publishAuthorizedCheckboxSource(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  owner: object,
  tx: DbTransaction
): void {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Foreign checkbox document authority.');
  own.engine.publishCheckbox(store, owner, tx);
}
/** Abandon the original checkbox source in the owning transaction. */
export function abandonAuthorizedCheckboxSource(
  authorization: DocChannelAuthorization,
  owner: object,
  tx: DbTransaction
): void {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Foreign checkbox document authority.');
  own.engine.abandonCheckbox(owner, tx);
}
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
  decision: import('./ingest-types.js').DocRouteDecision
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
export function replayAuthorizedCurrentDoc(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  documentId: string,
  actor: DocChannelActor,
  since: number,
  limit: number
): Promise<DocCurrentReplayResponse> {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Current replay requires genuine authorization.');
  return own.replay(store, documentId, actor, since, limit);
}

/** Immutable HTTP/capability input data capture only; never issues a principal, engine, scope or permission. */
export function captureCurrentHttpDocActor(rawActor: DocChannelActor): DocChannelActor {
  const captured = captureCurrentDocConfiguration(rawActor);
  const actor = Object.freeze({ surface: captured.surface, principal: captured.principal });
  if (actor.surface !== 'http' && actor.surface !== 'capability')
    throw new DocChannelNotFoundError();
  return actor;
}

/** Genuine original maintenance closure: callers supply no actor, clock, engine or facade. */
export function maintainAuthorizedDocHistory(
  authorization: DocChannelAuthorization,
  store: DocChannelStore
): void {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Document maintenance requires genuine authorization.');
  requireDocChannelStoreDatabase(store, own.db);
  own.engine.maintainHistory(store);
}

/** Fixed timer data/wake port from the genuine engine; never exposes engine, DB or source. */
export function readAuthorizedRoomDueAt(
  authorization: DocChannelAuthorization
): string | undefined {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Room due read requires genuine authorization.');
  return own.engine.nextRoomDueAt();
}
/** Revisit original committed custody only; no actor or source DTO is accepted. */
export function wakeAuthorizedRoomDue(authorization: DocChannelAuthorization): void {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Room due wake requires genuine authorization.');
  own.engine.wakeRoomDue();
}

/** Resolve Relay identifiers through this authorization's original Room engine only. */
export function hintAuthorizedRoomRelay(
  authorization: DocChannelAuthorization,
  documentId: string,
  batchId: string,
  generation: string
): boolean {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Room Relay hint requires genuine authorization.');
  return own.engine.hintRoomRelay(documentId, batchId, generation);
}

/** Subscribe only through the original authorization's native Room operation owner. */
export function subscribeAuthorizedRoomRelay(
  authorization: DocChannelAuthorization,
  listener: (documentId: string, batchId: string, generation: string) => void
): () => void {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Room Relay subscription requires genuine authorization.');
  return own.engine.subscribeRoomRelay(listener);
}

/** Genuine private source routing only, never a caller-supplied source or principal. */
export function prepareAuthorizedRoomResponder(
  authorization: DocChannelAuthorization,
  runtime: object,
  holder: import('@dorkos/shared/agent-runtime').SseResponse,
  key: string
): Promise<import('./current/current-operation-types.js').PreparedRoomResponder | undefined> {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Room preparation requires genuine authorization.');
  return own.engine.prepareRoomResponder(runtime, holder, key);
}

/** Original constructor engine commits only its own genuine prepared native entry. */
export function commitAuthorizedRoomResponder(
  authorization: DocChannelAuthorization,
  runtime: object,
  prepared: import('./current/current-operation-types.js').PreparedRoomResponder
): import('./current/current-operation-types.js').OriginalCommittedRoomResponder {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Room commit requires genuine authorization.');
  return own.engine.commitRoomResponder(runtime, prepared);
}

/** Genuine owning document-only issuance and current read, including an empty dependency list. */
export function captureAuthorizedCurrentDocument(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  documentId: string,
  actor: DocChannelActor,
  grantIds: readonly string[]
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.captureDocument(store, grants, documentId, actor, grantIds);
}
/** Require currentness of the original captured document authority. */
export function requireAuthorizedCurrentDocument(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  authority: import('./current/current-operation-types.js').OriginalCurrentDocumentAuthority
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.requireDocument(store, grants, authority);
}

/** Replay through the original captured document authority. */
export function replayAuthorizedDocumentAuthority(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  authority: import('./current/current-operation-types.js').OriginalCurrentDocumentAuthority,
  since: number,
  limit: number
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.documentReplay(store, grants, authority, since, limit);
}
/** Inspect an event through the original captured document authority. */
export function inspectAuthorizedDocumentAuthority(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  authority: import('./current/current-operation-types.js').OriginalCurrentDocumentAuthority,
  eventId: string
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.documentInspect(store, grants, authority, eventId);
}
/** Submit an event through the original captured document authority. */
export function submitAuthorizedDocumentAuthority(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  authority: import('./current/current-operation-types.js').OriginalCurrentDocumentAuthority,
  raw: unknown
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.documentSubmit(store, ingest, grants, authority, raw);
}

/** Fixed original engine invocation; registry rows and timer hints never issue source custody. */
export function pumpAuthorizedRoomDue(
  authorization: DocChannelAuthorization,
  registry: import('../../core/runtime-registry.js').RuntimeRegistry
): Promise<void> {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Original Room authorization required.');
  return own.engine.pumpRoomDue(registry);
}

/** Stop the original authorization-owned Room pump. */
export function stopAuthorizedRoomPump(authorization: DocChannelAuthorization): Promise<void> {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Original Room authorization required.');
  return own.engine.stopRoomPump();
}

/** Read scenario evidence from the original Room operation engine. */
export function readAuthorizedRoomScenarioEvidence(
  authorization: DocChannelAuthorization,
  documentId: string,
  batchId: string,
  generation: string
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new Error('Original Room authorization required.');
  return own.engine.readRoomScenarioEvidence(documentId, batchId, generation);
}

/** Repeat only an actual original retained actor/document authority in the supplied same native transaction. */
export function requireAuthorizedDocumentInTransaction(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  authority: import('./current/current-operation-types.js').OriginalCurrentDocumentAuthority,
  tx: DbTransaction
): void {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  own.engine.requireDocumentInTransaction(store, grants, authority, tx);
}

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
export function restoreAuthorizedOriginalTokenScope(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  hash: string
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  requireCurrentDocConstructorEngines(authorization, store, undefined, grants);
  return own.engine.restoreTokenScope(store, grants, hash);
}
/** Replay the original native token scope with its required permission. */
export function replayAuthorizedOriginalTokenScope(
  authorization: DocChannelAuthorization,
  scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope,
  since: number,
  limit: number,
  permission: 'replay' | 'stream' = 'replay'
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenReplay(scope, since, limit, permission);
}
/** Read an authorized event from the original native token scope. */
export function readAuthorizedOriginalTokenEvent(
  authorization: DocChannelAuthorization,
  scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope,
  eventId: string,
  permission: 'replay' | 'stream'
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenEvent(scope, eventId, permission);
}

/** Open a stream owned by the original native token scope. */
export function openAuthorizedOriginalTokenStream(
  authorization: DocChannelAuthorization,
  scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope,
  since: number
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenOpenStream(scope, since);
}
/** Read the next frame of the original authorization-owned token stream. */
export function nextAuthorizedOriginalTokenStream(
  authorization: DocChannelAuthorization,
  stream: import('./current/current-operation-types.js').OriginalNativeDocTokenStream
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenStreamNext(stream);
}
/** Close the original authorization-owned token stream. */
export function closeAuthorizedOriginalTokenStream(
  authorization: DocChannelAuthorization,
  stream: import('./current/current-operation-types.js').OriginalNativeDocTokenStream
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenCloseStream(stream);
}

/** Read whether the original token stream has closed. */
export function closedAuthorizedOriginalTokenStream(
  authorization: DocChannelAuthorization,
  stream: import('./current/current-operation-types.js').OriginalNativeDocTokenStream
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenStreamClosed(stream);
}

/** Read the state of the original authorization-owned token stream. */
export function stateAuthorizedOriginalTokenStream(
  authorization: DocChannelAuthorization,
  stream: import('./current/current-operation-types.js').OriginalNativeDocTokenStream
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenStreamState(stream);
}

/** Drain token-owner DATA through the original operation engine. */
export function drainDataAuthorizedOriginalTokenOwner(authorization: DocChannelAuthorization) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenDrainData();
}

/** Revocation is original operator/source authority; a bearer never restores an actor. */
export function revokeAuthorizedOriginalDocToken(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  actor: DocChannelActor,
  documentId: string,
  tokenId: string
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  requireCurrentDocConstructorEngines(authorization, store, undefined, grants);
  return own.engine.revokeToken(store, grants, actor, documentId, tokenId);
}

/** Authenticate original opaque input scope before a standalone parser consumes any body. */
export function admitAuthorizedOriginalTokenIngress(
  authorization: DocChannelAuthorization,
  scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.tokenIngressCurrent(scope);
}
/** Submit bearer ingress through the original native token scope. */
export function submitAuthorizedOriginalTokenIngress(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope,
  raw: unknown
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  requireCurrentDocConstructorEngines(authorization, store, ingest, grants);
  return own.engine.submitToken(store, ingest, grants, scope, raw);
}

/** Original service constructor establishes the single retained token recovery dependency tuple. */
export function bindAuthorizedOriginalTokenService(
  authorization: DocChannelAuthorization,
  service: import('./service.js').DocChannelService,
  store: DocChannelStore,
  grants: DocChannelGrants
): void {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  own.engine.bindTokenService(service, store, grants);
}

/** Inspect the original token ingress receipt by event identity. */
export function inspectAuthorizedOriginalTokenInputReceipt(
  authorization: DocChannelAuthorization,
  scope: import('./current/current-operation-types.js').OriginalNativeDocTokenScope,
  eventId: string
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.inspectTokenInputReceipt(scope, eventId);
}

/** Revalidate through the original authorization engine rather than reflected public methods. */
export function requireOriginalCurrentDocAccess(
  authorization: DocChannelAuthorization,
  documentId: string,
  actor: DocChannelActor,
  write = false,
  tx?: DbTransaction
): { id: string; scope: string } {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.requireCurrentAccess(documentId, actor, write, tx);
}

/** Original constructor-owned operator management projection; no caller reader or authority callback. */
export function readAuthorizedDocManagement(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  documentId: string,
  actor: DocChannelActor
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.management(store, documentId, actor);
}

/** Accept a host selection only through this original authorization's private engine. */
export function askAuthorizedOriginalDocSelection(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  raw: unknown,
  actor: DocChannelActor
): Promise<CanvasChannelEventReceipt> {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.selection(store, ingest, grants, raw, actor);
}

/** Enter the exact original operator replay engine, never the reflected legacy batch helper. */
export function replayAuthorizedOriginalExpiredDocBatch(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  raw: unknown,
  actor: DocChannelActor
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.replayExpired(store, ingest, grants, raw, actor);
}

/** Original installed file owner invokes preparation with its actual retained HTTP actor. */
export function prepareAuthorizedOriginalDocumentSave(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  grants: DocChannelGrants,
  scope: object,
  actor: DocChannelActor
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.prepareDocumentSave(store, grants, scope, actor);
}
/** Only the genuine private file-save scope can complete this reserved host event. */
export function completeAuthorizedOriginalDocumentSave(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  scope: object,
  actor: DocChannelActor
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.engine.completeDocumentSave(store, ingest, grants, scope, actor);
}

/** Authenticated host presence follows only the constructor-retained original engine. */
export function updateAuthorizedOriginalDocPresence(
  authorization: DocChannelAuthorization,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  documentId: string,
  actor: DocChannelActor,
  raw: unknown
) {
  const own = currentAuthorizationBindings.get(authorization);
  if (!own) throw new DocChannelNotFoundError();
  return own.presence(store, ingest, grants, documentId, actor, raw);
}
