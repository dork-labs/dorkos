import {
  and,
  eq,
  isNull,
  canvasDocChannels,
  canvasDocGrants,
  type DbTransaction,
} from '@dorkos/db';
import { type DocGrantRow } from '../store.js';
import { readDocAppManifest, type DocAppManifest } from '../app-manifest.js';
import {
  DocRouteGrantError,
  type DocGrantActor,
  type DocOriginalWriteObservation,
} from '../grant-policy.js';
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
import type { DocGrantedRoute } from '../current/current-operation-types.js';
import { readOriginalGrantRevalidationView } from '../grant-revalidation.js';

/** Original base responsibility, after exact private owner recognition. */
export function now(grantOwner: object): string {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  return grantCoreNow(facet.services);
}

/** Original base responsibility, after exact private owner recognition. */
export function access(
  grantOwner: object,
  documentId: string,
  actor: DocGrantActor,
  tx?: DbTransaction
): { id: string; scope: string } {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  return grantCoreAccess(facet.services, documentId, actor, tx);
}

/** Original base responsibility, after exact private owner recognition. */
export function refreshManifest(
  grantOwner: object,
  documentId: string,
  tx: DbTransaction
): unknown {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  let manifest: DocAppManifest | undefined;
  let error: unknown;
  try {
    manifest = readDocAppManifest(facet.services.authority.sourceRoot(documentId, tx));
  } catch (caught) {
    error = caught;
  }
  const channel = facet.services.store.getChannel(documentId, tx)!;
  const hash = manifest?.hash ?? null;
  if (error || channel.manifestHash !== hash) {
    tx.update(canvasDocChannels)
      .set({ manifestHash: hash, updatedAt: facet.now() })
      .where(eq(canvasDocChannels.documentId, documentId))
      .run();
    facet.suspend(documentId, tx);
  }
  return error;
}

/**
 * Commit observed manifest suspension before opening an acceptance transaction.
 * Call again after a final MANIFEST_CHANGED refusal if the app raced this preflight.
 * A payload refusal or admission rollback cannot undo this explicit refresh.
 */
export function refreshAuthority(
  grantOwner: object,
  documentId: string,
  actor: DocGrantActor
): void {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  if (facet.services.db.$client.inTransaction)
    throw new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY');
  const error = facet.services.store.transaction((tx) => {
    facet.access(documentId, actor, tx);
    return facet.refreshManifest(documentId, tx);
  });
  if (error) throw error;
}

/** Refresh durable background authority without reusing an expired opener-turn principal. */
export function refreshGrantedAuthority(grantOwner: object, grantId: string): void {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  if (facet.services.db.$client.inTransaction)
    throw new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY');
  const error = facet.services.store.transaction((tx) => {
    const grant = facet.services.store.getGrant(grantId, tx);
    if (!grant) throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
    facet.services.authority.requireGrantedCurrent(grant, tx);
    return facet.refreshManifest(grant.documentId, tx);
  });
  if (error) throw error;
}

/** Original base responsibility, after exact private owner recognition. */
export function manifest(
  grantOwner: object,
  documentId: string,
  tx: DbTransaction
): DocAppManifest | undefined {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  return grantCoreManifest(facet.services, documentId, tx);
}

/** Original base responsibility, after exact private owner recognition. */
export function suspend(grantOwner: object, documentId: string, tx: DbTransaction): void {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  tx.update(canvasDocGrants)
    .set({ revokedAt: facet.now() })
    .where(and(eq(canvasDocGrants.documentId, documentId), isNull(canvasDocGrants.revokedAt)))
    .run();
}

/** Validate declared app payloads inside acceptance's transaction; undeclared types stay log-only. */
export function validateEventPayload(
  grantOwner: object,
  documentId: string,
  type: string,
  payload: unknown,
  actor: DocGrantActor,
  tx?: DbTransaction
): void {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  if (!tx) {
    facet.refreshAuthority(documentId, actor);
    return facet.services.store.transaction((current) =>
      facet.validateEventPayload(documentId, type, payload, actor, current)
    );
  }
  grantCoreValidateEventPayload(facet.services, documentId, type, payload, actor, tx);
}

/** Recheck hashes, current origin/target, expiry and revocation before a final admission effect. */
export function revalidateGrant(
  grantOwner: object,
  documentId: string,
  grantId: string,
  actor: DocGrantActor,
  tx?: DbTransaction
): DocGrantRow {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  if (!tx) {
    facet.refreshAuthority(documentId, actor);
    return facet.services.store.transaction((current) =>
      facet.revalidateGrant(documentId, grantId, actor, current)
    );
  }
  return grantCoreRevalidateGrant(facet.services, documentId, grantId, actor, tx);
}

/** Original base responsibility, after exact private owner recognition. */
export function verifyCurrentGrant(
  grantOwner: object,
  documentId: string,
  grantId: string,
  scope: string,
  tx: DbTransaction,
  observed?: DocOriginalWriteObservation
): DocGrantRow {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  return grantCoreVerifyCurrentGrant(facet.services, documentId, grantId, scope, tx, observed);
}

/** Effective document ingress caps; an app manifest can only lower platform caps. */
export function getEffectiveLimits(
  grantOwner: object,
  documentId: string,
  actor: DocGrantActor,
  tx?: DbTransaction
): ReturnType<typeof grantCoreGetEffectiveLimits> {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  if (!tx) {
    facet.refreshAuthority(documentId, actor);
    return facet.services.store.transaction((current) =>
      facet.getEffectiveLimits(documentId, actor, current)
    );
  }
  return grantCoreGetEffectiveLimits(facet.services, documentId, actor, tx);
}

/** Return current granted or saved-only route outcomes; never enqueue or replay old input. */
export function getCurrentRoutes(
  grantOwner: object,
  documentId: string,
  type: string | undefined,
  actor: DocGrantActor,
  tx?: DbTransaction
): DocGrantedRoute[] {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  if (!tx) {
    facet.refreshAuthority(documentId, actor);
    return facet.services.store.transaction((current) =>
      facet.getCurrentRoutes(documentId, type, actor, current)
    );
  }
  return grantCoreGetCurrentRoutes(facet.services, documentId, type, actor, tx);
}
