/** Preserve pre-merge Doc databases across the immutable shipped Main148 migration. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './index.js';

type MigrationEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};
type MigrationRow = { rowIdentity: number; id: number | null; hash: string; created_at: number };
const main = {
  idx: 148,
  version: '6',
  when: 1791478831717,
  tag: '20261008170031_session_touches',
  breakpoints: true,
  hash: '88183c88d16354ffb5472ed57e4b03e94c26b00e95bdcb22a605b3df3be995b2',
} as const;
const docs = [
  {
    oldWhen: 1791414422000,
    when: 1791478832000,
    tag: '20261008170032_doc_room_admissions',
    hash: 'c156544a648a0d5dd48a5147f2488420d8460da5ea9e0c596afdd407486adc84',
  },
  {
    oldWhen: 1791414423000,
    when: 1791478833000,
    tag: '20261008170033_doc_room_pending_sources',
    hash: '934167d31e86442927414b4ef1790e60ddc3d1d7af51285b59411d135514fc49',
  },
  {
    oldWhen: 1791414424000,
    when: 1791478834000,
    tag: '20261008170034_lowly_molecule_man',
    hash: 'f85a83fc7fc5adc1764d1c10e089acdd3d0ea874139c5757bbff58ca77ed0825',
  },
] as const;

function refuse(detail: string): never {
  throw new Error(`Invalid legacy Doc migration history: ${detail}`);
}

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
  if (legacy.length === 0) return;
  if (recorded.flat().length !== legacy.length) refuse('mixed old and canonical Doc timestamps');
  if (legacy.some((row, i) => i > 0 && row.rowIdentity <= legacy[i - 1]!.rowIdentity)) {
    refuse('Doc rows are not recorded in their original prefix order');
  }
  const mainRows = rows.filter((row) => row.hash === main.hash);
  if (mainRows.length > 1 || (mainRows[0] && mainRows[0].created_at !== main.when)) {
    refuse('Main148 bookkeeping differs from the shipped migration');
  }
  if (mainRows[0] && mainRows[0].rowIdentity <= legacy[legacy.length - 1]!.rowIdentity) {
    refuse('Main148 precedes the legacy Doc prefix');
  }
  // No unrelated newer watermark may be silently skipped or retimed.
  if (
    rows.some(
      (row) => row.created_at >= docs[0].oldWhen && !legacy.includes(row) && !mainRows.includes(row)
    )
  ) {
    refuse('unexpected migration after the published prefix');
  }

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
  for (const [i, doc] of docs.entries()) {
    canonicalSql({ ...doc, idx: 149 + i, version: '6', breakpoints: true });
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
  // Main148 may already be committed after a stopped process. Retiming is a
  // separate, atomic ledger-only transaction: keep every rowid, id and hash.
  sqlite.transaction(() => {
    const update = sqlite.prepare(
      'UPDATE __drizzle_migrations SET created_at = ? WHERE rowid = ? AND hash = ? AND created_at = ?'
    );
    for (const [i, matching] of recorded.entries()) {
      const row = matching[0];
      if (!row) break;
      const doc = docs[i]!;
      if (update.run(doc.when, row.rowIdentity, doc.hash, doc.oldWhen).changes !== 1) {
        refuse('the exact legacy row changed before retiming');
      }
    }
  })();
}
