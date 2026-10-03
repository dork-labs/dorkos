/** The warning and its once-only marker share production file-SQLite transactions. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, expect, it } from 'vitest';
import { createDb, eq, canvasDocBatches, runMigrations, type Db } from '@dorkos/db';
import { DocChannelStore } from '../store.js';
import { appendDocStatus } from '../status.js';
import { replayExpiredDocBatch } from '../delivery/replay.js';
import { batchFixture, FROM, TO, NOW } from './batch-fixtures.js';

const connections = new Set<Db>();
const directories: string[] = [];
afterEach(() => {
  for (const db of connections) db.$client.close();
  connections.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'doc-warning-'));
  directories.push(directory);
  const file = join(directory, 'state.db');
  const f = batchFixture(file);
  connections.add(f.db);
  f.input();
  const batchId = f.batchId();
  const batch = f.store.getBatch(batchId)!;
  expect(batch.waitingWarningAt).toBeNull();
  f.db
    .update(canvasDocBatches)
    .set({ status: 'waiting' })
    .where(eq(canvasDocBatches.batchId, batchId))
    .run();
  return { ...f, file, batchId, generation: batch.generation };
}
function warn(store: DocChannelStore, batchId: string, generation: string, documentId: string) {
  return store.transaction((tx) => {
    if (!store.markWaitingWarning(batchId, generation, NOW, tx)) return false;
    appendDocStatus(
      store,
      tx,
      documentId,
      { batchId, status: 'waiting', warning: 'Still waiting.' },
      NOW
    );
    return true;
  });
}
// Counts every status, including the original input's one initial pending frame.
function warningCount(db: Db) {
  return db.$client
    .prepare("SELECT count(*) AS count FROM canvas_doc_events WHERE type='event.status'")
    .get() as { count: number };
}

it('allows one warning across competing connections and a database restart', () => {
  const f = fixture();
  const secondDb = createDb(f.file);
  connections.add(secondDb);
  secondDb.$client.pragma('busy_timeout = 0');
  const second = new DocChannelStore(secondDb);
  f.store.transaction((tx) => {
    expect(f.store.markWaitingWarning(f.batchId, f.generation, NOW, tx)).toBe(true);
    expect(() => warn(second, f.batchId, f.generation, f.documentId)).toThrow(/locked/);
    appendDocStatus(
      f.store,
      tx,
      f.documentId,
      { batchId: f.batchId, warning: 'Still waiting.' },
      NOW
    );
  });
  expect(warn(second, f.batchId, f.generation, f.documentId)).toBe(false);
  expect(warningCount(secondDb).count).toBe(2);
  expect(second.getBatch(f.batchId)?.waitingWarningAt).toBe(NOW);
  f.db.$client.close();
  connections.delete(f.db);
  secondDb.$client.close();
  connections.delete(secondDb);
  const restartedDb = createDb(f.file);
  connections.add(restartedDb);
  const restarted = new DocChannelStore(restartedDb);
  expect(warn(restarted, f.batchId, f.generation, f.documentId)).toBe(false);
  expect(warningCount(restartedDb).count).toBe(2);
});

it('rolls back the marker and sequence when the warning event insert fails', () => {
  const f = fixture();
  const before = f.store.getChannel(f.documentId)!.nextDocSeq;
  f.db.$client.exec(
    "CREATE TRIGGER reject_warning BEFORE INSERT ON canvas_doc_events WHEN NEW.type='event.status' BEGIN SELECT RAISE(ABORT, 'warning write failed'); END"
  );
  expect(() => warn(f.store, f.batchId, f.generation, f.documentId)).toThrow(
    'warning write failed'
  );
  expect(f.store.getBatch(f.batchId)?.waitingWarningAt).toBeNull();
  expect(f.store.getChannel(f.documentId)?.nextDocSeq).toBe(before);
  expect(warningCount(f.db).count).toBe(1);
  f.db.$client.exec('DROP TRIGGER reject_warning');
  expect(warn(f.store, f.batchId, f.generation, f.documentId)).toBe(true);
  expect(warn(f.store, f.batchId, f.generation, f.documentId)).toBe(false);
  expect(warningCount(f.db).count).toBe(2);
});

it('refuses wrong or absent generations and every non-waiting lifecycle state', () => {
  const f = fixture();
  expect(warn(f.store, f.batchId, 'wrong-generation', f.documentId)).toBe(false);
  expect(warn(f.store, 'absent-batch', f.generation, f.documentId)).toBe(false);
  const statuses = [
    'pending',
    'accepted',
    'dispatching',
    'turn_started',
    'turn_done',
    'failed',
    'expired',
    'cancelled',
    'in_doubt',
  ] as const;
  for (const status of statuses) {
    f.db
      .update(canvasDocBatches)
      .set({ status })
      .where(eq(canvasDocBatches.batchId, f.batchId))
      .run();
    expect(warn(f.store, f.batchId, f.generation, f.documentId)).toBe(false);
    expect(f.store.getBatch(f.batchId)?.waitingWarningAt).toBeNull();
  }
  expect(warningCount(f.db).count).toBe(1);
});

it('preserves the physical marker across rekey and gives explicit replay a fresh marker', () => {
  const f = fixture();
  expect(warn(f.store, f.batchId, f.generation, f.documentId)).toBe(true);
  f.documents.rekeyScope(FROM, TO);
  expect(f.store.getBatch(f.batchId)).toMatchObject({
    scope: TO,
    generation: f.generation,
    waitingWarningAt: NOW,
  });
  f.db
    .update(canvasDocBatches)
    .set({ status: 'expired' })
    .where(eq(canvasDocBatches.batchId, f.batchId))
    .run();
  const replayId = replayExpiredDocBatch(f.store, f.grants, f.batchId, f.grantId, f.actor, NOW);
  const replay = f.store.getBatch(replayId)!;
  expect(replayId).not.toBe(f.batchId);
  expect(replay.generation).not.toBe(f.generation);
  expect(replay.waitingWarningAt).toBeNull();
  expect(f.store.getBatch(f.batchId)?.waitingWarningAt).toBe(NOW);
  f.db
    .update(canvasDocBatches)
    .set({ status: 'waiting' })
    .where(eq(canvasDocBatches.batchId, replayId))
    .run();
  expect(warn(f.store, replayId, replay.generation, f.documentId)).toBe(true);
  expect(warningCount(f.db).count).toBe(4); // Initial pending, original warning, explicit replay status, new warning.
});

it('upgrades populated accounting-era batches without changing their existing data', () => {
  const f = fixture();
  const migrationDirectory = fileURLToPath(
    new URL('../../../../../../../packages/db/drizzle/', import.meta.url)
  );
  const oldDirectory = join(directories[0]!, 'old-migrations');
  mkdirSync(join(oldDirectory, 'meta'), { recursive: true });
  const journal = JSON.parse(
    readFileSync(join(migrationDirectory, 'meta/_journal.json'), 'utf8')
  ) as {
    entries: { tag: string }[];
  };
  // Everything up to the accounting era, whatever later migrations exist: a
  // later one (DOR-2678's approvals column) must not move this test's cut.
  const accountingEra = journal.entries.findIndex(
    (entry) => entry.tag === '0138_canvas_channel_accounting'
  );
  expect(accountingEra).toBeGreaterThan(-1);
  journal.entries = journal.entries.slice(0, accountingEra + 1);
  for (const entry of journal.entries)
    copyFileSync(
      join(migrationDirectory, `${entry.tag}.sql`),
      join(oldDirectory, `${entry.tag}.sql`)
    );
  writeFileSync(join(oldDirectory, 'meta/_journal.json'), JSON.stringify(journal));
  const oldDb = createDb(join(directories[0]!, 'upgrade.db'));
  connections.add(oldDb);
  migrate(oldDb, { migrationsFolder: oldDirectory });
  for (const table of [
    'canvas_doc_channels',
    'canvas_doc_grants',
    'canvas_doc_events',
    'canvas_doc_batches',
  ]) {
    const rows = f.db.$client.prepare(`SELECT * FROM ${table}`).all() as Record<
      string,
      string | number | null
    >[];
    for (const row of rows) {
      delete row.waiting_warning_at;
      const keys = Object.keys(row);
      oldDb.$client
        .prepare(
          `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
        )
        .run(...Object.values(row));
    }
  }
  const before = oldDb.$client.prepare('SELECT * FROM canvas_doc_batches').get();
  runMigrations(oldDb);
  expect(oldDb.$client.prepare('SELECT * FROM canvas_doc_batches').get()).toEqual({
    ...(before as Record<string, unknown>),
    waiting_warning_at: null,
  });
  expect(oldDb.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  const store = new DocChannelStore(oldDb);
  expect(warn(store, f.batchId, f.generation, f.documentId)).toBe(true);
});
