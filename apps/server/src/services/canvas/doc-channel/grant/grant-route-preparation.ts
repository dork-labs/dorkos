import {
  readOriginalCheckboxGrantManifest,
  type OriginalCheckboxGrantPreparation,
} from '../writes/checkbox/checkbox-grant-preparation.js';
import { CanvasChannelDeclarationSchema } from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../../core/approvals/approval-input-hash.js';
import {
  grantTypes,
  validateDocGrantTarget,
  DocRouteGrantRequestSchema,
  type DocRouteGrantRequest,
} from '../grant-policy.js';
import { and, eq, isNull, canvasDocGrants, type DbTransaction } from '@dorkos/db';
import { type DocGrantRow } from '../store.js';
import { DocRouteGrantError, declaredRoute, type DocGrantActor } from '../grant-policy.js';
import { grantCoreManifest } from './grant-current-core.js';
import { readOriginalGrantCreationView } from '../grant-revalidation.js';
import type { PreparedDocGrant } from './grant-private-contracts.js';

/** Resolve the exact binding shown for approval, using only current canonical server identity. */
export function prepare(
  grantOwner: object,
  request: DocRouteGrantRequest,
  actor: DocGrantActor,
  tx: DbTransaction
): PreparedDocGrant {
  const facet = readOriginalGrantCreationView(grantOwner);
  return facet.privatePrepare(request, actor, tx);
}

/** Original grant responsibility, after exact private owner recognition. */
export function privatePrepare(
  grantOwner: object,
  request: DocRouteGrantRequest,
  actor: DocGrantActor,
  tx: DbTransaction,
  source?: OriginalCheckboxGrantPreparation
): PreparedDocGrant {
  const facet = readOriginalGrantCreationView(grantOwner);
  const parsed = DocRouteGrantRequestSchema.parse(request);
  const { scope } = facet.privateAccess(parsed.documentId, actor, tx);
  const manifest = source
    ? readOriginalCheckboxGrantManifest(source, facet.originalOwner, tx)
    : grantCoreManifest(facet.deps, parsed.documentId, tx);
  const channel = facet.store.getChannel(parsed.documentId, tx)!;
  const route = declaredRoute(channel, parsed.routeId);
  if (
    !channel.declarationHash ||
    hashApprovalInput(CanvasChannelDeclarationSchema.parse(channel.declaration)) !==
      channel.declarationHash
  )
    throw new DocRouteGrantError('DECLARATION_HASH_MISMATCH');
  if (Date.parse(parsed.expiresAt) <= Date.parse(facet.privateNow()))
    throw new DocRouteGrantError('GRANT_EXPIRED');
  if (
    route.to !== 'log' &&
    (!channel.openerAgentId ||
      !facet.deps.authority.originCurrent(parsed.documentId, channel.openerAgentId, tx))
  )
    throw new DocRouteGrantError('ORIGIN_AUTHORITY_LOST');
  if (
    parsed.write &&
    hashApprovalInput(facet.deps.authority.resolveWriteBinding?.(parsed.documentId, tx) ?? null) !==
      hashApprovalInput(parsed.write)
  )
    throw new DocRouteGrantError('WRITE_BINDING_MISMATCH');
  const target = facet.deps.authority.resolveTarget(
    { documentId: parsed.documentId, scope, route, openerAgentId: channel.openerAgentId },
    tx
  );
  validateDocGrantTarget(scope, route, channel.openerAgentId, target);
  const allowedTypes = grantTypes(route, parsed.allowedTypes);
  const limits = { ...facet.PLATFORM_LIMITS };
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

/** Original grant responsibility, after exact private owner recognition. */
export function privateExisting(
  grantOwner: object,
  prepared: PreparedDocGrant,
  tx: DbTransaction
): DocGrantRow | undefined {
  const facet = readOriginalGrantCreationView(grantOwner);
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
      Date.parse(row.expiresAt) > Date.parse(facet.privateNow())
    );
  });
}
