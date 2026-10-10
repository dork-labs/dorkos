import { canonicalTime } from './room-spend-input.js';
/** Pure lifecycle row agreement and copied bindings. No native/Db/frame/authority. */
import type { RoomDocRow } from './room-doc-rows.js';
import { inputRowsAgree } from './room-doc-rows.js';
import type {
  RoomDocSourceData,
  RoomDocClaimData,
  RoomDocInput,
  AcceptedRoomSourceKey,
} from './room-doc-types.js';
/** Encode row DATA for equality checks while preserving native bigint values. */
export function roomRowIdentity(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? ['native-bigint', String(item)] : item
    ) ?? 'native-undefined'
  );
}
/** Refuse empty or oversized native Room selectors. */
export function roomSelectorString(value: string): string {
  if (typeof value !== 'string' || value.length > 4096 || !value.length)
    throw new Error('Invalid native Room selector');
  return value;
}
/** Freeze native row copies containing only supported scalar values. */
export function copyPrimitiveRoomRead(value: RoomDocRow | readonly RoomDocRow[] | undefined) {
  const row = (data: RoomDocRow) => {
    for (const item of Object.values(data))
      if (item !== null && !['string', 'number', 'bigint'].includes(typeof item))
        throw new Error('Unsupported native Room row');
    return Object.freeze({ ...data });
  };
  return Array.isArray(value)
    ? Object.freeze(value.map(row))
    : value === undefined
      ? undefined
      : row(value as RoomDocRow);
}
/** Require the lifecycle row to match the original claim, boot and spend. */
export function assertLifecycleAdmissionRow(
  row: RoomDocRow | undefined,
  data: RoomDocClaimData,
  bootEpoch: string,
  spendRowId: number
): asserts row is RoomDocRow {
  if (
    !row ||
    row.boot_epoch !== bootEpoch ||
    row.dispatch_id !== data.dispatchId ||
    row.spend_row_id !== spendRowId ||
    row.source_hash !== data.originalSourceHash ||
    row.source_attempt !== data.sourceAttempt ||
    row.generation !== data.generation ||
    !['claimed', 'turn_started'].includes(row.status as string)
  )
    throw new Error('Lost Room lifecycle admission');
}
/** Build lifecycle statement bindings from the retained claim and row. */
export function lifecycleBindings(
  data: RoomDocClaimData,
  row: RoomDocRow,
  bootEpoch: string,
  spendRowId: number,
  nowIso: string
) {
  return {
    ...data,
    bootEpoch,
    actualSpendRowId: spendRowId,
    nowIso,
    expectedStatus: row.status,
    expectedBatchStatus: row.status === 'claimed' ? 'dispatching' : 'turn_started',
  };
}
/** Bind the terminal batch outcome and its corresponding error code. */
export function terminalBatchBindings(
  bindings: Readonly<Record<string, unknown>>,
  outcome: string
) {
  return {
    ...bindings,
    terminalBatchStatus: outcome,
    terminalErrorCode: outcome === 'turn_done' ? null : 'room_doc_' + outcome,
  };
}
/** Verify delivery custody before binding a projected, unknown or terminal transition. */
export function lifecycleInputBindings(
  data: RoomDocClaimData,
  row: RoomDocRow,
  old: RoomDocRow,
  input: RoomDocInput,
  bindings: Readonly<Record<string, unknown>>,
  kind: 'projected' | 'unknown' | 'terminal',
  value?: string
) {
  if (
    old.event_id !== input.eventId ||
    old.doc_seq !== input.docSeq ||
    old.envelope_hash !== input.envelopeHash ||
    old.route_id !== data.routeId ||
    old.batch_id !== data.batchId ||
    old.room_admission_id !== data.admissionId ||
    old.delivery_kind !== 'room_app_event' ||
    old.status !== (row.status === 'claimed' ? input.status : 'turn_started') ||
    old.reason !== (row.status === 'claimed' ? 'room_doc_claimed' : 'room_doc_turn_started')
  )
    throw new Error('Room lifecycle input custody changed');
  const nextDeliveryStatus =
    kind === 'projected' ? 'turn_started' : kind === 'unknown' ? 'in_doubt' : value!;
  const nextDeliveryReason =
    kind === 'unknown' ? 'room_doc_claim_unknown' : 'room_doc_' + nextDeliveryStatus;
  const nextTurnId = kind === 'projected' ? value! : row.turn_id;
  return {
    ...bindings,
    eventId: input.eventId,
    nextDeliveryStatus,
    nextDeliveryReason,
    nextTurnId,
    oldDeliveryStatus: old.status,
    oldDeliveryReason: old.reason,
    oldTurnId: old.turn_id,
  };
}
/** Require lifecycle JSON to agree with the persisted status and turn fields. */
export function assertLifecycleRowJson(row: RoomDocRow): void {
  const json = JSON.parse(row.row_json as string);
  if (
    json.status !== row.status ||
    json.outcome !== row.outcome ||
    json.turnId !== row.turn_id ||
    json.updatedAt !== row.updated_at
  )
    throw new Error('Room lifecycle JSON disagreement');
}
/** Require the pending batch and ordered inputs to match the accepted source. */
export function assertOriginalFreezeRows(
  row: RoomDocRow | undefined,
  inputs: readonly RoomDocRow[],
  data: RoomDocSourceData
): asserts row is RoomDocRow {
  if (
    !row ||
    !['pending', 'waiting'].includes(row.status as string) ||
    row.generation !== data.generation ||
    row.attempt !== data.sourceAttempt ||
    row.grant_id !== data.grantId ||
    row.grant_revision !== data.grantRevision ||
    row.route_id !== data.routeId ||
    row.input_event_ids !== data.inputEventIdsJson ||
    row.effective_payload !== data.effectivePayloadJson ||
    row.updated_at !== data.originalUpdatedAt ||
    !inputRowsAgree(inputs, data, 'unfrozen')
  )
    throw new Error('Original accepted Room source changed');
}
/** Bind the original batch fields used by the source freeze comparison. */
export function originalFreezeBindings(data: RoomDocSourceData, row: RoomDocRow) {
  return {
    ...data,
    nowIso: data.originalUpdatedAt,
    oldBatchStatus: row.status,
    oldInputEventIdsJson: row.input_event_ids,
    oldEffectivePayloadJson: row.effective_payload,
  };
}
/** Freeze the document, batch and generation DATA selector. */
export function acceptedSourceKey(data: RoomDocSourceData): Readonly<AcceptedRoomSourceKey> {
  return Object.freeze({
    documentId: data.documentId,
    batchId: data.batchId,
    generation: data.generation,
  });
}
/** Bind receipt retention cutoffs and the original admission identity. */
export function pruneReceiptBindings(
  row: RoomDocRow,
  documentFloorMs: number,
  receiptRetentionCutoffIso: string
) {
  return {
    admissionId: row.admission_id,
    documentId: row.document_id,
    documentFloorMs,
    receiptRetentionCutoffIso,
  };
}

/** Bind one original input and its expected delivery status for freezing. */
export function frozenInputBindings(data: RoomDocSourceData, input: RoomDocInput) {
  return {
    ...data,
    nowIso: data.originalUpdatedAt,
    eventId: input.eventId,
    expectedDeliveryStatus: input.status,
    expectedDeliveryReason: input.reason,
  };
}
/** Validate the bounded accepted-source scan cursor. */
export function acceptedUnclaimedBindings(cursorAt: string, cursorId: string) {
  if (cursorAt) canonicalTime(cursorAt);
  if (typeof cursorId !== 'string' || cursorId.length > 4096)
    throw new Error('Invalid Room scan cursor');
  return { cursorAt, cursorId };
}

/** Retain an operation, copied bindings and encoded observed row DATA. */
export function roomObservedData(
  operation: import('./room-doc-statements.js').RoomDocNativeOperation,
  bindings: Record<string, unknown>,
  value: unknown
): import('./room-doc-types.js').RoomDocObservedRow {
  return { operation, bindings: { ...bindings }, value: roomRowIdentity(value) };
}

/** Encode the document, batch and generation as a stable lookup key. */
export function roomDocBatchKey(data: RoomDocClaimData) {
  return JSON.stringify([data.documentId, data.batchId, data.generation]);
}
/** Wrap the native insert result with its inserted-state discriminator. */
export function ordinaryInsertedResult(result: import('better-sqlite3').RunResult) {
  return { state: 'inserted' as const, result };
}

export const sourceStrings = [
  'documentId',
  'batchId',
  'generation',
  'admissionId',
  'scope',
  'roomId',
  'grantId',
  'routeId',
  'routeHash',
  'declarationHash',
  'normalizedRouteJson',
  'grantLimitsJson',
  'approvalId',
  'approvalInputHash',
  'approvalEvidenceJson',
  'producerEvidenceJson',
  'originalSourceJson',
  'originalSourceHash',
  'inputEventIdsJson',
  'effectivePayloadJson',
  'inputFingerprint',
  'authorityDigest',
  'effectivePayloadDigest',
  'targetAgentId',
  'targetAuthorId',
  'targetSessionId',
  'targetRuntime',
  'targetAgentPath',
  'originalUpdatedAt',
] as const;
export const sourceNumbers = ['sourceAttempt', 'grantRevision'] as const;
export const sourceNullable = ['manifestHash', 'originalError', 'originalLease'] as const;
export const claimStrings = [
  'effectiveTargetSessionId',
  'barrierIso',
  'nowIso',
  'systemAuthorId',
  'entryId',
  'appBodyJson',
  'cascadeRoot',
  'rootRoomId',
  'rootEntryId',
  'dispatchId',
] as const;
export const claimNumbers = [
  'atMs',
  'globalFloorMs',
  'documentFloorMs',
  'documentCap',
  'entryDepth',
  'frozenCeiling',
  'expectedReadSeq',
] as const;

/** Data equality only. Genuine principal/installation provenance belongs to original F2. */
export function assertRoomProducerData(data: RoomDocSourceData, original: Record<string, unknown>) {
  const evidence = JSON.parse(data.producerEvidenceJson) as Record<string, unknown>;
  if (
    !evidence ||
    typeof evidence !== 'object' ||
    Array.isArray(evidence) ||
    evidence.kind !== data.producerOrigin ||
    JSON.stringify(original.producer) !== data.producerEvidenceJson
  )
    throw new Error('Room producer evidence differs');
  if (data.producerOrigin === 'runtime') {
    if (
      !evidence.binding ||
      (evidence.binding as Record<string, unknown>).id !== data.producerBindingId
    )
      throw new Error('Room runtime producer binding differs');
    return;
  }
  if (data.producerOrigin === 'doc_token') {
    if (
      typeof evidence.tokenId !== 'string' ||
      !evidence.tokenId ||
      evidence.tokenId.length > 200 ||
      typeof evidence.tokenHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(evidence.tokenHash) ||
      typeof evidence.tokenCreatedAt !== 'string' ||
      typeof evidence.tokenExpiresAt !== 'string' ||
      typeof evidence.tokenIssuerJson !== 'string' ||
      !evidence.tokenIssuerJson ||
      evidence.tokenIssuerJson.length > 262144
    )
      throw new Error('Invalid original token producer evidence');
    canonicalTime(evidence.tokenCreatedAt);
    canonicalTime(evidence.tokenExpiresAt);
  }
  const owner = evidence.owner as Record<string, unknown>,
    birth = evidence.birth as Record<string, unknown>;
  if (
    !owner ||
    !birth ||
    (owner.kind === 'user'
      ? typeof owner.userId !== 'string' || !owner.userId.length
      : owner.kind !== 'local_install' ||
        typeof owner.installationId !== 'string' ||
        !owner.installationId.length) ||
    typeof evidence.operatorAuthorId !== 'string' ||
    !evidence.operatorAuthorId.length ||
    typeof evidence.operatorNaturalKey !== 'string' ||
    !evidence.operatorNaturalKey.length ||
    (evidence.operatorLinkedOwnerKey !== null &&
      typeof evidence.operatorLinkedOwnerKey !== 'string') ||
    birth.documentId !== data.documentId ||
    birth.scope !== data.scope ||
    birth.roomId !== data.roomId ||
    birth.declarationHash !== data.declarationHash ||
    birth.manifestHash !== data.manifestHash ||
    typeof birth.authorId !== 'string' ||
    !birth.authorId.length ||
    (birth.openerAgentId !== null && typeof birth.openerAgentId !== 'string') ||
    typeof birth.openedAt !== 'string' ||
    typeof birth.channelCreatedAt !== 'string'
  )
    throw new Error('Invalid Room operator evidence');
  canonicalTime(birth.openedAt);
  canonicalTime(birth.channelCreatedAt);
}
/** Project origin-specific producer identifiers from retained source evidence. */
export function roomProducerBindings(data: RoomDocSourceData) {
  const evidence = JSON.parse(data.producerEvidenceJson);
  return {
    ...data,
    operatorAuthorId: data.producerOrigin !== 'runtime' ? evidence.operatorAuthorId : null,
    ...(data.producerOrigin === 'doc_token'
      ? { producerTokenId: evidence.tokenId, producerTokenHash: evidence.tokenHash }
      : {}),
  };
}
/** Require current native producer rows to match the retained origin evidence. */
function assertRoomProducerIdentityRows(
  data: RoomDocSourceData,
  rows: Readonly<Record<string, unknown>>
) {
  if (data.producerOrigin === 'runtime') {
    if (!rows['producer-binding-history']) throw new Error('Room durable source refused');
    return;
  }
  if (rows['producer-binding-history']) throw new Error('Operator borrowed a runtime binding');
  const evidence = JSON.parse(data.producerEvidenceJson) as
    | import('./room-doc-types.js').RoomDocOperatorEvidence
    | import('./room-doc-types.js').RoomDocTokenEvidence;
  if (data.producerOrigin === 'doc_token') {
    const token = rows['producer-token-current'] as RoomDocRow | undefined;
    const origin = evidence as import('./room-doc-types.js').RoomDocTokenEvidence;
    if (
      !token ||
      token.token_id !== origin.tokenId ||
      token.token_hash !== origin.tokenHash ||
      token.document_id !== data.documentId ||
      token.created_at !== origin.tokenCreatedAt ||
      token.expires_at !== origin.tokenExpiresAt ||
      token.issuer_binding !== origin.tokenIssuerJson
    )
      throw new Error('Original token producer changed');
  }
  const owner = rows['producer-origin-owner'] as RoomDocRow | undefined;
  const member = rows['producer-origin-member'] as RoomDocRow | undefined;
  const document = (rows['source-document'] ?? rows['fixed-document']) as RoomDocRow | undefined;
  const channel = (rows['source-channel'] ?? rows['fixed-channel']) as RoomDocRow | undefined;
  if (
    (evidence.owner.kind === 'user' ? owner?.id !== evidence.owner.userId : owner !== undefined) ||
    !member ||
    member.id !== evidence.operatorAuthorId ||
    member.author_id !== evidence.operatorAuthorId ||
    member.room_id !== data.roomId ||
    member.natural_key !== evidence.operatorNaturalKey ||
    member.linked_owner_key !== evidence.operatorLinkedOwnerKey ||
    member.retired_at !== null ||
    !document ||
    document.author_id !== evidence.birth.authorId ||
    document.opened_at !== evidence.birth.openedAt ||
    document.id !== evidence.birth.documentId ||
    document.scope !== evidence.birth.scope ||
    document.room_id !== evidence.birth.roomId ||
    !channel ||
    channel.closed_at !== null ||
    channel.created_at !== evidence.birth.channelCreatedAt ||
    channel.opener_agent_id !== evidence.birth.openerAgentId ||
    channel.declaration_hash !== evidence.birth.declarationHash ||
    channel.manifest_hash !== evidence.birth.manifestHash
  )
    throw new Error('Room operator origin rows changed');
}
/** Retained pending DATA is not a live dispatch permission. */
export function assertRoomPendingProducerRows(
  data: RoomDocSourceData,
  rows: Readonly<Record<string, unknown>>
) {
  assertRoomProducerIdentityRows(data, rows);
}
/** Dispatch and accepted recovery continue to require the actual live token. */
export function assertRoomProducerRows(
  data: RoomDocSourceData,
  rows: Readonly<Record<string, unknown>>
) {
  assertRoomProducerIdentityRows(data, rows);
  if (data.producerOrigin === 'doc_token') {
    const token = rows['producer-token-current'] as RoomDocRow;
    if (token.revoked_at !== null || token.expiry_current !== 1)
      throw new Error('Original token producer changed');
  }
}
export const roomProducerReadOperations = Object.freeze([
  'fixed-document',
  'fixed-channel',
  'producer-binding-history',
  'producer-origin-owner',
  'producer-origin-member',
] as const);
