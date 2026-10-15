/** Fixed lifecycle inventory, not a mounted caller API or an execution capability. */
export const roomDocLifecycleStatements = Object.freeze({
  'undo-writer-triggers': {
    method: 'all' as const,
    sql: "SELECT name FROM main.sqlite_master WHERE type='trigger' AND tbl_name='canvas_doc_write_intents';",
  },
  'undo-total-changes': {
    method: 'get' as const,
    sql: 'SELECT total_changes() AS total;',
  },
  'undo-writer-intents': {
    method: 'all' as const,
    sql: `SELECT w.* FROM main.canvas_doc_write_intents w
WHERE w.document_id=:documentId AND w.status='committed'
 AND (w.intent_id=:intentId OR (w.before_hash=:beforeHash AND w.after_hash=:afterHash
 AND w.canonical_path=:canonicalPath AND w.grant_id=:grantId
 AND EXISTS(SELECT 1 FROM main.canvas_doc_deliveries d JOIN main.canvas_doc_batches b
 ON b.document_id=d.document_id AND b.batch_id=d.batch_id
 WHERE d.document_id=w.document_id AND d.event_id=w.event_id
 AND d.status IN ('pending','waiting','superseded') AND b.status IN ('pending','waiting','accepted'))))
ORDER BY w.intent_id LIMIT 1025;`,
  },
  'undo-original-intent': {
    method: 'get' as const,
    sql: 'SELECT * FROM main.canvas_doc_write_intents WHERE document_id=:documentId AND intent_id=:intentId;',
  },
  'undo-original-event': {
    method: 'get' as const,
    sql: 'SELECT * FROM main.canvas_doc_events WHERE document_id=:documentId AND event_id=:eventId;',
  },
  'undo-original-deliveries': {
    method: 'all' as const,
    sql: 'SELECT * FROM main.canvas_doc_deliveries WHERE document_id=:documentId AND event_id=:eventId ORDER BY route_id LIMIT 17;',
  },
  'undo-batch-claims': {
    method: 'all' as const,
    sql: 'SELECT * FROM main.room_doc_admissions WHERE document_id=:documentId AND batch_id=:batchId AND generation=:generation LIMIT 2;',
  },
  'undo-delivery-batch': {
    method: 'get' as const,
    sql: 'SELECT * FROM main.canvas_doc_batches WHERE document_id=:documentId AND batch_id=:batchId;',
  },
  'undo-cancel-exact-batch': {
    method: 'run' as const,
    sql: `UPDATE main.canvas_doc_batches SET status='cancelled',error_code='checkbox_baseline_restored',updated_at=:nowIso
WHERE document_id=:documentId AND batch_id=:batchId AND generation=:generation
 AND status=:oldStatus AND status IN ('pending','waiting','accepted') AND attempt=:oldAttempt
 AND turn_id IS NULL AND lease_until IS NULL AND admission_receipt_id IS NULL
 AND delivery_kind IS :oldDeliveryKind AND room_admission_id IS :oldAdmissionId
 AND room_source_attempt IS :oldSourceAttempt AND room_source_json IS :oldSourceJson
 AND room_source_hash IS :oldSourceHash AND input_event_ids=:oldInputEventIds
 AND effective_payload IS :oldPayload AND error_code IS :oldError AND updated_at=:oldUpdatedAt;`,
  },
  'undo-cancel-exact-delivery': {
    method: 'run' as const,
    sql: `UPDATE main.canvas_doc_deliveries SET status='cancelled',reason='checkbox_baseline_restored',updated_at=:nowIso
WHERE document_id=:documentId AND event_id=:eventId AND route_id=:routeId AND batch_id=:batchId
 AND status=:oldStatus AND reason IS :oldReason AND turn_id IS NULL
 AND delivery_kind IS :oldDeliveryKind AND room_admission_id IS :oldAdmissionId
 AND ack_outcome IS NULL AND ack_evidence IS NULL AND acknowledged_at IS NULL
 AND acknowledged_by IS NULL AND updated_at=:oldUpdatedAt;`,
  },
  'lifecycle-admission': {
    method: 'get' as const,
    sql: 'SELECT * FROM main.room_doc_admissions WHERE admission_id=:admissionId;',
  },
  'lifecycle-exact-input': {
    method: 'run' as const,
    sql: `UPDATE main.canvas_doc_deliveries SET status=:nextDeliveryStatus,turn_id=:nextTurnId,
 reason=:nextDeliveryReason,updated_at=:nowIso
WHERE document_id=:documentId AND event_id=:eventId AND route_id=:routeId AND batch_id=:batchId
 AND delivery_kind='room_app_event' AND room_admission_id=:admissionId
 AND status=:oldDeliveryStatus AND reason IS :oldDeliveryReason
 AND turn_id IS :oldTurnId;`,
  },
  'recover-unknown-inputs': {
    method: 'run' as const,
    sql: `UPDATE main.canvas_doc_deliveries SET status='in_doubt',reason='room_doc_claim_unknown',updated_at=:nowIso
WHERE delivery_kind='room_app_event' AND EXISTS(SELECT 1 FROM main.room_doc_admissions a
 WHERE a.admission_id=canvas_doc_deliveries.room_admission_id AND a.document_id=canvas_doc_deliveries.document_id
 AND a.batch_id=canvas_doc_deliveries.batch_id AND a.status='in_doubt');`,
  },
  'unknown-batch': {
    method: 'run' as const,
    sql: "UPDATE main.canvas_doc_batches SET status='in_doubt',error_code='room_doc_claim_unknown',updated_at=:nowIso WHERE document_id=:documentId AND batch_id=:batchId AND generation=:generation AND room_admission_id=:admissionId AND delivery_kind='room_app_event' AND attempt=:sourceAttempt AND status=:expectedBatchStatus;",
  },
  'quarantine-unowned-prepared': {
    method: 'run' as const,
    sql: "UPDATE main.canvas_doc_batches SET status='in_doubt',error_code='room_doc_claim_prepared_unknown' WHERE delivery_kind='room_app_event' AND status='dispatching' AND error_code='room_doc_claim_prepared' AND admission_receipt_id IS NULL AND room_admission_id IS NOT NULL AND lease_until IS NULL;",
  },
  'prune-candidates': {
    method: 'all' as const,
    sql: "SELECT a.* FROM main.room_doc_admissions a WHERE a.status='settled' AND a.claimed_at_ms<=:documentFloorMs AND a.updated_at<=:receiptRetentionCutoffIso AND NOT EXISTS(SELECT 1 FROM main.canvas_doc_batches b WHERE b.room_admission_id=a.admission_id AND b.status IN ('accepted','dispatching','turn_started','in_doubt')) AND NOT EXISTS(SELECT 1 FROM main.canvas_doc_deliveries d WHERE d.room_admission_id=a.admission_id AND d.ack_outcome IS NULL) ORDER BY a.admission_id LIMIT 100;",
  },

  'freeze-batch': {
    method: 'run' as const,
    sql: `UPDATE main.canvas_doc_batches SET status='accepted',delivery_kind='room_app_event',
 room_admission_id=:admissionId,room_source_attempt=attempt,
 room_source_json=:originalSourceJson,room_source_hash=:originalSourceHash,
 input_event_ids=:inputEventIdsJson,effective_payload=:effectivePayloadJson,updated_at=:nowIso
WHERE document_id=:documentId AND batch_id=:batchId AND generation=:generation
 AND status=:oldBatchStatus AND status IN ('pending','waiting') AND attempt=:sourceAttempt
 AND delivery_kind IS NULL AND admission_receipt_id IS NULL
 AND room_admission_id IS NULL AND room_source_json IS NULL AND room_source_hash IS NULL
 AND input_event_ids=:oldInputEventIdsJson AND effective_payload=:oldEffectivePayloadJson;`,
  },
  'freeze-exact-input': {
    method: 'run' as const,
    sql: `UPDATE main.canvas_doc_deliveries SET delivery_kind='room_app_event',room_admission_id=:admissionId,
 updated_at=:nowIso WHERE document_id=:documentId AND event_id=:eventId AND route_id=:routeId
 AND batch_id=:batchId AND status=:expectedDeliveryStatus AND reason IS :expectedDeliveryReason
 AND delivery_kind IS NULL AND room_admission_id IS NULL;`,
  },
  'owned-prune-spend': {
    method: 'run' as const,
    sql: `DELETE FROM main.room_turn_spend WHERE at<=:globalFloorMs;`,
  },
  'prune-document-floor': {
    method: 'run' as const,
    sql: `UPDATE main.canvas_doc_channels SET room_spend_floor_ms=:documentFloorMs
WHERE document_id=:documentId
 AND (room_spend_floor_ms IS NULL OR room_spend_floor_ms<=:documentFloorMs);`,
  },
  'prune-links': {
    method: 'run' as const,
    sql: `DELETE FROM main.room_doc_admission_inputs WHERE admission_id=:admissionId
 AND EXISTS(SELECT 1 FROM main.room_doc_admissions a WHERE a.admission_id=:admissionId
  AND a.status='settled' AND a.claimed_at_ms<=:documentFloorMs);`,
  },
  'prune-admission': {
    method: 'run' as const,
    sql: `DELETE FROM main.room_doc_admissions WHERE admission_id=:admissionId AND status='settled'
 AND claimed_at_ms<=:documentFloorMs AND updated_at<=:receiptRetentionCutoffIso;`,
  },
  'previous-boot-recovery': {
    method: 'run' as const,
    sql: `UPDATE main.room_doc_admissions SET status='in_doubt',outcome='in_doubt',updated_at=:nowIso,
 row_json=json_set(row_json,'$.status','in_doubt','$.outcome','in_doubt','$.updatedAt',:nowIso)
WHERE boot_epoch<>:currentBootEpoch AND status IN ('claimed','turn_started');`,
  },
  'previous-boot-batches': {
    method: 'run' as const,
    sql: `UPDATE main.canvas_doc_batches SET status='in_doubt',error_code='room_doc_claim_unknown',updated_at=:nowIso
WHERE delivery_kind='room_app_event' AND status IN ('dispatching','turn_started')
 AND EXISTS(SELECT 1 FROM main.room_doc_admissions a WHERE a.document_id=canvas_doc_batches.document_id
  AND a.batch_id=canvas_doc_batches.batch_id AND a.admission_id=canvas_doc_batches.room_admission_id
  AND a.status='in_doubt');`,
  },
  'pending-source': {
    method: 'get' as const,
    sql: `SELECT * FROM main.canvas_doc_room_pending_sources WHERE document_id=:documentId
 AND batch_id=:batchId AND generation=:generation;`,
  },
  'retire-pending-source': {
    method: 'run' as const,
    sql: `DELETE FROM main.canvas_doc_room_pending_sources WHERE document_id=:documentId
 AND batch_id=:batchId AND generation=:generation AND source_json=:originalSourceJson
 AND source_hash=:originalSourceHash;`,
  },
  'pending-unclaimed-resume': {
    method: 'all' as const,
    sql: `SELECT b.* FROM main.canvas_doc_batches b JOIN main.canvas_doc_room_pending_sources p
 ON p.document_id=b.document_id AND p.batch_id=b.batch_id AND p.generation=b.generation
 WHERE b.status IN ('pending','waiting') AND b.delivery_kind IS NULL
 AND b.admission_receipt_id IS NULL AND b.room_admission_id IS NULL
 AND b.room_source_attempt IS NULL AND b.room_source_json IS NULL AND b.room_source_hash IS NULL
 AND (b.updated_at>:cursorAt OR (b.updated_at=:cursorAt AND b.batch_id>:cursorId))
 ORDER BY b.updated_at,b.batch_id LIMIT 100;`,
  },
  'accepted-unclaimed-resume': {
    method: 'all' as const,
    sql: `SELECT b.* FROM main.canvas_doc_batches b WHERE b.delivery_kind='room_app_event' AND b.status='accepted'
 AND b.admission_receipt_id IS NULL AND b.room_admission_id IS NOT NULL
 AND b.room_source_attempt=b.attempt
 AND b.error_code IS NOT 'room_doc_claim_prepared'
 AND b.error_code IS NOT 'room_doc_claim_prepared_unknown'
 AND b.error_code IS NOT 'room_doc_claim_unknown'
 AND (b.updated_at>:cursorAt OR (b.updated_at=:cursorAt AND b.batch_id>:cursorId))
ORDER BY b.updated_at,b.batch_id LIMIT 100;`,
  },
  'observe-projected-start': {
    method: 'run' as const,
    sql: `UPDATE main.room_doc_admissions SET status='turn_started',turn_id=:projectedTurnId,updated_at=:nowIso,
 row_json=json_set(row_json,'$.status','turn_started','$.turnId',:projectedTurnId,'$.updatedAt',:nowIso)
WHERE admission_id=:admissionId AND boot_epoch=:bootEpoch AND dispatch_id=:dispatchId
 AND dispatch_attempt=1 AND status='claimed' AND turn_id IS NULL AND outcome IS NULL
 AND spend_row_id=:actualSpendRowId;`,
  },
  'projected-batch-start': {
    method: 'run' as const,
    sql: `UPDATE main.canvas_doc_batches SET status='turn_started',turn_id=:projectedTurnId,updated_at=:nowIso
WHERE document_id=:documentId AND batch_id=:batchId AND generation=:generation
 AND delivery_kind='room_app_event' AND room_admission_id=:admissionId
 AND status='dispatching' AND attempt=:sourceAttempt;`,
  },
  'mark-unknown': {
    method: 'run' as const,
    sql: `UPDATE main.room_doc_admissions SET status='in_doubt',outcome='in_doubt',updated_at=:nowIso,
 row_json=json_set(row_json,'$.status','in_doubt','$.outcome','in_doubt','$.updatedAt',:nowIso)
WHERE admission_id=:admissionId AND boot_epoch=:bootEpoch AND dispatch_id=:dispatchId
 AND dispatch_attempt=1 AND status IN ('claimed','turn_started');`,
  },
  'settle-known-terminal': {
    method: 'run' as const,
    sql: `UPDATE main.room_doc_admissions SET status='settled',outcome=:terminalOutcome,updated_at=:nowIso,
 row_json=json_set(row_json,'$.status','settled','$.outcome',:terminalOutcome,'$.updatedAt',:nowIso)
WHERE admission_id=:admissionId AND boot_epoch=:bootEpoch AND dispatch_id=:dispatchId
 AND dispatch_attempt=1 AND status=:expectedStatus AND status IN ('claimed','turn_started')
 AND outcome IS NULL AND (:terminalOutcome IN ('failed','cancelled')
  OR (:terminalOutcome='turn_done' AND turn_id IS NOT NULL));`,
  },
  'terminal-batch': {
    method: 'run' as const,
    sql: `UPDATE main.canvas_doc_batches SET status=:terminalBatchStatus,error_code=:terminalErrorCode,updated_at=:nowIso
WHERE document_id=:documentId AND batch_id=:batchId AND generation=:generation
 AND delivery_kind='room_app_event' AND room_admission_id=:admissionId
 AND status=:expectedBatchStatus AND status IN ('dispatching','turn_started');`,
  },
  'prepared-quarantine': {
    method: 'run' as const,
    sql: `UPDATE main.canvas_doc_batches SET status='in_doubt',error_code='room_doc_claim_prepared_unknown'
WHERE document_id=:documentId AND batch_id=:batchId AND generation=:generation
 AND attempt=:sourceAttempt AND status='dispatching' AND error_code='room_doc_claim_prepared'
 AND lease_until IS NULL AND updated_at=:barrierIso AND delivery_kind='room_app_event'
 AND admission_receipt_id IS NULL AND room_admission_id=:admissionId
 AND room_source_attempt=:sourceAttempt AND room_source_json=:originalSourceJson
 AND room_source_hash=:originalSourceHash AND input_event_ids=:inputEventIdsJson
 AND effective_payload=:effectivePayloadJson;`,
  },
});
for (const statement of Object.values(roomDocLifecycleStatements)) Object.freeze(statement);
