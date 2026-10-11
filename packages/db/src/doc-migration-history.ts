const publishedMigrationOwners = new WeakMap<
  object,
  { db: Db; folder: string; rows: MigrationRow[] }
>();
const migrationOwnerGet = WeakMap.prototype.get;
const migrationOwnerSet = WeakMap.prototype.set;
const migrationOwnerDelete = WeakMap.prototype.delete;
const migrationOwnerApply = Reflect.apply;
/** Internal lookup has no issuer; only the original bridge reads and registers actual bookkeeping. */
export function requirePublishedMigrationOwner(key: object): {
  db: Db;
  folder: string;
  rows: MigrationRow[];
} {
  const context = migrationOwnerApply(migrationOwnerGet, publishedMigrationOwners, [key]) as
    { db: Db; folder: string; rows: MigrationRow[] } | undefined;
  if (!context) throw new Error('Original migration bookkeeping owner required');
  return context;
}
/** Preserve exact published Doc histories across shipped Main migrations. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './index.js';
import {
  main,
  docs,
  consolidatedDoc,
  reportBack,
  agentReports,
  commitments,
  channelLeads,
  agentPauses,
  reviewedSql,
  refuse,
  type MigrationEntry,
  type MigrationRow,
} from './doc-migration-identities.js';
import { bridgePublishedRoomMigration } from './doc-migration-published-room.js';
import { verifyCanonicalSchema } from './doc-migration-schema.js';

/**
 * Drizzle uses the newest timestamp as its migration watermark. Old Doc rows
 * precede Main148; new canonical Doc rows follow it. Only the exact original
 * hash/timestamp prefix may cross that boundary, without replaying its DDL.
 * Main148 still runs through the public migrator, with its immutable SQL.
 */
export function bridgeLegacyDocMigrationHistory(db: Db, folder: string): void {
  const sqlite = db.$client;
  if (
    !sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
      )
      .get()
  ) {
    return;
  }
  const rows = sqlite
    .prepare(
      'SELECT rowid AS rowIdentity, id, hash, created_at FROM __drizzle_migrations ORDER BY rowid'
    )
    .all() as MigrationRow[];
  const publishedOwnerKey = {};
  migrationOwnerApply(migrationOwnerSet, publishedMigrationOwners, [
    publishedOwnerKey,
    { db, folder, rows },
  ]);
  try {
    if (bridgePublishedRoomMigration(publishedOwnerKey)) return;
  } finally {
    migrationOwnerApply(migrationOwnerDelete, publishedMigrationOwners, [publishedOwnerKey]);
  }
  const recorded = docs.map((doc) => rows.filter((row) => row.hash === doc.hash));
  let gap = false;
  for (const [i, matching] of recorded.entries()) {
    if (matching.length > 1) refuse('duplicate Doc SQL hash');
    if (matching.length === 0) {
      gap = true;
    } else {
      if (gap) refuse('Doc rows are not a contiguous prefix');
      const stamp = matching[0]!.created_at;
      if (stamp !== docs[i]!.oldWhen && stamp !== docs[i]!.when) {
        refuse('Doc SQL hash has an unexpected timestamp');
      }
    }
  }
  const legacy = recorded.flatMap((matching, i) =>
    matching.filter((row) => row.created_at === docs[i]!.oldWhen)
  );
  if (recorded.flat().length === 0) return;
  if (legacy.length > 0 && recorded.flat().length !== legacy.length)
    refuse('mixed old and canonical Doc timestamps');
  if (legacy.some((row, i) => i > 0 && row.rowIdentity <= legacy[i - 1]!.rowIdentity)) {
    refuse('Doc rows are not recorded in their original prefix order');
  }
  const mainRows = rows.filter((row) => row.hash === main.hash);
  if (mainRows.length > 1 || (mainRows[0] && mainRows[0].created_at !== main.when)) {
    refuse('Main148 bookkeeping differs from the shipped migration');
  }
  if (
    legacy.length > 0 &&
    mainRows[0] &&
    mainRows[0].rowIdentity <= legacy[legacy.length - 1]!.rowIdentity
  ) {
    refuse('Main148 precedes the legacy Doc prefix');
  }
  if (legacy.length === 0 && !mainRows[0]) refuse('canonical Doc rows have no shipped Main148');

  const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as {
    version: string;
    dialect: string;
    entries: MigrationEntry[];
  };
  function canonicalSql(expected: MigrationEntry & { hash: string }): Buffer {
    const entries = journal.entries.filter((entry) => entry.idx === expected.idx);
    const entry = journal.entries[expected.idx];
    if (
      entries.length !== 1 ||
      !entry ||
      entry.idx !== expected.idx ||
      entry.tag !== expected.tag ||
      entry.when !== expected.when ||
      entry.version !== expected.version ||
      entry.breakpoints !== expected.breakpoints
    ) {
      refuse('canonical journal entry differs from the reviewed migration');
    }
    const bytes = readFileSync(path.join(folder, `${expected.tag}.sql`));
    if (createHash('sha256').update(bytes).digest('hex') !== expected.hash) {
      refuse('canonical SQL differs from the original migration');
    }
    return bytes;
  }
  const mainSql = canonicalSql(main);
  const historicalSql = docs.map((doc) => {
    const bytes = readFileSync(path.join(folder, 'legacy-doc', `${doc.tag}.sql`));
    if (createHash('sha256').update(bytes).digest('hex') !== doc.hash)
      refuse('archived Doc SQL differs from the original migration');
    return bytes;
  });
  const chat = journal.entries[149];
  const consolidated = journal.entries[consolidatedDoc.idx];
  if (
    !chat ||
    chat.idx !== 149 ||
    chat.tag !== '20261009171311_chat_messages' ||
    !consolidated ||
    consolidated.idx !== consolidatedDoc.idx ||
    consolidated.tag !== consolidatedDoc.tag ||
    journal.entries.length <= consolidatedDoc.idx
  )
    refuse('current shipped Chat and regenerated Doc journal differs');
  const chatBytes = readFileSync(path.join(folder, `${chat.tag}.sql`));
  const finalBytes = readFileSync(path.join(folder, `${consolidated.tag}.sql`));
  const chatHash = createHash('sha256').update(chatBytes).digest('hex');
  const finalHash = createHash('sha256').update(finalBytes).digest('hex');
  if (
    chatHash !== '55b1201b98db390ccf33bb4069645f6c542ef20739f8bd1a2e4c1078275582fc' ||
    chat.when !== 1791565991417 ||
    consolidated.when !== consolidatedDoc.when ||
    finalHash !== consolidatedDoc.hash
  )
    refuse('regenerated migration differs from reviewed SQL');
  const shipped = [reportBack, agentReports, commitments, channelLeads, agentPauses];
  const shippedSql = shipped.map((entry) => reviewedSql(folder, entry));
  reviewedSql(folder, consolidatedDoc);
  const reportRows = rows.filter((row) => row.hash === reportBack.hash);
  const agentRows = rows.filter((row) => row.hash === agentReports.hash);
  const shippedRows = shipped.map((entry) => rows.filter((row) => row.hash === entry.hash));
  const chatRows = rows.filter((row) => row.hash === chatHash);
  const finalRows = rows.filter((row) => row.hash === finalHash);
  for (const [matching, entry] of [
    [chatRows, chat],
    [reportRows, reportBack],
    [agentRows, agentReports],
    [shippedRows[2]!, commitments],
    [shippedRows[3]!, channelLeads],
    [shippedRows[4]!, agentPauses],
    [finalRows, consolidated],
  ] as const) {
    if (matching.length > 1 || (matching[0] && matching[0].created_at !== entry.when))
      refuse('current migration bookkeeping differs');
  }
  let shippedGap = false;
  let shippedIdentity = 0;
  for (const matching of shippedRows) {
    if (!matching.length) {
      shippedGap = true;
      continue;
    }
    if (shippedGap || matching[0]!.rowIdentity <= shippedIdentity)
      refuse('shipped Main history is not an ordered contiguous prefix');
    shippedIdentity = matching[0]!.rowIdentity;
  }
  const futureRows = journal.entries.slice(consolidatedDoc.idx + 1).flatMap((entry) => {
    const hash = createHash('sha256')
      .update(readFileSync(path.join(folder, `${entry.tag}.sql`)))
      .digest('hex');
    const matching = rows.filter((row) => row.hash === hash);
    if (matching.length > 1 || (matching[0] && matching[0].created_at !== entry.when))
      refuse('future canonical migration bookkeeping differs');
    if (matching.length && !finalRows.length)
      refuse('future migration precedes consolidated Doc migration');
    return matching;
  });
  // No unrelated newer watermark may be silently skipped or retimed.
  if (
    rows.some(
      (row) =>
        row.created_at >= docs[0].oldWhen &&
        !recorded.flat().includes(row) &&
        !mainRows.includes(row) &&
        !chatRows.includes(row) &&
        !reportRows.includes(row) &&
        !agentRows.includes(row) &&
        !shippedRows.flat().includes(row) &&
        !finalRows.includes(row) &&
        !futureRows.includes(row)
    )
  )
    refuse('unexpected migration after the published prefix');
  if (finalRows.length) {
    if (
      recorded.some((matching) => matching.length !== 1) ||
      legacy.length ||
      !chatRows.length ||
      !reportRows.length ||
      !agentRows.length ||
      shippedRows.some((matching) => matching.length !== 1) ||
      finalRows[0]!.rowIdentity <= shippedIdentity
    )
      refuse('incomplete historical prefix claims consolidated migration');
    // A durable completed155 permits ordinary future migrations; never replay Doc DDL.
    return;
  }

  if (mainRows.length === 0) {
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'dorkos-main148-'));
    let failure: { cause: unknown } | undefined;
    try {
      mkdirSync(path.join(temporary, 'meta'));
      writeFileSync(
        path.join(temporary, 'meta/_journal.json'),
        JSON.stringify({
          version: journal.version,
          dialect: journal.dialect,
          entries: [journal.entries[148]],
        })
      );
      writeFileSync(path.join(temporary, `${main.tag}.sql`), mainSql);
      migrate(db, { migrationsFolder: temporary });
    } catch (cause) {
      failure = { cause };
    } finally {
      try {
        rmSync(temporary, { recursive: true, force: true });
      } catch (cause) {
        failure ??= { cause };
      }
    }
    if (failure) throw failure.cause;
  }
  // Finish only missing original Doc SQL. One transaction covers completion and
  // original ledger retiming; interruption/failure preserves every earlier row.
  sqlite.transaction(() => {
    const insert = sqlite.prepare(
      'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)'
    );
    for (const [i, doc] of docs.entries()) {
      if (recorded[i]!.length) continue;
      for (const statement of historicalSql[i]!.toString('utf8').split(
        '--> statement-breakpoint'
      )) {
        if (statement.trim()) sqlite.exec(statement);
      }
      insert.run(doc.hash, doc.when);
    }
    const update = sqlite.prepare(
      'UPDATE __drizzle_migrations SET created_at = ? WHERE rowid = ? AND hash = ? AND created_at = ?'
    );
    for (const [i, matching] of recorded.entries()) {
      const row = matching[0];
      if (!row) break;
      const doc = docs[i]!;
      if (row.created_at === doc.when) continue;
      if (update.run(doc.when, row.rowIdentity, doc.hash, doc.oldWhen).changes !== 1)
        refuse('the exact legacy row changed before retiming');
    }
  })();
  // The immutable shipped Chat migration follows the historical Doc timestamps.
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'dorkos-chat149-'));
  let chatFailure: { cause: unknown } | undefined;
  try {
    mkdirSync(path.join(temporary, 'meta'));
    writeFileSync(
      path.join(temporary, 'meta/_journal.json'),
      JSON.stringify({
        version: journal.version,
        dialect: journal.dialect,
        entries: [chat],
      })
    );
    writeFileSync(path.join(temporary, `${chat.tag}.sql`), chatBytes);
    migrate(db, { migrationsFolder: temporary });
  } catch (cause) {
    chatFailure = { cause };
  } finally {
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch (cause) {
      chatFailure ??= { cause };
    }
  }
  if (chatFailure) throw chatFailure.cause;
  // Original Doc DDL is already present; never replay consolidated CREATEs.
  // Only an exact final schema/FK match permits recording that covered step.
  sqlite.transaction(() => {
    for (const [i, entry] of shipped.entries()) {
      if (shippedRows[i]!.length) continue;
      for (const statement of shippedSql[i]!.toString('utf8').split('--> statement-breakpoint'))
        if (statement.trim()) sqlite.exec(statement);
      sqlite
        .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
        .run(entry.hash, entry.when);
    }
    verifyCanonicalSchema(db, folder);
    sqlite
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run(finalHash, consolidated.when);
  })();
}
