import { buildRoomDocAppBody } from '../../../rooms/data/room-rows.js';
/** EXTERNAL candidate. Data capture never creates authority or exposes a connection. */
import { types } from 'node:util';
import {
  inspectCanvasChannelJson,
  CANVAS_CHANNEL_STATE_BYTES,
} from '@dorkos/shared/canvas-channel-schemas';

/** Capture configured values once, without invoking getters or substituting genuine identities. */
export function captureCurrentDocConfiguration<T extends object>(value: T): T {
  if (types.isProxy(value)) throw new Error('Current document configuration must be own data.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('Current document configuration must be plain.');
  if (Object.getOwnPropertySymbols(value).length)
    throw new Error('Current document configuration cannot have symbols.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors))
    if (!('value' in descriptor))
      throw new Error('Current document configuration cannot have accessors.');
  return Object.freeze(Object.create(prototype, descriptors));
}

/** Copy only inspectable JSON data. Authentic actors, engines and callbacks remain separate. */
export function copyCurrentDocData<T>(value: T): T {
  // Refuse proxies BEFORE reflection, including arrays and nested/revoked proxies. Build a
  // descriptor-only parallel tree before the shared bounded JSON inspector sees any value.
  const ancestors = new Set<object>();
  const copy = (item: unknown, depth: number): unknown => {
    if (item === null || typeof item !== 'object') return item;
    if (types.isProxy(item)) throw new Error('Current document data cannot contain proxies.');
    if (depth > 32 || ancestors.has(item))
      throw new Error('Current document data is not bounded JSON.');
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      throw new Error('Current document data must be plain JSON.');
    if (Object.getOwnPropertySymbols(item).length)
      throw new Error('Current document data cannot contain symbols.');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const length = array ? descriptors.length : undefined;
    if (
      array &&
      (!length ||
        !('value' in length) ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0 ||
        length.value > CANVAS_CHANNEL_STATE_BYTES)
    )
      throw new Error('Current document data array is invalid.');
    const keys = array
      ? Array.from({ length: length!.value }, (_, index) => String(index))
      : Object.keys(descriptors).sort();
    if (
      keys.length > CANVAS_CHANNEL_STATE_BYTES ||
      (array && Object.keys(descriptors).length !== keys.length + 1)
    )
      throw new Error('Current document data container is invalid.');
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    ancestors.add(item);
    try {
      for (const key of keys) {
        const field = descriptors[key];
        if (
          !field ||
          !('value' in field) ||
          !field.enumerable ||
          ['__proto__', 'prototype', 'constructor'].includes(key)
        )
          throw new Error('Current document data cannot contain unsafe fields.');
        Object.defineProperty(result, key, {
          value: copy(field.value, depth + 1),
          enumerable: true,
        });
      }
    } finally {
      ancestors.delete(item);
    }
    return Object.freeze(result);
  };
  const copied = copy(value, 0);
  const problem = inspectCanvasChannelJson(copied, CANVAS_CHANNEL_STATE_BYTES);
  if (problem) throw new Error(problem);
  return copied as T;
}

/** Compare inspectable immutable row data independently from driver property insertion order. */
export function sameCurrentDocData(left: unknown, right: unknown): boolean {
  return JSON.stringify(copyCurrentDocData(left)) === JSON.stringify(copyCurrentDocData(right));
}

/** Literal pure JSON comparison only; original native grant/approval authority is separate. */
export function sameOriginalRoomSerializedGrantData(
  serialized:
    import('./current-operation-types.js').OriginalRoomRouteDraft['serializedGrant'] | undefined,
  grant: import('./current-operation-types.js').OriginalRoomRouteDraft['original']['grant']
): boolean {
  return (
    !!serialized &&
    sameCurrentDocData(JSON.parse(serialized.route), grant.normalizedRoute) &&
    sameCurrentDocData(JSON.parse(serialized.limits), grant.limits) &&
    sameCurrentDocData(JSON.parse(serialized.evidence), grant.approvalEvidence)
  );
}
/** Literal immutable field projection; it issues no actor, grant, operation or SDK permission. */
export function copyOriginalRoomSerializedInputData(
  raw: { payload: string; provenance: string; evidence: string | null } | undefined,
  original: import('../store.js').DocEventRow,
  delivery: import('../store.js').DocDeliveryRow
): import('@dorkos/db/internal-server').RoomDocSourceData['inputs'][number] {
  if (
    !raw ||
    !sameCurrentDocData(JSON.parse(raw.payload), original.payload) ||
    !sameCurrentDocData(JSON.parse(raw.provenance), original.provenance) ||
    !sameCurrentDocData(
      raw.evidence === null ? null : JSON.parse(raw.evidence),
      delivery.ackEvidence
    )
  )
    throw new Error('Room serialized input differs from its pre-effect intention.');
  return {
    eventId: original.eventId,
    docSeq: original.docSeq,
    envelopeHash: original.envelopeHash,
    direction: original.direction,
    type: original.type,
    payload: raw.payload,
    provenance: raw.provenance,
    status: delivery.status,
    reason: delivery.reason,
    ackOutcome: delivery.ackOutcome,
    acknowledgedAt: delivery.acknowledgedAt,
    acknowledgedBy: delivery.acknowledgedBy,
    ackEvidence: raw.evidence,
  };
}

/** Pure original claim field projection; current owner/SDK/SQL/FIRST checks stay in the delegate. */
export function projectOriginalRoomClaimData(
  source: Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>,
  producer: import('./current-operation-types.js').FrozenRoomSourceData['producerRoomFacts'],
  fixed: Readonly<{
    nowIso: string;
    at: number;
    systemAuthorId: string;
    entryId: string;
    dispatchId: string;
    maxAgentDepth: number;
    expectedReadSeq: number;
    effectiveTargetSessionId?: string;
  }>
): import('@dorkos/db/internal-server').RoomDocClaimData {
  const depth = producer ? producer.entry.cascadeDepth + 1 : 0;
  if (!Number.isSafeInteger(depth) || depth < 0 || depth >= fixed.maxAgentDepth)
    throw new Error('Original Room app event exceeds the current cascade depth policy.');
  const limits = JSON.parse(source.grantLimitsJson);
  return {
    ...source,
    effectiveTargetSessionId: fixed.effectiveTargetSessionId ?? source.targetSessionId,
    barrierIso: fixed.nowIso,
    nowIso: fixed.nowIso,
    atMs: fixed.at,
    globalFloorMs: fixed.at - 3_600_000,
    documentFloorMs: fixed.at - 3_600_000,
    globalCap: null,
    roomCap: null,
    documentCap: limits.turnsPerHour,
    systemAuthorId: fixed.systemAuthorId,
    entryId: fixed.entryId,
    appBodyJson: JSON.stringify(buildRoomDocAppBody(source)),
    cascadeRoot: producer?.root.id ?? fixed.entryId,
    rootRoomId: producer?.root.roomId ?? source.roomId,
    rootEntryId: producer?.root.id ?? fixed.entryId,
    entryDepth: depth,
    // Isolate the explicitly granted target: its reply reaches this frozen ceiling.
    frozenCeiling: depth + 1,
    expectedReadSeq: fixed.expectedReadSeq,
    dispatchId: fixed.dispatchId,
    memoryFacts: [],
  };
}

/** Copy/validate destination row data only. Native exact-Db, member, grant and current checks remain original. */
export function projectOriginalRoomDestinationData(
  membership: ReturnType<
    import('@dorkos/db/internal-server').FixedNativeRoomDocFacade['readCurrentRoomMembership']
  >,
  systemMembership: ReturnType<
    import('@dorkos/db/internal-server').FixedNativeRoomDocFacade['readCurrentRoomMembership']
  >,
  targetAuthorId: string
): Readonly<{ systemAuthorId: string; expectedReadSeq: number }> {
  const member = membership.members.find((row) => row.author_id === targetAuthorId);
  const system = systemMembership.authors.find(
    (row) => row.kind === 'system' && row.natural_key === 'system' && row.retired_at === null
  );
  if (
    !member ||
    !system ||
    typeof system.id !== 'string' ||
    !Number.isSafeInteger(member.last_read_seq) ||
    Number(member.last_read_seq) < 0
  )
    throw new Error('Room destination cursor/system author is unavailable.');
  return Object.freeze({
    systemAuthorId: system.id,
    expectedReadSeq: Number(member.last_read_seq),
  });
}
