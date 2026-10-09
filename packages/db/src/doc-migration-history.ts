/** Preserve pre-merge Doc databases across the immutable shipped Main148 migration. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './index.js';
import { constructDatabase } from './database-construction.js';

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
  const consolidated = journal.entries[150];
  if (
    !chat ||
    chat.idx !== 149 ||
    chat.tag !== '20261009171311_chat_messages' ||
    !consolidated ||
    consolidated.idx !== 150 ||
    consolidated.tag !== '20261009202012_sleepy_killer_shrike' ||
    journal.entries.length < 151
  )
    refuse('current shipped Chat and regenerated Doc journal differs');
  const chatBytes = readFileSync(path.join(folder, `${chat.tag}.sql`));
  const finalBytes = readFileSync(path.join(folder, `${consolidated.tag}.sql`));
  const chatHash = createHash('sha256').update(chatBytes).digest('hex');
  const finalHash = createHash('sha256').update(finalBytes).digest('hex');
  if (
    chatHash !== '55b1201b98db390ccf33bb4069645f6c542ef20739f8bd1a2e4c1078275582fc' ||
    chat.when !== 1791565991417 ||
    consolidated.when !== 1791577212201 ||
    finalHash !== '44321f0c067d6ce35619f22ac071fcd08bdddd8dec4a7b099f8ce31998b1324f'
  )
    refuse('regenerated migration differs from reviewed SQL');
  const chatRows = rows.filter((row) => row.hash === chatHash);
  const finalRows = rows.filter((row) => row.hash === finalHash);
  for (const [matching, entry] of [
    [chatRows, chat],
    [finalRows, consolidated],
  ] as const) {
    if (matching.length > 1 || (matching[0] && matching[0].created_at !== entry.when))
      refuse('current migration bookkeeping differs');
  }
  const futureRows = journal.entries.slice(151).flatMap((entry) => {
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
        !finalRows.includes(row) &&
        !futureRows.includes(row)
    )
  )
    refuse('unexpected migration after the published prefix');
  if (finalRows.length) {
    if (recorded.some((matching) => matching.length !== 1) || legacy.length || !chatRows.length)
      refuse('incomplete historical prefix claims consolidated migration');
    // A durable completed150 permits ordinary future migrations; never replay Doc DDL.
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
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  // Original Doc DDL is already present; never replay consolidated CREATEs.
  // Only an exact final schema/FK match permits recording that covered step.
  sqlite.transaction(() => {
    verifyCanonicalSchema(db, folder);
    sqlite
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run(finalHash, consolidated.when);
  })();
}

/** Compare real PRAGMA structure and CHECK/index semantics against a fresh canonical migration. */
function verifyCanonicalSchema(db: Db, folder: string): void {
  const reference = constructDatabase(':memory:').db;
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'dorkos-doc-schema-'));
  try {
    const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as {
      version: string;
      dialect: string;
      entries: MigrationEntry[];
    };
    mkdirSync(path.join(temporary, 'meta'));
    writeFileSync(
      path.join(temporary, 'meta/_journal.json'),
      JSON.stringify({
        ...journal,
        entries: journal.entries.slice(0, 151),
      })
    );
    for (const entry of journal.entries.slice(0, 151))
      writeFileSync(
        path.join(temporary, `${entry.tag}.sql`),
        readFileSync(path.join(folder, `${entry.tag}.sql`))
      );
    migrate(reference, { migrationsFolder: temporary });
    const normalize = (sql: string) => sql.replace(/[`"\s]/g, '');
    const tableNames = (value: Db) =>
      value.$client
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='__drizzle_migrations' ORDER BY name"
        )
        .all()
        .map((row) => (row as { name: string }).name);
    const expected = tableNames(reference);
    if (JSON.stringify(tableNames(db)) !== JSON.stringify(expected))
      refuse('legacy table membership differs');
    const stable = (rows: unknown[]) =>
      JSON.stringify(
        rows
          .map((row) => {
            const { id: _id, ...rest } = row as Record<string, unknown>;
            return rest;
          })
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      );
    for (const name of expected) {
      const escaped = name.replaceAll("'", "''");
      for (const pragma of ['table_xinfo', 'foreign_key_list']) {
        const read = (value: Db) => value.$client.prepare(`PRAGMA ${pragma}('${escaped}')`).all();
        if (stable(read(db)) !== stable(read(reference)))
          refuse(`legacy ${name} ${pragma} differs`);
      }
      const readIndexes = (value: Db) =>
        value.$client
          .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name"
          )
          .all(name)
          .map((row) => {
            const index = row as { name: string; sql: string };
            return { name: index.name, sql: normalize(index.sql) };
          });
      if (JSON.stringify(readIndexes(db)) !== JSON.stringify(readIndexes(reference)))
        refuse(`legacy ${name} indexes differ`);
      const checks = (value: Db) => {
        const row = value.$client
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
          .get(name) as { sql: string };
        const sql = row.sql;
        const expressions: string[] = [];
        // SQLite's own stored CREATE SQL; walk balanced CHECK expressions including quoted literals.
        for (let at = 0; at < sql.length; at++) {
          const match = /^CHECK\s*\(/i.exec(sql.slice(at));
          if (!match) continue;
          let end = at + match[0].length,
            depth = 1,
            quote = '';
          const start = end;
          for (; end < sql.length && depth; end++) {
            const character = sql[end]!;
            if (quote) {
              if (character === quote) {
                if (sql[end + 1] === quote) end++;
                else quote = '';
              }
            } else if (character === "'" || character === '"' || character === '`')
              quote = character;
            else if (character === '(') depth++;
            else if (character === ')') depth--;
          }
          if (depth) refuse('invalid stored CHECK expression');
          expressions.push(normalize(sql.slice(start, end - 1)));
          at = end - 1;
        }
        return expressions.sort();
      };
      if (JSON.stringify(checks(db)) !== JSON.stringify(checks(reference)))
        refuse(`legacy ${name} checks differ`);
    }
    if (db.$client.prepare('PRAGMA foreign_key_check').all().length)
      refuse('legacy foreign keys differ');
  } finally {
    try {
      reference.$client.close();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}
