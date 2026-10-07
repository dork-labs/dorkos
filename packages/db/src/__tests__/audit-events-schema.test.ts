/**
 * Migration `audit_events` — the audit log refuses every edit and every write
 * that does not extend its chain (spec `audit-trail` §3.1).
 *
 * The triggers are the part a schema diff cannot see: drizzle generates the
 * table, and the three triggers are hand-appended to the migration. So these
 * tests run the real migration history and then try, through the app's own
 * connection, every way a row could be changed, removed, or slotted in out of
 * order.
 *
 * @module db/tests/audit-events-schema
 */
import { describe, it, expect } from 'vitest';
import { auditEvents, createDb, eq, runMigrations } from '../index.js';

const GENESIS = '0'.repeat(64);

type Db = ReturnType<typeof createDb>;

/** A row with every required column, at the given chain position. */
function row(seq: number, prevHash: string, hash: string) {
  return {
    seq,
    id: `01AUDIT${String(seq).padStart(19, '0')}`,
    at: '2026-10-06T00:00:00.000Z',
    actorId: 'install:test',
    actorKind: 'person' as const,
    actorName: 'Owner',
    source: '{"surface":"app"}',
    action: 'config.changed',
    operation: 'modify' as const,
    outcome: 'ok' as const,
    summary: 'Changed a setting',
    visibility: 'space' as const,
    prevHash,
    hash,
  };
}

function migrated(): Db {
  const db = createDb(':memory:');
  runMigrations(db);
  return db;
}

describe('audit_events', () => {
  it('accepts rows that extend the chain one at a time', () => {
    const db = migrated();
    db.insert(auditEvents)
      .values(row(1, GENESIS, 'a'.repeat(64)))
      .run();
    db.insert(auditEvents)
      .values(row(2, 'a'.repeat(64), 'b'.repeat(64)))
      .run();
    expect(db.select().from(auditEvents).all()).toHaveLength(2);
    db.$client.close();
  });

  it('refuses an update and a delete', () => {
    const db = migrated();
    db.insert(auditEvents)
      .values(row(1, GENESIS, 'a'.repeat(64)))
      .run();
    expect(() =>
      db.update(auditEvents).set({ summary: 'rewritten' }).where(eq(auditEvents.seq, 1)).run()
    ).toThrow(/append-only/i);
    expect(() => db.delete(auditEvents).where(eq(auditEvents.seq, 1)).run()).toThrow(
      /append-only/i
    );
    db.$client.close();
  });

  it('refuses a first row that does not start from the genesis hash', () => {
    const db = migrated();
    expect(() =>
      db
        .insert(auditEvents)
        .values(row(1, 'f'.repeat(64), 'a'.repeat(64)))
        .run()
    ).toThrow(/extend the chain/i);
    db.$client.close();
  });

  it('refuses a gap in seq', () => {
    const db = migrated();
    db.insert(auditEvents)
      .values(row(1, GENESIS, 'a'.repeat(64)))
      .run();
    expect(() =>
      db
        .insert(auditEvents)
        .values(row(3, 'a'.repeat(64), 'c'.repeat(64)))
        .run()
    ).toThrow(/extend the chain/i);
    db.$client.close();
  });

  it('refuses a row that links to anything but the last hash', () => {
    const db = migrated();
    db.insert(auditEvents)
      .values(row(1, GENESIS, 'a'.repeat(64)))
      .run();
    expect(() =>
      db
        .insert(auditEvents)
        .values(row(2, GENESIS, 'b'.repeat(64)))
        .run()
    ).toThrow(/extend the chain/i);
    db.$client.close();
  });

  it('requires participants on a participants-only row', () => {
    const db = migrated();
    expect(() =>
      db
        .insert(auditEvents)
        .values({ ...row(1, GENESIS, 'a'.repeat(64)), visibility: 'participants' })
        .run()
    ).toThrow();
    db.$client.close();
  });

  it('finds the chain tail by key lookup, never a scan, so inserts stay cheap as the log grows', () => {
    const db = migrated();
    // The two lookups the chain-link trigger runs on every insert.
    const plans = [
      'SELECT MAX(`seq`) FROM `audit_events`',
      'SELECT `hash` FROM `audit_events` WHERE `seq` = (SELECT MAX(`seq`) FROM `audit_events`)',
    ].map((sql) =>
      (db.$client.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((row) => row.detail)
        .join(' | ')
    );
    for (const plan of plans) {
      expect(plan).toMatch(/SEARCH audit_events/);
      expect(plan).not.toMatch(/SCAN audit_events|TEMP B-TREE/);
    }
    // And the trigger really is written with those lookups.
    const trigger = db.$client
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_events_chain_link'"
      )
      .get() as { sql: string };
    expect(trigger.sql).toContain('WHERE `seq` = (SELECT MAX(`seq`) FROM `audit_events`)');
    expect(trigger.sql).not.toContain('ORDER BY');
    db.$client.close();
  });
});
