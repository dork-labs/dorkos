/** EXTERNAL placement proposal: validation data only; no constructor authority registry. */
import {
  and,
  eq,
  approvals,
  canvasDocChannels,
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
import {
  readDocAppManifest,
  type DocAppManifest,
  type createOriginalDocAppManifestReader,
} from './app-manifest.js';
import type { DocChannelStore, DocGrantRow } from './store.js';
import { readChecked } from './storage/store-json.js';
import {
  DocRouteGrantError,
  declaredRoute,
  validateDocGrantTarget,
  type DocGrantActor,
  type DocGrantAuthority,
  type DocGrantTarget,
  type DocOriginalWriteObservation,
} from './grant-policy.js';
import { DocChannelNotFoundError } from './authorization.js';
import type { DocGrantedRoute } from './grant-revalidation.js';
const PLATFORM_LIMITS = { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 };
export interface DocGrantCurrentCoreDependencies {
  readonly db: Db;
  readonly store: DocChannelStore;
  readonly authority: DocGrantAuthority;
  readonly now?: () => Date;
  /** Filled only by original grant constructor fixed services, never taken from caller configuration. */
  readonly originalManifestReader?: ReturnType<typeof createOriginalDocAppManifestReader>;
}
/** Fixed lexical validators return data only and never mint a scope. */
function readCurrentChannel(documentId: string, tx: DbTransaction) {
  return readChecked('canvas_doc_channels', documentId, () =>
    tx.select().from(canvasDocChannels).where(eq(canvasDocChannels.documentId, documentId)).get()
  );
}
function readCurrentGrant(grantId: string, tx: DbTransaction) {
  return readChecked('canvas_doc_grants', grantId, () =>
    tx.select().from(canvasDocGrants).where(eq(canvasDocGrants.grantId, grantId)).get()
  );
}
/** Read the configured clock for synchronous validation. */
export function grantCoreNow(services: DocGrantCurrentCoreDependencies): string {
  return (services.now?.() ?? new Date()).toISOString();
}

/** Validate the authentic principal through the supplied current-authority port. */
export function grantCoreAccess(
  services: DocGrantCurrentCoreDependencies,
  documentId: string,
  actor: DocGrantActor,
  tx?: DbTransaction
): { id: string; scope: string } {
  if (!isServerPrincipal(actor.principal)) throw new DocRouteGrantError('INVALID_PRINCIPAL');
  return services.authority.requireCurrent(documentId, actor, true, tx);
}

/** Read the current app declaration and refuse a changed persisted manifest. */
export function grantCoreManifest(
  services: DocGrantCurrentCoreDependencies,
  documentId: string,
  tx: DbTransaction
): DocAppManifest | undefined {
  const root = services.authority.sourceRoot(documentId, tx);
  const manifest = services.originalManifestReader
    ? services.originalManifestReader.read(root)
    : readDocAppManifest(root);
  const channel = readCurrentChannel(documentId, tx)!;
  if (channel.manifestHash !== (manifest?.hash ?? null))
    throw new DocRouteGrantError('MANIFEST_CHANGED');
  return manifest;
}

function grantCoreCanonicalSession(
  services: DocGrantCurrentCoreDependencies,
  sessionId: string | null,
  tx: DbTransaction
): string | null {
  return sessionId === null ? null : services.authority.resolveScope(`session:${sessionId}`, tx);
}

function grantCoreVerifyEvidence(
  services: DocGrantCurrentCoreDependencies,
  grant: DocGrantRow,
  scope: string,
  tx: DbTransaction
): void {
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
    services.authority.resolveScope(binding.scope, tx) !== scope ||
    !target ||
    services.authority.resolveScope(target.scope, tx) !== scope ||
    hashApprovalInput(binding.route) !== grant.routeHash ||
    hashApprovalInput(grant.normalizedRoute) !== grant.routeHash ||
    binding.declarationHash !== grant.declarationHash ||
    binding.manifestHash !== grant.manifestHash ||
    binding.openerAgentId !== grant.openerAgentId ||
    target?.agentId !== grant.targetAgentId ||
    grantCoreCanonicalSession(services, target?.sessionId ?? null, tx) !==
      grantCoreCanonicalSession(services, grant.targetSessionId, tx) ||
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

/** Validate the exact original grant and its current binding; return data only. */
export function grantCoreVerifyCurrentGrant(
  services: DocGrantCurrentCoreDependencies,
  documentId: string,
  grantId: string,
  scope: string,
  tx: DbTransaction,
  observed?: DocOriginalWriteObservation | Readonly<{ manifestHash: string | null; write: null }>
): DocGrantRow {
  const manifestHash = observed
    ? observed.manifestHash
    : (grantCoreManifest(services, documentId, tx)?.hash ?? null);
  const channel = readCurrentChannel(documentId, tx)!;
  const grant = readCurrentGrant(grantId, tx);
  if (!grant || grant.documentId !== documentId)
    throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
  grantCoreVerifyEvidence(services, grant, scope, tx);
  if (grant.manifestHash !== manifestHash || channel.manifestHash !== manifestHash)
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
  if (!grant.expiresAt || Date.parse(grant.expiresAt) <= Date.parse(grantCoreNow(services)))
    throw new DocRouteGrantError('GRANT_EXPIRED');
  if (
    grant.openerAgentId !== channel.openerAgentId ||
    (route.to !== 'log' &&
      (!grant.openerAgentId ||
        !services.authority.originCurrent(documentId, grant.openerAgentId, tx)))
  )
    throw new DocRouteGrantError('ORIGIN_AUTHORITY_LOST');
  const target = services.authority.resolveTarget(
    { documentId, scope, route, openerAgentId: channel.openerAgentId },
    tx
  );
  validateDocGrantTarget(scope, route, channel.openerAgentId, target);
  if (
    target.agentId !== grant.targetAgentId ||
    grantCoreCanonicalSession(services, target.sessionId, tx) !==
      grantCoreCanonicalSession(services, grant.targetSessionId, tx) ||
    target.runtime !== grant.targetRuntime ||
    target.agentPath !==
      (grant.approvalEvidence as { binding?: { target?: DocGrantTarget } }).binding?.target
        ?.agentPath
  )
    throw new DocRouteGrantError('TARGET_IDENTITY_CHANGED');
  if (
    grant.writeOperation &&
    hashApprovalInput(
      observed ? observed.write : (services.authority.resolveWriteBinding?.(documentId, tx) ?? null)
    ) !== hashApprovalInput(grant.writeOperation)
  )
    throw new DocRouteGrantError('WRITE_BINDING_MISMATCH');
  return grant;
}

/** Validate app payloads against the current declared schema. */
export function grantCoreValidateEventPayload(
  services: DocGrantCurrentCoreDependencies,
  documentId: string,
  type: string,
  payload: unknown,
  actor: DocGrantActor,
  tx: DbTransaction
): void {
  grantCoreAccess(services, documentId, actor, tx);
  const manifest = grantCoreManifest(services, documentId, tx);
  const channel = readCurrentChannel(documentId, tx)!;
  const declaration = CanvasChannelDeclarationSchema.safeParse(channel.declaration);
  if (
    !declaration.success ||
    !declaration.data.routes.some((route) => matchesCanvasChannelEvent(route.on, type))
  )
    return;
  if (manifest && manifest.compiled.validate(type, payload) !== 'valid')
    throw new DocRouteGrantError('INVALID_DECLARED_PAYLOAD', 422);
}

/** Resolve current access and validate the original grant in the caller transaction. */
export function grantCoreRevalidateGrant(
  services: DocGrantCurrentCoreDependencies,
  documentId: string,
  grantId: string,
  actor: DocGrantActor,
  tx: DbTransaction,
  observed?: DocOriginalWriteObservation
): DocGrantRow {
  const { scope } = grantCoreAccess(services, documentId, actor, tx);
  const grant = grantCoreVerifyCurrentGrant(services, documentId, grantId, scope, tx, observed);
  try {
    // A current caller cannot reuse authority approved by a previous owner.
    // Share the persisted/current gate with dispatch, without reviving opener proofs.
    const grantedAccess = services.authority.requireGrantedCurrent(grant, tx);
    if (
      grantedAccess.id !== documentId ||
      services.authority.resolveScope(grantedAccess.scope, tx) !==
        services.authority.resolveScope(scope, tx)
    )
      throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
  } catch (error) {
    if (error instanceof DocChannelNotFoundError && !Object.hasOwn(error, 'cause'))
      throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
    throw error;
  }
  return grant;
}

/** Return ingress limits bounded by the platform and current declaration. */
export function grantCoreGetEffectiveLimits(
  services: DocGrantCurrentCoreDependencies,
  documentId: string,
  actor: DocGrantActor,
  tx: DbTransaction
): typeof PLATFORM_LIMITS {
  grantCoreAccess(services, documentId, actor, tx);
  const app = grantCoreManifest(services, documentId, tx)?.compiled.manifest.limits;
  return {
    envelopeBytes: app?.envelopeBytes ?? PLATFORM_LIMITS.envelopeBytes,
    eventsPerMinute: app?.eventsPerMinute ?? PLATFORM_LIMITS.eventsPerMinute,
    turnsPerHour: app?.turnsPerHour ?? PLATFORM_LIMITS.turnsPerHour,
  };
}

/** Return current granted or saved-only route outcomes without queue effects. */
export function grantCoreGetCurrentRoutes(
  services: DocGrantCurrentCoreDependencies,
  documentId: string,
  type: string | undefined,
  actor: DocGrantActor,
  tx: DbTransaction,
  observed?: DocOriginalWriteObservation
): DocGrantedRoute[] {
  grantCoreAccess(services, documentId, actor, tx);
  grantCoreManifest(services, documentId, tx);
  const channel = readCurrentChannel(documentId, tx)!;
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
          const current = grantCoreRevalidateGrant(
            services,
            documentId,
            grant.grantId,
            actor,
            tx,
            observed
          );
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
