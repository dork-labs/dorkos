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
  CanvasChannelDeclarationSchema,
  matchesCanvasChannelEvent,
  type CanvasChannelRoute,
} from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../core/approvals/approval-input-hash.js';
import { isServerPrincipal } from '../../connectors/principal/server-principal.js';
import { DocChannelStore, type DocGrantRow, type DocBatchRow } from './store.js';
import { readDocAppManifest, type DocAppManifest } from './app-manifest.js';
import {
  DocRouteGrantError,
  declaredRoute,
  validateDocGrantTarget,
  type DocGrantActor,
  type DocGrantAuthority,
  type DocGrantTarget,
} from './grant-policy.js';
import { DocChannelNotFoundError } from './authorization.js';
const PLATFORM_LIMITS = { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 };
/** Current route selection, including explicit reasons saved input must not dispatch. */
export interface DocGrantedRoute {
  route: CanvasChannelRoute;
  grantId?: string;
  grantRevision?: number;
  allowedTypes?: string[];
  targetSessionId?: string | null;
  reason?: string;
}

/** Shared synchronous current-authority checks for ingestion and background dispatch. */
export class DocChannelGrantRevalidation {
  /** Use current canonical authority ports without reusing an opener turn's expired proof. */
  constructor(
    protected readonly services: {
      db: Db;
      store: DocChannelStore;
      authority: DocGrantAuthority;
      now?: () => Date;
    }
  ) {}
  protected now(): string {
    return (this.services.now?.() ?? new Date()).toISOString();
  }
  protected access(
    documentId: string,
    actor: DocGrantActor,
    tx?: DbTransaction
  ): { id: string; scope: string } {
    if (!isServerPrincipal(actor.principal)) throw new DocRouteGrantError('INVALID_PRINCIPAL');
    return this.services.authority.requireCurrent(documentId, actor, true, tx);
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
    const manifest = readDocAppManifest(this.services.authority.sourceRoot(documentId, tx));
    const channel = this.services.store.getChannel(documentId, tx)!;
    if (channel.manifestHash !== (manifest?.hash ?? null))
      throw new DocRouteGrantError('MANIFEST_CHANGED');
    return manifest;
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
    this.access(documentId, actor, tx);
    const manifest = this.manifest(documentId, tx);
    const channel = this.services.store.getChannel(documentId, tx)!;
    const declaration = CanvasChannelDeclarationSchema.safeParse(channel.declaration);
    if (
      !declaration.success ||
      !declaration.data.routes.some((route) => matchesCanvasChannelEvent(route.on, type))
    )
      return;
    if (manifest && manifest.compiled.validate(type, payload) !== 'valid')
      throw new DocRouteGrantError('INVALID_DECLARED_PAYLOAD', 422);
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
    const { scope } = this.access(documentId, actor, tx);
    const grant = this.verifyCurrentGrant(documentId, grantId, scope, tx);
    try {
      // A current caller cannot reuse authority approved by a previous owner.
      // Share the persisted/current gate with dispatch, without reviving opener proofs.
      const grantedAccess = this.services.authority.requireGrantedCurrent(grant, tx);
      if (
        grantedAccess.id !== documentId ||
        this.services.authority.resolveScope(grantedAccess.scope, tx) !==
          this.services.authority.resolveScope(scope, tx)
      )
        throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
    } catch (error) {
      if (error instanceof DocChannelNotFoundError && !Object.hasOwn(error, 'cause'))
        throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
      throw error;
    }
    return grant;
  }
  private canonicalSession(sessionId: string | null, tx: DbTransaction): string | null {
    return sessionId === null
      ? null
      : this.services.authority.resolveScope(`session:${sessionId}`, tx);
  }
  private verifyEvidence(grant: DocGrantRow, scope: string, tx: DbTransaction): void {
    const evidence = grant.approvalEvidence as {
      kind?: string;
      inputHash?: string;
      binding?: Record<string, unknown>;
      approvalId?: string;
      state?: string;
      decidedAt?: string;
      consumedAt?: string;
    };
    const binding = evidence?.binding;
    const target = binding?.target as DocGrantTarget | undefined;
    if (
      !binding ||
      evidence.inputHash !== hashApprovalInput(binding) ||
      binding.documentId !== grant.documentId ||
      typeof binding.scope !== 'string' ||
      this.services.authority.resolveScope(binding.scope, tx) !== scope ||
      !target ||
      this.services.authority.resolveScope(target.scope, tx) !== scope ||
      hashApprovalInput(binding.route) !== grant.routeHash ||
      hashApprovalInput(grant.normalizedRoute) !== grant.routeHash ||
      binding.declarationHash !== grant.declarationHash ||
      binding.manifestHash !== grant.manifestHash ||
      binding.openerAgentId !== grant.openerAgentId ||
      target?.agentId !== grant.targetAgentId ||
      this.canonicalSession(target?.sessionId ?? null, tx) !==
        this.canonicalSession(grant.targetSessionId, tx) ||
      target?.runtime !== grant.targetRuntime ||
      hashApprovalInput(binding.allowedTypes) !== hashApprovalInput(grant.allowedTypes) ||
      hashApprovalInput(binding.limits) !== hashApprovalInput(grant.limits) ||
      binding.expiresAt !== grant.expiresAt ||
      hashApprovalInput(binding.write) !== hashApprovalInput(grant.writeOperation)
    )
      throw new DocRouteGrantError('GRANT_EVIDENCE_MISMATCH');
    if (evidence.kind === 'verified_opener') {
      const origin = binding.origin as { kind?: string; agentId?: string } | undefined;
      const route = grant.normalizedRoute as CanvasChannelRoute;
      if (
        grant.approvalId ||
        grant.approvedBy !== grant.openerAgentId ||
        (origin?.kind !== 'agent' && origin?.kind !== 'runtime') ||
        origin.agentId !== grant.openerAgentId ||
        (route.to !== 'log' && route.to !== 'agent:owner') ||
        grant.writeOperation
      )
        throw new DocRouteGrantError('GRANT_EVIDENCE_MISMATCH');
      return;
    }
    const approval = grant.approvalId
      ? tx.select().from(approvals).where(eq(approvals.id, grant.approvalId)).get()
      : undefined;
    if (
      evidence.kind !== 'operator_approval' ||
      !approval ||
      approval.capabilityId !== 'ui.approve_doc_route' ||
      approval.state !== 'granted' ||
      approval.inputHash !== evidence.inputHash ||
      evidence.approvalId !== approval.id ||
      grant.approvedBy !== `approval:${approval.id}` ||
      evidence.state !== approval.state ||
      !approval.decidedAt ||
      !approval.consumedAt ||
      evidence.decidedAt !== approval.decidedAt ||
      evidence.consumedAt !== approval.consumedAt
    )
      throw new DocRouteGrantError('GRANT_EVIDENCE_MISMATCH');
  }
  private verifyCurrentGrant(
    documentId: string,
    grantId: string,
    scope: string,
    tx: DbTransaction
  ): DocGrantRow {
    const manifest = this.manifest(documentId, tx);
    const channel = this.services.store.getChannel(documentId, tx)!;
    const grant = this.services.store.getGrant(grantId, tx);
    if (!grant || grant.documentId !== documentId)
      throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
    this.verifyEvidence(grant, scope, tx);
    if (grant.manifestHash !== (manifest?.hash ?? null))
      throw new DocRouteGrantError('MANIFEST_CHANGED');
    const route = declaredRoute(channel, grant.routeId);
    if (
      hashApprovalInput(CanvasChannelDeclarationSchema.parse(channel.declaration)) !==
        channel.declarationHash ||
      grant.declarationHash !== channel.declarationHash ||
      grant.routeHash !== hashApprovalInput(route)
    )
      throw new DocRouteGrantError('DECLARATION_CHANGED');
    if (grant.revokedAt) throw new DocRouteGrantError('GRANT_REVOKED');
    if (!grant.expiresAt || Date.parse(grant.expiresAt) <= Date.parse(this.now()))
      throw new DocRouteGrantError('GRANT_EXPIRED');
    if (
      grant.openerAgentId !== channel.openerAgentId ||
      (route.to !== 'log' &&
        (!grant.openerAgentId ||
          !this.services.authority.originCurrent(documentId, grant.openerAgentId, tx)))
    )
      throw new DocRouteGrantError('ORIGIN_AUTHORITY_LOST');
    const target = this.services.authority.resolveTarget(
      { documentId, scope, route, openerAgentId: channel.openerAgentId },
      tx
    );
    validateDocGrantTarget(scope, route, channel.openerAgentId, target);
    if (
      target.agentId !== grant.targetAgentId ||
      this.canonicalSession(target.sessionId, tx) !==
        this.canonicalSession(grant.targetSessionId, tx) ||
      target.runtime !== grant.targetRuntime ||
      target.agentPath !==
        (grant.approvalEvidence as { binding?: { target?: DocGrantTarget } }).binding?.target
          ?.agentPath
    )
      throw new DocRouteGrantError('TARGET_IDENTITY_CHANGED');
    if (
      grant.writeOperation &&
      hashApprovalInput(this.services.authority.resolveWriteBinding?.(documentId, tx) ?? null) !==
        hashApprovalInput(grant.writeOperation)
    )
      throw new DocRouteGrantError('WRITE_BINDING_MISMATCH');
    return grant;
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
  ): typeof PLATFORM_LIMITS {
    if (!tx) {
      this.refreshAuthority(documentId, actor);
      return this.services.store.transaction((current) =>
        this.getEffectiveLimits(documentId, actor, current)
      );
    }
    this.access(documentId, actor, tx);
    const app = this.manifest(documentId, tx)?.compiled.manifest.limits;
    return {
      envelopeBytes: app?.envelopeBytes ?? PLATFORM_LIMITS.envelopeBytes,
      eventsPerMinute: app?.eventsPerMinute ?? PLATFORM_LIMITS.eventsPerMinute,
      turnsPerHour: app?.turnsPerHour ?? PLATFORM_LIMITS.turnsPerHour,
    };
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
    this.access(documentId, actor, tx);
    this.manifest(documentId, tx);
    const channel = this.services.store.getChannel(documentId, tx)!;
    const declaration = CanvasChannelDeclarationSchema.safeParse(channel.declaration);
    if (!declaration.success) return [];
    return declaration.data.routes
      .filter((route) => type === undefined || matchesCanvasChannelEvent(route.on, type))
      .map((route) => {
        const grants = tx
          .select()
          .from(canvasDocGrants)
          .where(
            and(eq(canvasDocGrants.documentId, documentId), eq(canvasDocGrants.routeId, route.id))
          )
          .all()
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        let reason = 'ROUTE_UNAPPROVED';
        for (const grant of grants) {
          try {
            const current = this.revalidateGrant(documentId, grant.grantId, actor, tx);
            const patterns = current.allowedTypes as string[];
            if (
              type !== undefined &&
              !patterns.some((pattern) => matchesCanvasChannelEvent(pattern, type))
            ) {
              reason = 'TYPE_NOT_GRANTED';
              continue;
            }
            return {
              route,
              grantId: current.grantId,
              grantRevision: current.revision,
              allowedTypes: patterns,
              targetSessionId: current.targetSessionId,
            };
          } catch (error) {
            if (!(error instanceof DocRouteGrantError)) throw error;
            reason = error.code;
          }
        }
        return { route, reason };
      });
  }
}
