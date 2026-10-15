import { readOriginalDocumentRelayAvailability } from '../delivery/relay-authority.js';
import {
  readOriginalRoomReplayAvailability,
  type CurrentRoomOperation,
} from '../operations/room-current-operation.js';
import type { CurrentDocOperationEngineCore } from '../current/current-operation-types.js';
import { grantTypes } from '../grant-policy.js';
import { type DbTransaction } from '@dorkos/db';
import { CanvasChannelGrantSchema } from '@dorkos/shared/canvas-channel-schemas';
import {
  DocRouteGrantError,
  declaredRoute,
  type DocGrantActor,
  type DocOriginalWriteObservation,
} from '../grant-policy.js';
import { grantCoreRevalidateGrant } from './grant-current-core.js';
import { DocChannelNotFoundError } from '../authorization.js';
import { copyCurrentDocData, sameCurrentDocData } from '../current/current-operation-data.js';
import { readOriginalGrantRevalidationView } from '../grant-revalidation.js';

/** Original base responsibility, after exact private owner recognition. */
export function privateReplayRouting(
  grantOwner: object,
  documentId: string,
  actor: DocGrantActor,
  tx: DbTransaction,
  room?: CurrentRoomOperation,
  engine?: CurrentDocOperationEngineCore,
  observed?: DocOriginalWriteObservation
): import('@dorkos/shared/canvas-channel-schemas').CanvasChannelRouting {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  const before = facet.privateSourceRows(documentId, tx);
  const types = new Set<string>();
  let agentDestination = false;
  let crossTargetDestination = false;
  const scope = facet.privateFixedAccess(documentId, actor, tx).scope;
  const nativeRoomAvailable =
    scope.startsWith('room:') && room && engine
      ? readOriginalRoomReplayAvailability(room, engine, facet.fixedServices.db)
      : false;
  for (const row of before.grants) {
    try {
      const grant = grantCoreRevalidateGrant(
        facet.fixedServices,
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
          facet.fixedServices.authority.resolveScope(`session:${grant.targetSessionId}`, tx) ===
            scope) ||
        (scope.startsWith('room:') && nativeRoomAvailable && route.to === 'room:self') ||
        (scope.startsWith('session:') &&
          route.to.startsWith('agent:') &&
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
          ) === undefined);
      if (!eligible) continue;
      if (route.to !== 'log') {
        agentDestination = true;
        if (
          scope.startsWith('session:') &&
          grant.targetSessionId !== null &&
          facet.fixedServices.authority.resolveScope(`session:${grant.targetSessionId}`, tx) !==
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
  if (!sameCurrentDocData(before, facet.privateSourceRows(documentId, tx)))
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
