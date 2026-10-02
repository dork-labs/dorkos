/** Explicit owner-authorized replay creates a new generation without repeating uncertain effects. */
import { DocChannelNotFoundError } from '../authorization.js';
import { isServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, canvasDocBatches, canvasDocDeliveries } from '@dorkos/db';
import type { CanvasChannelRoute } from '@dorkos/shared/canvas-channel-schemas';
import { matchesCanvasChannelEvent } from '@dorkos/shared/canvas-channel-schemas';
import type { DocGrantActor } from '../grant-policy.js';
import type { DocChannelGrants } from '../grants.js';
import { DocChannelStore } from '../store.js';
import { appendDocStatus } from '../status.js';
import { refuseDocBatch } from './batch-authority.js';
/** Replay requires current authenticated ownership and a currently approved grant for the same route. */
export function replayExpiredDocBatch(
  store: DocChannelStore,
  grants: DocChannelGrants,
  batchId: string,
  grantId: string,
  actor: DocGrantActor,
  now: string
): string {
  if (!isServerPrincipal(actor.principal)) throw new DocChannelNotFoundError();
  const original = store.getBatch(batchId);
  if (!original) throw new DocChannelNotFoundError();
  grants.refreshAuthority(original.documentId, actor);
  return store.transaction((tx) => {
    const old = store.getBatch(batchId, tx);
    if (
      !old ||
      old.status !== 'expired' ||
      old.admissionReceiptId ||
      old.errorCode === 'manual_replay_consumed'
    )
      refuseDocBatch('document_replay_unavailable');
    const grant = grants.revalidateGrant(old.documentId, grantId, actor, tx);
    const route = grant.normalizedRoute as CanvasChannelRoute;
    if (grant.routeId !== old.routeId || route.turn.mode === 'none')
      refuseDocBatch('document_replay_route_changed');
    for (const eventId of old.inputEventIds) {
      const event = store.getEvent(old.documentId, eventId, tx);
      if (
        !event ||
        event.payloadPrunedAt ||
        !matchesCanvasChannelEvent(route.on, event.type) ||
        !(grant.allowedTypes as string[]).some((pattern) =>
          matchesCanvasChannelEvent(pattern, event.type)
        )
      )
        refuseDocBatch('document_replay_input_unavailable');
    }
    const nextId = randomUUID();
    store.insertBatch(
      {
        batchId: nextId,
        documentId: old.documentId,
        scope: store.getChannel(old.documentId, tx)!.scope,
        routeId: old.routeId,
        grantId: grant.grantId,
        grantRevision: grant.revision,
        generation: randomUUID(),
        inputEventIds: [...old.inputEventIds],
        effectivePayload: { eventIds: [...old.inputEventIds] },
        dueAt: now,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      },
      tx
    );
    const moved = tx
      .update(canvasDocBatches)
      .set({ errorCode: 'manual_replay_consumed', updatedAt: now })
      .where(and(eq(canvasDocBatches.batchId, batchId), eq(canvasDocBatches.status, 'expired')))
      .run().changes;
    if (moved !== 1) refuseDocBatch('document_replay_raced');
    tx.update(canvasDocDeliveries)
      .set({ batchId: nextId, status: 'pending', reason: null, updatedAt: now })
      .where(
        and(
          eq(canvasDocDeliveries.batchId, old.batchId),
          inArray(canvasDocDeliveries.eventId, old.inputEventIds)
        )
      )
      .run();
    appendDocStatus(
      store,
      tx,
      old.documentId,
      {
        batchId: nextId,
        previousBatchId: old.batchId,
        routeId: old.routeId,
        status: 'pending',
        reason: 'explicit_replay',
      },
      now
    );
    return nextId;
  });
}
