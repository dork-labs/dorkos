import { readCurrentGrantSourceRows } from '../current/current-operation-row-audit.js';
import { selectOriginalRoomGrantSource } from '../current/current-operation-intentions.js';
import {
  and,
  eq,
  isNull,
  canvasDocChannels,
  approvals,
  canvasDocGrants,
  type DbTransaction,
} from '@dorkos/db';
import { CanvasChannelGrantSchema } from '@dorkos/shared/canvas-channel-schemas';
import { type DocAppManifest } from '../app-manifest.js';
import {
  DocRouteGrantError,
  type DocGrantActor,
  type DocOriginalWriteObservation,
} from '../grant-policy.js';
import { documentTransaction } from '../storage/store-transaction.js';
import {
  grantCoreNow,
  grantCoreManifest,
  grantCoreValidateEventPayload,
  grantCoreRevalidateGrant,
  grantCoreGetEffectiveLimits,
  grantCoreGetCurrentRoutes,
} from './grant-current-core.js';
import { readCurrentDocIngressInput, type DocChannelAuthorization } from '../authorization.js';
import { copyCurrentDocData, sameCurrentDocData } from '../current/current-operation-data.js';
import { readChecked } from '../storage/store-json.js';
import { withCheckboxReadOnlyGate } from '../writes/authority/authority-snapshot.js';
import { readOriginalGrantRevalidationView } from '../grant-revalidation.js';
import type { OriginalCurrentDocumentGrantDependencies } from './grant-private-contracts.js';

/** Original base responsibility, after exact private owner recognition. */
export function privateDocumentFinal(
  grantOwner: object,
  documentId: string,
  grantIds: readonly string[],
  tx: DbTransaction
): void {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  // This original configured clock is the last observable grant phase. No callbacks follow.
  const at = Date.parse(grantCoreNow(facet.fixedServices));
  if (!Number.isFinite(at)) throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
  const rows = facet.privateSourceRows(documentId, tx);
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

/** Original base responsibility, after exact private owner recognition. */
export function privateDocumentDependencies(
  grantOwner: object,
  documentId: string,
  actor: DocGrantActor,
  grantIds: readonly string[],
  tx: DbTransaction,
  observed?: DocOriginalWriteObservation
): OriginalCurrentDocumentGrantDependencies {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  const before = facet.privateSourceRows(documentId, tx);
  const manifest = grantCoreManifest(facet.fixedServices, documentId, tx);
  const selected = grantIds.map((id) =>
    grantCoreRevalidateGrant(facet.fixedServices, documentId, id, actor, tx, observed)
  );
  const after = facet.privateSourceRows(documentId, tx);
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

/** Original base responsibility, after exact private owner recognition. */
export function privateSourceRows(
  grantOwner: object,
  documentId: string,
  tx: DbTransaction
): ReturnType<typeof readCurrentGrantSourceRows> {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  return readCurrentGrantSourceRows(documentId, tx);
}

/** Original base responsibility, after exact private owner recognition. */
export function privatePrepareCurrent(
  grantOwner: object,
  authorization: DocChannelAuthorization,
  tx: DbTransaction,
  observed?: DocOriginalWriteObservation
): import('../ingest-data/ingest-types.js').DocIngestAccess {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  const input = readCurrentDocIngressInput(authorization, facet.fixedServices.store, tx);
  if (facet.fixedClaims.has(tx)) throw new Error('Current grant selection is already captured.');
  if (input.tokenScope) return facet.privatePrepareTokenCurrent(input, authorization, tx);
  if (!input.actor) throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
  const actor = input.actor;
  observed ??= input.originalWriteObservation;
  const before = facet.privateSourceRows(input.documentId, tx);
  const selected = withCheckboxReadOnlyGate(facet.fixedServices.db, () => {
    const limits = grantCoreGetEffectiveLimits(facet.fixedServices, input.documentId, actor, tx);
    const routes = grantCoreGetCurrentRoutes(
      facet.fixedServices,
      input.documentId,
      input.event.type,
      actor,
      tx,
      observed
    );
    grantCoreValidateEventPayload(
      facet.fixedServices,
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
  const after = facet.privateSourceRows(input.documentId, tx);
  if (!sameCurrentDocData(before, after)) throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
  facet.fixedClaims.set(tx, { authorization, ...after });
  return selected;
}

/** Original base responsibility, after exact private owner recognition. */
export function privateAuditCurrent(
  grantOwner: object,
  authorization: DocChannelAuthorization,
  tx: DbTransaction
): void {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  const input = readCurrentDocIngressInput(authorization, facet.fixedServices.store, tx);
  const own = facet.fixedClaims.get(tx);
  if (!own || own.authorization !== authorization)
    throw new Error('Current grant selection is foreign.');
  const fresh = facet.privateSourceRows(input.documentId, tx);
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

/** Original base responsibility, after exact private owner recognition. */
export function privateOriginalRoomSource(
  grantOwner: object,
  authorization: DocChannelAuthorization,
  tx: DbTransaction,
  routeId: string
): ReturnType<typeof selectOriginalRoomGrantSource> {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  facet.privateAuditCurrent(authorization, tx);
  const input = readCurrentDocIngressInput(authorization, facet.fixedServices.store, tx);
  const original = facet.fixedClaims.get(tx)!;
  return selectOriginalRoomGrantSource(original, input, routeId);
}

/** Original base responsibility, after exact private owner recognition. */
export function privateReadCurrentChannel(
  grantOwner: object,
  documentId: string,
  tx: DbTransaction
): typeof canvasDocChannels.$inferSelect | undefined {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  return readChecked('canvas_doc_channels', documentId, () =>
    tx.select().from(canvasDocChannels).where(eq(canvasDocChannels.documentId, documentId)).get()
  );
}

/** Original base responsibility, after exact private owner recognition. */
export function privateRefreshCurrentAuthority(
  grantOwner: object,
  documentId: string,
  actor: DocGrantActor
): void {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  if (facet.fixedServices.db.$client.inTransaction)
    throw new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY');
  const failure = documentTransaction(facet.fixedServices.db, (tx) => {
    // Keep the original caught cause outside the plain-data authority observation.
    let failure: { cause: unknown } | undefined;
    const observed = withCheckboxReadOnlyGate(facet.fixedServices.db, () => {
      facet.privateFixedAccess(documentId, actor, tx);
      let manifest: DocAppManifest | undefined;
      try {
        manifest = facet.tokenManifestReader.read(
          facet.fixedServices.authority.sourceRoot(documentId, tx)
        );
      } catch (cause) {
        failure = { cause };
      }
      return { hash: manifest?.hash ?? null, now: facet.privateFixedNow() };
    });
    const channel = facet.privateReadCurrentChannel(documentId, tx);
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
