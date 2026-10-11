/** Room pending-source data projection; native operation owners retain all custody and capability issuance. */
import { copyCurrentDocData, sameCurrentDocData } from './current/current-operation-data.js';
import { createHash } from 'node:crypto';
const roomSourceProjectionJson = (value: unknown): string =>
  JSON.stringify(copyCurrentDocData(value));
const roomSourceProjectionHash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
/** Literal pending-source projection only. Engine/private helper alone owns original inputs, custody and freeze issuance. */
export function buildOriginalRoomPendingSource(
  route: import('./current/current-operation-types.js').OriginalRoomRouteDraft,
  batch: import('./store.js').DocBatchRow,
  previous: import('./current/current-operation-types.js').PendingRoomSource | undefined,
  intendedInputs: ReturnType<
    typeof import('./current/current-operation-intentions.js').buildCurrentRoomInputIntention
  >,
  inputs: import('@dorkos/db/internal-server').RoomDocSourceData['inputs'],
  rawBatch: { ids: string; payload: string },
  routeId: string
): import('./current/current-operation-types.js').PendingRoomSource {
  const grant = route.original.grant;
  const effectivePayloadJson = rawBatch.payload;
  if (route.target.roomId !== batch.scope.slice('room:'.length))
    throw new Error('Original Room pending target changed.');
  const producerFields = !('kind' in route.producer)
    ? { producerOrigin: 'runtime' as const, producerBindingId: route.producer.id }
    : route.producer.kind === 'operator'
      ? { producerOrigin: 'operator' as const, producerBindingId: null }
      : { producerOrigin: 'doc_token' as const, producerBindingId: null };
  const pending: import('./current/current-operation-types.js').PendingRoomSource = {
    before: route.before,
    producerRoomFacts: route.producerRoomFacts,
    roomCustody: route.roomCustody,
    ...copyCurrentDocData({
      producer: route.producer,
      dueAt: batch.dueAt,
      source: {
        documentId: batch.documentId,
        batchId: batch.batchId,
        generation: batch.generation,
        sourceAttempt: batch.attempt,
        admissionId: previous?.source.admissionId ?? route.admissionId,
        scope: batch.scope,
        grantId: grant.grantId,
        grantRevision: grant.revision,
        routeId,
        routeHash: grant.routeHash,
        declarationHash: grant.declarationHash,
        manifestHash: grant.manifestHash,
        normalizedRouteJson: route.serializedGrant.route,
        grantLimitsJson: route.serializedGrant.limits,
        approvalId: route.original.approval.id,
        approvalInputHash: route.original.approval.inputHash,
        approvalEvidenceJson: route.serializedGrant.evidence,
        ...producerFields,
        producerEvidenceJson: roomSourceProjectionJson(
          'kind' in route.producer ? route.producer : { kind: 'runtime', binding: route.producer }
        ),
        originalSourceJson: '',
        originalSourceHash: '',
        inputEventIdsJson: rawBatch.ids,
        effectivePayloadJson,
        inputFingerprint: roomSourceProjectionHash(roomSourceProjectionJson(inputs)),
        authorityDigest: roomSourceProjectionHash(
          roomSourceProjectionJson({ grant, approval: route.original.approval })
        ),
        effectivePayloadDigest: roomSourceProjectionHash(effectivePayloadJson),
        ...route.target,
        originalError: batch.errorCode,
        originalLease: batch.leaseUntil,
        originalUpdatedAt: batch.updatedAt,
        inputs,
      },
    }),
  };
  const { originalSourceJson: _json, originalSourceHash: _hash, ...durableSource } = pending.source;
  const originalSourceJson = roomSourceProjectionJson({
    durableSource,
    dueAt: batch.dueAt,
    documentId: batch.documentId,
    batchId: batch.batchId,
    generation: batch.generation,
    sourceAttempt: batch.attempt,
    admissionId: previous?.source.admissionId ?? route.admissionId,
    originalGrant: grant,
    consumedApproval: route.original.approval,
    producerOrigin: 'kind' in route.producer ? route.producer.kind : 'runtime',
    producerBindingId: 'kind' in route.producer ? null : route.producer.id,
    producer:
      'kind' in route.producer ? route.producer : { kind: 'runtime', binding: route.producer },
    physical: route.physical,
    preEffectRows: route.before,
    ...(route.producerRoomFacts ? { producerRoomFacts: route.producerRoomFacts } : {}),
    target: route.target,
    inputs: intendedInputs,
  });
  return Object.freeze({
    ...pending,
    source: Object.freeze({
      ...pending.source,
      originalSourceJson,
      originalSourceHash: roomSourceProjectionHash(originalSourceJson),
    }),
  });
}

/** Data projection only; caller rows cannot mint authority. Helper requires native issued reacquisition first. */
export function projectDurableAcceptedRoomPending(
  source: Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>
): import('./current/current-operation-types.js').PendingRoomSource {
  const projection = JSON.parse(source.originalSourceJson) as Record<string, unknown>;
  const { originalSourceJson: _json, originalSourceHash: _hash, ...durable } = source;
  if (
    !sameCurrentDocData(projection.durableSource, durable) ||
    typeof projection.dueAt !== 'string' ||
    !Number.isFinite(Date.parse(projection.dueAt)) ||
    !projection.preEffectRows ||
    typeof projection.preEffectRows !== 'object' ||
    !projection.producer ||
    typeof projection.producer !== 'object'
  )
    throw new Error('Original durable Room capsule is incomplete.');
  const producer = projection.producer as { kind?: unknown; binding?: unknown };
  if (
    !sameCurrentDocData(projection.producer, JSON.parse(source.producerEvidenceJson)) ||
    (source.producerOrigin === 'runtime'
      ? producer.kind !== 'runtime' ||
        !producer.binding ||
        typeof producer.binding !== 'object' ||
        (producer.binding as { id?: unknown }).id !== source.producerBindingId
      : producer.kind !== source.producerOrigin || source.producerBindingId !== null)
  )
    throw new Error('Original durable producer identity disagrees.');
  return copyCurrentDocData({
    source,
    dueAt: projection.dueAt,
    before: projection.preEffectRows,
    producer: source.producerOrigin === 'runtime' ? producer.binding : producer,
    ...(projection.producerRoomFacts === undefined
      ? {}
      : { producerRoomFacts: projection.producerRoomFacts }),
  }) as import('./current/current-operation-types.js').PendingRoomSource;
}
