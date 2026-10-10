/** Private literal captured statements; no request supplies SQL or an operation name. */
import { roomDocLifecycleStatements } from './room-doc-lifecycle-statements.js';
import { roomDocSchemaStatements } from './room-doc-schema-statements.js';
export const roomDocStatements = Object.freeze({
  ...roomDocSchemaStatements,
  ...roomDocLifecycleStatements,
  'producer-token-current': {
    method: 'get' as const,
    sql: `SELECT token_id,token_hash,document_id,created_at,expires_at,issuer_binding,revoked_at,
      CASE WHEN julianday(expires_at)>julianday('now') THEN 1 ELSE 0 END AS expiry_current
      FROM main.canvas_doc_channel_tokens WHERE token_id=:producerTokenId AND token_hash=:producerTokenHash
      AND document_id=:documentId LIMIT 1;`,
  },
  'fixed-document': {
    method: 'get' as const,
    sql: 'SELECT * FROM main.canvas_documents WHERE id=:documentId;',
  },
  'fixed-channel': {
    method: 'get' as const,
    sql: 'SELECT * FROM main.canvas_doc_channels WHERE document_id=:documentId;',
  },
  'fixed-birth-intents': {
    method: 'all' as const,
    sql: 'SELECT * FROM main.canvas_doc_identity_intents WHERE document_id=:documentId ORDER BY intent_id LIMIT 1025;',
  },
  'fixed-grant': {
    method: 'get' as const,
    sql: 'SELECT * FROM main.canvas_doc_grants WHERE grant_id=:grantId;',
  },
  'fixed-approval': {
    method: 'get' as const,
    sql: 'SELECT * FROM main.approvals WHERE id=:approvalId;',
  },
  'fixed-aliases': {
    method: 'all' as const,
    sql: "SELECT * FROM main.canvas_doc_identity_intents WHERE status='applied' AND intent_id>:cursor ORDER BY intent_id LIMIT 1025;",
  },
  'fixed-all-aliases': {
    method: 'all' as const,
    sql: 'SELECT * FROM main.canvas_doc_identity_intents WHERE intent_id>:cursor ORDER BY intent_id LIMIT 1025;',
  },
  'fixed-owner': {
    method: 'get' as const,
    sql: 'SELECT * FROM main.user ORDER BY created_at ASC LIMIT 1;',
  },
  'fixed-membership-room': {
    method: 'get' as const,
    sql: 'SELECT * FROM main.rooms WHERE id=:roomId;',
  },
  'fixed-membership-authors': {
    method: 'all' as const,
    sql: 'SELECT * FROM main.authors WHERE natural_key=:subjectKey OR linked_owner_key=:subjectKey ORDER BY id LIMIT 1025;',
  },
  'fixed-membership-members': {
    method: 'all' as const,
    sql: 'SELECT m.* FROM main.room_members m JOIN main.authors a ON a.id=m.author_id WHERE m.room_id=:roomId AND (a.natural_key=:subjectKey OR a.linked_owner_key=:subjectKey) ORDER BY m.author_id LIMIT 1025;',
  },
  'fixed-emission-doc-target': {
    method: 'all' as const,
    sql: `WITH RECURSIVE original_room_destination(session_id,hops,path) AS (
 SELECT :targetSessionId,0,json_array(:targetSessionId)
 UNION ALL
 SELECT t.canonical_session_id,d.hops+1,json_insert(d.path,'$[#]',t.canonical_session_id)
 FROM original_room_destination d JOIN main.room_session_retirements t ON t.retired_session_id=d.session_id
 WHERE d.hops<16 AND NOT EXISTS(SELECT 1 FROM json_each(d.path) p WHERE p.value=t.canonical_session_id)
), current_room_destination AS (
 SELECT d.session_id FROM original_room_destination d
 WHERE NOT EXISTS(SELECT 1 FROM main.room_session_retirements t WHERE t.retired_session_id=d.session_id)
 AND (d.hops=0 OR NOT EXISTS(SELECT 1 FROM main.session_metadata old WHERE old.session_id=:targetSessionId))
)
SELECT r.id AS roomId, au.id AS targetAuthorId, a.id AS targetAgentId,
 sm.session_id AS targetSessionId, a.runtime AS targetRuntime, a.project_path AS targetAgentPath
 FROM main.rooms r
 JOIN main.room_members m ON m.room_id=r.id
 JOIN main.authors au ON au.id=m.author_id AND au.kind='agent' AND au.retired_at IS NULL
 JOIN main.agents a ON a.project_path=au.natural_key AND a.id=au.minted_for_manifest_id
 JOIN main.room_sessions rs ON rs.room_id=r.id AND rs.author_id=au.id
 JOIN main.session_metadata sm ON sm.session_id=rs.session_id AND sm.agent_path=a.project_path AND sm.runtime=a.runtime
 WHERE r.id=:roomId AND r.archived=0 AND a.id=:targetAgentId AND a.status='active'
 AND a.runtime=:targetRuntime AND rs.session_id=(SELECT session_id FROM current_room_destination)
 AND NOT EXISTS(SELECT 1 FROM main.community_room_mirrors c WHERE c.local_room_id=r.id)
 LIMIT 2;`,
  },
  'fixed-runtime-binding': {
    method: 'get' as const,
    sql: 'SELECT * FROM main.connector_runtime_bindings WHERE id=:bindingId;',
  },
  'fixed-batch': {
    method: 'get' as const,
    sql: 'SELECT * FROM main.canvas_doc_batches WHERE document_id=:documentId AND batch_id=:batchId AND generation=:generation;',
  },
  'fixed-ordered-inputs': {
    method: 'all' as const,
    sql: 'SELECT CAST(j.key AS INTEGER) AS ordinal,e.*,d.* FROM main.canvas_doc_batches b,json_each(b.input_event_ids) j JOIN main.canvas_doc_events e ON e.document_id=b.document_id AND e.event_id=j.value JOIN main.canvas_doc_deliveries d ON d.document_id=b.document_id AND d.event_id=e.event_id AND d.route_id=b.route_id AND d.batch_id=b.batch_id WHERE b.document_id=:documentId AND b.batch_id=:batchId AND b.generation=:generation ORDER BY ordinal LIMIT 101;',
  },
  'fixed-status-events': {
    method: 'all' as const,
    sql: 'SELECT e.* FROM main.canvas_doc_batches b,json_each(b.input_event_ids) j JOIN main.canvas_doc_events e ON e.document_id=b.document_id AND e.event_id=j.value WHERE b.document_id=:documentId AND b.batch_id=:batchId AND b.generation=:generation ORDER BY CAST(j.key AS INTEGER) LIMIT 101;',
  },
  'fixed-status-deliveries': {
    method: 'all' as const,
    sql: 'SELECT d.* FROM main.canvas_doc_deliveries d JOIN main.canvas_doc_batches b ON b.document_id=d.document_id AND b.batch_id=d.batch_id WHERE b.document_id=:documentId AND b.batch_id=:batchId AND b.generation=:generation ORDER BY d.route_id,d.event_id LIMIT 1025;',
  },
  'extra-reader-schema': {
    method: 'all' as const,
    sql: "SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE tbl_name IN ('user','canvas_doc_identity_intents');",
  },
  'extra-reader-triggers': {
    method: 'all' as const,
    sql: "SELECT name FROM main.sqlite_master WHERE type='trigger' AND tbl_name IN ('user','canvas_doc_identity_intents') UNION ALL SELECT name FROM temp.sqlite_master WHERE type='trigger';",
  },
  'extra-user-columns': { method: 'all' as const, sql: 'PRAGMA main.table_xinfo(user);' },
  'extra-user-keys': { method: 'all' as const, sql: 'PRAGMA main.foreign_key_list(user);' },
  'extra-alias-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(canvas_doc_identity_intents);',
  },
  'extra-alias-keys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(canvas_doc_identity_intents);',
  },

  'room-limit-data': {
    method: 'get' as const,
    sql: 'SELECT turn_limits_enabled AS turnLimitsEnabled,max_agent_depth AS maxAgentDepth,max_turns_per_agent_per_cascade AS maxTurnsPerAgentPerCascade,max_auto_turns_per_hour AS maxAutoTurnsPerHour FROM main.rooms WHERE id=:roomId;',
  },
  'final-entry': {
    method: 'get' as const,
    sql: 'SELECT * FROM main.room_entries WHERE room_id=:roomId AND id=:entryId;',
  },
  'final-cursor': {
    method: 'get' as const,
    sql: 'SELECT last_read_seq FROM main.room_members WHERE room_id=:roomId AND author_id=:targetAuthorId;',
  },

  'source-batch': {
    method: 'get' as const,
    sql: `SELECT * FROM main.canvas_doc_batches
WHERE document_id=:documentId AND batch_id=:batchId AND generation=:generation;`,
  },
  'source-channel': {
    method: 'get' as const,
    sql: `SELECT * FROM main.canvas_doc_channels WHERE document_id=:documentId AND scope=:scope
 AND closed_at IS NULL AND declaration_hash=:declarationHash
 AND (room_spend_floor_ms IS NULL OR room_spend_floor_ms<=:documentFloorMs);`,
  },
  'source-document': {
    method: 'get' as const,
    sql: `SELECT * FROM main.canvas_documents WHERE id=:documentId AND scope=:scope AND room_id=:roomId;`,
  },
  'source-grant': {
    method: 'get' as const,
    sql: `SELECT * FROM main.canvas_doc_grants
WHERE document_id=:documentId AND grant_id=:grantId AND revision=:grantRevision
 AND route_id=:routeId AND route_hash=:routeHash AND declaration_hash=:declarationHash
 AND manifest_hash IS :manifestHash AND revoked_at IS NULL
 AND (expires_at IS NULL OR expires_at>:nowIso)
 AND normalized_route=:normalizedRouteJson AND limits=:grantLimitsJson
 AND approval_id=:approvalId AND approval_evidence=:approvalEvidenceJson
 AND target_agent_id=:targetAgentId AND target_session_id=:targetSessionId AND target_runtime=:targetRuntime;`,
  },
  'source-approval': {
    method: 'get' as const,
    sql: `SELECT id,state,capability_id,input_hash,decided_at,consumed_at,decided_by_user_id
FROM main.approvals WHERE id=:approvalId AND state='granted' AND capability_id='ui.approve_doc_route'
 AND input_hash=:approvalInputHash AND decided_at IS NOT NULL AND consumed_at IS NOT NULL;`,
  },
  'producer-binding-history': {
    method: 'get' as const,
    sql: `SELECT * FROM main.connector_runtime_bindings WHERE id=:producerBindingId;`,
  },
  'producer-origin-owner': {
    method: 'get' as const,
    sql: 'SELECT * FROM main.user ORDER BY created_at ASC LIMIT 1;',
  },
  'producer-origin-member': {
    method: 'get' as const,
    sql: 'SELECT a.id,a.natural_key,a.linked_owner_key,a.retired_at,m.room_id,m.author_id FROM main.authors a JOIN main.room_members m ON m.author_id=a.id WHERE a.id=:operatorAuthorId AND m.room_id=:roomId;',
  },
  'ordered-source-inputs': {
    method: 'all' as const,
    sql: `SELECT CAST(j.key AS INTEGER) AS ordinal,e.event_id,e.doc_seq,e.envelope_hash,
 e.direction,e.type,e.payload,e.provenance,e.payload_pruned_at,
 d.route_id,d.batch_id,d.status,d.reason,d.turn_id,d.delivery_kind,d.room_admission_id,
 d.ack_outcome,d.acknowledged_at,d.acknowledged_by,d.ack_evidence
FROM main.canvas_doc_batches b, json_each(b.input_event_ids) j
JOIN main.canvas_doc_events e ON e.document_id=b.document_id AND e.event_id=j.value
JOIN main.canvas_doc_deliveries d ON d.document_id=e.document_id AND d.event_id=e.event_id
 AND d.route_id=b.route_id AND d.batch_id=b.batch_id
WHERE b.document_id=:documentId AND b.batch_id=:batchId AND b.generation=:generation
ORDER BY CAST(j.key AS INTEGER);`,
  },
  'room-current': {
    method: 'get' as const,
    sql: `WITH RECURSIVE original_room_destination(session_id,hops,path) AS (
 SELECT :targetSessionId,0,json_array(:targetSessionId)
 UNION ALL
 SELECT t.canonical_session_id,d.hops+1,json_insert(d.path,'$[#]',t.canonical_session_id)
 FROM original_room_destination d JOIN main.room_session_retirements t ON t.retired_session_id=d.session_id
 WHERE d.hops<16 AND NOT EXISTS(SELECT 1 FROM json_each(d.path) p WHERE p.value=t.canonical_session_id)
), current_room_destination AS (
 SELECT d.session_id FROM original_room_destination d
 WHERE NOT EXISTS(SELECT 1 FROM main.room_session_retirements t WHERE t.retired_session_id=d.session_id)
 AND (d.hops=0 OR NOT EXISTS(SELECT 1 FROM main.session_metadata old WHERE old.session_id=:targetSessionId))
)
SELECT r.id,r.archived,r.turn_limits_enabled,m.author_id,m.response_mode,m.last_read_seq,
 a.id AS agent_id,a.runtime,a.project_path,a.status,
 au.retired_at,au.natural_key,au.minted_for_manifest_id,
 s.session_id,s.created_at AS room_session_created_at
FROM main.rooms r
JOIN main.room_members m ON m.room_id=r.id AND m.author_id=:targetAuthorId
JOIN main.authors au ON au.id=m.author_id AND au.kind='agent'
JOIN main.agents a ON a.id=:targetAgentId AND a.project_path=au.natural_key
JOIN main.room_sessions s ON s.room_id=r.id AND s.author_id=m.author_id
JOIN main.session_metadata sm ON sm.session_id=s.session_id AND sm.agent_path=a.project_path AND sm.runtime=a.runtime
WHERE r.id=:roomId AND r.archived=0 AND au.retired_at IS NULL AND a.status='active'
 AND a.runtime=:targetRuntime AND a.project_path=:targetAgentPath
 AND au.minted_for_manifest_id=a.id AND s.session_id=:effectiveTargetSessionId
 AND s.session_id=(SELECT session_id FROM current_room_destination)
 AND m.response_mode<>'silent'
 AND NOT EXISTS(SELECT 1 FROM main.room_session_retirements t WHERE t.retired_session_id=s.session_id)
 AND NOT EXISTS(SELECT 1 FROM main.community_room_mirrors c WHERE c.local_room_id=r.id);`,
  },
  'system-author': {
    method: 'get' as const,
    sql: `SELECT id FROM main.authors WHERE id=:systemAuthorId AND kind='system'
 AND natural_key='system' AND retired_at IS NULL;`,
  },
  'global-root': {
    method: 'all' as const,
    sql: `SELECT room_id,id,cascade_root,cascade_depth FROM main.room_entries
WHERE id=:cascadeRoot AND cascade_root=id ORDER BY room_id LIMIT 2;`,
  },
  'root-exhausted': {
    method: 'get' as const,
    sql: `SELECT * FROM main.room_doc_exhausted_lineages WHERE cascade_root=:cascadeRoot;`,
  },
  'strict-spend-counts': {
    method: 'get' as const,
    sql: `SELECT count(*) AS global_count,coalesce(sum(room_id=:roomId),0) AS room_count
FROM main.room_turn_spend WHERE at>:globalFloorMs AND at<=:atMs;`,
  },
  'receipt-membership': {
    method: 'all' as const,
    sql: `SELECT id,room_id,at FROM main.room_turn_spend
WHERE id=:receiptRowId AND room_id=:receiptRoomId AND at=:receiptAtMs
 AND at>:globalFloorMs AND at<=:atMs;`,
  },
  'document-window': {
    method: 'get' as const,
    sql: `SELECT count(*) AS document_count FROM main.room_doc_admissions
WHERE document_id=:documentId AND claimed_at_ms>:documentFloorMs AND claimed_at_ms<=:atMs;`,
  },
  'original-admission': {
    method: 'get' as const,
    sql: `SELECT * FROM main.room_doc_admissions WHERE admission_id=:admissionId
 OR (document_id=:documentId AND batch_id=:batchId AND generation=:generation);`,
  },
  begin: { method: 'run' as const, sql: `BEGIN IMMEDIATE;` },
  commit: { method: 'run' as const, sql: `COMMIT;` },
  'prepare-barrier': {
    method: 'run' as const,
    sql: `UPDATE main.canvas_doc_batches
SET status='dispatching',error_code='room_doc_claim_prepared',lease_until=NULL,updated_at=:barrierIso
WHERE document_id=:documentId AND batch_id=:batchId AND generation=:generation
 AND attempt=:sourceAttempt AND status='accepted' AND error_code IS :originalError
 AND delivery_kind='room_app_event' AND admission_receipt_id IS NULL
 AND room_admission_id=:admissionId AND room_source_attempt=:sourceAttempt
 AND room_source_json=:originalSourceJson AND room_source_hash=:originalSourceHash
 AND input_event_ids=:inputEventIdsJson AND effective_payload=:effectivePayloadJson
 AND updated_at=:originalUpdatedAt AND lease_until IS :originalLease;`,
  },
  'source-claim': {
    method: 'run' as const,
    sql: `UPDATE main.canvas_doc_batches SET error_code=NULL,updated_at=:nowIso
WHERE document_id=:documentId AND batch_id=:batchId AND generation=:generation
 AND status='dispatching' AND error_code='room_doc_claim_prepared' AND lease_until IS NULL
 AND updated_at=:barrierIso AND delivery_kind='room_app_event' AND admission_receipt_id IS NULL
 AND room_admission_id=:admissionId AND attempt=:sourceAttempt AND room_source_attempt=:sourceAttempt
 AND room_source_json=:originalSourceJson AND room_source_hash=:originalSourceHash
 AND input_event_ids=:inputEventIdsJson AND effective_payload=:effectivePayloadJson;`,
  },
  'next-entry-seq': {
    method: 'get' as const,
    sql: `SELECT coalesce(max(seq),0)+1 AS seq FROM main.room_entries WHERE room_id=:roomId;`,
  },
  'app-entry': {
    method: 'run' as const,
    sql: `INSERT INTO main.room_entries(room_id,seq,id,author_id,kind,body,mentions,mention_spans,
 session_id,cascade_root,cascade_depth,dispatch_id,parent_entry_id,thread_root_entry_id,
 signature,created_at,timeline_band,timeline_pos)
VALUES(:roomId,:entrySeq,:entryId,:systemAuthorId,'app_event',:appBodyJson,'[]','[]',
 NULL,:cascadeRoot,:entryDepth,NULL,NULL,NULL,NULL,:nowIso,NULL,NULL);`,
  },
  'room-activity': {
    method: 'run' as const,
    sql: `UPDATE main.rooms SET last_activity_at=:nowIso WHERE id=:roomId AND archived=0;`,
  },
  'insert-admission': {
    method: 'run' as const,
    sql: `INSERT INTO main.room_doc_admissions(admission_id,document_id,batch_id,generation,source_attempt,
 room_id,entry_id,entry_seq,grant_id,grant_revision,route_id,route_hash,declaration_hash,manifest_hash,
 input_fingerprint,authority_digest,effective_payload_digest,source_hash,producer_evidence_json,
 target_agent_id,target_author_id,target_session_id,target_runtime,target_agent_path,
 cascade_root,root_room_id,root_entry_id,frozen_ceiling,dispatch_attempt,boot_epoch,dispatch_id,
 claimed_at_ms,claimed_at,spend_row_id,status,turn_id,outcome,created_at,updated_at,row_json)
VALUES(:admissionId,:documentId,:batchId,:generation,:sourceAttempt,:roomId,:entryId,:entrySeq,
 :grantId,:grantRevision,:routeId,:routeHash,:declarationHash,:manifestHash,
 :inputFingerprint,:authorityDigest,:effectivePayloadDigest,:originalSourceHash,:producerEvidenceJson,
 :targetAgentId,:targetAuthorId,:targetSessionId,:targetRuntime,:targetAgentPath,
 :cascadeRoot,:rootRoomId,:rootEntryId,:frozenCeiling,1,:bootEpoch,:dispatchId,
 :atMs,:nowIso,NULL,'claimed',NULL,NULL,:nowIso,:nowIso,:claimRowJsonWithNullSpend);`,
  },
  'link-input': {
    method: 'run' as const,
    sql: `INSERT INTO main.room_doc_admission_inputs(admission_id,document_id,event_id,route_id,
 input_ordinal,doc_seq,envelope_hash,source_delivery_status,source_delivery_reason)
VALUES(:admissionId,:documentId,:eventId,:routeId,:ordinal,:docSeq,:envelopeHash,
 :expectedDeliveryStatus,:expectedDeliveryReason);`,
  },
  'claim-input-disposition': {
    method: 'run' as const,
    sql: `UPDATE main.canvas_doc_deliveries SET reason='room_doc_claimed',updated_at=:nowIso
WHERE document_id=:documentId AND event_id=:eventId AND route_id=:routeId AND batch_id=:batchId
 AND status=:expectedDeliveryStatus AND reason IS :expectedDeliveryReason
 AND delivery_kind='room_app_event' AND room_admission_id=:admissionId;`,
  },
  'one-unconditional-spend': {
    method: 'run' as const,
    sql: `INSERT INTO main.room_turn_spend(room_id,at) VALUES(:roomId,:atMs);`,
  },
  'spend-correlation': {
    method: 'run' as const,
    sql: `UPDATE main.room_doc_admissions SET spend_row_id=:actualSpendRowId,
 row_json=json_set(row_json,'$.spendRowId',:actualSpendRowId)
WHERE admission_id=:admissionId AND dispatch_attempt=1 AND status='claimed'
 AND spend_row_id IS NULL AND boot_epoch=:bootEpoch AND dispatch_id=:dispatchId;`,
  },
  'root-exhaustion': {
    method: 'run' as const,
    sql: `INSERT INTO main.room_doc_exhausted_lineages(cascade_root,root_room_id,root_entry_id,
 original_admission_id,frozen_ceiling,exhausted_at)
VALUES(:cascadeRoot,:rootRoomId,:rootEntryId,:admissionId,:frozenCeiling,:nowIso);`,
  },
  'member-read-cursor': {
    method: 'run' as const,
    sql: `UPDATE main.room_members SET last_read_seq=:entrySeq
WHERE room_id=:roomId AND author_id=:targetAuthorId AND last_read_seq=:expectedReadSeq;`,
  },
  'final-row-agreement': {
    method: 'get' as const,
    sql: `SELECT a.*,s.room_id AS actual_spend_room,s.at AS actual_spend_at,b.status AS batch_status,
 b.delivery_kind,b.room_admission_id,b.room_source_attempt,b.room_source_hash,b.room_source_json
FROM main.room_doc_admissions a JOIN main.room_turn_spend s ON s.id=a.spend_row_id
JOIN main.canvas_doc_batches b ON b.document_id=a.document_id AND b.batch_id=a.batch_id
WHERE a.admission_id=:admissionId AND a.spend_row_id=:actualSpendRowId
 AND s.room_id=:roomId AND s.at=:atMs AND a.boot_epoch=:bootEpoch AND a.dispatch_id=:dispatchId;`,
  },
  'final-ordered-links': {
    method: 'all' as const,
    sql: `SELECT * FROM main.room_doc_admission_inputs WHERE admission_id=:admissionId ORDER BY input_ordinal;`,
  },
  rollback: { method: 'run' as const, sql: `ROLLBACK;` },
  'known-release': {
    method: 'run' as const,
    sql: `UPDATE main.canvas_doc_batches SET status='accepted',error_code=:originalError,
 lease_until=:originalLease,updated_at=:originalUpdatedAt
WHERE document_id=:documentId AND batch_id=:batchId AND generation=:generation
 AND attempt=:sourceAttempt AND status='dispatching' AND error_code='room_doc_claim_prepared'
 AND lease_until IS NULL AND updated_at=:barrierIso AND delivery_kind='room_app_event'
 AND admission_receipt_id IS NULL AND room_admission_id=:admissionId
 AND room_source_attempt=:sourceAttempt AND room_source_json=:originalSourceJson
 AND room_source_hash=:originalSourceHash AND input_event_ids=:inputEventIdsJson
 AND effective_payload=:effectivePayloadJson;`,
  },
  'potential-fence-observation': {
    method: 'all' as const,
    sql: `SELECT b.*,
 a.admission_id,a.source_attempt,a.boot_epoch,a.dispatch_id,a.claimed_at_ms,a.spend_row_id,
 a.status AS admission_status,a.row_json
FROM main.canvas_doc_batches b LEFT JOIN main.room_doc_admissions a
 ON a.document_id=b.document_id AND a.batch_id=b.batch_id AND a.generation=b.generation
 AND a.admission_id=b.room_admission_id
WHERE b.delivery_kind='room_app_event' AND b.status IN ('dispatching','turn_started','in_doubt')
ORDER BY b.document_id,b.batch_id LIMIT 1001;`,
  },
  'ordinary-insert-doc-fenced': {
    method: 'run' as const,
    sql: `INSERT INTO main.room_turn_spend(room_id,at)
SELECT :roomId,:atMs WHERE NOT EXISTS (
 SELECT 1 FROM main.canvas_doc_batches b LEFT JOIN main.room_doc_admissions a
 ON a.document_id=b.document_id AND a.batch_id=b.batch_id AND a.generation=b.generation
 AND a.admission_id=b.room_admission_id
 WHERE b.delivery_kind='room_app_event' AND b.status IN ('dispatching','turn_started','in_doubt')
 AND (
  (b.error_code IN ('room_doc_claim_prepared','room_doc_claim_prepared_unknown')
   AND (length(b.updated_at)<>24 OR b.updated_at>:floorIso))
  OR (b.error_code='room_doc_claim_unknown'
   AND (a.claimed_at_ms IS NULL OR a.claimed_at_ms>:floorMs))
  OR (b.error_code IS NULL AND (a.admission_id IS NULL
    OR a.boot_epoch<>:actualNativeRoomEpoch) AND (a.claimed_at_ms IS NULL OR a.claimed_at_ms>:floorMs))
  OR (b.error_code IS NOT NULL AND b.error_code NOT IN
      ('room_doc_claim_prepared','room_doc_claim_prepared_unknown','room_doc_claim_unknown'))
  )
);`,
  },
});
export type RoomDocNativeOperation = keyof typeof roomDocStatements;

for (const statement of Object.values(roomDocStatements)) Object.freeze(statement);
