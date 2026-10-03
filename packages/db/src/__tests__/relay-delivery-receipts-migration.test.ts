import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  createDb,
  relayDeliveryReceipts,
  relayReceiptObserverOwner,
  runMigrations,
} from '../index';
import type { Db } from '../index';

const migrationDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const predecessorIndex = 138;
const directories: string[] = [];
const handles: Db[] = [];
const now = '2026-10-02T17:00:00.000Z';
const expiresAt = '2026-10-09T17:00:00.000Z';
const messageId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

afterEach(() => {
  for (const db of handles.splice(0)) if (db.$client.open) db.$client.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function database(): Db {
  const db = createDb(':memory:');
  handles.push(db);
  return db;
}

function predecessorMigrations(): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'relay-receipt-upgrade-'));
  directories.push(folder);
  mkdirSync(path.join(folder, 'meta'));
  const journal = JSON.parse(
    readFileSync(path.join(migrationDir, 'meta/_journal.json'), 'utf8')
  ) as {
    entries: { idx: number; tag: string }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= predecessorIndex);
  for (const entry of journal.entries)
    copyFileSync(
      path.join(migrationDir, `${entry.tag}.sql`),
      path.join(folder, `${entry.tag}.sql`)
    );
  writeFileSync(path.join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  return folder;
}

describe('Relay delivery receipt migration', () => {
  // Exercise a real pre-feature database, not a fresh-schema mock that cannot lose existing rows.
  it('upgrades without losing message accounting and repeats idempotently', () => {
    const db = database();
    migrate(db, { migrationsFolder: predecessorMigrations() });
    db.$client
      .prepare(
        `INSERT INTO relay_index (id, subject, endpoint_hash, status, created_at)
      VALUES (?, ?, ?, ?, ?)`
      )
      .run(messageId, 'relay.agent.backend', '*', 'delivered', now);
    expect(
      db.$client
        .prepare("SELECT name FROM sqlite_master WHERE name = 'relay_delivery_receipts'")
        .get()
    ).toBeUndefined();
    runMigrations(db);
    runMigrations(db);
    expect(db.$client.prepare('SELECT id, status FROM relay_index').all()).toEqual([
      { id: messageId, status: 'delivered' },
    ]);
    db.insert(relayDeliveryReceipts)
      .values({
        messageId,
        subject: 'relay.agent.backend',
        ownerUserId: null,
        state: 'accepted',
        bootEpoch: 'observer-a',
        acceptedAt: now,
        updatedAt: now,
        expiresAt,
      })
      .run();
    expect(db.select().from(relayDeliveryReceipts).all()).toEqual([
      {
        messageId,
        subject: 'relay.agent.backend',
        ownerUserId: null,
        state: 'accepted',
        bootEpoch: 'observer-a',
        acceptedAt: now,
        updatedAt: now,
        expiresAt,
        settledAt: null,
        failureCode: null,
        failureMessage: null,
      },
    ]);
  });

  it('registers only minimized columns, lookup indexes and no owner cascade', () => {
    const db = database();
    runMigrations(db);
    const columns = db.$client.prepare('PRAGMA table_info(relay_delivery_receipts)').all() as {
      name: string;
      dflt_value: unknown;
    }[];
    expect(columns.map((column) => column.name)).toEqual([
      'message_id',
      'subject',
      'owner_user_id',
      'state',
      'boot_epoch',
      'accepted_at',
      'updated_at',
      'settled_at',
      'expires_at',
      'failure_code',
      'failure_message',
    ]);
    expect(columns.every((column) => column.dflt_value === null)).toBe(true);
    expect(db.$client.prepare('PRAGMA foreign_key_list(relay_delivery_receipts)').all()).toEqual(
      []
    );
    const indexes = db.$client.prepare('PRAGMA index_list(relay_delivery_receipts)').all() as {
      name: string;
    }[];
    expect(indexes.map((index) => index.name)).toContain('idx_relay_delivery_receipts_expiry');
    expect(indexes.map((index) => index.name)).toContain('idx_relay_delivery_receipts_recovery');
    const expiryColumns = db.$client
      .prepare('PRAGMA index_info(idx_relay_delivery_receipts_expiry)')
      .all() as { name: string }[];
    const recoveryColumns = db.$client
      .prepare('PRAGMA index_info(idx_relay_delivery_receipts_recovery)')
      .all() as { name: string }[];
    expect(expiryColumns.map((column) => column.name)).toEqual(['expires_at', 'message_id']);
    expect(recoveryColumns.map((column) => column.name)).toEqual(['state', 'boot_epoch']);
  });

  // SQLite CHECK considers NULL successful, so every required terminal field needs an explicit guard.
  it('rejects inconsistent durable states including unknown with a missing code', () => {
    const db = database();
    runMigrations(db);
    const insert = db.$client.prepare(`INSERT INTO relay_delivery_receipts
      (message_id, subject, state, boot_epoch, accepted_at, updated_at, expires_at, settled_at, failure_code, failure_message)
      VALUES (?, 'relay.agent.backend', ?, 'observer-a', ?, ?, ?, ?, ?, ?)`);
    for (const [state, settled, code, message] of [
      ['accepted', now, null, null],
      ['delivered', null, null, null],
      ['failed', now, 'observation_lost', 'safe'],
      ['failed', now, null, 'safe'],
      ['outcome_unknown', now, null, 'safe'],
      ['outcome_unknown', now, 'at_capacity', 'safe'],
      ['invented', null, null, null],
    ])
      expect(() =>
        insert.run(messageId, state, now, now, expiresAt, settled, code, message)
      ).toThrow();
    expect(db.select().from(relayDeliveryReceipts).all()).toEqual([]);
  });

  it('keeps one observer row and never invents holder identity defaults', () => {
    const db = database();
    runMigrations(db);
    const owner = {
      singletonKey: 'observer' as const,
      ownerToken: 'token-a',
      pid: process.pid,
      hostname: os.hostname(),
      claimedAt: now,
    };
    db.insert(relayReceiptObserverOwner).values(owner).run();
    expect(() =>
      db
        .insert(relayReceiptObserverOwner)
        .values({ ...owner, ownerToken: 'token-b' })
        .run()
    ).toThrow();
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO relay_receipt_observer_owner
      (singleton_key, owner_token, pid, hostname, claimed_at) VALUES ('other', 'token-c', 1, 'host', ?)`
        )
        .run(now)
    ).toThrow();
    expect(db.select().from(relayReceiptObserverOwner).all()).toEqual([owner]);
  });
});
