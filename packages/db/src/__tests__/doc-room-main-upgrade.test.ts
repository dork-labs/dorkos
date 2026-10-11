/** Populated shipped-main upgrades retain data and never invent Room custody. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../index.js';

const folder = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const timestamp = '2026-10-09T19:00:00.000Z';

describe('Doc Room upgrade from populated shipped main', () => {
  it.each([148, 149, 150, 154, 155, 156])(
    'preserves Main%d rows with foreign keys enforced and no invented custody',
    (idx) => {
      const temporary = mkdtempSync(path.join(os.tmpdir(), 'dorkos-room-upgrade-'));
      const db = createDb(':memory:');
      try {
        mkdirSync(path.join(temporary, 'meta'));
        const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8'));
        const finalEntry = journal.entries.at(-1);
        expect(finalEntry).toMatchObject({
          idx: 157,
          when: 1791701524866,
          tag: '20261011065204_lonely_sentinel',
        });
        const finalHistoryLength = journal.entries.length;
        expect(finalHistoryLength).toBe(158);
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
        if (idx >= 155) seedIncomingMainData(db, idx as 155 | 156);
        const durable = idx >= 155 ? incomingMainData(db, idx as 155 | 156) : [];
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
          // The real rebuilt tables must preserve data and enforce genuine Room agreement.
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
  for (const value of before)
    expect(db.$client.prepare(`SELECT * FROM ${value.table} ORDER BY rowid`).all()).toEqual(
      value.rows
    );
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
