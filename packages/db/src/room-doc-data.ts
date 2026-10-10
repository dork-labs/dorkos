import type { NativeSpendReceipt } from './room-spend-witness.js';
import type { RoomDocCommittedFact, CommitState, NativeRoomDocCommit } from './room-doc-types.js';
import type {
  RoomDocInput,
  RoomDocMemoryFact,
  RoomDocSourceData,
  RoomDocClaimData,
  AcceptedRoomSourceKey,
} from './room-doc-types.js';
/** Private bounded data copying. Nothing in this module grants source or SDK rights. */
import { isProxy } from 'node:util/types';
import { sha256, canonicalTime } from './room-spend-input.js';

import {
  sourceStrings,
  sourceNumbers,
  sourceNullable,
  claimStrings,
  claimNumbers,
  assertRoomProducerData,
  roomProducerBindings,
} from './room-doc-lifecycle-data.js';

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || isProxy(value)) throw new Error('Invalid Room data');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('Invalid Room data prototype');
  return value as Record<string, unknown>;
}
function field(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value'))
    throw new Error('Room data requires own fields');
  return descriptor.value;
}
function copyFields(
  value: Record<string, unknown>,
  keys: readonly string[],
  kind: 'string' | 'number' | 'nullable'
) {
  const result: Record<string, string | number | null> = Object.create(null);
  for (const key of keys) {
    const item = field(value, key);
    if (
      kind === 'number'
        ? !Number.isSafeInteger(item)
        : kind === 'nullable'
          ? item !== null && typeof item !== 'string'
          : typeof item !== 'string'
    )
      throw new Error('Invalid Room data field');
    if (typeof item === 'string' && item.length > 1_048_576) throw new Error('Oversized Room data');
    result[key] = item as string | number | null;
  }
  return result;
}
function copyArray<T>(value: unknown, maximum: number, copy: (value: unknown) => T): readonly T[] {
  if (
    !value ||
    typeof value !== 'object' ||
    isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    throw new Error('Invalid Room data array');
  const size = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    !size ||
    !Object.hasOwn(size, 'value') ||
    !Number.isSafeInteger(size.value) ||
    size.value < 0 ||
    size.value > maximum
  )
    throw new Error('Oversized Room data array');
  const result: T[] = [];
  for (let index = 0; index < size.value; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item || !Object.hasOwn(item, 'value'))
      throw new Error('Room data array requires own values');
    result.push(copy(item.value));
  }
  return Object.freeze(result);
}
/** Validate and freeze a complete Room document source DATA capsule. */
export function copyRoomDocSource(input: unknown): Readonly<RoomDocSourceData> {
  const value = plain(input);
  const producerOrigin = field(value, 'producerOrigin'),
    producerBindingId = field(value, 'producerBindingId');
  if (
    producerOrigin === 'runtime'
      ? typeof producerBindingId !== 'string' || !producerBindingId.length
      : (producerOrigin !== 'operator' && producerOrigin !== 'doc_token') ||
        producerBindingId !== null
  )
    throw new Error('Invalid Room producer origin');
  const copied = {
    ...copyFields(value, sourceStrings, 'string'),
    ...copyFields(value, sourceNumbers, 'number'),
    ...copyFields(value, sourceNullable, 'nullable'),
    producerOrigin,
    producerBindingId,
    inputs: copyArray(field(value, 'inputs'), 100, (item) => {
      const row = plain(item);
      const result = {
        ...copyFields(
          row,
          ['eventId', 'envelopeHash', 'direction', 'type', 'payload', 'provenance', 'status'],
          'string'
        ),
        ...copyFields(row, ['docSeq'], 'number'),
        ...copyFields(
          row,
          ['reason', 'ackOutcome', 'acknowledgedAt', 'acknowledgedBy', 'ackEvidence'],
          'nullable'
        ),
      };
      return Object.freeze(result) as unknown as RoomDocInput;
    }),
  } as unknown as RoomDocSourceData;
  if (
    !copied.inputs.length ||
    copied.sourceAttempt < 0 ||
    copied.grantRevision < 0 ||
    !['claude-code', 'codex', 'opencode'].includes(copied.targetRuntime)
  )
    throw new Error('Invalid frozen Room source');
  const ids = JSON.parse(copied.inputEventIdsJson) as unknown;
  if (
    !Array.isArray(ids) ||
    ids.length !== copied.inputs.length ||
    new Set(ids).size !== ids.length ||
    copied.inputs.some((row, index) => row.eventId !== ids[index] || row.docSeq <= 0)
  )
    throw new Error('Invalid frozen Room input order');
  for (const hash of [
    copied.routeHash,
    copied.declarationHash,
    copied.approvalInputHash,
    copied.originalSourceHash,
    copied.inputFingerprint,
    copied.authorityDigest,
    copied.effectivePayloadDigest,
    ...copied.inputs.map((row) => row.envelopeHash),
  ])
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid Room digest');
  if (
    sha256(copied.originalSourceJson) !== copied.originalSourceHash ||
    sha256(copied.effectivePayloadJson) !== copied.effectivePayloadDigest
  )
    throw new Error('Frozen Room digest mismatch');
  const source = JSON.parse(copied.originalSourceJson) as Record<string, unknown>;
  for (const key of [
    'documentId',
    'batchId',
    'generation',
    'sourceAttempt',
    'admissionId',
    'producerOrigin',
    'producerBindingId',
  ] as const)
    if (source[key] !== copied[key]) throw new Error('Frozen source identity mismatch');
  assertRoomProducerData(copied, source);
  canonicalTime(copied.originalUpdatedAt);
  return Object.freeze(copied);
}
/** Validate and freeze claim DATA, including its source, capacity and clock bounds. */
export function copyRoomDocClaim(input: unknown): Readonly<RoomDocClaimData> {
  const value = plain(input),
    source = copyRoomDocSource(value);
  const caps: Record<string, number | null> = {};
  for (const key of ['globalCap', 'roomCap']) {
    const cap = field(value, key);
    if (cap !== null && (!Number.isSafeInteger(cap) || (cap as number) < 0))
      throw new Error('Invalid Room cap');
    caps[key] = cap as number | null;
  }
  const facts = copyArray(field(value, 'memoryFacts'), 4096, (item) => {
    const row = plain(item),
      identity = field(row, 'identity');
    if (!identity || typeof identity !== 'object' || isProxy(identity))
      throw new Error('Invalid memory identity');
    const data = copyFields(row, ['roomId'], 'string'),
      at = field(row, 'at');
    if (!Number.isSafeInteger(at)) throw new Error('Invalid memory time');
    const receipt = Object.getOwnPropertyDescriptor(row, 'receipt');
    if (receipt && !Object.hasOwn(receipt, 'value')) throw new Error('Invalid memory receipt');
    return Object.freeze({ ...data, identity, at, receipt: receipt?.value }) as RoomDocMemoryFact;
  });
  if (new Set(facts.map((fact) => fact.identity)).size !== facts.length)
    throw new Error('Duplicate memory fact');
  const result = {
    ...source,
    ...copyFields(value, claimStrings, 'string'),
    ...copyFields(value, claimNumbers, 'number'),
    ...caps,
    memoryFacts: facts,
  } as unknown as RoomDocClaimData;
  if (
    canonicalTime(result.nowIso) !== result.atMs ||
    canonicalTime(result.barrierIso) > result.atMs ||
    result.globalFloorMs > result.atMs ||
    result.documentFloorMs > result.atMs ||
    result.documentCap < 1 ||
    result.frozenCeiling < 1 ||
    result.entryDepth < 0 ||
    result.entryDepth !== result.frozenCeiling - 1 ||
    result.expectedReadSeq < 0 ||
    result.rootEntryId !== result.cascadeRoot
  )
    throw new Error('Invalid Room claim window/root');
  JSON.parse(result.appBodyJson);
  return Object.freeze(result);
}

/** Bind only named literal statement slots. This function neither executes SQL nor grants authority. */
export function copyRoomDocStatementBindings(sql: string, args: Readonly<Record<string, unknown>>) {
  const data = plain(args),
    names = [...sql.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]);
  if (!names.length) return [];
  const result: Record<string, unknown> = Object.create(null);
  for (const name of new Set(names)) {
    const value = field(data, name);
    if (!['string', 'number', 'bigint'].includes(typeof value) && value !== null)
      throw new Error('Invalid private Room binding');
    result[name] = value;
  }
  return result;
}

/** Validate the bounded document, batch and generation selector. */
export function copyRoomDocSelector(input: unknown): Readonly<AcceptedRoomSourceKey> {
  const value = plain(input),
    result = copyFields(value, ['documentId', 'batchId', 'generation'], 'string');
  if (
    Object.values(result).some(
      (value) => typeof value !== 'string' || !value.length || value.length > 4096
    )
  )
    throw new Error('Invalid Room selector');
  return Object.freeze(result) as unknown as AcceptedRoomSourceKey;
}

export type {
  RoomDocInput,
  RoomDocMemoryFact,
  RoomDocSourceData,
  RoomDocClaimData,
  RoomDocNativeFrameState,
  BarrierState,
  CommitState,
  AcceptedRoomSourceKey,
  ServerNativeRoomConstruction,
  FixedNativeRoomDocFacade,
} from './room-doc-types.js';

/** Copied fixed binding fields only; captured native epoch is read by the owning caller. */
export function roomDocBindings(
  data: RoomDocClaimData,
  bootEpoch: string,
  extra: Record<string, unknown> = {}
) {
  return { ...roomProducerBindings(data), bootEpoch, actualNativeRoomEpoch: bootEpoch, ...extra };
}

/** Compare the retained source, barrier, destination and dispatch identities. */
export function roomBarrierDataAgrees(data: RoomDocClaimData, original: RoomDocClaimData) {
  return (
    data.originalSourceJson === original.originalSourceJson &&
    data.barrierIso === original.barrierIso &&
    data.effectiveTargetSessionId === original.effectiveTargetSessionId &&
    data.dispatchId === original.dispatchId &&
    data.entryId === original.entryId
  );
}
/** Build ordered input bindings for the original claim statement. */
export function claimedInputBindings(input: RoomDocInput, ordinal: number) {
  return {
    ordinal,
    eventId: input.eventId,
    docSeq: input.docSeq,
    envelopeHash: input.envelopeHash,
    expectedDeliveryStatus: input.status,
    expectedDeliveryReason: input.reason,
  };
}
/** Freeze the committed Room fact with its native commit and spend identities. */
export function committedRoomFact(
  identity: NativeRoomDocCommit,
  data: RoomDocClaimData,
  receipt: NativeSpendReceipt
): RoomDocCommittedFact {
  return Object.freeze({
    identity,
    roomId: data.roomId,
    at: data.atMs,
    receipt,
    sourceHash: data.originalSourceHash,
    admissionId: data.admissionId,
  });
}
/** Retain a committed fact and its original row, generation and boot epoch. */
export function roomCommitData(
  fact: RoomDocCommittedFact,
  data: RoomDocClaimData,
  rowId: number,
  generation: number,
  bootEpoch: string
): CommitState {
  return { fact, data, rowId, generation, bootEpoch };
}
/** Bind the room, clock window and native epoch for an ordinary spend insert. */
export function ordinaryRoomInsertBindings(
  roomId: string,
  atMs: number,
  floorMs: number,
  floorIso: string,
  actualNativeRoomEpoch: string
) {
  return {
    roomId,
    atMs,
    floorMs,
    floorIso,
    actualNativeRoomEpoch,
  };
}

/** Decode only the exact before-effect durable capsule. Native ownership/row agreement is in lifecycle. */
export function decodeDurableAcceptedRoomSource(row: import('./room-doc-rows.js').RoomDocRow) {
  const json = row.room_source_json,
    hash = row.room_source_hash;
  if (typeof json !== 'string' || json.length > 1_048_576 || typeof hash !== 'string')
    throw new Error('Accepted Room source has no complete durable capsule.');
  const projection = plain(JSON.parse(json));
  const data = plain(field(projection, 'durableSource'));
  return copyRoomDocSource({ ...data, originalSourceJson: json, originalSourceHash: hash });
}
