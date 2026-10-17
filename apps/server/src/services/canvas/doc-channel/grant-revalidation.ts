import { readOriginalDocumentRelayAvailability } from './delivery/relay-authority.js';
import {
  readOriginalRoomReplayAvailability,
  type CurrentRoomOperation,
} from './operations/room-current-operation.js';
import type { CurrentDocOperationEngineCore } from './current/current-operation-types.js';
// Keep the original grant subclass beside its base: FILE/HTTP/native imports
// may reenter the grant module before a separately imported base is initialized.
import { isServerPrincipal } from '../../connectors/principal/server-principal.js';
import {
  enterOriginalCheckboxGrantOperation,
  requireOriginalCheckboxGrantTransaction,
  readOriginalCheckboxGrantManifest,
  type OriginalCheckboxGrantPreparation,
} from './writes/checkbox-grant-preparation.js';
import { ulid } from 'ulidx';
import { APPROVAL_DETAIL_MAX_LENGTH } from '@dorkos/shared/approval-schemas';
import {
  CanvasChannelDeclarationSchema,
  type CanvasChannelDeclaration,
} from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../core/approvals/approval-input-hash.js';
import type {
  ApprovalService,
  ApprovalTicket,
  ApprovalConsumptionSettlement,
} from '../../core/approvals/approval-service.js';
import {
  grantTypes,
  validateDocGrantTarget,
  DocRouteGrantRequestSchema,
  type DocGrantAuthority,
  type DocRouteGrantRequest,
} from './grant-policy.js';

import { readCurrentGrantSourceRows } from './current/current-operation-row-audit.js';
import { selectOriginalRoomGrantSource } from './current/current-operation-intentions.js';
/** Current route admission checks, separated from grant creation and approval consumption. */
import {
  and,
  eq,
  isNull,
  canvasDocChannels,
  approvals,
  canvasDocGrants,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import {
  CanvasChannelGrantSchema,
  matchesCanvasChannelEvent,
  type CanvasChannelRoute,
} from '@dorkos/shared/canvas-channel-schemas';
import { redactSecretsInText } from '../../core/approvals/approval-summary.js';
import {
  DocChannelStore,
  type DocGrantRow,
  type DocBatchRow,
  requireDocChannelStoreDatabase,
  requireOriginalDocGrantStore,
  requireOriginalDocumentRelayStore,
} from './store.js';
import { CompiledCanvasAppManifest } from '@dorkos/shared/canvas-app-manifest';
const originalTokenPayloadValidate = CompiledCanvasAppManifest.prototype.validate;
import {
  createOriginalDocAppManifestReader,
  readDocAppManifest,
  type DocAppManifest,
} from './app-manifest.js';
import {
  DocRouteGrantError,
  declaredRoute,
  type DocGrantActor,
  type DocGrantTarget,
  type DocOriginalWriteObservation,
} from './grant-policy.js';
import { documentTransaction } from './storage/store-transaction.js';
import { readOriginalCheckboxCompletionStage } from './writes/completion.js';
import {
  grantCoreNow,
  grantCoreAccess,
  grantCoreManifest,
  grantCoreVerifyCurrentGrant,
  grantCoreValidateEventPayload,
  grantCoreRevalidateGrant,
  grantCoreGetEffectiveLimits,
  grantCoreGetCurrentRoutes,
} from './grant-current-core.js';
import {
  DocChannelNotFoundError,
  readCurrentDocIngressInput,
  readCurrentDocReplayWriteObservation,
  type DocChannelAuthorization,
} from './authorization.js';

import {
  captureCurrentDocConfiguration,
  copyCurrentDocData,
  sameCurrentDocData,
} from './current/current-operation-data.js';
import { readChecked } from './storage/store-json.js';
import {
  withCheckboxReadOnlyGate,
  checkboxAuthorityClock,
  captureCheckboxGrantContext,
} from './writes/authority-snapshot.js';

import type {
  CurrentGrantConstructorBinding,
  CurrentGrantSourceClaims,
  DocGrantedRoute,
  DocGrantCurrentServices,
} from './current/current-operation-types.js';
export type { DocGrantedRoute } from './current/current-operation-types.js';
export interface OriginalCurrentDocumentGrantDependencies {
  manifestHash: string | null;
  originalRows: {
    grants: DocGrantRow[];
    approvals: (typeof approvals.$inferSelect)[];
    channel: Omit<
      import('./store.js').DocChannelRow,
      'nextDocSeq' | 'updatedAt' | 'receiptRetentionFloor'
    >;
  };
  grants: DocGrantRow[];
  approvals: (typeof approvals.$inferSelect)[];
}
const originalGrantInsertions = new WeakMap<
  DbTransaction,
  {
    grants: DocChannelGrants;
    store: DocChannelStore;
    documentId: string;
    actor: DocGrantActor;
    grant: DocGrantRow;
    approval: typeof approvals.$inferSelect | null;
  }
>();
/** Compare only the exact constructor-owned insertion against the prior source snapshot.
 * All other grant/approval rows remain in the complete original census. */
export function documentDependenciesBeforeOriginalGrantInsertion(
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  documentId: string,
  actor: DocGrantActor,
  grantIds: readonly string[],
  tx: DbTransaction,
  dependencies: OriginalCurrentDocumentGrantDependencies
): OriginalCurrentDocumentGrantDependencies {
  const own = originalGrantInsertions.get(tx);
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
const originalReviewedReplayRoutes = new WeakMap<
  DocChannelGrantRevalidation,
  (
    documentId: string,
    actor: DocGrantActor,
    tx: DbTransaction,
    grantId: string,
    observed?: DocOriginalWriteObservation,
    inputs?: readonly { type: string; payload: unknown }[],
    room?: CurrentRoomOperation,
    engine?: CurrentDocOperationEngineCore
  ) => { grant: DocGrantRow; route: CanvasChannelRoute }
>();
const originalReplayRouting = new WeakMap<
  DocChannelGrantRevalidation,
  (
    documentId: string,
    actor: DocGrantActor,
    tx: DbTransaction,
    room?: CurrentRoomOperation,
    engine?: CurrentDocOperationEngineCore,
    observed?: DocOriginalWriteObservation
  ) => import('@dorkos/shared/canvas-channel-schemas').CanvasChannelRouting
>();
const currentGrantBindings = new WeakMap<
  DocChannelGrantRevalidation,
  CurrentGrantConstructorBinding
>();
type OriginalTokenWriteObservation =
  DocOriginalWriteObservation | Readonly<{ manifestHash: string | null; write: null }>;
const originalTokenGrantPreparations = new WeakMap<
  import('./current/current-operation-types.js').OriginalDocTokenGrantPreparation,
  {
    owner: DocChannelGrantRevalidation;
    documentId: string;
    manifest: DocAppManifest | undefined;
    observed: OriginalTokenWriteObservation;
  }
>();
const originalTokenGrantPreparers = new WeakMap<
  DocChannelGrantRevalidation,
  {
    db: Db;
    store: DocChannelStore;
    prepare: (
      documentId: string,
      observed: OriginalTokenWriteObservation
    ) => import('./current/current-operation-types.js').OriginalDocTokenGrantPreparation;
  }
>();
const originalTokenManifestReads = new WeakMap<
  DocChannelGrantRevalidation,
  {
    db: Db;
    store: DocChannelStore;
    read: (documentId: string) => string | null;
    source: (documentId: string, tx: DbTransaction) => DocAppManifest | undefined;
    closed: () => void;
  }
>();
const originalRelayGrantReads = new WeakMap<
  DocChannelGrantRevalidation,
  {
    db: Db;
    store: DocChannelStore;
    calls: Readonly<
      Pick<DocChannelGrantRevalidation, 'refreshGrantedAuthority' | 'revalidateBatchGrant'>
    >;
  }
>();
/** Shared synchronous current-authority checks for ingestion and background dispatch. */
export class DocChannelGrantRevalidation {
  readonly #relayStore: ReturnType<typeof requireOriginalDocGrantStore> &
    ReturnType<typeof requireOriginalDocumentRelayStore>;

  readonly #tokenManifestReader = createOriginalDocAppManifestReader();
  readonly #fixedServices: DocChannelGrantRevalidation['services'] & {
    readonly originalManifestReader: ReturnType<typeof createOriginalDocAppManifestReader>;
  };
  readonly #fixedClaims = new WeakMap<DbTransaction, CurrentGrantSourceClaims>();
  /** Use current canonical authority ports without reusing an opener turn's expired proof. */
  constructor(protected readonly services: DocGrantCurrentServices) {
    const fixed = captureCurrentDocConfiguration(services);
    if (fixed.db.$client.inTransaction)
      throw new Error('Current grant construction requires an inactive database.');
    this.#relayStore = Object.freeze({
      ...requireOriginalDocGrantStore(fixed.store, fixed.db),
      ...requireOriginalDocumentRelayStore(fixed.store),
    });
    this.#fixedServices = Object.freeze({
      db: fixed.db,
      store: fixed.store,
      authority: captureCurrentDocConfiguration(fixed.authority),
      now: fixed.now,
      originalManifestReader: this.#tokenManifestReader,
    });
    requireDocChannelStoreDatabase(services.store, services.db);
    originalTokenManifestReads.set(this, {
      db: fixed.db,
      store: fixed.store,
      read: (documentId) => this.#readTokenManifestOutsideSql(documentId),
      source: (documentId, tx) =>
        this.#tokenManifestReader.read(this.#fixedServices.authority.sourceRoot(documentId, tx)),
      closed: () => this.#tokenManifestReader.requireClosed(),
    });
    originalTokenGrantPreparers.set(this, {
      db: fixed.db,
      store: fixed.store,
      prepare: (documentId, observed) => this.#prepareTokenManifest(documentId, observed),
    });
    originalRelayGrantReads.set(this, {
      db: fixed.db,
      store: fixed.store,
      calls: Object.freeze({
        refreshGrantedAuthority: (id: string) => this.#relayRefresh(id),
        revalidateBatchGrant: (batch: DocBatchRow, tx: DbTransaction) =>
          this.#relayBatch(batch, tx),
      }),
    });
    originalReviewedReplayRoutes.set(
      this,
      (documentId, actor, tx, grantId, observed, inputs, room, engine) => {
        const before = this.#sourceRows(documentId, tx);
        const scope = this.#fixedAccess(documentId, actor, tx).scope;
        const grant = grantCoreRevalidateGrant(
          this.#fixedServices,
          documentId,
          grantId,
          actor,
          tx,
          observed
        );
        const route = declaredRoute(before.channel, grant.routeId);
        const nativeRoom =
          scope.startsWith('room:') &&
          route.to === 'room:self' &&
          room &&
          engine &&
          readOriginalRoomReplayAvailability(room, engine, this.#fixedServices.db);
        const ownSession =
          scope.startsWith('session:') &&
          route.to !== 'log' &&
          route.to !== 'room:self' &&
          grant.targetSessionId !== null &&
          this.#fixedServices.authority.resolveScope(`session:${grant.targetSessionId}`, tx) ===
            scope;
        const relaySession =
          scope.startsWith('session:') &&
          route.to.startsWith('agent:') &&
          grant.targetSessionId !== null &&
          readOriginalDocumentRelayAvailability(
            this,
            this.#fixedServices.authority.resolveTarget(
              {
                documentId,
                scope,
                route,
                openerAgentId: grant.openerAgentId,
              },
              tx
            ),
            grant.openerAgentId
          ) === undefined;
        if (
          (!nativeRoom && !ownSession && !relaySession) ||
          route.turn.mode === 'none' ||
          grant.targetSessionId === null
        )
          throw new DocRouteGrantError('DOCUMENT_REPLAY_TRANSPORT_UNAVAILABLE');
        if (inputs) {
          if (inputs.length < 1 || inputs.length > 400)
            throw new DocRouteGrantError('DOCUMENT_REPLAY_INPUT_UNAVAILABLE');
          for (const event of inputs)
            grantCoreValidateEventPayload(
              this.#fixedServices,
              documentId,
              event.type,
              event.payload,
              actor,
              tx
            );
        }
        if (!sameCurrentDocData(before, this.#sourceRows(documentId, tx)))
          throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
        return copyCurrentDocData({ grant, route });
      }
    );
    originalReplayRouting.set(this, (documentId, actor, tx, room, engine, observed) =>
      this.#replayRouting(documentId, actor, tx, room, engine, observed)
    );
    currentGrantBindings.set(this, {
      store: services.store,
      db: services.db,
      documentFinal: (documentId, ids, tx) => this.#documentFinal(documentId, ids, tx),
      documentDependencies: (documentId, actor, grantIds, tx, observed) =>
        this.#documentDependencies(documentId, actor, grantIds, tx, observed),
      refresh: (documentId, actor) => this.#refreshCurrentAuthority(documentId, actor),
      prepare: (authorization, tx, observed) => this.#prepareCurrent(authorization, tx, observed),
      audit: (authorization, tx) => this.#auditCurrent(authorization, tx),
      roomSource: (authorization, tx, routeId) =>
        this.#originalRoomSource(authorization, tx, routeId),
    });
  }
  #prepareTokenManifest(documentId: string, observed: OriginalTokenWriteObservation) {
    if (this.#fixedServices.db.$client.inTransaction)
      throw new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY');
    const manifest = this.#tokenManifestReader.readFresh(
      this.#fixedServices.authority.sourceRoot(documentId)
    );
    const stage = Object.freeze({ kind: 'original-doc-token-grant-preparation' as const });
    if (observed.manifestHash !== (manifest?.hash ?? null))
      throw new DocRouteGrantError('MANIFEST_CHANGED');
    originalTokenGrantPreparations.set(stage, {
      owner: this,
      documentId,
      manifest,
      observed: copyCurrentDocData(observed),
    });
    return stage;
  }
  #prepareTokenCurrent(
    input: ReturnType<typeof readCurrentDocIngressInput>,
    authorization: DocChannelAuthorization,
    tx: DbTransaction
  ) {
    if (input.actor || !input.tokenScope || !input.tokenGrantPreparation || !input.tokenGrantIds)
      throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
    const prepared = originalTokenGrantPreparations.get(input.tokenGrantPreparation);
    if (
      !prepared ||
      prepared.owner !== this ||
      prepared.documentId !== input.documentId ||
      (prepared.manifest?.hash ?? null) !== input.tokenManifestHash
    )
      throw new DocRouteGrantError('MANIFEST_CHANGED');
    if (CompiledCanvasAppManifest.prototype.validate !== originalTokenPayloadValidate)
      throw new DocRouteGrantError('MANIFEST_CHANGED');
    if (
      prepared.manifest &&
      Reflect.apply(originalTokenPayloadValidate, prepared.manifest.compiled, [
        input.event.type,
        input.event.payload,
      ]) !== 'valid'
    )
      throw new DocRouteGrantError('PAYLOAD_INVALID', 422);
    const before = this.#sourceRows(input.documentId, tx);
    const routes: DocGrantedRoute[] = [];
    const limits = {
      envelopeBytes: Math.min(
        16384,
        prepared.manifest?.compiled.manifest.limits?.envelopeBytes ?? 16384
      ),
      eventsPerMinute: Math.min(
        60,
        prepared.manifest?.compiled.manifest.limits?.eventsPerMinute ?? 60
      ),
    };
    for (let index = 0; index < input.tokenGrantIds.length; index++) {
      const id = input.tokenGrantIds[index]!;
      const grant = grantCoreVerifyCurrentGrant(
        this.#fixedServices,
        input.documentId,
        id,
        input.scope,
        tx,
        prepared.observed
      );
      const route = grant.normalizedRoute as CanvasChannelRoute;
      if (
        !matchesCanvasChannelEvent(route.on, input.event.type) ||
        !(grant.allowedTypes as string[]).some((pattern) =>
          matchesCanvasChannelEvent(pattern, input.event.type)
        )
      )
        continue;
      if (routes.some((selected) => selected.route.id === route.id))
        throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
      const bounded = CanvasChannelGrantSchema.shape.limits.parse(grant.limits);
      limits.envelopeBytes = Math.min(limits.envelopeBytes, bounded.envelopeBytes);
      limits.eventsPerMinute = Math.min(limits.eventsPerMinute, bounded.eventsPerMinute);
      routes.push({ route, grantId: grant.grantId, grantRevision: grant.revision });
    }
    const after = this.#sourceRows(input.documentId, tx);
    if (!sameCurrentDocData(before, after)) throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
    this.#fixedClaims.set(tx, { authorization, ...after });
    return copyCurrentDocData({
      documentId: input.documentId,
      scope: input.scope,
      documentLabel: input.documentLabel,
      provenance: { transport: 'http', trust: 'app_untrusted' },
      routes,
      ...limits,
    });
  }
  #readTokenManifestOutsideSql(documentId: string): string | null {
    if (this.#fixedServices.db.$client.inTransaction)
      throw new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY');
    return (
      this.#tokenManifestReader.read(this.#fixedServices.authority.sourceRoot(documentId))?.hash ??
      null
    );
  }
  protected now(): string {
    return grantCoreNow(this.services);
  }
  protected access(
    documentId: string,
    actor: DocGrantActor,
    tx?: DbTransaction
  ): { id: string; scope: string } {
    return grantCoreAccess(this.services, documentId, actor, tx);
  }
  private refreshManifest(documentId: string, tx: DbTransaction): unknown {
    let manifest: DocAppManifest | undefined;
    let error: unknown;
    try {
      manifest = readDocAppManifest(this.services.authority.sourceRoot(documentId, tx));
    } catch (caught) {
      error = caught;
    }
    const channel = this.services.store.getChannel(documentId, tx)!;
    const hash = manifest?.hash ?? null;
    if (error || channel.manifestHash !== hash) {
      tx.update(canvasDocChannels)
        .set({ manifestHash: hash, updatedAt: this.now() })
        .where(eq(canvasDocChannels.documentId, documentId))
        .run();
      this.suspend(documentId, tx);
    }
    return error;
  }
  /**
   * Commit observed manifest suspension before opening an acceptance transaction.
   * Call again after a final MANIFEST_CHANGED refusal if the app raced this preflight.
   * A payload refusal or admission rollback cannot undo this explicit refresh.
   */
  refreshAuthority(documentId: string, actor: DocGrantActor): void {
    if (this.services.db.$client.inTransaction)
      throw new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY');
    const error = this.services.store.transaction((tx) => {
      this.access(documentId, actor, tx);
      return this.refreshManifest(documentId, tx);
    });
    if (error) throw error;
  }
  /** Refresh durable background authority without reusing an expired opener-turn principal. */
  refreshGrantedAuthority(grantId: string): void {
    if (this.services.db.$client.inTransaction)
      throw new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY');
    const error = this.services.store.transaction((tx) => {
      const grant = this.services.store.getGrant(grantId, tx);
      if (!grant) throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
      this.services.authority.requireGrantedCurrent(grant, tx);
      return this.refreshManifest(grant.documentId, tx);
    });
    if (error) throw error;
  }
  protected manifest(documentId: string, tx: DbTransaction): DocAppManifest | undefined {
    return grantCoreManifest(this.services, documentId, tx);
  }
  protected suspend(documentId: string, tx: DbTransaction): void {
    tx.update(canvasDocGrants)
      .set({ revokedAt: this.now() })
      .where(and(eq(canvasDocGrants.documentId, documentId), isNull(canvasDocGrants.revokedAt)))
      .run();
  }
  /** Validate declared app payloads inside acceptance's transaction; undeclared types stay log-only. */
  validateEventPayload(
    documentId: string,
    type: string,
    payload: unknown,
    actor: DocGrantActor,
    tx?: DbTransaction
  ): void {
    if (!tx) {
      this.refreshAuthority(documentId, actor);
      return this.services.store.transaction((current) =>
        this.validateEventPayload(documentId, type, payload, actor, current)
      );
    }
    grantCoreValidateEventPayload(this.services, documentId, type, payload, actor, tx);
  }
  /** Recheck hashes, current origin/target, expiry and revocation before a final admission effect. */
  revalidateGrant(
    documentId: string,
    grantId: string,
    actor: DocGrantActor,
    tx?: DbTransaction
  ): DocGrantRow {
    if (!tx) {
      this.refreshAuthority(documentId, actor);
      return this.services.store.transaction((current) =>
        this.revalidateGrant(documentId, grantId, actor, current)
      );
    }
    return grantCoreRevalidateGrant(this.services, documentId, grantId, actor, tx);
  }
  private verifyCurrentGrant(
    documentId: string,
    grantId: string,
    scope: string,
    tx: DbTransaction,
    observed?: DocOriginalWriteObservation
  ): DocGrantRow {
    return grantCoreVerifyCurrentGrant(this.services, documentId, grantId, scope, tx, observed);
  }
  /** Pure original write grant check: supplied observation replaces ONLY legacy filesystem ports. */
  revalidateOriginalWriteGrant(
    documentId: string,
    grantId: string,
    revision: number,
    scope: string,
    observed: DocOriginalWriteObservation,
    tx: DbTransaction
  ): DocGrantRow {
    const capturedTime = checkboxAuthorityClock(() => this.services.now?.() ?? new Date());
    const original = this.services.store.getGrant(grantId, tx);
    if (
      !original ||
      original.documentId !== documentId ||
      original.revision !== revision ||
      !original.routeId
    )
      throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
    const channel = this.services.store.getChannel(documentId, tx);
    if (!channel) throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
    const context = captureCheckboxGrantContext(
      this.services.authority,
      original,
      channel,
      scope,
      tx
    );
    const fresh = this.services.store.getGrant(grantId, tx);
    if (!fresh || fresh.documentId !== documentId || fresh.revision !== revision)
      throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
    const evidence = fresh.approvalEvidence as {
      kind?: string;
      binding?: unknown;
      approvalId?: string;
      inputHash?: string;
    };
    const approval = fresh.approvalId
      ? tx.select().from(approvals).where(eq(approvals.id, fresh.approvalId)).get()
      : undefined;
    if (
      evidence.kind !== 'operator_approval' ||
      !approval ||
      !approval.detail ||
      approval.detail !== redactSecretsInText(JSON.stringify(evidence.binding))
    )
      throw new DocRouteGrantError('GRANT_EVIDENCE_MISMATCH');
    return grantCoreVerifyCurrentGrant(
      {
        ...this.services,
        authority: { ...this.services.authority, ...context },
        now: () => new Date(capturedTime),
      },
      documentId,
      grantId,
      scope,
      tx,
      observed
    );
  }

  /**
   * Background dispatch uses persisted server grant evidence, never an expired
   * opener-turn proof or a freshly minted broad operator identity.
   */
  revalidateBatchGrant(
    batch: DocBatchRow,
    tx: DbTransaction
  ): { grant: DocGrantRow; target: DocGrantTarget } {
    const current = this.services.store.getBatch(batch.batchId, tx);
    if (
      !current ||
      current.documentId !== batch.documentId ||
      current.generation !== batch.generation ||
      current.grantId !== batch.grantId ||
      current.grantRevision !== batch.grantRevision ||
      current.routeId !== batch.routeId
    )
      throw new DocRouteGrantError('BATCH_BINDING_CHANGED');
    const grant = this.services.store.getGrant(current.grantId, tx);
    if (
      !grant ||
      grant.documentId !== current.documentId ||
      grant.revision !== current.grantRevision ||
      grant.routeId !== current.routeId
    )
      throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
    const access = this.services.authority.requireGrantedCurrent(grant, tx);
    if (
      access.id !== current.documentId ||
      access.scope !== this.services.authority.resolveScope(current.scope, tx)
    )
      throw new DocRouteGrantError('BATCH_SCOPE_CHANGED');
    const verified = this.verifyCurrentGrant(current.documentId, grant.grantId, access.scope, tx);
    return {
      grant: verified,
      target: this.services.authority.resolveTarget(
        {
          documentId: current.documentId,
          scope: access.scope,
          route: declaredRoute(
            this.services.store.getChannel(current.documentId, tx)!,
            current.routeId
          ),
          openerAgentId: verified.openerAgentId,
        },
        tx
      ),
    };
  }
  /** Effective document ingress caps; an app manifest can only lower platform caps. */
  getEffectiveLimits(
    documentId: string,
    actor: DocGrantActor,
    tx?: DbTransaction
  ): ReturnType<typeof grantCoreGetEffectiveLimits> {
    if (!tx) {
      this.refreshAuthority(documentId, actor);
      return this.services.store.transaction((current) =>
        this.getEffectiveLimits(documentId, actor, current)
      );
    }
    return grantCoreGetEffectiveLimits(this.services, documentId, actor, tx);
  }
  /** Return current granted or saved-only route outcomes; never enqueue or replay old input. */
  getCurrentRoutes(
    documentId: string,
    type: string | undefined,
    actor: DocGrantActor,
    tx?: DbTransaction
  ): DocGrantedRoute[] {
    if (!tx) {
      this.refreshAuthority(documentId, actor);
      return this.services.store.transaction((current) =>
        this.getCurrentRoutes(documentId, type, actor, current)
      );
    }
    return grantCoreGetCurrentRoutes(this.services, documentId, type, actor, tx);
  }

  #relayRefresh(grantId: string): void {
    const services = this.#fixedServices;
    if (services.db.$client.inTransaction)
      throw new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY');
    const failure = documentTransaction(services.db, (tx) => {
      const observed = withCheckboxReadOnlyGate(services.db, () => {
        const grant = this.#relayStore.getGrant(grantId, tx);
        if (!grant) throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
        services.authority.requireGrantedCurrent(grant, tx);
        let manifest: DocAppManifest | undefined;
        let failure: { cause: unknown } | undefined;
        try {
          manifest = this.#tokenManifestReader.read(
            services.authority.sourceRoot(grant.documentId, tx)
          );
        } catch (cause) {
          failure = { cause };
        }
        return {
          documentId: grant.documentId,
          hash: manifest?.hash ?? null,
          now: this.#fixedNow(),
          failure,
        };
      });
      const channel = this.#readCurrentChannel(observed.documentId, tx);
      if (!channel) throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
      if (observed.failure || channel.manifestHash !== observed.hash) {
        tx.update(canvasDocChannels)
          .set({ manifestHash: observed.hash, updatedAt: observed.now })
          .where(eq(canvasDocChannels.documentId, observed.documentId))
          .run();
        tx.update(canvasDocGrants)
          .set({ revokedAt: observed.now })
          .where(
            and(
              eq(canvasDocGrants.documentId, observed.documentId),
              isNull(canvasDocGrants.revokedAt)
            )
          )
          .run();
      }
      return observed.failure;
    });
    if (failure) throw failure.cause;
  }
  #relayBatch(
    batch: DocBatchRow,
    tx: DbTransaction
  ): { grant: DocGrantRow; target: DocGrantTarget } {
    const current = this.#relayStore.getBatch(batch.batchId, tx);
    if (
      !current ||
      current.documentId !== batch.documentId ||
      current.generation !== batch.generation ||
      current.grantId !== batch.grantId ||
      current.grantRevision !== batch.grantRevision ||
      current.routeId !== batch.routeId
    )
      throw new DocRouteGrantError('BATCH_BINDING_CHANGED');
    const grant = this.#relayStore.getGrant(current.grantId, tx);
    if (
      !grant ||
      grant.documentId !== current.documentId ||
      grant.revision !== current.grantRevision ||
      grant.routeId !== current.routeId
    )
      throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
    const services = this.#fixedServices;
    return withCheckboxReadOnlyGate(services.db, () => {
      const before = this.#sourceRows(current.documentId, tx);
      const access = services.authority.requireGrantedCurrent(grant, tx);
      if (
        access.id !== current.documentId ||
        access.scope !== services.authority.resolveScope(current.scope, tx)
      )
        throw new DocRouteGrantError('BATCH_SCOPE_CHANGED');
      const verified = grantCoreVerifyCurrentGrant(
        services,
        current.documentId,
        grant.grantId,
        access.scope,
        tx
      );
      const channel = this.#relayStore.getChannel(current.documentId, tx);
      if (!channel) throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
      const target = services.authority.resolveTarget(
        {
          documentId: current.documentId,
          scope: access.scope,
          route: declaredRoute(channel, current.routeId),
          openerAgentId: verified.openerAgentId,
        },
        tx
      );
      const after = this.#sourceRows(current.documentId, tx);
      if (!sameCurrentDocData(before, after)) throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
      return { grant: verified, target };
    });
  }

  #fixedNow(): string {
    return grantCoreNow(this.#fixedServices);
  }

  #fixedAccess(
    documentId: string,
    actor: DocGrantActor,
    tx?: DbTransaction
  ): { id: string; scope: string } {
    return grantCoreAccess(this.#fixedServices, documentId, actor, tx);
  }

  #documentFinal(documentId: string, grantIds: readonly string[], tx: DbTransaction): void {
    // This original configured clock is the last observable grant phase. No callbacks follow.
    const at = Date.parse(grantCoreNow(this.#fixedServices));
    if (!Number.isFinite(at)) throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
    const rows = this.#sourceRows(documentId, tx);
    for (const id of grantIds) {
      const grant = rows.grants.find((row) => row.grantId === id);
      if (
        !grant ||
        grant.revokedAt ||
        !grant.expiresAt ||
        !Number.isFinite(Date.parse(grant.expiresAt)) ||
        Date.parse(grant.expiresAt) <= at
      )
        throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
    }
  }
  #documentDependencies(
    documentId: string,
    actor: DocGrantActor,
    grantIds: readonly string[],
    tx: DbTransaction,
    observed?: DocOriginalWriteObservation
  ): OriginalCurrentDocumentGrantDependencies {
    const before = this.#sourceRows(documentId, tx);
    const manifest = grantCoreManifest(this.#fixedServices, documentId, tx);
    const selected = grantIds.map((id) =>
      grantCoreRevalidateGrant(this.#fixedServices, documentId, id, actor, tx, observed)
    );
    const after = this.#sourceRows(documentId, tx);
    if (!sameCurrentDocData(before, after)) throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
    const {
      nextDocSeq: _seq,
      updatedAt: _updated,
      receiptRetentionFloor: _floor,
      ...channelIdentity
    } = before.channel;
    return copyCurrentDocData({
      manifestHash: manifest?.hash ?? null,
      originalRows: { ...before, channel: channelIdentity },
      grants: selected,
      approvals: before.approvals.filter((row) =>
        selected.some((grant) => grant.approvalId === row.id)
      ),
    });
  }
  #replayRouting(
    documentId: string,
    actor: DocGrantActor,
    tx: DbTransaction,
    room?: CurrentRoomOperation,
    engine?: CurrentDocOperationEngineCore,
    observed?: DocOriginalWriteObservation
  ) {
    const before = this.#sourceRows(documentId, tx);
    const types = new Set<string>();
    let agentDestination = false;
    let crossTargetDestination = false;
    const scope = this.#fixedAccess(documentId, actor, tx).scope;
    const nativeRoomAvailable =
      scope.startsWith('room:') && room && engine
        ? readOriginalRoomReplayAvailability(room, engine, this.#fixedServices.db)
        : false;
    for (const row of before.grants) {
      try {
        const grant = grantCoreRevalidateGrant(
          this.#fixedServices,
          documentId,
          row.grantId,
          actor,
          tx,
          observed
        );
        const route = declaredRoute(before.channel, grant.routeId);
        // A verified grant does not itself supply cross-target or native Room transport.
        const eligible =
          route.to === 'log' ||
          (scope.startsWith('session:') &&
            grant.targetSessionId !== null &&
            this.#fixedServices.authority.resolveScope(`session:${grant.targetSessionId}`, tx) ===
              scope) ||
          (scope.startsWith('room:') && nativeRoomAvailable && route.to === 'room:self') ||
          (scope.startsWith('session:') &&
            route.to.startsWith('agent:') &&
            readOriginalDocumentRelayAvailability(
              this,
              this.#fixedServices.authority.resolveTarget(
                {
                  documentId,
                  scope,
                  route,
                  openerAgentId: grant.openerAgentId,
                },
                tx
              ),
              grant.openerAgentId
            ) === undefined);
        if (!eligible) continue;
        if (route.to !== 'log') {
          agentDestination = true;
          if (
            scope.startsWith('session:') &&
            grant.targetSessionId !== null &&
            this.#fixedServices.authority.resolveScope(`session:${grant.targetSessionId}`, tx) !==
              scope
          )
            crossTargetDestination = true;
        }
        for (const type of grantTypes(
          route,
          CanvasChannelGrantSchema.shape.allowedTypes.parse(grant.allowedTypes)
        ))
          types.add(type);
      } catch (cause) {
        // A saved-only route is readable, but cannot qualify an app input channel.
        if (!(cause instanceof DocRouteGrantError) && !(cause instanceof DocChannelNotFoundError))
          throw cause;
      }
    }
    if (!sameCurrentDocData(before, this.#sourceRows(documentId, tx)))
      throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
    return copyCurrentDocData({
      enabled: types.size > 0,
      approvedEventTypes: [...types].sort(),
      destinationLabel: agentDestination
        ? scope.startsWith('room:')
          ? 'Room'
          : crossTargetDestination
            ? 'Approved agents'
            : 'This document’s agent'
        : types.size > 0
          ? 'Saved in this document'
          : 'Approval needed',
    });
  }
  #sourceRows(documentId: string, tx: DbTransaction) {
    return readCurrentGrantSourceRows(documentId, tx);
  }
  #prepareCurrent(
    authorization: DocChannelAuthorization,
    tx: DbTransaction,
    observed?: DocOriginalWriteObservation
  ): import('./ingest-types.js').DocIngestAccess {
    const input = readCurrentDocIngressInput(authorization, this.#fixedServices.store, tx);
    if (this.#fixedClaims.has(tx)) throw new Error('Current grant selection is already captured.');
    if (input.tokenScope) return this.#prepareTokenCurrent(input, authorization, tx);
    if (!input.actor) throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
    const actor = input.actor;
    observed ??= input.originalWriteObservation;
    const before = this.#sourceRows(input.documentId, tx);
    const selected = withCheckboxReadOnlyGate(this.#fixedServices.db, () => {
      const limits = grantCoreGetEffectiveLimits(this.#fixedServices, input.documentId, actor, tx);
      const routes = grantCoreGetCurrentRoutes(
        this.#fixedServices,
        input.documentId,
        input.event.type,
        actor,
        tx,
        observed
      );
      grantCoreValidateEventPayload(
        this.#fixedServices,
        input.documentId,
        input.event.type,
        input.event.payload,
        actor,
        tx
      );
      for (const route of routes) {
        if (!route.grantId || route.reason) continue;
        const grant = before.grants.find((row) => row.grantId === route.grantId);
        if (!grant || grant.revision !== route.grantRevision)
          throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
        const bounded = CanvasChannelGrantSchema.shape.limits.parse(grant.limits);
        limits.envelopeBytes = Math.min(limits.envelopeBytes, bounded.envelopeBytes);
        limits.eventsPerMinute = Math.min(limits.eventsPerMinute, bounded.eventsPerMinute);
      }
      return copyCurrentDocData({
        documentId: input.documentId,
        scope: input.scope,
        documentLabel: input.documentLabel,
        provenance: { transport: 'http', trust: 'app_untrusted' },
        routes,
        envelopeBytes: limits.envelopeBytes,
        eventsPerMinute: limits.eventsPerMinute,
      });
    });
    const after = this.#sourceRows(input.documentId, tx);
    if (!sameCurrentDocData(before, after)) throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
    this.#fixedClaims.set(tx, { authorization, ...after });
    return selected;
  }
  #auditCurrent(authorization: DocChannelAuthorization, tx: DbTransaction): void {
    const input = readCurrentDocIngressInput(authorization, this.#fixedServices.store, tx);
    const own = this.#fixedClaims.get(tx);
    if (!own || own.authorization !== authorization)
      throw new Error('Current grant selection is foreign.');
    const fresh = this.#sourceRows(input.documentId, tx);
    if (
      !sameCurrentDocData(
        {
          grants: own.grants,
          approvals: own.approvals,
          channel: {
            ...own.channel,
            nextDocSeq: fresh.channel.nextDocSeq,
            updatedAt: fresh.channel.updatedAt,
          },
        },
        fresh
      )
    )
      throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
  }

  #originalRoomSource(authorization: DocChannelAuthorization, tx: DbTransaction, routeId: string) {
    this.#auditCurrent(authorization, tx);
    const input = readCurrentDocIngressInput(authorization, this.#fixedServices.store, tx);
    const original = this.#fixedClaims.get(tx)!;
    return selectOriginalRoomGrantSource(original, input, routeId);
  }

  #readCurrentChannel(documentId: string, tx: DbTransaction) {
    return readChecked('canvas_doc_channels', documentId, () =>
      tx.select().from(canvasDocChannels).where(eq(canvasDocChannels.documentId, documentId)).get()
    );
  }
  #refreshCurrentAuthority(documentId: string, actor: DocGrantActor): void {
    if (this.#fixedServices.db.$client.inTransaction)
      throw new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY');
    const failure = documentTransaction(this.#fixedServices.db, (tx) => {
      // Keep the original caught cause outside the plain-data authority observation.
      let failure: { cause: unknown } | undefined;
      const observed = withCheckboxReadOnlyGate(this.#fixedServices.db, () => {
        this.#fixedAccess(documentId, actor, tx);
        let manifest: DocAppManifest | undefined;
        try {
          manifest = this.#tokenManifestReader.read(
            this.#fixedServices.authority.sourceRoot(documentId, tx)
          );
        } catch (cause) {
          failure = { cause };
        }
        return { hash: manifest?.hash ?? null, now: this.#fixedNow() };
      });
      const channel = this.#readCurrentChannel(documentId, tx);
      if (!channel) throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
      if (failure || channel.manifestHash !== observed.hash) {
        tx.update(canvasDocChannels)
          .set({ manifestHash: observed.hash, updatedAt: observed.now })
          .where(eq(canvasDocChannels.documentId, documentId))
          .run();
        tx.update(canvasDocGrants)
          .set({ revokedAt: observed.now })
          .where(and(eq(canvasDocGrants.documentId, documentId), isNull(canvasDocGrants.revokedAt)))
          .run();
      }
      return failure;
    });
    if (failure) throw failure.cause;
  }
}

/** Project current route readiness through the original constructor-owned grant validators. */
export function readOriginalCurrentDocReplayRouting(
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  documentId: string,
  actor: DocGrantActor,
  tx: DbTransaction,
  room?: CurrentRoomOperation,
  engine?: CurrentDocOperationEngineCore
): import('@dorkos/shared/canvas-channel-schemas').CanvasChannelRouting {
  const own = originalReplayRouting.get(grants);
  const binding = currentGrantBindings.get(grants);
  if (!own || !binding || binding.store !== store)
    throw new Error('Replay routing requires the original grant constructor.');
  requireCurrentDocGrantEngine(grants, store, binding.db);
  if (!engine) throw new Error('Replay routing requires its original current engine.');
  const observed = readCurrentDocReplayWriteObservation(store, tx, documentId, engine);
  return own(documentId, actor, tx, room, engine, observed);
}
/** Fixed genuine constructor entry; caller does not supply route authority or a checker. */
export function prepareCurrentDocGrantRoutes(
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  tx: DbTransaction
): import('./ingest-types.js').DocIngestAccess {
  const own = currentGrantBindings.get(grants);
  if (!own || own.store !== store)
    throw new Error('Current route selection requires its genuine grant store.');
  requireCurrentDocGrantEngine(grants, store, own.db);
  return own.prepare(authorization, tx);
}
/** Only the active original completion stage supplies checked FILE observation DATA. */
export function prepareCurrentDocCheckboxGrantRoutes(
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  owner: object,
  tx: DbTransaction
): import('./ingest-types.js').DocIngestAccess {
  const own = currentGrantBindings.get(grants);
  if (!own || own.store !== store)
    throw new Error('Checkbox route selection requires its genuine grant store.');
  requireCurrentDocGrantEngine(grants, store, own.db);
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
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  tx: DbTransaction
): void {
  const own = currentGrantBindings.get(grants);
  if (!own || own.store !== store)
    throw new Error('Current grant audit requires its genuine grant store.');
  requireCurrentDocGrantEngine(grants, store, own.db);
  own.audit(authorization, tx);
}

/** Commit observed manifest reductions through captured genuine core before admission, preserving thrown undefined. */
export function refreshCurrentDocGrantAuthority(
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  documentId: string,
  actor: DocGrantActor
): void {
  const own = currentGrantBindings.get(grants);
  if (!own || own.store !== store)
    throw new Error('Current grant refresh requires its genuine store.');
  requireCurrentDocGrantEngine(grants, store, own.db);
  own.refresh(documentId, actor);
}

/** Original pre-effect data from this genuine current grant constructor; cannot issue or extend authority. */
export function readCurrentOriginalRoomGrantSource(
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  tx: DbTransaction,
  routeId: string
): ReturnType<typeof selectOriginalRoomGrantSource> {
  const own = currentGrantBindings.get(grants);
  if (!own || own.store !== store)
    throw new Error('Original Room source requires its genuine grant store.');
  requireCurrentDocGrantEngine(grants, store, own.db);
  return own.roomSource(authorization, tx, routeId);
}

/** Fixed document-only dependencies; no batch, opener resurrection or caller-supplied authority. */
export function captureCurrentDocumentGrantDependencies(
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  documentId: string,
  actor: DocGrantActor,
  grantIds: readonly string[],
  tx: DbTransaction,
  observed?: DocOriginalWriteObservation
): OriginalCurrentDocumentGrantDependencies {
  const own = currentGrantBindings.get(grants);
  if (!own || own.store !== store)
    throw new Error('Document dependencies require original grants.');
  requireCurrentDocGrantEngine(grants, store, own.db);
  return own.documentDependencies(documentId, actor, grantIds, tx, observed);
}

/** Last owner-clock phase followed only by native row/data guards; no supplied numeric time. */
export function requireCurrentDocumentGrantFinal(
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  documentId: string,
  grantIds: readonly string[],
  tx: DbTransaction
): void {
  const own = currentGrantBindings.get(grants);
  if (!own || own.store !== store)
    throw new Error('Document final expiry requires original grants.');
  requireCurrentDocGrantEngine(grants, store, own.db);
  own.documentFinal(documentId, grantIds, tx);
}

/** Fixed constructor-owned FILE/manifest observation DATA, always outside SQL.
 * The original token engine must bind it to authenticated native source facts.
 */
export function readOriginalTokenDocumentManifest(
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  db: Db,
  documentId: string
): string | null {
  const own = originalTokenManifestReads.get(grants);
  if (!own || own.db !== db || own.store !== store || typeof documentId !== 'string' || !documentId)
    throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
  requireCurrentDocGrantEngine(grants, store, db);
  return own.read(documentId);
}

/** Fixed owning manifest-FD close witness, distinct from ordinary validation refusal. */
export function requireOriginalTokenDocumentManifestClosed(
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  db: Db
): void {
  const own = originalTokenManifestReads.get(grants);
  if (!own || own.db !== db || own.store !== store)
    throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
  own.closed();
}

/** Original constructor-bound manifest preparation DATA; never grants bearer authority by itself. */
export function prepareOriginalTokenGrantInput(
  grants: import('./grants.js').DocChannelGrants,
  store: DocChannelStore,
  db: Db,
  documentId: string,
  observed: OriginalTokenWriteObservation
) {
  requireCurrentDocGrantEngine(grants, store, db);
  const own = originalTokenGrantPreparers.get(grants);
  if (!own || own.db !== db || own.store !== store)
    throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
  return own.prepare(documentId, observed);
}

/** Fixed original grant background reads; reflection cannot replace captured class/SQL/currentness. */
export function requireOriginalDocumentRelayGrants(
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore
) {
  const own = originalRelayGrantReads.get(grants);
  if (!own || own.store !== store) throw new Error('DOCUMENT_RELAY_ORIGINAL_GRANTS_REQUIRED');
  requireCurrentDocGrantEngine(grants, store, own.db);
  return own.calls;
}

const currentGrantEngines = new WeakMap<
  DocChannelGrantRevalidation,
  { db: Db; store: DocChannelStore }
>();
const originalPreparedGrantCalls = new WeakMap<
  DocChannelGrants,
  {
    db: Db;
    store: DocChannelStore;
    grant: (
      helper: OriginalCheckboxGrantPreparation,
      request: DocRouteGrantRequest,
      actor: DocGrantActor,
      token?: string
    ) => DocGrantResult;
  }
>();
const originalGrantMutations = new WeakMap<
  DocChannelGrants,
  {
    configure: (
      documentId: string,
      declaration: CanvasChannelDeclaration,
      actor: DocGrantActor,
      opener?: string
    ) => void;
    grant: (request: DocRouteGrantRequest, actor: DocGrantActor, token?: string) => DocGrantResult;
    revoke: (documentId: string, grantId: string, actor: DocGrantActor) => void;
  }
>();
const APPROVE_CAPABILITY = 'ui.approve_doc_route';
const PLATFORM_LIMITS = { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 };
/** One server-normalized exact approval subject; no page field supplies authority evidence. */
export interface PreparedDocGrant {
  request: DocRouteGrantRequest;
  bindingInput: Record<string, unknown>;
  inputHash: string;
  route: CanvasChannelRoute;
  target: DocGrantTarget;
  openerAgentId: string | null;
  declarationHash: string;
  manifestHash: string | null;
  allowedTypes: string[];
  limits: typeof PLATFORM_LIMITS;
  self: boolean;
}
/** Outcomes distinguish existing/active grant from a pending actual operator decision. */
export type DocGrantResult =
  { kind: 'granted'; grant: DocGrantRow } | { kind: 'approval_required'; ticket: ApprovalTicket };
/** Exact grants; declaration changes and approvals never replay previously accepted input. */
export class DocChannelGrants extends DocChannelGrantRevalidation {
  /** Build over the same SQLite connection as the existing one-use approval service. */
  readonly #store: Pick<
    DocChannelStore,
    'transaction' | 'getChannel' | 'insertGrant' | 'getGrant' | 'revokeGrant'
  >;
  readonly #deps: {
    db: Db;
    store: DocChannelStore;
    approvals: ApprovalService;
    authority: DocGrantAuthority;
    now?: () => Date;
  };
  constructor(deps: {
    db: Db;
    store: DocChannelStore;
    approvals: ApprovalService;
    authority: DocGrantAuthority;
    now?: () => Date;
  }) {
    const fixed = captureCurrentDocConfiguration(deps);
    super(fixed);
    this.#deps = fixed;
    this.#store = requireOriginalDocGrantStore(fixed.store, fixed.db);
    if (fixed.db.$client.inTransaction)
      throw new Error('Current grant construction requires an inactive database.');
    requireDocChannelStoreDatabase(fixed.store, fixed.db);
    fixed.approvals.assertTransactionDatabase(fixed.db);
    currentGrantEngines.set(this, Object.freeze({ db: fixed.db, store: fixed.store }));
    originalGrantMutations.set(this, {
      configure: (id, declaration, actor, opener) =>
        this.#configure(id, declaration, actor, opener),
      grant: (request, actor, token) => this.#grant(request, actor, token),
      revoke: (id, grantId, actor) => this.#revoke(id, grantId, actor),
    });
    originalPreparedGrantCalls.set(this, {
      db: fixed.db,
      store: fixed.store,
      grant: (helper, request, actor, token) => this.#grant(request, actor, token, helper),
    });
  }
  #suspendOriginalGrants(documentId: string, tx: DbTransaction): void {
    tx.update(canvasDocGrants)
      .set({ revokedAt: this.#now() })
      .where(and(eq(canvasDocGrants.documentId, documentId), isNull(canvasDocGrants.revokedAt)))
      .run();
  }
  #refreshOriginalAuthority(documentId: string, actor: DocGrantActor): void {
    if (this.#deps.db.$client.inTransaction)
      throw new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY');
    let failure: { cause: unknown } | undefined;
    try {
      this.#store.transaction((tx) => {
        this.#access(documentId, actor, tx);
        const source = originalTokenManifestReads.get(this);
        if (!source || source.db !== this.#deps.db)
          throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
        let manifest: DocAppManifest | undefined;
        try {
          manifest = source.source(documentId, tx);
        } catch (cause) {
          failure = { cause };
        }
        const channel = this.#store.getChannel(documentId, tx)!;
        const hash = manifest?.hash ?? null;
        if (failure || channel.manifestHash !== hash) {
          let lateFailure: { cause: unknown } | undefined;
          try {
            tx.update(canvasDocChannels)
              .set({ manifestHash: hash, updatedAt: this.#now() })
              .where(eq(canvasDocChannels.documentId, documentId))
              .run();
          } catch (cause) {
            lateFailure = { cause };
          }
          // Attempt the original suspension even if the channel update failed.
          try {
            this.#suspendOriginalGrants(documentId, tx);
          } catch (cause) {
            lateFailure ??= { cause };
          }
          if (lateFailure) throw lateFailure.cause;
        }
      });
    } catch (cause) {
      failure ??= { cause };
    }
    if (failure) throw failure.cause;
  }
  #now(): string {
    return new Date(checkboxAuthorityClock(() => this.#deps.now?.() ?? new Date())).toISOString();
  }
  #access(
    documentId: string,
    actor: DocGrantActor,
    tx?: DbTransaction
  ): { id: string; scope: string } {
    if (!isServerPrincipal(actor.principal)) throw new DocRouteGrantError('INVALID_PRINCIPAL');
    return this.#deps.authority.requireCurrent(documentId, actor, true, tx);
  }
  /** Replace declarations as data, invalidating old authority without routing old events. */
  configure(
    documentId: string,
    declaration: CanvasChannelDeclaration,
    actor: DocGrantActor,
    selectedOpenerAgentId?: string
  ): void {
    return this.#configure(documentId, declaration, actor, selectedOpenerAgentId);
  }
  #configure(
    documentId: string,
    declaration: CanvasChannelDeclaration,
    actor: DocGrantActor,
    selectedOpenerAgentId?: string
  ): void {
    const validated = CanvasChannelDeclarationSchema.parse(declaration);
    this.#refreshOriginalAuthority(documentId, actor);
    this.#store.transaction((tx) => {
      const { scope } = this.#access(documentId, actor, tx);
      const channel = this.#store.getChannel(documentId, tx)!;
      const claims = actor.principal.claims;
      const actorAgent =
        claims.kind === 'agent' || claims.kind === 'runtime' ? claims.agentId : null;
      if (claims.kind !== 'operator' && (!actorAgent || actorAgent !== channel.openerAgentId))
        throw new DocRouteGrantError('OPENER_REQUIRED');
      let openerAgentId = channel.openerAgentId;
      if (selectedOpenerAgentId) {
        if (
          claims.kind !== 'operator' ||
          (openerAgentId && openerAgentId !== selectedOpenerAgentId)
        )
          throw new DocRouteGrantError('OPENER_IMMUTABLE');
        const route: CanvasChannelRoute = {
          id: 'opener-selection',
          on: 'doc.opened',
          to: `agent:${selectedOpenerAgentId}`,
          turn: { mode: 'none' },
        };
        const target = this.#deps.authority.resolveTarget(
          { documentId, scope, route, openerAgentId },
          tx
        );
        validateDocGrantTarget(scope, route, openerAgentId, target);
        openerAgentId = selectedOpenerAgentId;
      }
      const declarationHash = hashApprovalInput(validated);
      if (channel.declarationHash !== declarationHash) this.#suspendOriginalGrants(documentId, tx);
      tx.update(canvasDocChannels)
        .set({ declaration: validated, declarationHash, openerAgentId, updatedAt: this.#now() })
        .where(eq(canvasDocChannels.documentId, documentId))
        .run();
      grantCoreManifest(this.#deps, documentId, tx);
    });
  }
  /** Resolve the exact binding shown for approval, using only current canonical server identity. */
  prepare(
    request: DocRouteGrantRequest,
    actor: DocGrantActor,
    tx: DbTransaction
  ): PreparedDocGrant {
    return this.#prepare(request, actor, tx);
  }
  #prepare(
    request: DocRouteGrantRequest,
    actor: DocGrantActor,
    tx: DbTransaction,
    source?: OriginalCheckboxGrantPreparation
  ): PreparedDocGrant {
    const parsed = DocRouteGrantRequestSchema.parse(request);
    const { scope } = this.#access(parsed.documentId, actor, tx);
    const manifest = source
      ? readOriginalCheckboxGrantManifest(source, this, tx)
      : grantCoreManifest(this.#deps, parsed.documentId, tx);
    const channel = this.#store.getChannel(parsed.documentId, tx)!;
    const route = declaredRoute(channel, parsed.routeId);
    if (
      !channel.declarationHash ||
      hashApprovalInput(CanvasChannelDeclarationSchema.parse(channel.declaration)) !==
        channel.declarationHash
    )
      throw new DocRouteGrantError('DECLARATION_HASH_MISMATCH');
    if (Date.parse(parsed.expiresAt) <= Date.parse(this.#now()))
      throw new DocRouteGrantError('GRANT_EXPIRED');
    if (
      route.to !== 'log' &&
      (!channel.openerAgentId ||
        !this.#deps.authority.originCurrent(parsed.documentId, channel.openerAgentId, tx))
    )
      throw new DocRouteGrantError('ORIGIN_AUTHORITY_LOST');
    if (
      parsed.write &&
      hashApprovalInput(
        this.#deps.authority.resolveWriteBinding?.(parsed.documentId, tx) ?? null
      ) !== hashApprovalInput(parsed.write)
    )
      throw new DocRouteGrantError('WRITE_BINDING_MISMATCH');
    const target = this.#deps.authority.resolveTarget(
      { documentId: parsed.documentId, scope, route, openerAgentId: channel.openerAgentId },
      tx
    );
    validateDocGrantTarget(scope, route, channel.openerAgentId, target);
    const allowedTypes = grantTypes(route, parsed.allowedTypes);
    const limits = { ...PLATFORM_LIMITS };
    for (const key of Object.keys(limits) as (keyof typeof limits)[])
      limits[key] = Math.min(
        limits[key],
        parsed.limits?.[key] ?? limits[key],
        manifest?.compiled.manifest.limits?.[key] ?? limits[key]
      );
    const claims = actor.principal.claims;
    const actorAgent = claims.kind === 'agent' || claims.kind === 'runtime' ? claims.agentId : null;
    const self =
      actorAgent === channel.openerAgentId &&
      actorAgent !== null &&
      !parsed.write &&
      (route.to === 'log' || route.to === 'agent:owner');
    const bindingInput = {
      documentId: parsed.documentId,
      scope,
      route,
      routeHash: hashApprovalInput(route),
      declarationHash: channel.declarationHash,
      manifestHash: manifest?.hash ?? null,
      openerAgentId: channel.openerAgentId,
      target,
      allowedTypes,
      limits,
      expiresAt: parsed.expiresAt,
      write: parsed.write ?? null,
      origin: claims,
    };
    return {
      request: parsed,
      bindingInput,
      inputHash: hashApprovalInput(bindingInput),
      route,
      target,
      openerAgentId: channel.openerAgentId,
      declarationHash: channel.declarationHash,
      manifestHash: manifest?.hash ?? null,
      allowedTypes,
      limits,
      self,
    };
  }
  #existing(prepared: PreparedDocGrant, tx: DbTransaction): DocGrantRow | undefined {
    const rows = tx
      .select()
      .from(canvasDocGrants)
      .where(
        and(
          eq(canvasDocGrants.documentId, prepared.request.documentId),
          eq(canvasDocGrants.routeId, prepared.route.id),
          isNull(canvasDocGrants.revokedAt)
        )
      )
      .all();
    return rows.find((row) => {
      const evidence = row.approvalEvidence as { inputHash?: unknown };
      return (
        evidence?.inputHash === prepared.inputHash &&
        row.expiresAt !== null &&
        Date.parse(row.expiresAt) > Date.parse(this.#now())
      );
    });
  }
  /** Enable opener self/log authority or request/consume an exact operator verdict atomically. */
  grant(
    request: DocRouteGrantRequest,
    actor: DocGrantActor,
    approvalToken?: string
  ): DocGrantResult {
    return this.#grant(request, actor, approvalToken);
  }
  #grant(
    request: DocRouteGrantRequest,
    actor: DocGrantActor,
    approvalToken?: string,
    source?: OriginalCheckboxGrantPreparation
  ): DocGrantResult {
    if (!source) this.#refreshOriginalAuthority(request.documentId, actor);
    const settlements: ApprovalConsumptionSettlement[] = [];
    let result: DocGrantResult;
    try {
      result = this.#store.transaction((tx) => {
        if (source) requireOriginalCheckboxGrantTransaction(source, this, tx, request, actor);
        const operation = (): DocGrantResult => {
          const prepared = this.#prepare(request, actor, tx, source);
          const existing = this.#existing(prepared, tx);
          if (existing) return { kind: 'granted', grant: existing };
          if (!prepared.self && !approvalToken) {
            const detail = JSON.stringify(prepared.bindingInput);
            if (detail.length > APPROVAL_DETAIL_MAX_LENGTH)
              throw new DocRouteGrantError('APPROVAL_SUBJECT_TOO_LARGE', 422);
            const ticket = this.#deps.approvals.request({
              capabilityId: APPROVE_CAPABILITY,
              inputHash: prepared.inputHash,
              summary: `Allow document events on route ${prepared.route.id}.`,
              detail,
              area: null,
            });
            return { kind: 'approval_required', ticket };
          }
          let approvalId: string | null = null;
          let originalConsumedApproval: typeof approvals.$inferSelect | null = null;
          let approvedBy: string;
          let approvalEvidence: Record<string, unknown>;
          if (prepared.self) {
            approvedBy = prepared.openerAgentId!;
            approvalEvidence = {
              kind: 'verified_opener',
              inputHash: prepared.inputHash,
              binding: prepared.bindingInput,
            };
          } else {
            const verdict = this.#deps.approvals.consume(
              approvalToken!,
              {
                capabilityId: APPROVE_CAPABILITY,
                inputHash: prepared.inputHash,
              },
              { deferSettlement: (settlement) => settlements.push(settlement) }
            );
            if (verdict.outcome !== 'granted')
              throw new DocRouteGrantError(`APPROVAL_${verdict.outcome.toUpperCase()}`);
            const row = tx
              .select()
              .from(approvals)
              .where(eq(approvals.id, verdict.approvalId))
              .get();
            if (
              !row ||
              row.state !== 'granted' ||
              row.inputHash !== prepared.inputHash ||
              !row.decidedAt ||
              !row.consumedAt
            )
              throw new DocRouteGrantError('APPROVAL_EVIDENCE_MISMATCH');
            originalConsumedApproval = copyCurrentDocData(row);
            approvalId = row.id;
            approvedBy = `approval:${row.id}`;
            approvalEvidence = {
              kind: 'operator_approval',
              approvalId,
              state: row.state,
              inputHash: row.inputHash,
              decidedAt: row.decidedAt,
              consumedAt: row.consumedAt,
              binding: prepared.bindingInput,
            };
          }
          // No async boundary between current authority, one-use consumption and source insertion.
          const finalPrepared = this.#prepare(request, actor, tx, source);
          if (finalPrepared.inputHash !== prepared.inputHash)
            throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
          const grantId = ulid();
          const intendedGrant: DocGrantRow = {
            grantId,
            documentId: request.documentId,
            routeId: prepared.route.id,
            revision: 1,
            normalizedRoute: prepared.route,
            routeHash: hashApprovalInput(prepared.route),
            declarationHash: prepared.declarationHash,
            manifestHash: prepared.manifestHash,
            openerAgentId: prepared.openerAgentId ?? null,
            targetAgentId: prepared.target.agentId,
            targetSessionId: prepared.target.sessionId,
            targetRuntime: prepared.target.runtime,
            approvedBy,
            approvalId,
            approvalEvidence,
            allowedTypes: prepared.allowedTypes,
            limits: prepared.limits,
            writeOperation: request.write ?? null,
            createdAt: this.#now(),
            expiresAt: request.expiresAt ?? null,
            revokedAt: null,
          };
          if (source) {
            if (originalGrantInsertions.has(tx))
              throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
            originalGrantInsertions.set(tx, {
              grants: this,
              store: this.#deps.store,
              documentId: request.documentId,
              actor,
              grant: copyCurrentDocData(intendedGrant),
              approval: originalConsumedApproval,
            });
          }
          this.#store.insertGrant(intendedGrant, tx);
          return { kind: 'granted', grant: this.#store.getGrant(grantId, tx)! };
        };
        try {
          const selected = operation();
          if (source) requireOriginalCheckboxGrantTransaction(source, this, tx, request, actor);
          return selected;
        } finally {
          originalGrantInsertions.delete(tx);
        }
      });
    } catch (error) {
      for (const settlement of settlements) this.#deps.approvals.discardConsumption(settlement);
      throw error;
    }
    for (const settlement of settlements) this.#deps.approvals.publishConsumption(settlement);
    return result;
  }
  /** Explicit revoke; a later grant never implicitly retries input saved under this one. */
  revoke(documentId: string, grantId: string, actor: DocGrantActor): void {
    return this.#revoke(documentId, grantId, actor);
  }
  #revoke(documentId: string, grantId: string, actor: DocGrantActor): void {
    this.#store.transaction((tx) => {
      this.#access(documentId, actor, tx);
      const row = this.#store.getGrant(grantId, tx);
      if (!row || row.documentId !== documentId)
        throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
      const claims = actor.principal.claims;
      if (
        claims.kind !== 'operator' &&
        (!(claims.kind === 'agent' || claims.kind === 'runtime') ||
          claims.agentId !== row.openerAgentId)
      )
        throw new DocRouteGrantError('OPENER_REQUIRED');
      this.#store.revokeGrant(grantId, row.revision, this.#now(), tx);
    });
  }
}

/** Exact constructor provenance only; never returns a connection, checker or authority token. */
export function requireCurrentDocGrantEngine(
  grants: DocChannelGrantRevalidation,
  store: DocChannelStore,
  expected: Db
): void {
  const own = currentGrantEngines.get(grants);
  if (!own || own.store !== store || own.db !== expected)
    throw new Error('Current document operation requires its genuine grant constructor.');
}

/** The original owning FILE preparation invokes this captured private grant core, never reflected public methods. */
export function grantOriginalPreparedCheckboxRoute(
  grants: DocChannelGrants,
  db: Db,
  store: DocChannelStore,
  helper: OriginalCheckboxGrantPreparation,
  request: DocRouteGrantRequest,
  actor: DocGrantActor,
  token?: string
): DocGrantResult {
  const own = originalPreparedGrantCalls.get(grants);
  if (!own || own.db !== db || own.store !== store)
    throw new Error('Foreign original FILE grant constructor.');
  enterOriginalCheckboxGrantOperation(helper, grants, request, actor);
  return own.grant(helper, request, actor, token);
}

/** Invoke only the original grant constructor's configuration closure. */
export function configureOriginalDocChannel(
  grants: DocChannelGrants,
  documentId: string,
  declaration: CanvasChannelDeclaration,
  actor: DocGrantActor,
  openerAgentId?: string
): void {
  const own = originalGrantMutations.get(grants);
  if (!own) throw new DocRouteGrantError('DOC_CHANNEL_UNAVAILABLE');
  own.configure(documentId, declaration, actor, openerAgentId);
}
/** Invoke only the original grant constructor's exact approval operation. */
export function approveOriginalDocRoute(
  grants: DocChannelGrants,
  request: DocRouteGrantRequest,
  actor: DocGrantActor,
  token?: string
): DocGrantResult {
  const own = originalGrantMutations.get(grants);
  if (!own) throw new DocRouteGrantError('DOC_CHANNEL_UNAVAILABLE');
  return own.grant(request, actor, token);
}
/** Invoke only the original grant constructor's revocation closure. */
export function revokeOriginalDocRoute(
  grants: DocChannelGrants,
  documentId: string,
  grantId: string,
  actor: DocGrantActor
): void {
  const own = originalGrantMutations.get(grants);
  if (!own) throw new DocRouteGrantError('DOC_CHANNEL_UNAVAILABLE');
  own.revoke(documentId, grantId, actor);
}

/** Revalidate only the explicitly selected original route and its owning session transport. */
export function readOriginalReviewedDocReplayRoute(
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
  const binding = currentGrantBindings.get(grants),
    read = originalReviewedReplayRoutes.get(grants);
  if (!binding || binding.store !== store || !read)
    throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
  requireCurrentDocGrantEngine(grants, store, binding.db);
  return read(documentId, actor, tx, grantId, observed, inputs, room, engine);
}
