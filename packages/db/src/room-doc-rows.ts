import { assertRoomProducerRows } from './room-doc-lifecycle-data.js';
import { canonicalTime } from './room-spend-input.js';
/** Pure agreement checks over fixed native query data; not SDK/source authorization. */
import type { RoomDocClaimData, RoomDocSourceData } from './room-doc-data.js';
export type RoomDocRow = Record<string, unknown>;
/** Compare an accepted or prepared batch row with its original source capsule. */
export function sourceRowAgrees(
  row: RoomDocRow | undefined,
  data: RoomDocSourceData,
  stage: 'accepted' | 'prepared',
  barrierIso?: string
): boolean {
  if (!row) return false;
  const fields = {
    document_id: data.documentId,
    batch_id: data.batchId,
    generation: data.generation,
    attempt: data.sourceAttempt,
    room_source_attempt: data.sourceAttempt,
    room_admission_id: data.admissionId,
    room_source_json: data.originalSourceJson,
    room_source_hash: data.originalSourceHash,
    input_event_ids: data.inputEventIdsJson,
    effective_payload: data.effectivePayloadJson,
    grant_id: data.grantId,
    grant_revision: data.grantRevision,
    route_id: data.routeId,
    scope: data.scope,
    admission_receipt_id: null,
    delivery_kind: 'room_app_event',
    status: stage === 'accepted' ? 'accepted' : 'dispatching',
    error_code: stage === 'accepted' ? data.originalError : 'room_doc_claim_prepared',
    lease_until: stage === 'accepted' ? data.originalLease : null,
    updated_at: stage === 'accepted' ? data.originalUpdatedAt : barrierIso,
  };
  return Object.entries(fields).every(([key, value]) => row[key] === value);
}
/** Compare every ordered delivery row with the retained source inputs. */
export function inputRowsAgree(
  rows: readonly RoomDocRow[],
  data: RoomDocSourceData,
  stage: 'frozen' | 'unfrozen' = 'frozen'
): boolean {
  return (
    rows.length === data.inputs.length &&
    rows.every((row, ordinal) => {
      const expected = data.inputs[ordinal];
      const fields = {
        ordinal,
        event_id: expected.eventId,
        doc_seq: expected.docSeq,
        envelope_hash: expected.envelopeHash,
        direction: expected.direction,
        type: expected.type,
        payload: expected.payload,
        provenance: expected.provenance,
        payload_pruned_at: null,
        route_id: data.routeId,
        batch_id: data.batchId,
        status: expected.status,
        reason: expected.reason,
        delivery_kind: stage === 'frozen' ? 'room_app_event' : null,
        room_admission_id: stage === 'frozen' ? data.admissionId : null,
        ack_outcome: expected.ackOutcome,
        acknowledged_at: expected.acknowledgedAt,
        acknowledged_by: expected.acknowledgedBy,
        ack_evidence: expected.ackEvidence,
      };
      return Object.entries(fields).every(([key, value]) => row[key] === value);
    })
  );
}
/** Encode the original claimed admission and its source binding for storage. */
export function claimedRowJson(data: RoomDocClaimData, bootEpoch: string): string {
  return JSON.stringify({
    admissionId: data.admissionId,
    entryId: data.entryId,
    source: {
      documentId: data.documentId,
      batchId: data.batchId,
      generation: data.generation,
      roomId: data.roomId,
      grantId: data.grantId,
      grantRevision: data.grantRevision,
      routeId: data.routeId,
      routeHash: data.routeHash,
      declarationHash: data.declarationHash,
      manifestHash: data.manifestHash,
      inputFingerprint: data.inputFingerprint,
      authorityDigest: data.authorityDigest,
      effectivePayloadDigest: data.effectivePayloadDigest,
      agentId: data.targetAgentId,
      authorId: data.targetAuthorId,
      sessionId: data.targetSessionId,
      runtime: data.targetRuntime,
      agentPath: data.targetAgentPath,
    },
    sourceAttempt: data.sourceAttempt,
    sourceHash: data.originalSourceHash,
    dispatchAttempt: 1,
    bootEpoch,
    dispatchId: data.dispatchId,
    claimedAtMs: data.atMs,
    spendRowId: null,
    status: 'claimed',
    turnId: null,
    outcome: null,
    cascadeRoot: data.cascadeRoot,
    rootRoomId: data.rootRoomId,
    rootEntryId: data.rootEntryId,
    ceiling: data.frozenCeiling,
    producerEvidence: JSON.parse(data.producerEvidenceJson),
    createdAt: data.nowIso,
    claimedAt: data.nowIso,
    updatedAt: data.nowIso,
  });
}
/** Check that each final input link still belongs to the original admission. */
export function finalLinksAgree(rows: readonly RoomDocRow[], data: RoomDocClaimData): boolean {
  return (
    rows.length === data.inputs.length &&
    rows.every((row, ordinal) => {
      const input = data.inputs[ordinal];
      return (
        row.admission_id === data.admissionId &&
        row.document_id === data.documentId &&
        row.event_id === input.eventId &&
        row.route_id === data.routeId &&
        row.input_ordinal === ordinal &&
        row.doc_seq === input.docSeq &&
        row.envelope_hash === input.envelopeHash &&
        row.source_delivery_status === input.status &&
        row.source_delivery_reason === input.reason
      );
    })
  );
}

/** The storage constructor supplies all fixed native observations; this checks data only. */
export function assertRoomDocSourceRows(
  data: RoomDocClaimData,
  stage: 'accepted' | 'prepared',
  rows: Readonly<Record<string, unknown>>
) {
  if (
    !sourceRowAgrees(
      rows['source-batch'] as RoomDocRow | undefined,
      data,
      stage,
      data.barrierIso
    ) ||
    !inputRowsAgree(rows['ordered-source-inputs'] as RoomDocRow[], data)
  )
    throw new Error('Room source changed');
  for (const name of [
    'source-channel',
    'source-document',
    'source-grant',
    'source-approval',
    'room-current',
    'system-author',
  ])
    if (!rows[name]) throw new Error('Room durable source refused');
  assertRoomProducerRows(data, rows);
  if ((rows['room-current'] as RoomDocRow).last_read_seq !== data.expectedReadSeq)
    throw new Error('Room cursor changed');
  if (
    (JSON.parse(data.grantLimitsJson) as { turnsPerHour?: number }).turnsPerHour !==
      data.documentCap ||
    data.documentFloorMs !== data.atMs - 3_600_000
  )
    throw new Error('Room document window differs from grant');
  if (rows['original-admission']) throw new Error('Room source already claimed');
  const roots = rows['global-root'] as RoomDocRow[];
  if (rows['root-exhausted']) throw new Error('Room lineage exhausted');
  if (data.cascadeRoot === data.entryId) {
    if (roots.length || data.rootRoomId !== data.roomId) throw new Error('Invalid Room self root');
  } else if (
    roots.length !== 1 ||
    roots[0].room_id !== data.rootRoomId ||
    roots[0].id !== data.rootEntryId
  )
    throw new Error('Ambiguous or missing genuine Room root');
}
export const roomDocSourceReadOperations = Object.freeze([
  'source-batch',
  'ordered-source-inputs',
  'source-channel',
  'source-document',
  'source-grant',
  'source-approval',
  'producer-binding-history',
  'producer-origin-owner',
  'producer-origin-member',
  'room-current',
  'system-author',
  'original-admission',
  'global-root',
  'root-exhausted',
] as const);

export { matchesExtraRoomReaderSchema } from './room-doc-schema.js';

/** Pure exact data agreements; native observation and lifetime remain constructor-owned. */
export function roomPotentialRowAgrees(
  row: RoomDocRow,
  data: RoomDocClaimData,
  bootEpoch: string,
  rowId: number
) {
  return (
    row.boot_epoch === bootEpoch &&
    row.spend_row_id === rowId &&
    row.room_source_hash === data.originalSourceHash &&
    row.dispatch_id === data.dispatchId &&
    row.claimed_at_ms === data.atMs &&
    row.error_code === null &&
    ['claimed', 'turn_started'].includes(row.admission_status as string)
  );
}
/** Refuse uncertain counts or capacity exhaustion after accounting for overlap. */
export function assertRoomStrictCapacity(
  data: RoomDocClaimData,
  counts: { global_count: number; room_count: number },
  documentCount: number,
  memoryCount: number,
  roomMemoryCount: number,
  overlap: { global: number; room: number }
) {
  if (
    ![counts.global_count, counts.room_count, documentCount].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    )
  )
    throw new Error('Uncertain Room strict counts');
  const global = counts.global_count + memoryCount - overlap.global;
  const room = counts.room_count + roomMemoryCount - overlap.room;
  if (
    !Number.isSafeInteger(global) ||
    !Number.isSafeInteger(room) ||
    global < 0 ||
    room < 0 ||
    (data.globalCap !== null && global + 1 > data.globalCap) ||
    (data.roomCap !== null && room + 1 > data.roomCap) ||
    documentCount + 1 > data.documentCap
  )
    throw new Error('Room capacity exhausted');
}
/** Compare the final admission, Room entry and cursor with the original claim. */
export function finalRoomClaimRowsAgree(
  data: RoomDocClaimData,
  seq: number,
  final: RoomDocRow | undefined,
  entry: RoomDocRow | undefined,
  cursor: RoomDocRow | undefined
): boolean {
  return !(
    !final ||
    final.source_hash !== data.originalSourceHash ||
    final.entry_seq !== seq ||
    final.actual_spend_room !== data.roomId ||
    final.actual_spend_at !== data.atMs ||
    final.batch_status !== 'dispatching' ||
    !entry ||
    entry.kind !== 'app_event' ||
    entry.body !== data.appBodyJson ||
    entry.seq !== seq ||
    entry.cascade_root !== data.cascadeRoot ||
    entry.cascade_depth !== data.entryDepth ||
    cursor?.last_read_seq !== seq
  );
}

/** Refuse release when prepared delivery inputs changed. */
export function assertPreparedReleaseInputs(rows: readonly RoomDocRow[], data: RoomDocClaimData) {
  if (!inputRowsAgree(rows, data))
    throw new Error('Prepared original source changed before release');
}

/** Require a positive safe integer Room sequence. */
export function assertRoomSequence(seq: number) {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Invalid Room sequence');
}
/** Require a positive safe integer native spend row identity. */
export function assertRoomSpendIdentity(rowId: number | bigint): asserts rowId is number {
  if (typeof rowId !== 'number' || !Number.isSafeInteger(rowId) || rowId < 1)
    throw new Error('Unknown spend identity');
}
/** Require the released row to agree with the original accepted source. */
export function assertReleasedRoomSource(row: RoomDocRow, data: RoomDocClaimData) {
  if (!sourceRowAgrees(row, data, 'accepted')) throw new Error('Room release agreement failed');
}
/** Bind the entry sequence and claim JSON before its spend identity is assigned. */
export function roomClaimEntryBindings(
  data: RoomDocClaimData,
  entrySeq: number,
  bootEpoch: string
) {
  return { entrySeq, claimRowJsonWithNullSpend: claimedRowJson(data, bootEpoch) };
}
/** Select retained memory facts inside the original global accounting window. */
export function roomClaimMemory(data: RoomDocClaimData) {
  return data.memoryFacts.filter((fact) => fact.at > data.globalFloorMs && fact.at <= data.atMs);
}
/** Check original observed database and memory counts against strict capacity. */
export function assertRoomObservedCapacity(
  data: RoomDocClaimData,
  counts: { global_count: number; room_count: number },
  document: { document_count: number },
  memory: readonly import('./room-doc-types.js').RoomDocMemoryFact[],
  overlap: { global: number; room: number }
) {
  assertRoomStrictCapacity(
    data,
    counts,
    document.document_count,
    memory.length,
    memory.filter((fact) => fact.roomId === data.roomId).length,
    overlap
  );
}
/** Read the accounting time and validity of a potential or prepared claim. */
export function roomPotentialTime(row: RoomDocRow, at: number, floor: number) {
  const prepared =
    row.error_code === 'room_doc_claim_prepared' ||
    row.error_code === 'room_doc_claim_prepared_unknown';
  const time = prepared ? canonicalTime(row.updated_at as string) : row.claimed_at_ms;
  return {
    prepared,
    valid: Number.isSafeInteger(time) && (time as number) <= at,
    expired: (time as number) <= floor,
  };
}

/** Freeze a confirmed accepted row as read-only DATA. */
export function confirmedAcceptedRoomRow(row: RoomDocRow) {
  return { state: 'confirmed' as const, value: Object.freeze({ ...row }) };
}

/** Compare a potential commit row with the retained generation and spend. */
export function roomPotentialCommitRowsAgree(
  row: RoomDocRow,
  known: import('./room-doc-types.js').CommitState,
  generation: number
) {
  return (
    known.generation === generation &&
    roomPotentialRowAgrees(row, known.data, known.bootEpoch, known.rowId)
  );
}
/** Check prepared status and source agreement at the original barrier. */
export function roomPreparedSourceRowAgrees(
  row: RoomDocRow,
  data: RoomDocClaimData,
  status: string,
  prepared: boolean
) {
  return (
    status === 'prepared' && prepared && sourceRowAgrees(row, data, 'prepared', data.barrierIso)
  );
}
