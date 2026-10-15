import { randomUUID } from 'node:crypto';
import {
  and,
  eq,
  sql,
  canvasDocBatches,
  canvasDocDeliveries,
  type DbTransaction,
} from '@dorkos/db';
import {
  CanvasChannelBatchReplayRequestSchema,
  CanvasChannelBatchReplayResultSchema,
  StoredPageEventSchema,
  matchesCanvasChannelEvent,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  captureCurrentHttpDocActor,
  requireCurrentDocConstructorEngines,
  DocChannelNotFoundError,
  type DocChannelActor,
} from '../../authorization.js';
import {
  readOriginalDocIngestLimits,
  captureCurrentDocIngestClock,
  type DocChannelIngest,
} from '../../ingest.js';
import { DocIngestRefusal } from '../../ingest-data/ingest-types.js';
import { requireOriginalNativeDownstreamStore, type DocChannelStore } from '../../store.js';
import type { DocChannelGrants } from '../../grants.js';
import { createOriginalDocTokenFileSourceReader } from '../../tokens/token-native-file-source.js';
import {
  readOriginalReviewedDocReplayRoute,
  prepareCurrentDocGrantRoutes,
  auditCurrentDocGrantRows,
} from '../../grant-revalidation.js';
import { readOriginalRoomPendingWriteCount } from '../../operations/room-current-operation.js';
import { documentTransaction } from '../../storage/store-transaction.js';
import { copyCurrentDocData, sameCurrentDocData } from '../current-operation-data.js';
import { readCurrentStoreGetBatch } from '../current-operation-row-audit.js';
import {
  readDocEventRow,
  scanCheckboxReservationPolicies,
} from '../../writes/reservations/reservation-policy-census.js';
import { withCheckboxReadOnlyGate } from '../../writes/authority/authority-snapshot.js';
import { protectedCapacityQuery } from '../accounting.js';
import { createOriginalExpiredReplayEnvelope } from './current-expired-replay-envelope-data.js';
import { readOriginalExpiredReplayFacet } from '../current-operation-engine.js';
/** Replay retains the original transaction, source predicates and first-cause boundary. */
export async function replayExpiredCurrent(
  owner: object,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  raw: unknown,
  rawActor: DocChannelActor
): Promise<import('@dorkos/shared/canvas-channel-schemas').CanvasChannelBatchReplayResult> {
  const own = readOriginalExpiredReplayFacet(owner);
  const request = CanvasChannelBatchReplayRequestSchema.parse(copyCurrentDocData(raw));
  const actor = captureCurrentHttpDocActor(rawActor);
  if (actor.principal.claims.kind !== 'operator') throw new DocChannelNotFoundError();
  requireCurrentDocConstructorEngines(own.authorization, store, ingest, grants);
  await own.preflightCurrent(request.documentId, actor, true);
  const reader = (own.tokenFileSourceReader ??= createOriginalDocTokenFileSourceReader(
    own.db,
    own.fixedPorts.originalRoomRepoStore
  ));
  const fileSource = reader.observe(request.documentId);
  const captured = await own.captureDocument(
    store,
    grants,
    request.documentId,
    actor,
    [request.grantId],
    undefined,
    fileSource
  );
  if (captured.generation !== request.expectedGeneration)
    throw new DocIngestRefusal('DOC_GENERATION_CHANGED', 409);
  const original = own.readDocumentAuthority(store, grants, captured.authority);
  const limits = readOriginalDocIngestLimits(ingest, store);
  const fixedStore = requireOriginalNativeDownstreamStore(store, own.db);
  own.ensureRoom();
  let committedTx: DbTransaction | undefined;
  let committedAt: string | undefined;
  try {
    const response = documentTransaction(own.db, (tx) => {
      const scope = own.beginCurrent(
        store,
        tx,
        request.documentId,
        actor,
        true,
        { expectedGeneration: request.expectedGeneration },
        captured.authority
      );
      scope.ingest = ingest;
      scope.grants = grants;
      try {
        const hasRoom = scope.scope.startsWith('room:');
        if ((!hasRoom && !scope.scope.startsWith('session:')) || (hasRoom && !own.room))
          throw new DocIngestRefusal('DOCUMENT_REPLAY_UNAVAILABLE', 409);
        const old = readCurrentStoreGetBatch(tx, request.batchId);
        if (
          !old ||
          old.documentId !== request.documentId ||
          old.scope !== scope.scope ||
          old.generation !== request.expectedBatchGeneration
        )
          throw new DocIngestRefusal('DOCUMENT_REPLAY_UNAVAILABLE', 409);
        const retained = readDocEventRow(tx, request.documentId, request.eventId);
        if (retained) {
          const payload = retained.payload as Record<string, unknown>;
          if (
            retained.direction !== 'system' ||
            retained.type !== 'event.status' ||
            !payload ||
            payload.operation !== 'explicit_replay' ||
            payload.previousBatchId !== old.batchId ||
            payload.previousGeneration !== old.generation ||
            payload.documentGeneration !== request.expectedGeneration ||
            payload.grantId !== request.grantId ||
            typeof payload.batchId !== 'string' ||
            typeof payload.generation !== 'string' ||
            old.errorCode !== 'manual_replay_consumed'
          )
            throw new DocIngestRefusal('DOC_EVENT_ID_CONFLICT', 409);
          const next = readCurrentStoreGetBatch(tx, payload.batchId);
          if (
            !next ||
            next.documentId !== request.documentId ||
            next.generation !== payload.generation ||
            next.grantId !== request.grantId ||
            next.routeId !== old.routeId ||
            !sameCurrentDocData(next.inputEventIds, old.inputEventIds)
          )
            throw new DocIngestRefusal('DOCUMENT_REPLAY_UNAVAILABLE', 409);
          const response = CanvasChannelBatchReplayResultSchema.parse({
            documentId: request.documentId,
            eventId: request.eventId,
            previousBatchId: old.batchId,
            batchId: next.batchId,
            generation: next.generation,
            status: 'duplicate',
          });
          own.finalCurrent(store, tx);
          if (
            !sameCurrentDocData(
              retained,
              readDocEventRow(tx, request.documentId, request.eventId)
            ) ||
            !sameCurrentDocData(next, readCurrentStoreGetBatch(tx, next.batchId)) ||
            !sameCurrentDocData(old, readCurrentStoreGetBatch(tx, old.batchId))
          )
            throw new DocChannelNotFoundError();
          return response;
        }
        if (
          old.status !== 'expired' ||
          old.errorCode === 'manual_replay_consumed' ||
          old.admissionReceiptId !== null ||
          old.turnId !== null ||
          old.relayMessageId !== null ||
          old.leaseUntil !== null ||
          old.deliveryKind === 'room_app_event' ||
          old.roomAdmissionId !== null ||
          old.roomSourceAttempt !== null ||
          old.roomSourceJson !== null ||
          old.roomSourceHash !== null ||
          tx.get(sql`SELECT 1 FROM room_doc_admissions WHERE document_id=${request.documentId}
              AND batch_id=${old.batchId} LIMIT 1`) ||
          tx.get(sql`SELECT 1 FROM session_message_acceptance_receipts
              WHERE source_kind='document_event_batch' AND source_id=${old.batchId} LIMIT 1`)
        )
          throw new DocIngestRefusal('DOCUMENT_REPLAY_UNAVAILABLE', 409);
        const route = readOriginalReviewedDocReplayRoute(
          grants,
          store,
          request.documentId,
          actor,
          tx,
          request.grantId,
          original.writeObservation,
          undefined,
          own.room,
          own.core
        );
        if (
          route.grant.routeId !== old.routeId ||
          old.inputEventIds.length < 1 ||
          old.inputEventIds.length > 400 ||
          new Set(old.inputEventIds).size !== old.inputEventIds.length
        )
          throw new DocIngestRefusal('DOCUMENT_REPLAY_INPUT_UNAVAILABLE', 409);
        const inputs = old.inputEventIds.map((id) => {
          const event = readDocEventRow(tx, request.documentId, id);
          if (
            !event ||
            event.direction !== 'upstream' ||
            event.payloadPrunedAt !== null ||
            !matchesCanvasChannelEvent(route.route.on, event.type) ||
            !(route.grant.allowedTypes as string[]).some((type) =>
              matchesCanvasChannelEvent(type, event.type)
            )
          )
            throw new DocIngestRefusal('DOCUMENT_REPLAY_INPUT_UNAVAILABLE', 409);
          return event;
        });
        const deliveries = tx
          .select()
          .from(canvasDocDeliveries)
          .where(
            and(
              eq(canvasDocDeliveries.documentId, request.documentId),
              eq(canvasDocDeliveries.batchId, old.batchId)
            )
          )
          .orderBy(canvasDocDeliveries.eventId, canvasDocDeliveries.routeId)
          .limit(401)
          .all();
        if (
          deliveries.length !== inputs.length ||
          deliveries.some(
            (row) =>
              row.routeId !== old.routeId ||
              !old.inputEventIds.includes(row.eventId) ||
              row.status !== 'expired' ||
              row.turnId !== null ||
              row.roomAdmissionId !== null ||
              row.deliveryKind === 'room_app_event' ||
              row.ackOutcome !== null ||
              row.ackEvidence !== null ||
              row.acknowledgedAt !== null ||
              row.acknowledgedBy !== null
          )
        )
          throw new DocIngestRefusal('DOCUMENT_REPLAY_UNAVAILABLE', 409);
        if (
          !sameCurrentDocData(
            route,
            readOriginalReviewedDocReplayRoute(
              grants,
              store,
              request.documentId,
              actor,
              tx,
              request.grantId,
              original.writeObservation,
              inputs,
              own.room,
              own.core
            )
          )
        )
          throw new DocChannelNotFoundError();
        const now = withCheckboxReadOnlyGate(own.db, () =>
          captureCurrentDocIngestClock(ingest, store, own.authorization, tx)
        );
        scope.now = now;
        scope.originalWriteObservation = original.writeObservation;
        if (hasRoom) {
          const first = inputs[0]!;
          scope.event = copyCurrentDocData(
            StoredPageEventSchema.parse({
              v: 1,
              id: first.eventId,
              type: first.type,
              payload: first.payload,
            })
          );
          const access = prepareCurrentDocGrantRoutes(grants, store, own.authorization, tx);
          const decisions = access.routes.filter(
            (decision) =>
              !decision.reason &&
              decision.grantId === request.grantId &&
              decision.route.id === old.routeId &&
              decision.route.to === 'room:self' &&
              decision.route.turn.mode !== 'none'
          );
          if (decisions.length !== 1)
            throw new DocIngestRefusal('DOCUMENT_REPLAY_TRANSPORT_UNAVAILABLE', 409);
          scope.access = { ...access, routes: decisions };
        }
        const sessionNextId = randomUUID(),
          sessionGeneration = randomUUID();
        const next = hasRoom
          ? own.room!.prepareReplay(store, grants, tx, old.batchId, now)
          : {
              batchId: sessionNextId,
              documentId: request.documentId,
              scope: scope.scope,
              routeId: old.routeId,
              grantId: route.grant.grantId,
              grantRevision: route.grant.revision,
              generation: sessionGeneration,
              inputEventIds: [...old.inputEventIds],
              effectivePayload: { eventIds: [...old.inputEventIds] },
              dueAt: now,
              status: 'pending' as const,
              createdAt: now,
              updatedAt: now,
              attempt: 0,
              leaseUntil: null,
              waitingWarningAt: null,
              relayMessageId: null,
              turnId: null,
              admissionReceiptId: null,
              deliveryKind: null,
              roomAdmissionId: null,
              roomSourceAttempt: null,
              roomSourceJson: null,
              roomSourceHash: null,
              errorCode: null,
            };
        const nextId = next.batchId,
          generation = next.generation;
        own.finalCurrent(store, tx);
        if (!sameCurrentDocData(old, readCurrentStoreGetBatch(tx, old.batchId)))
          throw new DocChannelNotFoundError();
        for (const event of inputs)
          if (!sameCurrentDocData(event, readDocEventRow(tx, request.documentId, event.eventId)))
            throw new DocChannelNotFoundError();
        if (
          !sameCurrentDocData(
            deliveries,
            tx
              .select()
              .from(canvasDocDeliveries)
              .where(
                and(
                  eq(canvasDocDeliveries.documentId, request.documentId),
                  eq(canvasDocDeliveries.batchId, old.batchId)
                )
              )
              .orderBy(canvasDocDeliveries.eventId, canvasDocDeliveries.routeId)
              .limit(401)
              .all()
          )
        )
          throw new DocChannelNotFoundError();
        const beforeChanges = tx.get<{ count: number }>(
          sql`SELECT total_changes() AS count`
        )!.count;
        if (!Number.isSafeInteger(beforeChanges)) throw new DocChannelNotFoundError();
        // The private intention is immutable JSON DATA; Drizzle receives an ordinary JSON value.
        tx.insert(canvasDocBatches)
          .values({ ...next, effectivePayload: { eventIds: [...next.inputEventIds] } })
          .run();
        const consumed = tx
          .update(canvasDocBatches)
          .set({ errorCode: 'manual_replay_consumed', updatedAt: now })
          .where(
            and(
              eq(canvasDocBatches.batchId, old.batchId),
              eq(canvasDocBatches.generation, old.generation),
              eq(canvasDocBatches.status, 'expired')
            )
          )
          .run().changes;
        if (consumed !== 1) throw new DocIngestRefusal('DOCUMENT_REPLAY_RACED', 409);
        const moved = tx
          .update(canvasDocDeliveries)
          .set({ batchId: nextId, status: 'pending', reason: null, updatedAt: now })
          .where(
            and(
              eq(canvasDocDeliveries.documentId, request.documentId),
              eq(canvasDocDeliveries.batchId, old.batchId),
              eq(canvasDocDeliveries.routeId, old.routeId),
              eq(canvasDocDeliveries.status, 'expired')
            )
          )
          .run().changes;
        if (moved !== inputs.length) throw new DocIngestRefusal('DOCUMENT_REPLAY_RACED', 409);
        // Replay adds no input or rate unit. It must still fit the original full backlog and reservation census.
        const reservations = scanCheckboxReservationPolicies(tx, {
          documentId: request.documentId,
        });
        const usage = tx.get<{ count: number; bytes: number }>(
          protectedCapacityQuery(request.documentId)
        )!;
        const installation = tx.get<{ bytes: number }>(protectedCapacityQuery())!;
        if (
          usage.count + reservations.document.originals > limits.pendingEvents ||
          usage.bytes + reservations.document.bytes > limits.pendingBytes ||
          installation.bytes + reservations.installation.bytes > limits.installationPendingBytes
        )
          throw new DocIngestRefusal('DOC_EVENT_BACKLOG_FULL', 429, 60);
        const { payload, identity } = createOriginalExpiredReplayEnvelope(
          request,
          old,
          nextId,
          generation
        );
        const saved = fixedStore.appendEvent(
          {
            documentId: request.documentId,
            eventId: request.eventId,
            direction: 'system',
            type: 'event.status',
            payload,
            envelopeHash: identity.hash,
            envelopeBytes: identity.bytes,
            provenance: { source: 'doc-channel-service' },
            receivedAt: now,
          },
          tx
        );
        scope.acceptedDocSeq = saved.docSeq;
        if (hasRoom) {
          own.room!.seal(store, tx, readOriginalDocIngestLimits(ingest, store));
          auditCurrentDocGrantRows(grants, store, own.authorization, tx);
          own.room!.audit(store, grants, tx);
        }
        const response = CanvasChannelBatchReplayResultSchema.parse({
          documentId: request.documentId,
          eventId: request.eventId,
          previousBatchId: old.batchId,
          batchId: nextId,
          generation,
          status: 'pending',
        });
        if (
          !sameCurrentDocData(
            route,
            readOriginalReviewedDocReplayRoute(
              grants,
              store,
              request.documentId,
              actor,
              tx,
              request.grantId,
              original.writeObservation,
              inputs,
              own.room,
              own.core
            )
          )
        )
          throw new DocChannelNotFoundError();
        own.finalCurrent(store, tx);
        const actual = readCurrentStoreGetBatch(tx, nextId);
        if (
          !sameCurrentDocData(actual, next) ||
          !sameCurrentDocData(readCurrentStoreGetBatch(tx, old.batchId), {
            ...old,
            errorCode: 'manual_replay_consumed',
            updatedAt: now,
          }) ||
          tx.get(sql`SELECT 1 FROM session_message_acceptance_receipts
              WHERE source_kind='document_event_batch' AND source_id IN (${old.batchId},${nextId}) LIMIT 1`)
        )
          throw new DocChannelNotFoundError();
        const finalDeliveries = tx
          .select()
          .from(canvasDocDeliveries)
          .where(
            and(
              eq(canvasDocDeliveries.documentId, request.documentId),
              eq(canvasDocDeliveries.batchId, nextId)
            )
          )
          .orderBy(canvasDocDeliveries.eventId, canvasDocDeliveries.routeId)
          .limit(401)
          .all();
        if (
          !sameCurrentDocData(
            finalDeliveries,
            deliveries.map((row) => ({
              ...row,
              batchId: nextId,
              status: 'pending',
              reason: null,
              updatedAt: now,
            }))
          ) ||
          !sameCurrentDocData(saved, readDocEventRow(tx, request.documentId, request.eventId)) ||
          tx.get<{ count: number }>(sql`SELECT total_changes() AS count`)!.count - beforeChanges !==
            inputs.length + 4 + (hasRoom ? readOriginalRoomPendingWriteCount(own.room!, tx) : 0)
        )
          throw new DocChannelNotFoundError();
        for (const event of inputs)
          if (!sameCurrentDocData(event, readDocEventRow(tx, request.documentId, event.eventId)))
            throw new DocChannelNotFoundError();
        if (hasRoom) {
          committedTx = tx;
          committedAt = now;
        }
        return response;
      } catch (cause) {
        own.room?.abandoned(tx);
        if (!scope.failure) scope.failure = { cause };
        throw scope.failure.cause;
      } finally {
        own.retireCurrent(tx);
      }
    });
    if (committedTx) own.room!.committed(committedTx, committedAt!);
    return response;
  } catch (cause) {
    if (committedTx) own.room?.abandoned(committedTx);
    throw cause;
  }
}
