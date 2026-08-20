/**
 * Migration 0069 — the delivery ledger learns to describe an escalation
 * (DOR-1387, spec `notification-system` task 4.3, ADR 260819-234829).
 *
 * Two changes, and both are load-bearing for the escalation ladder:
 *
 * - `notification_id` becomes NULLABLE. An escalation happens WHILE an Attention
 *   condition is standing, and a standing condition has no notification row yet
 *   (ADR 260819-234828) — so its delivery has nothing to point at.
 * - `subject_key` is added, so a delivery with no notification row is still
 *   interpretable, and "has this subject already been escalated?" survives a
 *   restart.
 *
 * A SQLite rebuild, so the risk this test covers is the one a rebuild carries:
 * that existing rows are lost or mangled on the way across. It also pins the
 * NULL-vs-NOT-NULL flip in both directions, because the whole idempotency story
 * fails closed if a null `notification_id` is still refused.
 *
 * @module db/tests/escalation-ledger-migration
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.join(__dirname, '../../drizzle');

/** The migration under test. */
const TAG = '0069_futuristic_boomerang';
/** Its index in the journal — the shape this test builds is everything below it. */
const IDX = 69;

type Raw = Database.Database;

/** One column of `notification_deliveries`, as sqlite reports it. */
interface ColumnInfo {
  name: string;
  notnull: number;
}

/** How sqlite describes the ledger's columns right now. */
function columns(raw: Raw): ColumnInfo[] {
  return raw.prepare('PRAGMA table_info(notification_deliveries)').all() as ColumnInfo[];
}

/** Whether a column exists and is declared NOT NULL. */
function isNotNull(raw: Raw, name: string): boolean {
  return columns(raw).find((c) => c.name === name)?.notnull === 1;
}

/** The indexes sqlite currently holds on the ledger. */
function indexNames(raw: Raw): string[] {
  return (
    raw.prepare('PRAGMA index_list(notification_deliveries)').all() as { name: string }[]
  ).map((i) => i.name);
}

/**
 * A database at the shape 0068 left — every migration before 0069 applied, and
 * 0069 itself not. Built by copying the migration folder minus 0069 and
 * truncating the journal, the same construction the other migration tests use
 * (there is no "up to N" option on the migrator).
 */
function databaseAtOldShape(): Raw {
  const folder = mkdtempSync(path.join(tmpdir(), 'dorkos-0068-'));
  mkdirSync(path.join(folder, 'meta'));

  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
  ) as { entries: { idx: number; tag: string }[] };
  const before = journal.entries.filter((e) => e.idx < IDX);

  // A renumbered 0069 would leave this asserting against a shape that already
  // includes it, and every expectation below would pass for the wrong reason.
  expect(before.map((e) => e.tag)).not.toContain(TAG);
  expect(journal.entries.map((e) => e.tag)).toContain(TAG);

  for (const entry of before) {
    copyFileSync(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(
    path.join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: before })
  );

  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: folder });
  return sqlite;
}

/** Apply 0069 the way production does — the real migrator over the real folder. */
function applyMigration(raw: Raw): void {
  migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });
}

/** A notification row for a ledger row to hang off. */
function seedNotification(raw: Raw, id: string): void {
  raw
    .prepare(
      'INSERT INTO notifications (id, kind, tier, subject_type, subject_id, title, dedupe_key, created_at) ' +
        "VALUES (?, 'turn.completed', 'notable', 'session', 'sess-1', 'acme finished', ?, '2026-08-19T09:00:00.000Z')"
    )
    .run(id, `turn:${id}`);
}

/** One ledger row at the OLD shape (no subject_key, notification_id required). */
function seedOldDelivery(raw: Raw, id: string, notificationId: string): void {
  raw
    .prepare(
      'INSERT INTO notification_deliveries (id, notification_id, channel, sent_at, detail_json) ' +
        "VALUES (?, ?, 'telegram', '2026-08-19T09:00:01.000Z', '{\"surface\":\"integration\"}')"
    )
    .run(id, notificationId);
}

describe('0069 — notification_deliveries gains subject_key and a nullable notification_id', () => {
  it('has neither the column nor the nullable FK before the migration', () => {
    const raw = databaseAtOldShape();
    expect(columns(raw).map((c) => c.name)).not.toContain('subject_key');
    expect(isNotNull(raw, 'notification_id')).toBe(true);
  });

  it('carries existing rows across the rebuild, with a NULL subject key', () => {
    const raw = databaseAtOldShape();
    seedNotification(raw, 'n-1');
    seedOldDelivery(raw, 'd-1', 'n-1');

    applyMigration(raw);

    const row = raw
      .prepare(
        "SELECT notification_id AS n, subject_key AS s, channel AS c, detail_json AS d FROM notification_deliveries WHERE id = 'd-1'"
      )
      .get() as { n: string; s: string | null; c: string; d: string };
    // The rebuild's copy step is the thing that has to be right: drizzle-kit
    // emitted a SELECT of a column the old table never had, and the hand-fixed
    // literal NULL is what this asserts.
    expect(row.n).toBe('n-1');
    expect(row.s).toBeNull();
    expect(row.c).toBe('telegram');
    expect(row.d).toBe('{"surface":"integration"}');
  });

  it('accepts an escalation delivery with no notification row to point at', () => {
    const raw = databaseAtOldShape();
    applyMigration(raw);

    raw
      .prepare(
        'INSERT INTO notification_deliveries (id, notification_id, subject_key, channel, sent_at, detail_json) ' +
          "VALUES ('d-esc', NULL, 'ask:int-7', 'web_push', '2026-08-19T09:05:00.000Z', '{\"escalated\":true}')"
      )
      .run();

    const row = raw
      .prepare(
        "SELECT notification_id AS n, subject_key AS s FROM notification_deliveries WHERE id = 'd-esc'"
      )
      .get() as { n: string | null; s: string };
    expect(row.n).toBeNull();
    expect(row.s).toBe('ask:int-7');
  });

  /**
   * A SQLite rebuild drops the old table and every index on it. Drizzle-kit
   * re-emits them AFTER the rename, but that is a property of the generated SQL
   * rather than a guarantee — and a silently missing `subject_key` index would
   * cost nothing visible until the escalation service's two per-fire lookups
   * were scanning an uncapped table.
   */
  it('re-creates both indexes after the rebuild, subject_key included', () => {
    const raw = databaseAtOldShape();
    applyMigration(raw);

    expect(indexNames(raw)).toEqual(
      expect.arrayContaining([
        'idx_notification_deliveries_notification',
        'idx_notification_deliveries_subject',
      ])
    );
  });

  it('keeps the cascade, so a pruned notification still takes its deliveries with it', () => {
    const raw = databaseAtOldShape();
    seedNotification(raw, 'n-2');
    seedOldDelivery(raw, 'd-2', 'n-2');
    applyMigration(raw);

    // `foreign_keys` is set per connection and the rebuild toggles it off and
    // back on; this is the assertion that it really came back.
    raw.prepare("DELETE FROM notifications WHERE id = 'n-2'").run();

    const remaining = raw
      .prepare("SELECT COUNT(*) AS c FROM notification_deliveries WHERE id = 'd-2'")
      .get() as { c: number };
    expect(remaining.c).toBe(0);
  });
});
