/** Populated shipped-main upgrades retain data and never invent Room custody. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../index.js';

const folder = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const timestamp = '2026-10-09T19:00:00.000Z';

describe('Doc Room upgrade from populated shipped main', () => {
  it.each([148, 149, 150])(
    'preserves Main%d rows with foreign keys enforced and no invented custody',
    (idx) => {
      const temporary = mkdtempSync(path.join(os.tmpdir(), 'dorkos-room-upgrade-'));
      const db = createDb(':memory:');
      try {
        mkdirSync(path.join(temporary, 'meta'));
        const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8'));
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
        expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        const afterHistory = db.$client
          .prepare('SELECT * FROM __drizzle_migrations ORDER BY rowid')
          .all();
        expect(afterHistory.slice(0, idx + 1)).toEqual(history);
        expect(afterHistory).toHaveLength(153);
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
