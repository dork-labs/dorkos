import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './index.js';
import { constructDatabase } from './database-construction.js';
import { consolidatedDoc, refuse, type MigrationEntry } from './doc-migration-identities.js';

/** Compare real PRAGMA structure and CHECK/index semantics against a fresh canonical migration. */
export function verifyCanonicalSchema(
  db: Db,
  folder: string,
  published?: MigrationEntry & { hash: string },
  shippedAfter: Array<MigrationEntry & { hash: string }> = [],
  referenceEnd: number = consolidatedDoc.idx + 1
): void {
  const reference = constructDatabase(':memory:').db;
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'dorkos-doc-schema-'));
  let failure: { cause: unknown } | undefined;
  try {
    const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as {
      version: string;
      dialect: string;
      entries: MigrationEntry[];
    };
    const entries = published
      ? [
          ...journal.entries.slice(0, published.idx),
          ...shippedAfter.filter((entry) => entry.idx >= published.idx),
          published,
        ]
      : journal.entries.slice(0, referenceEnd);
    mkdirSync(path.join(temporary, 'meta'));
    writeFileSync(
      path.join(temporary, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries })
    );
    for (const entry of entries)
      writeFileSync(
        path.join(temporary, `${entry.tag}.sql`),
        readFileSync(
          path.join(
            folder,
            ...(published && entry === published ? ['legacy-doc'] : []),
            `${entry.tag}.sql`
          )
        )
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
  } catch (cause) {
    failure = { cause };
  } finally {
    try {
      reference.$client.close();
    } catch (cause) {
      failure ??= { cause };
    }
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch (cause) {
      failure ??= { cause };
    }
  }
  if (failure) throw failure.cause;
}
