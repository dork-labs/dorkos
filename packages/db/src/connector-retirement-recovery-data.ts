/** Readonly recognition of the schema retired by the published connector backfill. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './index.js';
import { constructDatabase } from './database-construction.js';
import {
  docs,
  publishedRoom,
  publishedRoom151,
  consolidatedDoc,
  refuse,
  type MigrationEntry,
  type MigrationRow,
} from './doc-migration-identities.js';

const retired = Object.freeze([
  'agent_connector_attachments',
  'connected_accounts',
  'connector_legacy_agent_revocations',
  'session_connector_attachments',
] as const);

/** Return immutable canonical DDL only; mutation remains private to original runMigrations. */
export function readPublishedConnectorRecoveryPlan(
  db: Db,
  folder: string
):
  | Readonly<{
      sql: readonly string[];
      referenceEnd: number;
    }>
  | undefined {
  const names = new Set(
    (
      db.$client.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name)
  );
  if (!names.has('connector_application_migrations')) return;
  const missing = retired.filter((name) => !names.has(name));
  if (!missing.length) return;
  if (missing.length !== retired.length) refuse('partial published connector retirement');
  const ledger = db.$client
    .prepare(
      'SELECT version,state,started_at,completed_at FROM connector_application_migrations ORDER BY version'
    )
    .all() as { version: number; state: string; started_at: string; completed_at: string | null }[];
  if (
    ledger.length !== 1 ||
    ledger[0]!.version !== 1 ||
    ledger[0]!.state !== 'complete' ||
    !Number.isFinite(Date.parse(ledger[0]!.started_at)) ||
    !ledger[0]!.completed_at ||
    !Number.isFinite(Date.parse(ledger[0]!.completed_at!)) ||
    Date.parse(ledger[0]!.completed_at!) < Date.parse(ledger[0]!.started_at)
  )
    refuse('published connector retirement lacks completed ledger');
  const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as {
    version: string;
    dialect: string;
    entries: MigrationEntry[];
  };
  const canonical = journal.entries.map((entry, idx) => {
    if (entry.idx !== idx) refuse('connector recovery canonical journal is not contiguous');
    return {
      ...entry,
      hash: createHash('sha256')
        .update(readFileSync(path.join(folder, `${entry.tag}.sql`)))
        .digest('hex'),
    };
  });
  if (!names.has('__drizzle_migrations')) refuse('connector recovery history absent');
  const rows = db.$client
    .prepare(
      'SELECT rowid AS rowIdentity,id,hash,created_at FROM __drizzle_migrations ORDER BY rowid'
    )
    .all() as MigrationRow[];
  const roomRows = rows.filter((row) =>
    [publishedRoom, publishedRoom151, consolidatedDoc].some(
      (entry) => entry.hash === row.hash && entry.when === row.created_at
    )
  );
  if (roomRows.length > 1) refuse('connector recovery Room history duplicated');
  const historical = rows.filter((row) =>
    docs.some(
      (doc) =>
        doc.hash === row.hash && (doc.when === row.created_at || doc.oldWhen === row.created_at)
    )
  );
  const ordinary = rows.filter((row) => !roomRows.includes(row) && !historical.includes(row));
  const ordinaryJournal = canonical.filter((entry) => entry.idx !== consolidatedDoc.idx);
  const prefix = ordinaryJournal.filter((entry) =>
    ordinary.some((row) => row.hash === entry.hash && row.created_at === entry.when)
  );
  // Backfill is introduced by canonical86. Exact recorded prefix is required, not a watermark.
  if (
    prefix.length < 87 ||
    ordinary.length !== prefix.length ||
    prefix.some(
      (entry, idx) =>
        entry.idx !== ordinaryJournal[idx]!.idx ||
        ordinary.filter((row) => row.hash === entry.hash && row.created_at === entry.when)
          .length !== 1
    ) ||
    rows.some((row) => rows.filter((other) => other.hash === row.hash).length !== 1)
  )
    refuse('connector recovery history is not a recognized exact prefix');
  if (
    prefix.some((entry) => entry.idx > consolidatedDoc.idx) &&
    (roomRows.length !== 1 || roomRows[0]!.created_at !== consolidatedDoc.when)
  )
    refuse('connector recovery future prefix lacks canonical Room completion');
  if (
    !roomRows.length &&
    !historical.length &&
    prefix.some(
      (entry, idx) =>
        idx > 0 &&
        ordinary.find((row) => row.hash === entry.hash)!.rowIdentity <=
          ordinary.find((row) => row.hash === prefix[idx - 1]!.hash)!.rowIdentity
    )
  )
    refuse('connector recovery canonical row order differs');
  // Original Doc/Room bridge independently authenticates every historical row/order before commit.
  const recordedEnd = Math.max(
    prefix.at(-1)!.idx + 1,
    roomRows.some((row) => row.created_at === consolidatedDoc.when) ? consolidatedDoc.idx + 1 : 0
  );
  const reference = constructDatabase(':memory:').db;
  let temporary: string | undefined;
  let failure: { cause: unknown } | undefined;
  let sql: readonly string[] | undefined;
  try {
    temporary = mkdtempSync(path.join(os.tmpdir(), 'dorkos-connector-recovery-'));
    mkdirSync(path.join(temporary, 'meta'));
    const entries = journal.entries.slice(0, recordedEnd);
    writeFileSync(
      path.join(temporary, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries })
    );
    for (const entry of entries)
      writeFileSync(
        path.join(temporary, `${entry.tag}.sql`),
        readFileSync(path.join(folder, `${entry.tag}.sql`))
      );
    migrate(reference, { migrationsFolder: temporary });
    const statements: string[] = [];
    for (const name of retired) {
      const table = reference.$client
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(name) as { sql: string } | undefined;
      if (!table?.sql) refuse('canonical connector table absent');
      statements.push(table.sql);
      const indexes = reference.$client
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name"
        )
        .all(name) as { sql: string }[];
      for (const index of indexes) statements.push(index.sql);
    }
    sql = Object.freeze(statements);
  } catch (cause) {
    failure = { cause };
  } finally {
    try {
      reference.$client.close();
    } catch (cause) {
      failure ??= { cause };
    }
    try {
      if (temporary) rmSync(temporary, { recursive: true, force: true });
    } catch (cause) {
      failure ??= { cause };
    }
  }
  if (failure) throw failure.cause;
  if (!sql) refuse('canonical connector recovery SQL unavailable');
  return Object.freeze({ sql, referenceEnd: journal.entries.length });
}
