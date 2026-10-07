/** Private literal schema introspection; never accepts a caller table or SQL. */
export const roomDocSchemaStatements = Object.freeze({
  'schema-presence': {
    method: 'all' as const,
    sql: "SELECT name FROM main.sqlite_master WHERE type='table' AND name IN ('room_doc_admissions','room_doc_admission_inputs','room_doc_exhausted_lineages');",
  },
  'schema-canvas_doc_room_pending_sources-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(canvas_doc_room_pending_sources);',
  },
  'schema-canvas_doc_room_pending_sources-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(canvas_doc_room_pending_sources);',
  },
  'schema-canvas_doc_channels-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(canvas_doc_channels);',
  },
  'schema-canvas_doc_channels-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(canvas_doc_channels);',
  },
  'schema-canvas_doc_grants-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(canvas_doc_grants);',
  },
  'schema-canvas_doc_grants-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(canvas_doc_grants);',
  },
  'schema-canvas_doc_batches-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(canvas_doc_batches);',
  },
  'schema-canvas_doc_batches-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(canvas_doc_batches);',
  },
  'schema-canvas_doc_events-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(canvas_doc_events);',
  },
  'schema-canvas_doc_events-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(canvas_doc_events);',
  },
  'schema-canvas_doc_deliveries-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(canvas_doc_deliveries);',
  },
  'schema-canvas_doc_deliveries-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(canvas_doc_deliveries);',
  },
  'schema-canvas_documents-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(canvas_documents);',
  },
  'schema-canvas_documents-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(canvas_documents);',
  },
  'schema-approvals-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(approvals);',
  },
  'schema-approvals-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(approvals);',
  },
  'schema-connector_runtime_bindings-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(connector_runtime_bindings);',
  },
  'schema-connector_runtime_bindings-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(connector_runtime_bindings);',
  },
  'schema-rooms-columns': { method: 'all' as const, sql: 'PRAGMA main.table_xinfo(rooms);' },
  'schema-rooms-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(rooms);',
  },
  'schema-authors-columns': { method: 'all' as const, sql: 'PRAGMA main.table_xinfo(authors);' },
  'schema-authors-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(authors);',
  },
  'schema-agents-columns': { method: 'all' as const, sql: 'PRAGMA main.table_xinfo(agents);' },
  'schema-agents-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(agents);',
  },
  'schema-room_members-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(room_members);',
  },
  'schema-room_members-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(room_members);',
  },
  'schema-room_sessions-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(room_sessions);',
  },
  'schema-room_sessions-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(room_sessions);',
  },
  'schema-room_session_retirements-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(room_session_retirements);',
  },
  'schema-room_session_retirements-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(room_session_retirements);',
  },
  'schema-community_room_mirrors-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(community_room_mirrors);',
  },
  'schema-community_room_mirrors-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(community_room_mirrors);',
  },
  'schema-room_entries-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(room_entries);',
  },
  'schema-room_entries-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(room_entries);',
  },
  'schema-room_turn_spend-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(room_turn_spend);',
  },
  'schema-room_turn_spend-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(room_turn_spend);',
  },
  'schema-room_doc_admissions-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(room_doc_admissions);',
  },
  'schema-room_doc_admissions-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(room_doc_admissions);',
  },
  'schema-room_doc_admission_inputs-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(room_doc_admission_inputs);',
  },
  'schema-room_doc_admission_inputs-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(room_doc_admission_inputs);',
  },
  'schema-room_doc_exhausted_lineages-columns': {
    method: 'all' as const,
    sql: 'PRAGMA main.table_xinfo(room_doc_exhausted_lineages);',
  },
  'schema-room_doc_exhausted_lineages-foreignKeys': {
    method: 'all' as const,
    sql: 'PRAGMA main.foreign_key_list(room_doc_exhausted_lineages);',
  },
  'guard-main-version': { method: 'get' as const, sql: `PRAGMA main.data_version;` },
  'guard-main-schema': { method: 'get' as const, sql: `PRAGMA main.schema_version;` },
  'guard-temp-schema': { method: 'get' as const, sql: `PRAGMA temp.schema_version;` },
  'guard-databases': { method: 'all' as const, sql: `PRAGMA database_list;` },
  'guard-foreign-keys': { method: 'get' as const, sql: `PRAGMA foreign_keys;` },
  'guard-recursive-triggers': { method: 'get' as const, sql: `PRAGMA recursive_triggers;` },
  'guard-schema': {
    method: 'all' as const,
    sql: `SELECT type,name,tbl_name,sql FROM main.sqlite_master
WHERE name IN ('canvas_doc_room_pending_sources','canvas_doc_channels','canvas_doc_grants','canvas_doc_batches',
 'canvas_doc_events','canvas_doc_deliveries','canvas_documents','approvals',
 'connector_runtime_bindings','rooms','authors','agents','room_members','room_sessions',
 'room_session_retirements','community_room_mirrors','room_entries','room_turn_spend',
 'room_doc_admissions','room_doc_admission_inputs','room_doc_exhausted_lineages')
 OR (type='index' AND tbl_name IN ('canvas_doc_room_pending_sources','canvas_doc_channels','canvas_doc_grants',
 'canvas_doc_batches','canvas_doc_events','canvas_doc_deliveries','canvas_documents',
 'approvals','connector_runtime_bindings','rooms','authors','agents','room_members',
 'room_sessions','room_session_retirements','community_room_mirrors','room_entries',
 'room_turn_spend','room_doc_admissions','room_doc_admission_inputs','room_doc_exhausted_lineages'))
ORDER BY type,name;`,
  },
  'guard-triggers': {
    method: 'all' as const,
    sql: `SELECT 'main' AS db,name,tbl_name,sql FROM main.sqlite_master WHERE type='trigger'
AND tbl_name IN ('canvas_doc_room_pending_sources','canvas_doc_channels','canvas_doc_grants','canvas_doc_batches',
 'canvas_doc_events','canvas_doc_deliveries','canvas_documents','approvals',
 'connector_runtime_bindings','rooms','authors','agents','room_members','room_sessions',
 'room_session_retirements','community_room_mirrors','room_entries','room_turn_spend',
 'room_doc_admissions','room_doc_admission_inputs','room_doc_exhausted_lineages')
UNION ALL SELECT 'temp',name,tbl_name,sql FROM temp.sqlite_master WHERE type='trigger';`,
  },
});

for (const statement of Object.values(roomDocSchemaStatements)) Object.freeze(statement);
