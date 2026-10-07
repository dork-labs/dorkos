/** Only complete unquoted Boolean SQL keywords are case-insensitive; literals/expressions stay exact. */
function normalizeBooleanDefault(value: string | null): string | null {
  const lower = value?.toLowerCase();
  return lower === 'true' || lower === 'false' ? lower : value;
}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, runMigrations, type Db } from '../index.js';
import * as migrationLocation from '../migrations-folder.js';

const migrationDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const handles: Db[] = [];
const directories: string[] = [];
const now = '2026-10-04T00:00:00.000Z';
const hash = 'a'.repeat(64);

afterEach(() => {
  // Drain every registered resource, even if cleanup throws undefined.
  const failures: unknown[] = [];
  try {
    vi.restoreAllMocks();
  } catch (error) {
    failures.push(error);
  }
  for (const db of handles.splice(0)) {
    try {
      if (db.$client.open) db.$client.close();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Room migration cleanup failed');
});
function directory(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), 'dorkos-room-doc-migration-'));
  directories.push(value);
  return value;
}
function database(filename: string, migrate = true): Db {
  const db = createDb(filename);
  handles.push(db); // Register immediately, before migration can fail.
  if (migrate) runMigrations(db);
  return db;
}
function previousMigrations(): string {
  const folder = directory();
  mkdirSync(path.join(folder, 'meta'));
  const journal = JSON.parse(
    readFileSync(path.join(migrationDir, 'meta/_journal.json'), 'utf8')
  ) as {
    entries: { idx: number; tag: string }[];
  };
  const additions = journal.entries.filter((entry) =>
    /CREATE TABLE\s+["`]?room_doc_admissions["`]?\s*\(/i.test(
      readFileSync(path.join(migrationDir, `${entry.tag}.sql`), 'utf8')
    )
  );
  expect(additions).toHaveLength(1); // Missing generated migration must fail, never skip.
  const introduction = additions[0];
  if (!introduction) throw new Error('The real Room admission migration is missing');
  journal.entries = journal.entries.filter((entry) => entry.idx < introduction.idx);
  writeFileSync(path.join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  for (const entry of journal.entries)
    copyFileSync(
      path.join(migrationDir, `${entry.tag}.sql`),
      path.join(folder, `${entry.tag}.sql`)
    );
  return folder;
}
function normalize(value: string): string {
  const outside = (part: string) =>
    part
      .replace(/[`"[\]]/g, '')
      .replace(/\b[a-z_]+\.(?=[a-z_])/gi, '')
      .replace(/\s+/g, '');
  let result = '',
    plain = '',
    index = 0;
  while (index < value.length) {
    if (value[index] !== "'") {
      plain += value[index++];
      continue;
    }
    result += outside(plain);
    plain = '';
    const start = index++;
    let closed = false;
    while (index < value.length) {
      if (value[index++] !== "'") continue;
      if (value[index] === "'") {
        index++;
        continue;
      }
      closed = true;
      break;
    }
    if (!closed) throw new Error('Unterminated SQL literal');
    result += value.slice(start, index);
  }
  return (result + outside(plain)).replace(/;$/, '');
}
function checks(sql: string): string[] {
  const result: string[] = [];
  const pattern = /\bCHECK\s*\(/gi;
  let found: RegExpExecArray | null;
  while ((found = pattern.exec(sql))) {
    let depth = 1;
    let quoted = false;
    let offset = pattern.lastIndex;
    const start = offset;
    while (depth && offset < sql.length) {
      const character = sql[offset++];
      if (character === "'") {
        if (quoted && sql[offset] === "'") {
          offset++;
          continue;
        }
        quoted = !quoted;
      }
      if (!quoted && character === '(') depth++;
      if (!quoted && character === ')') depth--;
    }
    if (depth || quoted) throw new Error('Incomplete generated CHECK');
    result.push(normalize(sql.slice(start, offset - 1)));
    pattern.lastIndex = offset;
  }
  return result.sort();
}
interface ExpectedTable {
  columns: [string, string, number, number, string | null][];
  foreignKeys: [string[], string, string[], string, string][];
  checks: string[];
  indices: [string, string][];
}
// Exact original native schema literal metadata; observation is not an authority witness.
const expected = JSON.parse(
  readFileSync(new URL('./fixtures/room-doc-native-schema.json', import.meta.url), 'utf8')
) as Record<string, ExpectedTable>;

function assertNativeSchema(db: Db): void {
  for (const [table, contract] of Object.entries(expected)) {
    const observed = db.$client.prepare(`PRAGMA table_xinfo(${table})`).all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
      hidden: number;
    }[];
    expect(observed.every((column) => column.hidden === 0)).toBe(true);
    expect(
      observed
        .map((c) => [
          c.name,
          c.type.toUpperCase(),
          c.notnull,
          c.pk,
          normalizeBooleanDefault(c.dflt_value),
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    ).toEqual(
      contract.columns
        .map((c) => [c[0], c[1], c[2], c[3], normalizeBooleanDefault(c[4])])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );
    const rows = db.$client.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
    }[];
    const groups = new Map<number, typeof rows>();
    for (const row of rows) groups.set(row.id, [...(groups.get(row.id) ?? []), row]);
    const keys = [...groups.values()].map((group) => {
      group.sort((a, b) => a.seq - b.seq);
      return [
        group.map((r) => r.from),
        group[0]!.table,
        group.map((r) => r.to),
        group[0]!.on_update,
        group[0]!.on_delete,
      ];
    });
    expect(keys.map((key) => JSON.stringify(key)).sort()).toEqual(
      contract.foreignKeys.map((key) => JSON.stringify(key)).sort()
    );
    const schema = db.$client
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) as { sql: string };
    expect(checks(schema.sql)).toEqual(contract.checks.map(normalize).sort());
    const indices = db.$client
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL"
      )
      .all(table) as { name: string; sql: string }[];
    expect(
      indices.map((i) => [i.name, normalize(i.sql)]).sort((a, b) => a[0]!.localeCompare(b[0]!))
    ).toEqual(
      contract.indices
        .map(([name, sql]) => [name, normalize(sql)])
        .sort((a, b) => a[0]!.localeCompare(b[0]!))
    );
  }
  expect(db.$client.pragma('foreign_key_check')).toEqual([]);
}
function insert(db: Db, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.$client
    .prepare(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    )
    .run(...Object.values(row));
}
function seedLegacy(db: Db): void {
  insert(db, 'canvas_doc_channels', {
    document_id: 'doc',
    scope: 'session:s',
    created_at: now,
    updated_at: now,
  });
  insert(db, 'canvas_doc_grants', {
    grant_id: 'grant',
    document_id: 'doc',
    route_id: 'route',
    normalized_route: '{}',
    route_hash: hash,
    declaration_hash: hash,
    approved_by: 'owner',
    approval_evidence: '{}',
    limits: '{}',
    allowed_types: '[]',
    created_at: now,
  });
  insert(db, 'canvas_doc_events', {
    document_id: 'doc',
    event_id: 'event',
    doc_seq: 1,
    direction: 'upstream',
    type: 'app.changed',
    payload: '{}',
    envelope_hash: hash,
    received_at: now,
    provenance: '{}',
  });
  insert(db, 'session_message_acceptance_receipts', {
    id: 'private-receipt',
    source_kind: 'document_event_batch',
    source_id: 'batch',
    source_generation: 'g',
    queue_message_id: 'q',
    session_id: 's',
    agent_id: 'agent',
    origin_runtime: 'claude-code',
    origin_agent_path: '/test/agent',
    origin_authority_digest: hash,
    state: 'accepted',
    accepted_at: now,
  });
  insert(db, 'canvas_doc_batches', {
    batch_id: 'batch',
    document_id: 'doc',
    scope: 'session:s',
    route_id: 'route',
    grant_id: 'grant',
    grant_revision: 1,
    generation: 'g',
    input_event_ids: '["event"]',
    effective_payload: '{}',
    due_at: now,
    status: 'accepted',
    admission_receipt_id: 'private-receipt',
    created_at: now,
    updated_at: now,
  });
  insert(db, 'canvas_doc_deliveries', {
    document_id: 'doc',
    event_id: 'event',
    route_id: 'route',
    batch_id: 'batch',
    status: 'pending',
    updated_at: now,
  });
  insert(db, 'canvas_documents', {
    id: 'physical',
    scope: 'session:s',
    content: '{"type":"json","data":{}}',
    title: 'Existing',
    content_type: 'json',
    author_id: 'owner',
    rev: 1,
    last_touched_by: 'owner',
    last_touched_at: now,
    opened_at: now,
    last_active_at: now,
  });
}
function admissionRow(): Record<string, unknown> {
  const source = {
    documentId: 'doc',
    batchId: 'batch',
    generation: 'g',
    roomId: 'room',
    grantId: 'grant',
    grantRevision: 1,
    routeId: 'route',
    routeHash: hash,
    declarationHash: hash,
    manifestHash: null,
    inputFingerprint: hash,
    authorityDigest: hash,
    effectivePayloadDigest: hash,
    agentId: 'agent',
    authorId: 'author',
    sessionId: 's',
    runtime: 'claude-code',
    agentPath: '/test/agent',
  };
  const logical = {
    admissionId: 'admission',
    entryId: 'child',
    source,
    sourceAttempt: 0,
    sourceHash: hash,
    dispatchAttempt: 1,
    bootEpoch: 'boot',
    dispatchId: 'dispatch',
    claimedAtMs: 1,
    spendRowId: null,
    status: 'claimed',
    turnId: null,
    outcome: null,
    cascadeRoot: 'root',
    rootRoomId: 'room',
    rootEntryId: 'root',
    ceiling: 3,
    producerEvidence: {},
    createdAt: now,
    claimedAt: now,
    updatedAt: now,
  };
  return {
    admission_id: 'admission',
    document_id: 'doc',
    batch_id: 'batch',
    generation: 'g',
    source_attempt: 0,
    room_id: 'room',
    entry_id: 'child',
    entry_seq: 2,
    grant_id: 'grant',
    grant_revision: 1,
    route_id: 'route',
    route_hash: hash,
    declaration_hash: hash,
    manifest_hash: null,
    input_fingerprint: hash,
    authority_digest: hash,
    effective_payload_digest: hash,
    source_hash: hash,
    producer_evidence_json: '{}',
    target_agent_id: 'agent',
    target_author_id: 'author',
    target_session_id: 's',
    target_runtime: 'claude-code',
    target_agent_path: '/test/agent',
    cascade_root: 'root',
    root_room_id: 'room',
    root_entry_id: 'root',
    frozen_ceiling: 3,
    dispatch_attempt: 1,
    boot_epoch: 'boot',
    dispatch_id: 'dispatch',
    claimed_at_ms: 1,
    claimed_at: now,
    spend_row_id: null,
    status: 'claimed',
    turn_id: null,
    outcome: null,
    created_at: now,
    updated_at: now,
    row_json: JSON.stringify(logical),
  };
}
function seedStorageParents(db: Db): void {
  // SQL storage positive only: this never issues a real native claim/start permission.
  seedLegacy(db);
  insert(db, 'rooms', {
    id: 'room',
    kind: 'channel',
    title: 'Storage test',
    created_at: now,
    last_activity_at: now,
  });
  for (const [id, seq] of [
    ['root', 1],
    ['child', 2],
  ] as const)
    insert(db, 'room_entries', {
      room_id: 'room',
      seq,
      id,
      author_id: 'author',
      kind: 'post',
      body: '{}',
      cascade_root: 'root',
      created_at: now,
    });
  db.$client
    .prepare(
      "UPDATE canvas_doc_batches SET admission_receipt_id=NULL,delivery_kind='room_app_event',room_admission_id='admission',room_source_attempt=0,room_source_json=?,room_source_hash=? WHERE batch_id='batch'"
    )
    .run(
      JSON.stringify({
        admissionId: 'admission',
        documentId: 'doc',
        batchId: 'batch',
        generation: 'g',
        sourceAttempt: 0,
      }),
      hash
    );
  db.$client
    .prepare(
      "UPDATE canvas_doc_deliveries SET delivery_kind='room_app_event',room_admission_id='admission'"
    )
    .run();
}

describe('genuine Room admission production migration', () => {
  it('upgrades populated FILE schema through the actual journal and preserves private rows across reopen', () => {
    const filename = path.join(directory(), 'dork.db');
    const db = database(filename, false);
    const prefix = previousMigrations();
    const locator = vi.spyOn(migrationLocation, 'migrationsFolder').mockReturnValue(prefix);
    try {
      runMigrations(db);
    } finally {
      locator.mockRestore();
    }
    seedLegacy(db);
    const names = [
      'canvas_doc_channels',
      'canvas_doc_grants',
      'canvas_doc_events',
      'canvas_doc_batches',
      'canvas_doc_deliveries',
      'canvas_documents',
      'session_message_acceptance_receipts',
    ];
    const before = Object.fromEntries(
      names.map((name) => [name, db.$client.prepare(`SELECT * FROM ${name}`).all()])
    );
    runMigrations(db);
    runMigrations(db);
    for (const name of names) {
      const rows = db.$client.prepare(`SELECT * FROM ${name}`).all() as Record<string, unknown>[];
      const additions = Object.keys(rows[0]!).filter(
        (key) => !(key in (before[name] as Record<string, unknown>[])[0]!)
      );
      for (const row of rows) for (const key of additions) expect(row[key]).toBeNull();
      expect(
        rows.map((row) =>
          Object.fromEntries(Object.entries(row).filter(([key]) => !additions.includes(key)))
        )
      ).toEqual(before[name]);
    }
    for (const name of [
      'room_doc_admissions',
      'room_doc_admission_inputs',
      'room_doc_exhausted_lineages',
    ])
      expect(db.$client.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get()).toEqual({
        count: 0,
      });
    assertNativeSchema(db);
    db.$client.close();
    const reopened = database(filename);
    assertNativeSchema(reopened);
    expect(
      reopened.$client
        .prepare(
          'SELECT admission_receipt_id,delivery_kind,room_admission_id FROM canvas_doc_batches'
        )
        .get()
    ).toEqual({
      admission_receipt_id: 'private-receipt',
      delivery_kind: null,
      room_admission_id: null,
    });
  });

  it('normalizes only complete unquoted Boolean default keywords', () => {
    expect(normalizeBooleanDefault('False')).toBe('false');
    expect(normalizeBooleanDefault('TRUE')).toBe('true');
    for (const literal of ["'False'", '0', 'false ', '(false)', "'a b'", "'$.source.documentId'"])
      expect(normalizeBooleanDefault(literal)).toBe(literal);
    for (const keyword of ['TRUE', 'FALSE', 'true', 'false'])
      for (const ending of ['\n', '\r', '\r\n']) {
        const literal = keyword + ending;
        expect(normalizeBooleanDefault(literal)).toBe(literal);
      }
    expect(normalizeBooleanDefault(null)).toBeNull();
  });

  it('preserves SQL literals while normalizing equivalent identifier syntax', () => {
    expect(normalize("json_extract(main.row_json,'$.source.documentId') IS document_id")).not.toBe(
      normalize("json_extract(main.row_json,'$.other.documentId') IS document_id")
    );
    for (const [left, right] of [
      ["'a b'", "'ab'"],
      ["'[x]'", "'x'"],
      ["'a''b'", "'ab'"],
    ])
      expect(normalize(left!)).not.toBe(normalize(right!));
    expect(normalize('"main"."row_json" IS [row_json]')).toBe(normalize('row_json IS row_json'));
    expect(() => normalize("'unterminated")).toThrow('Unterminated SQL literal');
  });

  it('rejects null terminal outcomes independently of row agreement and retains valid lifecycle rows', () => {
    const db = database(path.join(directory(), 'dork.db'));
    seedStorageParents(db);
    const original = admissionRow();
    const states = [
      { status: 'claimed', turn_id: null, outcome: null },
      { status: 'turn_started', turn_id: 'turn', outcome: null },
      { status: 'settled', turn_id: 'turn', outcome: 'turn_done' },
      { status: 'settled', turn_id: null, outcome: 'failed' },
      { status: 'settled', turn_id: null, outcome: 'cancelled' },
      { status: 'in_doubt', turn_id: null, outcome: 'in_doubt' },
    ];
    for (const state of states) {
      const logical = {
        ...JSON.parse(original.row_json as string),
        status: state.status,
        turnId: state.turn_id,
        outcome: state.outcome,
      };
      insert(db, 'room_doc_admissions', {
        ...original,
        ...state,
        row_json: JSON.stringify(logical),
      });
      db.$client.prepare("DELETE FROM room_doc_admissions WHERE admission_id='admission'").run();
    }
    for (const status of ['settled', 'in_doubt']) {
      const logical = {
        ...JSON.parse(original.row_json as string),
        status,
        turnId: null,
        outcome: null,
      };
      expect(() =>
        insert(db, 'room_doc_admissions', {
          ...original,
          status,
          turn_id: null,
          outcome: null,
          row_json: JSON.stringify(logical),
        })
      ).toThrow(/CHECK/);
    }
  });

  it('enforces exact native schema, row agreement and NO ACTION evidence references', () => {
    const db = database(path.join(directory(), 'dork.db'));
    assertNativeSchema(db);
    seedStorageParents(db);
    expect(() =>
      db.$client
        .prepare(
          "UPDATE canvas_doc_batches SET delivery_kind='private_session' WHERE batch_id='batch'"
        )
        .run()
    ).toThrow(/CHECK/);
    expect(() =>
      db.$client
        .prepare("UPDATE canvas_doc_batches SET room_source_hash='BAD' WHERE batch_id='batch'")
        .run()
    ).toThrow(/CHECK/);
    expect(() =>
      db.$client
        .prepare("UPDATE canvas_doc_batches SET room_source_json='{}' WHERE batch_id='batch'")
        .run()
    ).toThrow(/CHECK/);
    expect(() =>
      db.$client.prepare('UPDATE canvas_doc_deliveries SET delivery_kind=NULL').run()
    ).toThrow(/CHECK/);
    expect(() =>
      db.$client
        .prepare("UPDATE canvas_doc_batches SET delivery_kind=NULL WHERE batch_id='batch'")
        .run()
    ).toThrow(/CHECK/);
    const row = admissionRow();
    for (const change of [
      { source_attempt: -1 },
      { entry_seq: 0 },
      { dispatch_attempt: 2 },
      { target_runtime: 'unknown' },
      { producer_evidence_json: 'invalid' },
      { row_json: '{}' },
      { spend_row_id: 0 },
    ])
      expect(() => {
        const logical = JSON.parse(row.row_json as string);
        if ('source_attempt' in change) logical.sourceAttempt = change.source_attempt;
        if ('dispatch_attempt' in change) logical.dispatchAttempt = change.dispatch_attempt;
        if ('target_runtime' in change) logical.source.runtime = change.target_runtime;
        if ('spend_row_id' in change) logical.spendRowId = change.spend_row_id;
        insert(db, 'room_doc_admissions', {
          ...row,
          ...change,
          ...('row_json' in change ? {} : { row_json: JSON.stringify(logical) }),
        });
      }).toThrow(/CHECK/);
    insert(db, 'room_doc_admissions', row);
    expect(() => insert(db, 'room_doc_admissions', row)).toThrow(/UNIQUE/);
    const input = {
      admission_id: 'admission',
      document_id: 'doc',
      event_id: 'event',
      route_id: 'route',
      input_ordinal: 0,
      doc_seq: 1,
      envelope_hash: hash,
      source_delivery_status: 'pending',
    };
    for (const input_ordinal of [-1, 100])
      expect(() => insert(db, 'room_doc_admission_inputs', { ...input, input_ordinal })).toThrow(
        /CHECK/
      );
    expect(() =>
      insert(db, 'room_doc_admission_inputs', { ...input, event_id: 'missing' })
    ).toThrow(/FOREIGN KEY/);
    insert(db, 'room_doc_admission_inputs', input);
    for (const [table, predicate] of [
      ['canvas_doc_batches', "batch_id='batch'"],
      ['canvas_doc_grants', "grant_id='grant'"],
      ['canvas_doc_deliveries', "event_id='event'"],
      ['canvas_doc_events', "event_id='event'"],
      ['room_entries', "id='child'"],
      ['room_doc_admissions', "admission_id='admission'"],
    ])
      expect(() => db.$client.prepare(`DELETE FROM ${table} WHERE ${predicate}`).run()).toThrow(
        /FOREIGN KEY/
      );
    insert(db, 'room_doc_exhausted_lineages', {
      cascade_root: 'root',
      root_room_id: 'room',
      root_entry_id: 'root',
      original_admission_id: 'admission',
      frozen_ceiling: 3,
      exhausted_at: now,
    });
    // No spend FK and no original-admission FK; preserve exhaustion/root after removing linked receipt.
    db.transaction(() => {
      db.$client
        .prepare("DELETE FROM room_doc_admission_inputs WHERE admission_id='admission'")
        .run();
      db.$client.prepare("DELETE FROM room_doc_admissions WHERE admission_id='admission'").run();
    });
    expect(() => db.$client.prepare("DELETE FROM room_entries WHERE id='root'").run()).toThrow(
      /FOREIGN KEY/
    );
    expect(
      db.$client.prepare('SELECT original_admission_id FROM room_doc_exhausted_lineages').get()
    ).toEqual({ original_admission_id: 'admission' });
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });
});

it('migrates an existing Room queue without giving private acceptance or claimed Room work a second active slot', () => {
  const folder = directory();
  mkdirSync(path.join(folder, 'meta'));
  const journal = JSON.parse(
    readFileSync(path.join(migrationDir, 'meta/_journal.json'), 'utf8')
  ) as {
    entries: { idx: number; tag: string }[];
  };
  const queueMigrations = journal.entries.filter((entry) =>
    readFileSync(path.join(migrationDir, `${entry.tag}.sql`), 'utf8').includes(
      "AND (delivery_kind IS NOT 'room_app_event' OR status IS NOT 'accepted')"
    )
  );
  expect(queueMigrations).toHaveLength(1);
  const queueMigration = queueMigrations[0];
  if (!queueMigration) throw new Error('The original Room queue migration is missing');
  journal.entries = journal.entries.filter((entry) => entry.idx < queueMigration.idx);
  writeFileSync(path.join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  for (const entry of journal.entries)
    copyFileSync(
      path.join(migrationDir, `${entry.tag}.sql`),
      path.join(folder, `${entry.tag}.sql`)
    );
  const migrationFolder = vi.spyOn(migrationLocation, 'migrationsFolder').mockReturnValue(folder);
  const filename = path.join(directory(), 'existing.sqlite');
  const db = database(filename);
  seedLegacy(db);
  const legacy = db.$client
    .prepare("SELECT * FROM canvas_doc_batches WHERE batch_id='batch'")
    .get() as Record<string, unknown>;
  expect(() =>
    insert(db, 'canvas_doc_batches', { ...legacy, batch_id: 'private-overlap' })
  ).toThrow(/UNIQUE/);
  db.$client
    .prepare("UPDATE canvas_doc_batches SET status='turn_done' WHERE batch_id='batch'")
    .run();
  const room = (batchId: string): Record<string, unknown> => ({
    ...legacy,
    batch_id: batchId,
    scope: 'room:r',
    admission_receipt_id: null,
    delivery_kind: 'room_app_event',
    room_admission_id: `admission-${batchId}`,
    room_source_attempt: 0,
    room_source_json: JSON.stringify({
      documentId: 'doc',
      batchId,
      generation: 'g',
      sourceAttempt: 0,
      admissionId: `admission-${batchId}`,
    }),
    room_source_hash: hash,
  });
  insert(db, 'canvas_doc_batches', room('room-first'));
  expect(() => insert(db, 'canvas_doc_batches', room('room-second'))).toThrow(/UNIQUE/);
  const before = db.$client.prepare('SELECT * FROM canvas_doc_batches ORDER BY batch_id').all();
  const historyBefore = db.$client.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all();
  migrationFolder.mockRestore();
  runMigrations(db);
  expect(db.$client.prepare('SELECT * FROM canvas_doc_batches ORDER BY batch_id').all()).toEqual(
    before
  );
  expect(db.$client.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()).toHaveLength(
    historyBefore.length + 1
  );
  insert(db, 'canvas_doc_batches', room('room-second'));
  insert(db, 'canvas_doc_batches', { ...legacy, batch_id: 'private-first' });
  expect(() => insert(db, 'canvas_doc_batches', { ...legacy, batch_id: 'private-second' })).toThrow(
    /UNIQUE/
  );
  expect(() =>
    db.$client
      .prepare("UPDATE canvas_doc_batches SET status='dispatching' WHERE batch_id='room-first'")
      .run()
  ).toThrow(/UNIQUE/);
  db.$client
    .prepare("UPDATE canvas_doc_batches SET status='turn_done' WHERE batch_id='private-first'")
    .run();
  db.$client
    .prepare("UPDATE canvas_doc_batches SET status='dispatching' WHERE batch_id='room-first'")
    .run();
  expect(() =>
    db.$client
      .prepare("UPDATE canvas_doc_batches SET status='dispatching' WHERE batch_id='room-second'")
      .run()
  ).toThrow(/UNIQUE/);
  db.$client
    .prepare("UPDATE canvas_doc_batches SET status='in_doubt' WHERE batch_id='room-first'")
    .run();
  expect(() =>
    db.$client
      .prepare("UPDATE canvas_doc_batches SET status='dispatching' WHERE batch_id='room-second'")
      .run()
  ).toThrow(/UNIQUE/);
  expect(() => insert(db, 'canvas_doc_batches', { ...legacy, batch_id: 'private-third' })).toThrow(
    /UNIQUE/
  );
  db.$client
    .prepare("UPDATE canvas_doc_batches SET status='turn_done' WHERE batch_id='room-first'")
    .run();
  db.$client
    .prepare("UPDATE canvas_doc_batches SET status='dispatching' WHERE batch_id='room-second'")
    .run();
  const settledRows = db.$client
    .prepare('SELECT * FROM canvas_doc_batches ORDER BY batch_id')
    .all();
  const history = db.$client.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all();
  db.$client.close();
  expect(db.$client.open).toBe(false);
  const reopened = database(filename);
  runMigrations(reopened);
  expect(
    reopened.$client.prepare('SELECT * FROM canvas_doc_batches ORDER BY batch_id').all()
  ).toEqual(settledRows);
  expect(reopened.$client.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()).toEqual(
    history
  );
});
