import { type DbTransaction } from '@dorkos/db';
import {
  CanvasChannelGrantSchema,
  matchesCanvasChannelEvent,
  type CanvasChannelRoute,
} from '@dorkos/shared/canvas-channel-schemas';
import { CompiledCanvasAppManifest } from '@dorkos/shared/canvas-app-manifest';
import { DocRouteGrantError } from '../grant-policy.js';
import { grantCoreVerifyCurrentGrant } from './grant-current-core.js';
import { readCurrentDocIngressInput, type DocChannelAuthorization } from '../authorization.js';
import { copyCurrentDocData, sameCurrentDocData } from '../current/current-operation-data.js';
import type { DocGrantedRoute } from '../current/current-operation-types.js';
import { readOriginalGrantRevalidationView } from '../grant-revalidation.js';
import type { OriginalTokenWriteObservation } from './grant-private-contracts.js';

/** Original base responsibility, after exact private owner recognition. */
export function privatePrepareTokenManifest(
  grantOwner: object,
  documentId: string,
  observed: OriginalTokenWriteObservation
): import('../current/current-operation-types.js').OriginalDocTokenGrantPreparation {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  if (facet.fixedServices.db.$client.inTransaction)
    throw new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY');
  const manifest = facet.tokenManifestReader.readFresh(
    facet.fixedServices.authority.sourceRoot(documentId)
  );
  const stage = Object.freeze({ kind: 'original-doc-token-grant-preparation' as const });
  if (observed.manifestHash !== (manifest?.hash ?? null))
    throw new DocRouteGrantError('MANIFEST_CHANGED');
  facet.originalTokenGrantPreparations.set(stage, {
    owner: facet.originalOwner,
    documentId,
    manifest,
    observed: copyCurrentDocData(observed),
  });
  return stage;
}

/** Original base responsibility, after exact private owner recognition. */
export function privatePrepareTokenCurrent(
  grantOwner: object,
  input: ReturnType<typeof readCurrentDocIngressInput>,
  authorization: DocChannelAuthorization,
  tx: DbTransaction
): import('../ingest-data/ingest-types.js').DocIngestAccess {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  if (input.actor || !input.tokenScope || !input.tokenGrantPreparation || !input.tokenGrantIds)
    throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
  const prepared = facet.originalTokenGrantPreparations.get(input.tokenGrantPreparation);
  if (
    !prepared ||
    prepared.owner !== facet.originalOwner ||
    prepared.documentId !== input.documentId ||
    (prepared.manifest?.hash ?? null) !== input.tokenManifestHash
  )
    throw new DocRouteGrantError('MANIFEST_CHANGED');
  if (CompiledCanvasAppManifest.prototype.validate !== facet.originalTokenPayloadValidate)
    throw new DocRouteGrantError('MANIFEST_CHANGED');
  if (
    prepared.manifest &&
    Reflect.apply(facet.originalTokenPayloadValidate, prepared.manifest.compiled, [
      input.event.type,
      input.event.payload,
    ]) !== 'valid'
  )
    throw new DocRouteGrantError('PAYLOAD_INVALID', 422);
  const before = facet.privateSourceRows(input.documentId, tx);
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
      facet.fixedServices,
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
  const after = facet.privateSourceRows(input.documentId, tx);
  if (!sameCurrentDocData(before, after)) throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
  facet.fixedClaims.set(tx, { authorization, ...after });
  return copyCurrentDocData({
    documentId: input.documentId,
    scope: input.scope,
    documentLabel: input.documentLabel,
    provenance: { transport: 'http', trust: 'app_untrusted' },
    routes,
    ...limits,
  });
}

/** Original base responsibility, after exact private owner recognition. */
export function privateReadTokenManifestOutsideSql(
  grantOwner: object,
  documentId: string
): string | null {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  if (facet.fixedServices.db.$client.inTransaction)
    throw new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY');
  return (
    facet.tokenManifestReader.read(facet.fixedServices.authority.sourceRoot(documentId))?.hash ??
    null
  );
}
