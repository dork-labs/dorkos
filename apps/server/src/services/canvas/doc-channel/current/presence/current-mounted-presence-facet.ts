import { type PresencePlan } from '../../presence.js';
import { CanvasChannelPresenceResponseSchema } from '@dorkos/shared/canvas-channel-schemas';
import { appendOriginalDocPresenceEvent, auditCurrentDocAppendIntentions } from '../../store.js';
import { sameOriginalDocTokenData } from '../../tokens/token-native-comparison.js';
import { createOriginalDocTokenFileSourceReader } from '../../tokens/token-native-file-source.js';
import { randomUUID, createHash } from 'node:crypto';
import { StoredPageEventSchema } from '@dorkos/shared/canvas-channel-schemas';
import { type DocChannelStore } from '../../store.js';
import { type DocChannelIngest } from '../../ingest.js';
import { type DocChannelGrants } from '../../grants.js';
import { documentTransaction } from '../../storage/store-transaction.js';
import { copyCurrentDocData, sameCurrentDocData } from '../current-operation-data.js';
import { envelopeIdentity } from '../../envelope.js';
import { type CurrentOperationScope } from '../current-operation-types.js';
import {
  DocChannelNotFoundError,
  requireCurrentDocConstructorEngines,
  type DocChannelActor,
} from '../../authorization.js';
import { readOriginalMountedPresenceFacet } from '../current-operation-engine.js';
/** Update mounted document presence after the original actor and currentness checks. */
export async function updatePresence(
  owner: object,
  store: DocChannelStore,
  documentId: string,
  actor: DocChannelActor,
  request?: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelPresenceRequest,
  retiredCallers: ReadonlySet<string> = new Set()
) {
  const facet = readOriginalMountedPresenceFacet(owner);
  const failure = facet.presenceFailures.get(documentId);
  if (failure) throw failure.cause;
  requireCurrentDocConstructorEngines(facet.authorization, store);
  await facet.preflightCurrent(documentId, actor, false);
  if (facet.roomPumpStopped || facet.db.$client.inTransaction || facet.currentEntry)
    throw new DocChannelNotFoundError();
  const now = facet.presenceNow();
  let plan: PresencePlan | undefined;
  let context:
    | {
        store: DocChannelStore;
        actor: DocChannelActor;
        birth: CurrentOperationScope['birth'];
        scope: string;
        callers: Map<string, DocChannelActor>;
      }
    | undefined;
  documentTransaction(facet.db, (tx) => {
    const scope = facet.beginCurrent(store, tx, documentId, actor, false, 'server-initial-replay');
    try {
      const before = facet.presenceDocuments.get(documentId);
      if (before && (before.store !== store || !sameCurrentDocData(before.birth, scope.birth)))
        throw new DocChannelNotFoundError();
      if (request) {
        const caller = createHash('sha256')
          .update(JSON.stringify(actor.principal.claims))
          .digest('hex');
        plan = facet.presenceLedger.prepare(documentId, caller, request, now);
      } else plan = facet.presenceLedger.expire(documentId, now, retiredCallers);
      context = {
        store,
        actor,
        birth: copyCurrentDocData(scope.birth),
        scope: scope.scope,
        callers: new Map(before?.callers),
      };
      if (request)
        context.callers.set(
          createHash('sha256').update(JSON.stringify(actor.principal.claims)).digest('hex'),
          actor
        );
      const transitions: {
        type: string;
        payload: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelJsonValue;
      }[] = [];
      if (plan?.closed) transitions.push({ type: 'host.closed', payload: { mounts: plan.closed } });
      if (plan?.opened) transitions.push({ type: 'host.opened', payload: { mounts: 1 } });
      if (plan?.countChanged)
        transitions.push({ type: 'doc.viewers', payload: { views: plan.views } });

      for (const transition of transitions) {
        scope.event = copyCurrentDocData(
          StoredPageEventSchema.parse({ v: 1, id: randomUUID(), ...transition })
        );
        scope.now = new Date(now).toISOString();
        const identity = envelopeIdentity(scope.event);
        facet.originalPresenceAppends.set(tx, {
          authorization: facet.authorization,
          store,
          input: {
            documentId,
            eventId: scope.event.id,
            direction: 'system',
            type: scope.event.type,
            payload: scope.event.payload,
            envelopeHash: identity.hash,
            envelopeBytes: identity.bytes,
            provenance: { source: 'doc-channel-presence' },
            receivedAt: scope.now,
          },
        });
        if (facet.roomPumpStopped) throw new DocChannelNotFoundError();
        facet.finalCurrent(store, tx);
        appendOriginalDocPresenceEvent(store, facet.authorization, tx);
      }
      if (transitions.length) auditCurrentDocAppendIntentions(store, facet.authorization, tx);
      if (facet.roomPumpStopped) throw new DocChannelNotFoundError();
      facet.finalCurrent(store, tx);
    } catch (cause) {
      if (!scope.failure) scope.failure = { cause };
      throw scope.failure.cause;
    } finally {
      facet.originalPresenceAppends.delete(tx);
      facet.retireCurrent(tx);
    }
  });
  if (plan) {
    facet.presenceLedger.commit(plan);
    if (plan.views && context) {
      for (const caller of context.callers.keys())
        if (!facet.presenceLedger.hasCaller(documentId, caller)) context.callers.delete(caller);
      facet.presenceDocuments.set(documentId, context);
    } else facet.presenceDocuments.delete(documentId);
  }
  facet.schedulePresence();
  if (!request || !plan) return;
  return CanvasChannelPresenceResponseSchema.parse({
    viewerId: plan.viewerId,
    views: plan.views,
    heartbeatMs: 30_000,
    ttlMs: 75_000,
  });
}
/** Prepare and commit document focus under the original mounted presence authority. */
export async function focusPresence(
  owner: object,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  documentId: string,
  actor: DocChannelActor,
  request: Extract<
    import('@dorkos/shared/canvas-channel-schemas').CanvasChannelPresenceRequest,
    { action: 'focus' }
  >
) {
  const facet = readOriginalMountedPresenceFacet(owner);
  const failure = facet.presenceFailures.get(documentId);
  if (failure) throw failure.cause;
  requireCurrentDocConstructorEngines(facet.authorization, store, ingest, grants);
  await facet.preflightCurrent(documentId, actor, false);
  const caller = createHash('sha256').update(JSON.stringify(actor.principal.claims)).digest('hex');
  const plan = facet.presenceLedger.prepare(documentId, caller, request, facet.presenceNow());
  if (plan.focused !== undefined) {
    const reader = (facet.tokenFileSourceReader ??= createOriginalDocTokenFileSourceReader(
      facet.db,
      facet.fixedPorts.originalRoomRepoStore
    ));
    const fileSource = reader.observe(documentId);
    const event = copyCurrentDocData(
      StoredPageEventSchema.parse({
        v: 1,
        id: randomUUID(),
        type: 'host.focus',
        payload: { focused: plan.focused },
      })
    );
    const current = await facet.captureDocument(
      store,
      grants,
      documentId,
      actor,
      [],
      undefined,
      fileSource,
      event
    );
    const stage = Object.freeze({ kind: 'original-mounted-host-focus' });
    facet.presenceFocusStages.set(stage, {
      store,
      ingest,
      grants,
      actor,
      plan,
      caller,
      event,
      fileSource,
    });
    try {
      // The original ingress applies only explicit currently approved matching routes.
      // A declaration/reserved name alone does not grant a focus turn.
      await facet.submitCurrent(
        store,
        ingest,
        grants,
        documentId,
        event,
        actor,
        { expectedGeneration: current.generation },
        current.authority,
        undefined,
        undefined,
        stage
      );
    } finally {
      facet.presenceFocusStages.delete(stage);
    }
  } else facet.presenceLedger.commit(plan);
  return CanvasChannelPresenceResponseSchema.parse({
    viewerId: plan.viewerId,
    views: plan.views,
    heartbeatMs: 30_000,
    ttlMs: 75_000,
  });
}
/** Recheck the captured focus plan before entering its original transaction. */
export function requirePresenceFocusPreflight(
  owner: object,
  stage: object,
  store: DocChannelStore
): void {
  const facet = readOriginalMountedPresenceFacet(owner);
  const own = facet.presenceFocusStages.get(stage);
  if (
    !own ||
    own.store !== store ||
    facet.roomPumpStopped ||
    facet.currentEntry ||
    facet.db.$client.inTransaction ||
    !facet.tokenFileSourceReader
  )
    throw new DocChannelNotFoundError();
  facet.presenceLedger.requireFocus(own.plan, own.caller, facet.presenceNow());
  if (
    !sameOriginalDocTokenData(
      own.fileSource,
      facet.tokenFileSourceReader.observe(own.plan.documentId)
    )
  )
    throw new DocChannelNotFoundError();
}
/** Require the original current focus plan and mounted document source. */
export function requirePresenceFocus(owner: object, stage: object, store: DocChannelStore): void {
  const facet = readOriginalMountedPresenceFacet(owner);
  const own = facet.presenceFocusStages.get(stage);
  if (!own || own.store !== store || facet.roomPumpStopped) throw new DocChannelNotFoundError();
  facet.presenceLedger.requireFocus(own.plan, own.caller, facet.presenceNow());
  if (
    !facet.currentEntry ||
    !facet.db.$client.inTransaction ||
    !facet.tokenFileSourceReader ||
    !sameOriginalDocTokenData(
      own.fileSource,
      facet.tokenFileSourceReader.observeCurrentTransaction(own.plan.documentId)
    )
  )
    throw new DocChannelNotFoundError();
}
