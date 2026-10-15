/** Fixed native Relay receipt/route charge SQL. Internal construction only. */
export const relayDocStatements = Object.freeze({
  begin: { sql: 'BEGIN IMMEDIATE', method: 'run' as const },
  commit: { sql: 'COMMIT', method: 'run' as const },
  rollback: { sql: 'ROLLBACK', method: 'run' as const },
  // Approved route hour is durable and counts claimed UNKNOWN before SDK FIRST.
  // No refund branch is exposed here: a claimed dispatch is conservatively charged.
  routeCharges: {
    sql: `SELECT count(*) AS charged FROM canvas_doc_batches b
    JOIN session_message_acceptance_receipts r ON r.id=b.admission_receipt_id
    WHERE b.document_id=@documentId AND b.route_id=@routeId
    AND r.source_kind='document_event_batch' AND r.source_id=b.batch_id
    AND r.source_generation=b.generation AND r.dispatch_claimed_at>@floor
    AND r.dispatch_claimed_at<=@now`,
    method: 'get' as const,
  },
  principal: {
    sql: `SELECT * FROM connector_runtime_bindings WHERE id=@bindingId AND runtime=@runtime
    AND canonical_session_id=@sessionId AND agent_id=@agentId AND agent_path=@agentPath
    AND canonical_cwd=@agentPath AND revoked_at IS NULL AND expires_at>@now LIMIT 2`,
    method: 'all' as const,
  },
  target: {
    sql: `SELECT a.id AS agent_id,a.project_path AS agent_path,a.runtime,
    s.session_id FROM agents a JOIN session_metadata s ON s.session_id=@sessionId
    AND s.agent_path=a.project_path AND s.runtime=a.runtime
    WHERE a.id=@agentId AND a.project_path=@agentPath AND a.runtime=@runtime AND a.status='active' LIMIT 2`,
    method: 'all' as const,
  },
  channel: {
    sql: 'SELECT * FROM canvas_doc_channels WHERE document_id=@documentId LIMIT 2',
    method: 'all' as const,
  },
  grant: {
    sql: 'SELECT * FROM canvas_doc_grants WHERE document_id=@documentId AND grant_id=@grantId LIMIT 2',
    method: 'all' as const,
  },
  document: {
    sql: 'SELECT * FROM canvas_documents WHERE id=@documentId LIMIT 2',
    method: 'all' as const,
  },
  inputs: {
    sql: `SELECT e.*,d.status AS delivery_status,d.reason AS delivery_reason,
    d.ack_outcome AS delivery_ack_outcome,d.ack_evidence AS delivery_ack_evidence FROM canvas_doc_events e JOIN canvas_doc_deliveries d
    ON d.document_id=e.document_id AND d.event_id=e.event_id
    WHERE e.document_id=@documentId AND d.batch_id=@batchId AND d.route_id=@routeId
    ORDER BY e.doc_seq LIMIT 101`,
    method: 'all' as const,
  },
  accepted: {
    sql: `SELECT b.*,r.id AS receipt_id,r.queue_message_id,r.session_id,r.agent_id,
    r.origin_runtime,r.origin_agent_path,r.origin_authority_digest,r.state AS receipt_state,
    r.dispatch_attempt_id,r.dispatch_boot_epoch,r.dispatch_claimed_at,r.turn_start_seq,
    r.turn_started_at,r.settled_at,r.settle_outcome,r.cancellation_code
    FROM canvas_doc_batches b JOIN session_message_acceptance_receipts r ON r.id=b.admission_receipt_id
    WHERE b.batch_id=@batchId AND b.generation=@generation AND b.document_id=@documentId
    AND b.route_id=@routeId AND b.scope=@scope AND b.grant_id=@grantId
    AND b.grant_revision=@grantRevision AND b.status='accepted'
    AND r.source_kind='document_event_batch' AND r.source_id=b.batch_id AND r.source_generation=b.generation
    AND r.session_id=@sessionId AND r.agent_id=@agentId AND r.origin_runtime=@runtime
    AND r.origin_agent_path=@agentPath AND r.origin_authority_digest=@authorityDigest
    AND r.state='accepted' AND r.dispatch_attempt_id IS NULL AND r.dispatch_boot_epoch IS NULL
    AND r.dispatch_claimed_at IS NULL AND r.turn_start_seq IS NULL AND r.turn_started_at IS NULL
    AND r.settled_at IS NULL AND r.settle_outcome IS NULL AND r.cancellation_code IS NULL LIMIT 2`,
    method: 'all' as const,
  },
  claimed: {
    sql: `SELECT b.batch_id,r.id FROM canvas_doc_batches b
    JOIN session_message_acceptance_receipts r ON r.id=b.admission_receipt_id
    WHERE b.batch_id=@batchId AND b.generation=@generation AND b.document_id=@documentId
    AND b.route_id=@routeId AND b.scope=@scope AND b.grant_id=@grantId AND b.grant_revision=@grantRevision
    AND b.status='dispatching' AND b.attempt=@expectedAttempt AND b.updated_at=@now
    AND r.id=@receiptId AND r.source_kind='document_event_batch' AND r.source_id=b.batch_id AND r.source_generation=b.generation
    AND r.session_id=@sessionId AND r.agent_id=@agentId AND r.origin_runtime=@runtime AND r.origin_agent_path=@agentPath
    AND r.origin_authority_digest=@authorityDigest AND r.state='dispatching' AND r.dispatch_attempt_id=@attemptId
    AND r.dispatch_boot_epoch=@bootEpoch AND r.dispatch_claimed_at=@now
    AND r.turn_start_seq IS NULL AND r.turn_started_at IS NULL AND r.settled_at IS NULL
    AND r.settle_outcome IS NULL AND r.cancellation_code IS NULL LIMIT 2`,
    method: 'all' as const,
  },
  fullBatch: {
    sql: `SELECT * FROM canvas_doc_batches WHERE batch_id=@batchId AND generation=@generation
    AND document_id=@documentId AND route_id=@routeId LIMIT 2`,
    method: 'all' as const,
  },
  fullReceipt: {
    sql: `SELECT r.* FROM session_message_acceptance_receipts r JOIN canvas_doc_batches b
    ON b.admission_receipt_id=r.id WHERE b.batch_id=@batchId AND b.generation=@generation
    AND b.document_id=@documentId AND b.route_id=@routeId LIMIT 2`,
    method: 'all' as const,
  },
  fullDeliveries: {
    sql: `SELECT * FROM canvas_doc_deliveries WHERE document_id=@documentId
    AND batch_id=@batchId AND route_id=@routeId ORDER BY event_id LIMIT 101`,
    method: 'all' as const,
  },
  queueRow: {
    sql: `SELECT id,session_id FROM session_message_queue
    WHERE id=@queueMessageId AND session_id=@sessionId LIMIT 2`,
    method: 'all' as const,
  },
  removeQueue: {
    sql: `DELETE FROM session_message_queue WHERE id=@queueMessageId AND session_id=@sessionId`,
    method: 'run' as const,
  },
  startReceipt: {
    sql: `UPDATE session_message_acceptance_receipts SET state='turn_started',
    turn_start_seq=@turnStartSeq,turn_started_at=@now WHERE id=@receiptId
    AND source_kind='document_event_batch' AND source_id=@batchId AND source_generation=@generation
    AND state='dispatching' AND dispatch_attempt_id=@attemptId AND dispatch_boot_epoch=@bootEpoch
    AND dispatch_claimed_at=@now AND turn_start_seq IS NULL AND turn_started_at IS NULL
    AND settled_at IS NULL AND settle_outcome IS NULL AND cancellation_code IS NULL`,
    method: 'run' as const,
  },
  startBatch: {
    sql: `UPDATE canvas_doc_batches SET status='turn_started',turn_id=@turnId,error_code=NULL,updated_at=@now
    WHERE batch_id=@batchId AND generation=@generation AND document_id=@documentId
    AND admission_receipt_id=@receiptId AND status='dispatching' AND attempt=@expectedAttempt`,
    method: 'run' as const,
  },
  startDeliveries: {
    sql: `UPDATE canvas_doc_deliveries SET status='turn_started',turn_id=@turnId,reason=NULL,updated_at=@now
    WHERE document_id=@documentId AND batch_id=@batchId AND route_id=@routeId
    AND event_id IN (SELECT value FROM json_each(@inputEventIds))`,
    method: 'run' as const,
  },
  allocateStatus: {
    sql: `UPDATE canvas_doc_channels SET next_doc_seq=next_doc_seq+1,updated_at=@now
    WHERE document_id=@documentId AND closed_at IS NULL AND next_doc_seq=@docSeq`,
    method: 'run' as const,
  },
  appendStatus: {
    sql: `INSERT INTO canvas_doc_events(document_id,event_id,doc_seq,direction,type,payload,
    envelope_hash,envelope_bytes,received_at,provenance) VALUES(@documentId,@eventId,@docSeq,'system','event.status',
    @statusPayload,@envelopeHash,@envelopeBytes,@now,'{"source":"doc-channel-service"}')`,
    method: 'run' as const,
  },
  startStatus: {
    sql: `SELECT * FROM canvas_doc_events WHERE document_id=@documentId AND event_id=@eventId LIMIT 2`,
    method: 'all' as const,
  },
  started: {
    sql: `SELECT b.batch_id,r.id FROM canvas_doc_batches b
    JOIN session_message_acceptance_receipts r ON r.id=b.admission_receipt_id
    WHERE b.batch_id=@batchId AND b.generation=@generation AND b.document_id=@documentId
    AND b.route_id=@routeId AND b.scope=@scope AND b.grant_id=@grantId AND b.grant_revision=@grantRevision
    AND b.status='turn_started' AND b.attempt=@expectedAttempt AND b.updated_at=@now AND b.turn_id=@turnId
    AND r.id=@receiptId AND r.source_kind='document_event_batch' AND r.source_id=b.batch_id AND r.source_generation=b.generation
    AND r.session_id=@sessionId AND r.agent_id=@agentId AND r.origin_runtime=@runtime AND r.origin_agent_path=@agentPath
    AND r.origin_authority_digest=@authorityDigest AND r.queue_message_id=@queueMessageId
    AND r.state='turn_started' AND r.dispatch_attempt_id=@attemptId AND r.dispatch_boot_epoch=@bootEpoch
    AND r.dispatch_claimed_at=@now AND r.turn_start_seq=@turnStartSeq AND r.turn_started_at=@now
    AND r.settled_at IS NULL AND r.settle_outcome IS NULL AND r.cancellation_code IS NULL LIMIT 2`,
    method: 'all' as const,
  },
  settleReceipt: {
    sql: `UPDATE session_message_acceptance_receipts SET state='settled',settled_at=@settledAt,
    settle_outcome=@settleOutcome WHERE id=@receiptId AND source_kind='document_event_batch'
    AND source_id=@batchId AND source_generation=@generation AND state='turn_started'
    AND dispatch_attempt_id=@attemptId AND turn_start_seq=@turnStartSeq
    AND settled_at IS NULL AND settle_outcome IS NULL AND cancellation_code IS NULL`,
    method: 'run' as const,
  },
  settleBatch: {
    sql: `UPDATE canvas_doc_batches SET status=@terminalStatus,updated_at=@settledAt
    WHERE batch_id=@batchId AND generation=@generation AND document_id=@documentId
    AND route_id=@routeId AND admission_receipt_id=@receiptId AND status='turn_started'
    AND attempt=@expectedAttempt AND turn_id=@turnId AND error_code IS NULL`,
    method: 'run' as const,
  },
  settleDeliveries: {
    sql: `UPDATE canvas_doc_deliveries SET status=@terminalStatus,updated_at=@settledAt
    WHERE document_id=@documentId AND batch_id=@batchId AND route_id=@routeId
    AND status='turn_started' AND turn_id=@turnId AND event_id IN (SELECT value FROM json_each(@inputEventIds))`,
    method: 'run' as const,
  },
  claimReceipt: {
    sql: `UPDATE session_message_acceptance_receipts SET state='dispatching',
    dispatch_attempt_id=@attemptId,dispatch_boot_epoch=@bootEpoch,dispatch_claimed_at=@now
    WHERE id=@receiptId AND source_kind='document_event_batch' AND source_id=@batchId
    AND source_generation=@generation AND origin_authority_digest=@authorityDigest
    AND state='accepted' AND dispatch_attempt_id IS NULL AND dispatch_boot_epoch IS NULL
    AND dispatch_claimed_at IS NULL AND turn_start_seq IS NULL AND turn_started_at IS NULL
    AND settled_at IS NULL AND settle_outcome IS NULL AND cancellation_code IS NULL`,
    method: 'run' as const,
  },
  claimBatch: {
    sql: `UPDATE canvas_doc_batches SET status='dispatching',attempt=attempt+1,updated_at=@now
    WHERE batch_id=@batchId AND generation=@generation AND document_id=@documentId
    AND admission_receipt_id=@receiptId AND status='accepted' AND attempt=@priorAttempt`,
    method: 'run' as const,
  },
});
export type RelayDocNativeOperation = keyof typeof relayDocStatements;

/** Literal Relay @slots only, copied primitives; never a supplied SQL/binding getter. */
export function copyRelayDocStatementBindings(
  sql: string,
  args: Readonly<Record<string, unknown>>
) {
  if (
    !args ||
    (Object.getPrototypeOf(args) !== Object.prototype && Object.getPrototypeOf(args) !== null)
  )
    throw new Error('Native Relay binding DATA required');
  const names = [...sql.matchAll(/@([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]!);
  if (!names.length) return [];
  const result: Record<string, unknown> = Object.create(null);
  for (const name of new Set(names)) {
    const slot = Object.getOwnPropertyDescriptor(args, name);
    if (!slot || !('value' in slot)) throw new Error('Missing original Relay binding');
    const value = slot.value;
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'bigint' &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      throw new Error('Native Relay primitive binding required');
    result[name] = value;
  }
  return result;
}
