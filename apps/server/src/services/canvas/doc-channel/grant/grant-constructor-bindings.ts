import { readOriginalDocumentRelayAvailability } from '../delivery/relay-authority.js';
import { readOriginalRoomReplayAvailability } from '../operations/room-current-operation.js';
import { type DbTransaction } from '@dorkos/db';
import { type DocBatchRow, requireDocChannelStoreDatabase } from '../store.js';
import { DocRouteGrantError, declaredRoute } from '../grant-policy.js';
import { grantCoreValidateEventPayload, grantCoreRevalidateGrant } from './grant-current-core.js';
import { copyCurrentDocData, sameCurrentDocData } from '../current/current-operation-data.js';
import type { DocGrantCurrentServices } from '../current/current-operation-types.js';
import { readOriginalGrantRevalidationView } from '../grant-revalidation.js';

/** Install the original constructor callbacks after the same native captures. */
export function installOriginalGrantCallbacks(
  grantOwner: object,
  fixed: DocGrantCurrentServices,
  services: DocGrantCurrentServices
): void {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  requireDocChannelStoreDatabase(services.store, services.db);
  facet.originalTokenManifestReads.set(facet.originalOwner, {
    db: fixed.db,
    store: fixed.store,
    read: (documentId) => facet.privateReadTokenManifestOutsideSql(documentId),
    source: (documentId, tx) =>
      facet.tokenManifestReader.read(facet.fixedServices.authority.sourceRoot(documentId, tx)),
    closed: () => facet.tokenManifestReader.requireClosed(),
  });
  facet.originalTokenGrantPreparers.set(facet.originalOwner, {
    db: fixed.db,
    store: fixed.store,
    prepare: (documentId, observed) => facet.privatePrepareTokenManifest(documentId, observed),
  });
  facet.originalRelayGrantReads.set(facet.originalOwner, {
    db: fixed.db,
    store: fixed.store,
    calls: Object.freeze({
      refreshGrantedAuthority: (id: string) => facet.privateRelayRefresh(id),
      revalidateBatchGrant: (batch: DocBatchRow, tx: DbTransaction) =>
        facet.privateRelayBatch(batch, tx),
    }),
  });
  facet.originalReviewedReplayRoutes.set(
    facet.originalOwner,
    (documentId, actor, tx, grantId, observed, inputs, room, engine) => {
      const before = facet.privateSourceRows(documentId, tx);
      const scope = facet.privateFixedAccess(documentId, actor, tx).scope;
      const grant = grantCoreRevalidateGrant(
        facet.fixedServices,
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
        readOriginalRoomReplayAvailability(room, engine, facet.fixedServices.db);
      const ownSession =
        scope.startsWith('session:') &&
        route.to !== 'log' &&
        route.to !== 'room:self' &&
        grant.targetSessionId !== null &&
        facet.fixedServices.authority.resolveScope(`session:${grant.targetSessionId}`, tx) ===
          scope;
      const relaySession =
        scope.startsWith('session:') &&
        route.to.startsWith('agent:') &&
        grant.targetSessionId !== null &&
        readOriginalDocumentRelayAvailability(
          facet.originalOwner,
          facet.fixedServices.authority.resolveTarget(
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
            facet.fixedServices,
            documentId,
            event.type,
            event.payload,
            actor,
            tx
          );
      }
      if (!sameCurrentDocData(before, facet.privateSourceRows(documentId, tx)))
        throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
      return copyCurrentDocData({ grant, route });
    }
  );
  facet.originalReplayRouting.set(
    facet.originalOwner,
    (documentId, actor, tx, room, engine, observed) =>
      facet.privateReplayRouting(documentId, actor, tx, room, engine, observed)
  );
  facet.currentGrantBindings.set(facet.originalOwner, {
    store: services.store,
    db: services.db,
    documentFinal: (documentId, ids, tx) => facet.privateDocumentFinal(documentId, ids, tx),
    documentDependencies: (documentId, actor, grantIds, tx, observed) =>
      facet.privateDocumentDependencies(documentId, actor, grantIds, tx, observed),
    refresh: (documentId, actor) => facet.privateRefreshCurrentAuthority(documentId, actor),
    prepare: (authorization, tx, observed) =>
      facet.privatePrepareCurrent(authorization, tx, observed),
    audit: (authorization, tx) => facet.privateAuditCurrent(authorization, tx),
    roomSource: (authorization, tx, routeId) =>
      facet.privateOriginalRoomSource(authorization, tx, routeId),
  });
}
