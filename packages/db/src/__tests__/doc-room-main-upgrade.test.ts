/** Populated shipped-main upgrades retain data and never invent Room custody. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it, vi } from 'vitest';
import {
  consolidatedDoc,
  previousConsolidatedDoc,
  heartbeatReportItems,
  remoteEventRefusals,
} from '../doc-migration-identities.js';
import { createDb, runMigrations } from '../index.js';
import { bridgeLegacyDocMigrationHistory } from '../doc-migration-history.js';

const folder = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const timestamp = '2026-10-09T19:00:00.000Z';

describe('Doc Room upgrade from populated shipped main', () => {
  it.each([148, 149, 150, 154, 155, 156, 157, 158])(
    'preserves Main%d rows with foreign keys enforced and no invented custody',
    (idx) => {
      const temporary = mkdtempSync(path.join(os.tmpdir(), 'dorkos-room-upgrade-'));
      const db = createDb(':memory:');
      try {
        mkdirSync(path.join(temporary, 'meta'));
        const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8'));
        const finalEntry = journal.entries.at(-1);
        expect(finalEntry).toMatchObject({
          idx: 159,
          when: 1791744308484,
          tag: '20261011184508_tearful_killer_shrike',
        });
        const finalHistoryLength = journal.entries.length;
        expect(finalHistoryLength).toBe(160);
        journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= idx);
        writeFileSync(path.join(temporary, 'meta/_journal.json'), JSON.stringify(journal));
        for (const entry of journal.entries)
          copyFileSync(
            path.join(folder, `${entry.tag}.sql`),
            path.join(temporary, `${entry.tag}.sql`)
          );
        migrate(db, { migrationsFolder: temporary });
        expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
        const insert = (table: string, row: Record<string, string | number>) => {
          const keys = Object.keys(row);
          db.$client
            .prepare(
              `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
            )
            .run(...Object.values(row));
        };
        insert('canvas_doc_channels', {
          document_id: 'doc',
          scope: 'session:one',
          created_at: timestamp,
          updated_at: timestamp,
        });
        insert('canvas_doc_grants', {
          grant_id: 'grant',
          document_id: 'doc',
          route_id: 'route',
          normalized_route: '{}',
          route_hash: 'a'.repeat(64),
          declaration_hash: 'b'.repeat(64),
          approved_by: 'operator',
          approval_evidence: '{}',
          limits: '{}',
          allowed_types: '[]',
          created_at: timestamp,
        });
        insert('canvas_doc_events', {
          document_id: 'doc',
          event_id: 'event',
          doc_seq: 1,
          direction: 'upstream',
          type: 'task.changed',
          payload: '{"text":"keep"}',
          envelope_hash: 'c'.repeat(64),
          received_at: timestamp,
          provenance: '{}',
        });
        insert('canvas_doc_batches', {
          batch_id: 'batch',
          document_id: 'doc',
          scope: 'session:one',
          route_id: 'route',
          grant_id: 'grant',
          grant_revision: 1,
          generation: 'generation',
          input_event_ids: '["event"]',
          effective_payload: '{"text":"keep"}',
          due_at: timestamp,
          status: 'turn_started',
          created_at: timestamp,
          updated_at: timestamp,
        });
        insert('canvas_doc_deliveries', {
          document_id: 'doc',
          event_id: 'event',
          route_id: 'route',
          batch_id: 'batch',
          status: 'turn_started',
          updated_at: timestamp,
        });
        if (idx >= 149)
          insert('chat_messages', {
            id: 'chat-message',
            to_session_id: 'to',
            from_session_id: 'from',
            from_agent_path: '/agents/one',
            from_agent_name: 'One',
            kind: 'message',
            text: 'keep chat words',
            delivery: 'queue',
            status: 'queued',
            ceiling_json: '"runtime-default"',
            created_at: timestamp,
            updated_at: timestamp,
          });
        if (idx >= 155) seedIncomingMainData(db, idx >= 156 ? 156 : 155);
        if (idx >= 157) seedIncomingMain158Data(db, idx === 158 ? 158 : 157);
        const durable = idx >= 155 ? incomingMainData(db, idx >= 156 ? 156 : 155) : [];
        const reports =
          idx >= 157
            ? db.$client.prepare('SELECT * FROM heartbeat_report_items ORDER BY id').all()
            : [];
        const tables = [
          'canvas_doc_channels',
          'canvas_doc_grants',
          'canvas_doc_events',
          'canvas_doc_batches',
          'canvas_doc_deliveries',
          ...(idx >= 149 ? ['chat_messages'] : []),
        ];
        const before = tables.map((table) => ({
          table,
          rows: db.$client.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[],
        }));
        const history = db.$client
          .prepare('SELECT * FROM __drizzle_migrations ORDER BY rowid')
          .all();
        runMigrations(db);
        expectIncomingMainDataPreserved(db, durable);
        expect(
          db.$client.prepare('SELECT * FROM heartbeat_report_items ORDER BY id').all()
        ).toEqual(reports);
        if (idx >= 156)
          expect(db.$client.prepare('SELECT refusals FROM remote_event_outbox').all()).toEqual([
            { refusals: idx === 158 ? 7 : 0 },
          ]);
        for (const { table, rows } of before) {
          const after = db.$client.prepare(`SELECT * FROM ${table}`).all() as Record<
            string,
            unknown
          >[];
          expect(after).toHaveLength(rows.length);
          for (const [index, row] of rows.entries()) expect(after[index]).toMatchObject(row);
        }
        expect(
          db.$client
            .prepare(
              'SELECT delivery_kind, room_admission_id, room_source_attempt, room_source_json, room_source_hash FROM canvas_doc_batches'
            )
            .get()
        ).toEqual({
          delivery_kind: null,
          room_admission_id: null,
          room_source_attempt: null,
          room_source_json: null,
          room_source_hash: null,
        });
        expect(
          db.$client
            .prepare('SELECT delivery_kind, room_admission_id FROM canvas_doc_deliveries')
            .get()
        ).toEqual({ delivery_kind: null, room_admission_id: null });
        expect(
          db.$client.prepare('SELECT room_spend_floor_ms FROM canvas_doc_channels').get()
        ).toEqual({ room_spend_floor_ms: null });
        if (idx >= 154) {
          // The real additive columns must preserve data and enforce genuine Room agreement.
          expect(() =>
            db.$client.exec(
              "UPDATE canvas_doc_batches SET delivery_kind='room_app_event' WHERE batch_id='batch'"
            )
          ).toThrow(/CHECK constraint failed/);
          expect(() =>
            db.$client.exec(
              "UPDATE canvas_doc_deliveries SET delivery_kind='room_app_event' WHERE event_id='event'"
            )
          ).toThrow(/CHECK constraint failed/);
          expect(() =>
            db.$client.exec(`INSERT INTO canvas_doc_batches
            (batch_id, document_id, scope, route_id, grant_id, grant_revision,
             generation, input_event_ids, effective_payload, due_at, status, created_at, updated_at)
            SELECT 'duplicate-active', document_id, scope, route_id, grant_id, grant_revision,
              generation, input_event_ids, effective_payload, due_at, status, created_at, updated_at
            FROM canvas_doc_batches WHERE batch_id='batch'`)
          ).toThrow(
            /UNIQUE constraint failed: canvas_doc_batches.document_id, canvas_doc_batches.route_id/
          );
          const indexes = db.$client.prepare("PRAGMA index_list('canvas_doc_batches')").all() as {
            name: string;
            unique: number;
          }[];
          expect(indexes).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: 'canvas_doc_batches_active_unique', unique: 1 }),
              expect.objectContaining({
                name: 'canvas_doc_batches_room_admission_unique',
                unique: 1,
              }),
            ])
          );
          expect(
            db.$client.prepare('SELECT COUNT(*) AS count FROM canvas_doc_batches').get()
          ).toEqual({ count: 1 });
          expect(
            db.$client.prepare('SELECT COUNT(*) AS count FROM canvas_doc_deliveries').get()
          ).toEqual({ count: 1 });
        }
        expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        const afterHistory = db.$client
          .prepare('SELECT * FROM __drizzle_migrations ORDER BY rowid')
          .all();
        expect(afterHistory.slice(0, idx + 1)).toEqual(history);
        expect(afterHistory).toHaveLength(finalHistoryLength);
        expect(afterHistory.at(-1)).toMatchObject({
          hash: createHash('sha256')
            .update(readFileSync(path.join(folder, `${finalEntry.tag}.sql`)))
            .digest('hex'),
          created_at: finalEntry.when,
        });
        runMigrations(db);
        expect(
          db.$client.prepare('SELECT * FROM __drizzle_migrations ORDER BY rowid').all()
        ).toEqual(afterHistory);
      } finally {
        db.$client.close();
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  );
});

// Seed authenticated shipped Main155/156 rows in genuine migration fixtures.
// These helpers preserve the durable rows across ordinary migrations and restart.
function seedIncomingMainData(db: ReturnType<typeof createDb>, through: 155 | 156) {
  const at = '2026-10-11T00:00:00.000Z';
  db.$client
    .prepare(
      `INSERT INTO heartbeat_beats
    (id, agent_id, started_at, kind, wake, changes, raises, bypass, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'kept-beat',
      'kept-agent',
      at,
      'report',
      '{"cause":"preserve"}',
      '{"changed":true}',
      3,
      1,
      'original beat'
    );
  db.$client
    .prepare(
      `INSERT INTO heartbeat_outbox
    (id, agent_id, beat_id, to_account, rung, text, key, urgent,
      deliver_after, state, attempts, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'kept-heartbeat-outbox',
      'kept-agent',
      'kept-beat',
      'kept-account',
      'report',
      'original report',
      'kept-key',
      1,
      at,
      'held',
      2,
      at
    );
  db.$client
    .prepare(
      `INSERT INTO heartbeat_state
    (agent_id, last_beat_at, gathered_through, last_change_keys, wake_again,
      consecutive_failures, beat_chat_id, frontmatter_hash, new_manager)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('kept-agent', at, 'kept-entry', '["kept-key"]', 1, 2, 'kept-chat', 'kept-frontmatter', 1);
  if (through === 156) {
    db.$client
      .prepare(
        `INSERT INTO remote_command_journal
      (command_id, lease_token, verb, instance_id, outcome, ack_state,
        ack_attempts, received_at, settled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'kept-command',
        'kept-lease',
        'rotate',
        'kept-instance',
        '{"ok":true}',
        'unconfirmed',
        3,
        at,
        at
      );
    db.$client
      .prepare(
        `INSERT INTO remote_event_outbox
      (id, idempotency_key, instance_id, batch, attempts, created_at, last_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('kept-remote-outbox', 'kept-idempotency', 'kept-instance', '[{"kept":true}]', 4, at, at);
  }
}

function incomingMainData(db: ReturnType<typeof createDb>, through: 155 | 156) {
  const tables = ['heartbeat_beats', 'heartbeat_outbox', 'heartbeat_state'];
  if (through === 156) tables.push('remote_command_journal', 'remote_event_outbox');
  return tables.map((table) => ({
    table,
    rows: db.$client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  }));
}

function expectIncomingMainDataPreserved(
  db: ReturnType<typeof createDb>,
  before: ReturnType<typeof incomingMainData>
) {
  for (const value of before) {
    const after = db.$client.prepare(`SELECT * FROM ${value.table} ORDER BY rowid`).all() as Record<
      string,
      unknown
    >[];
    // Main158 adds refusals; compare every original key and cardinality without deleting new data.
    expect(after).toHaveLength(value.rows.length);
    expect(
      after.map((row, index) =>
        Object.fromEntries(Object.keys(value.rows[index] as object).map((key) => [key, row[key]]))
      )
    ).toEqual(value.rows);
  }
  expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  // Called only after accepted canonical completion includes all Main150..156.
  if (before.some((value) => value.table === 'remote_event_outbox')) {
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO remote_event_outbox
      (id, idempotency_key, instance_id, batch, created_at)
      VALUES ('duplicate-outbox', 'kept-idempotency', 'kept-instance', '[]', 'later')`
        )
        .run()
    ).toThrow(/UNIQUE constraint failed: remote_event_outbox.idempotency_key/);
  }
  expect(() =>
    db.$client
      .prepare(
        `INSERT INTO remote_command_journal
    (command_id, lease_token, verb, instance_id, received_at)
    VALUES ('invalid-command', 'invalid-lease', 'invented-verb', 'kept-instance', 'later')`
      )
      .run()
  ).toThrow(/CHECK constraint failed: remote_command_journal_verb/);
  expect(() =>
    db.$client
      .prepare(
        `INSERT INTO heartbeat_beats
    (id, agent_id, started_at, kind, wake)
    VALUES ('invalid-beat', 'kept-agent', 'later', 'invented-kind', '{}')`
      )
      .run()
  ).toThrow(/CHECK constraint failed: heartbeat_beats_kind/);
  expect(
    db.$client
      .prepare(
        `SELECT name FROM sqlite_master
    WHERE type='index' AND name IN
      ('heartbeat_beats_agent_started_idx', 'heartbeat_outbox_due_idx',
       'heartbeat_outbox_key_idx', 'remote_command_journal_ack_idx',
       'remote_event_outbox_idempotency_key_unique', 'remote_event_outbox_created_idx')
    ORDER BY name`
      )
      .all()
  ).toHaveLength(6);
}

/** Create a real on-disk old Doc157 database from original SQL, with immediate owned cleanup. */
function original157File(recordedMain: 0 | 1 | 2 = 0) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dorkos-original157-file-'));
  let db: ReturnType<typeof createDb> | undefined;
  try {
    const migrationRoot = path.join(root, 'migrations');
    mkdirSync(path.join(migrationRoot, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8'));
    const entries = [...journal.entries.slice(0, 157), previousConsolidatedDoc];
    writeFileSync(
      path.join(migrationRoot, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries })
    );
    for (const entry of entries)
      copyFileSync(
        path.join(
          folder,
          ...(entry === previousConsolidatedDoc ? ['legacy-doc'] : []),
          `${entry.tag}.sql`
        ),
        path.join(migrationRoot, `${entry.tag}.sql`)
      );
    const filename = path.join(root, 'actual.sqlite');
    db = createDb(filename);
    migrate(db, { migrationsFolder: migrationRoot });
    db.$client
      .prepare(
        'INSERT INTO session_metadata (session_id,runtime,agent_path,created_at) VALUES (?,?,?,?)'
      )
      .run('original-file-session', 'claude-code', '/original-agent', timestamp);
    seedIncomingMainData(db, 156);
    // Real historical bridge partial state: execute only exact authentic incoming SQL
    // and its ledger INSERT in the same native transaction, retaining old157 unchanged.
    db.$client.transaction(() => {
      for (const entry of [heartbeatReportItems, remoteEventRefusals].slice(0, recordedMain)) {
        const sql = readFileSync(path.join(folder, `${entry.tag}.sql`), 'utf8');
        expect(createHash('sha256').update(sql).digest('hex')).toBe(entry.hash);
        for (const statement of sql.split('--> statement-breakpoint'))
          if (statement.trim()) db!.$client.exec(statement);
        db!.$client
          .prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)')
          .run(entry.hash, entry.when);
      }
    })();
    if (recordedMain >= 1) seedIncomingMain158Data(db, recordedMain === 2 ? 158 : 157);
    return { root, filename, db };
  } catch (cause) {
    try {
      db?.$client.close();
    } catch {
      /* Preserve original setup cause, including undefined. */
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Same first cause. */
    }
    throw cause;
  }
}
/** Attempt every acquired cleanup duty while preserving the earliest exact cause. */
function closeOriginal157(h: ReturnType<typeof original157File>, failure?: { cause: unknown }) {
  try {
    h.db.$client.close();
  } catch (cause) {
    failure ??= { cause };
  }
  try {
    rmSync(h.root, { recursive: true, force: true });
  } catch (cause) {
    failure ??= { cause };
  }
  if (failure) throw failure.cause;
}
function original157History(db: ReturnType<typeof createDb>) {
  return db.$client
    .prepare(
      'SELECT rowid AS rowIdentity,id,hash,created_at FROM __drizzle_migrations ORDER BY rowid'
    )
    .all();
}
function original157Schema(db: ReturnType<typeof createDb>) {
  return db.$client
    .prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')
    .all();
}

/** Seed actual incoming Main157/158 data after its genuine native SQL exists. */
function seedIncomingMain158Data(db: ReturnType<typeof createDb>, through: 157 | 158) {
  db.$client
    .prepare(
      `INSERT INTO heartbeat_report_items
    (id,agent_id,kind,to_account,text,key,state,created_at)
    VALUES ('kept-report','kept-agent','reports-to','kept-owner','keep exact report','kept-report-key','reported',?)`
    )
    .run(timestamp);
  if (through === 158) db.$client.prepare('UPDATE remote_event_outbox SET refusals=7').run();
}

describe('authentic original Doc157 to Doc159 bridge', () => {
  it.each([1, 2] as const)(
    'retains authentic partially applied %d Main steps and their populated FILE rows',
    (recorded) => {
      const h = original157File(recorded);
      let failure: { cause: unknown } | undefined;
      try {
        const before = original157History(h.db),
          data = incomingMainData(h.db, 156);
        const reports = h.db.$client
          .prepare('SELECT * FROM heartbeat_report_items ORDER BY id')
          .all();
        runMigrations(h.db);
        const after = original157History(h.db),
          completedSchema = original157Schema(h.db);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after.slice(before.length)).toEqual([
          ...(recorded === 1
            ? [
                expect.objectContaining({
                  hash: remoteEventRefusals.hash,
                  created_at: remoteEventRefusals.when,
                }),
              ]
            : []),
          expect.objectContaining({ hash: consolidatedDoc.hash, created_at: consolidatedDoc.when }),
        ]);
        expect(
          h.db.$client.prepare('SELECT * FROM heartbeat_report_items ORDER BY id').all()
        ).toEqual(reports);
        expectIncomingMainDataPreserved(h.db, data);
        expect(h.db.$client.prepare('SELECT refusals FROM remote_event_outbox').all()).toEqual([
          { refusals: recorded === 2 ? 7 : 0 },
        ]);
        for (let reopen = 0; reopen < 2; reopen++) {
          h.db.$client.close();
          h.db = createDb(h.filename);
          runMigrations(h.db);
          expect(original157History(h.db)).toEqual(after);
          expect(original157Schema(h.db)).toEqual(completedSchema);
          expect(
            h.db.$client.prepare('SELECT * FROM heartbeat_report_items ORDER BY id').all()
          ).toEqual(reports);
          expectIncomingMainDataPreserved(h.db, data);
        }
      } catch (cause) {
        failure = { cause };
      } finally {
        closeOriginal157(h, failure);
      }
    }
  );
  it('preserves original ledger identities and populated FILE data through two real reopens', () => {
    const h = original157File();
    let failure: { cause: unknown } | undefined;
    try {
      const before = original157History(h.db),
        data = incomingMainData(h.db, 156);
      const original = before.find(
        (row) => (row as { hash: string }).hash === previousConsolidatedDoc.hash
      );
      expect(original).toBeDefined();
      runMigrations(h.db);
      const after = original157History(h.db);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toEqual([
        expect.objectContaining({
          hash: heartbeatReportItems.hash,
          created_at: heartbeatReportItems.when,
        }),
        expect.objectContaining({
          hash: remoteEventRefusals.hash,
          created_at: remoteEventRefusals.when,
        }),
        expect.objectContaining({ hash: consolidatedDoc.hash, created_at: consolidatedDoc.when }),
      ]);
      expectIncomingMainDataPreserved(h.db, data);
      const completedSchema = original157Schema(h.db);
      for (let reopened = 0; reopened < 2; reopened++) {
        h.db.$client.close();
        h.db = createDb(h.filename);
        runMigrations(h.db);
        expect(original157History(h.db)).toEqual(after);
        expect(original157Schema(h.db)).toEqual(completedSchema);
        expectIncomingMainDataPreserved(h.db, data);
      }
    } catch (cause) {
      failure = { cause };
    } finally {
      closeOriginal157(h, failure);
    }
  });

  it.each(['first-main', 'second-main', 'completion'] as const)(
    'rolls back actual missing SQL, ledger and populated data on %s failure, then resumes',
    (stage) => {
      const h = original157File();
      let failure: { cause: unknown } | undefined;
      let restore: (() => void) | undefined;
      try {
        const before = original157History(h.db),
          schema = original157Schema(h.db),
          data = incomingMainData(h.db, 156);
        const error = new Error(`original ${stage} failure`);
        const execute = h.db.$client.exec.bind(h.db.$client);
        const spy = vi.spyOn(h.db.$client, 'exec').mockImplementation((sql) => {
          if (
            (stage === 'first-main' && sql.includes('CREATE TABLE `heartbeat_report_items`')) ||
            (stage === 'second-main' && sql.includes('ADD `refusals`'))
          )
            throw error;
          return execute(sql);
        });
        restore = () => spy.mockRestore();
        if (stage === 'completion') {
          const hash = consolidatedDoc.hash.replaceAll("'", "''");
          execute(
            `CREATE TEMP TRIGGER original159_failure BEFORE INSERT ON __drizzle_migrations WHEN NEW.hash='${hash}' BEGIN SELECT RAISE(ABORT,'original completion failure'); END`
          );
        }
        expect(() => runMigrations(h.db)).toThrow(
          stage === 'completion' ? /original completion failure/ : error
        );
        expect(original157History(h.db)).toEqual(before);
        expect(original157Schema(h.db)).toEqual(schema);
        expectIncomingMainDataPreserved(h.db, data);
        restore();
        restore = undefined;
        if (stage === 'completion') execute('DROP TRIGGER original159_failure');
        runMigrations(h.db);
        expect(original157History(h.db).slice(0, before.length)).toEqual(before);
        expectIncomingMainDataPreserved(h.db, data);
      } catch (cause) {
        failure = { cause };
      } finally {
        try {
          restore?.();
        } catch (cause) {
          failure ??= { cause };
        }
        closeOriginal157(h, failure);
      }
    }
  );

  it.each([
    'wrong-stamp',
    'wrong-hash',
    'missing-prefix',
    'duplicate',
    'forged-completion',
    'future-without-completion',
  ] as const)('refuses %s without changing FILE history, schema or durable rows', (kind) => {
    const h = original157File();
    let failure: { cause: unknown } | undefined;
    try {
      if (kind === 'wrong-stamp')
        h.db.$client
          .prepare('UPDATE __drizzle_migrations SET created_at=created_at+1 WHERE hash=?')
          .run(previousConsolidatedDoc.hash);
      if (kind === 'wrong-hash')
        h.db.$client
          .prepare('UPDATE __drizzle_migrations SET hash=? WHERE hash=?')
          .run('unreviewed-old157', previousConsolidatedDoc.hash);
      if (kind === 'missing-prefix')
        h.db.$client
          .prepare('DELETE FROM __drizzle_migrations WHERE hash=?')
          .run('f0ea5a4d2b2fb986c26031c0eb25f38335f7a4ded3280e93a0c6632c331b1bd0');
      if (kind === 'duplicate')
        h.db.$client
          .prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)')
          .run(previousConsolidatedDoc.hash, previousConsolidatedDoc.when);
      if (kind === 'forged-completion')
        h.db.$client
          .prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)')
          .run(consolidatedDoc.hash, consolidatedDoc.when);
      if (kind === 'future-without-completion')
        h.db.$client
          .prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)')
          .run('unknown-future', consolidatedDoc.when + 1);
      const before = original157History(h.db),
        schema = original157Schema(h.db),
        data = incomingMainData(h.db, 156);
      expect(() => runMigrations(h.db)).toThrow();
      expect(original157History(h.db)).toEqual(before);
      expect(original157Schema(h.db)).toEqual(schema);
      expectIncomingMainDataPreserved(h.db, data);
    } catch (cause) {
      failure = { cause };
    } finally {
      closeOriginal157(h, failure);
    }
  });
});

it.each(['missing', 'changed'] as const)(
  'refuses %s original157 retained SQL before any bridge effect',
  (kind) => {
    const h = original157File();
    let failure: { cause: unknown } | undefined;
    try {
      const isolated = path.join(h.root, 'isolated-current');
      mkdirSync(path.join(isolated, 'meta'), { recursive: true });
      mkdirSync(path.join(isolated, 'legacy-doc'));
      const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8'));
      writeFileSync(path.join(isolated, 'meta/_journal.json'), JSON.stringify(journal));
      for (const entry of journal.entries)
        copyFileSync(
          path.join(folder, `${entry.tag}.sql`),
          path.join(isolated, `${entry.tag}.sql`)
        );
      if (kind === 'changed')
        writeFileSync(
          path.join(isolated, 'legacy-doc', `${previousConsolidatedDoc.tag}.sql`),
          'unreviewed original SQL'
        );
      const before = original157History(h.db),
        schema = original157Schema(h.db),
        data = incomingMainData(h.db, 156);
      expect(() => bridgeLegacyDocMigrationHistory(h.db, isolated)).toThrow();
      expect(original157History(h.db)).toEqual(before);
      expect(original157Schema(h.db)).toEqual(schema);
      expectIncomingMainDataPreserved(h.db, data);
    } catch (cause) {
      failure = { cause };
    } finally {
      closeOriginal157(h, failure);
    }
  }
);
