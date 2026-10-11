import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './index.js';
import { constructDatabase } from './database-construction.js';
import {
  consolidatedDoc,
  reviewedPublishedSql,
  refuse,
  type MigrationEntry,
} from './doc-migration-identities.js';

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
        published && entry === published
          ? reviewedPublishedSql(folder, published)
          : readFileSync(path.join(folder, `${entry.tag}.sql`))
      );
    migrate(reference, { migrationsFolder: temporary });
    // Preserve token boundaries and every quoted byte while ignoring only code formatting.
    // CHECK-like text inside strings or SQL comments has no constraint authority.
    const tokens = (sql: string): string[] => {
      const result: string[] = [];
      for (let at = 0; at < sql.length;) {
        const character = sql[at]!;
        if (/[ \t\r\n\f]/.test(character)) {
          at++;
          continue;
        }
        if (sql.startsWith('--', at)) {
          const end = sql.indexOf('\n', at + 2);
          at = end < 0 ? sql.length : end + 1;
          continue;
        }
        if (sql.startsWith('/*', at)) {
          const end = sql.indexOf('*/', at + 2);
          if (end < 0) refuse('unterminated stored SQL comment');
          at = end + 2;
          continue;
        }
        const start = at;
        if (character === "'" || character === '"' || character === '`' || character === '[') {
          const quote = character === '[' ? ']' : character;
          let closed = false;
          for (at++; at < sql.length; at++) {
            if (sql[at] !== quote) continue;
            if (sql[at + 1] === quote) {
              at++;
              continue;
            }
            at++;
            closed = true;
            break;
          }
          if (!closed) refuse('unterminated stored SQL quote');
        } else if (/[A-Za-z0-9_$]/.test(character)) {
          for (at++; at < sql.length && /[A-Za-z0-9_$]/.test(sql[at]!); at++) {
            /* token */
          }
        } else at++;
        result.push(sql.slice(start, at));
      }
      return result;
    };
    const normalize = (sql: string) => JSON.stringify(tokens(sql));
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
    const stableForeignKeys = (rows: unknown[]) => {
      const groups = new Map<number, Record<string, unknown>[]>();
      for (const value of rows) {
        const row = value as Record<string, unknown>;
        if (
          typeof row.id !== 'number' ||
          !Number.isInteger(row.id) ||
          typeof row.seq !== 'number' ||
          !Number.isInteger(row.seq)
        )
          refuse('invalid legacy foreign key grouping');
        const group = groups.get(row.id) ?? [];
        group.push(row);
        groups.set(row.id, group);
      }
      const normalized = [...groups.values()].map((group) => {
        group.sort((left, right) => (left.seq as number) - (right.seq as number));
        const ordered = group.map((row, sequence) => {
          if (row.seq !== sequence) refuse('invalid legacy composite foreign key sequence');
          const { id: _id, ...rest } = row;
          return rest;
        });
        return JSON.stringify(ordered);
      });
      return JSON.stringify(normalized.sort());
    };
    for (const name of expected) {
      const escaped = name.replaceAll("'", "''");
      for (const pragma of ['table_xinfo', 'foreign_key_list']) {
        const read = (value: Db) => value.$client.prepare(`PRAGMA ${pragma}('${escaped}')`).all();
        const compare = pragma === 'foreign_key_list' ? stableForeignKeys : stable;
        if (compare(read(db)) !== compare(read(reference)))
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
        const sql = tokens(row.sql);
        const expressions: string[] = [];
        for (let at = 0; at < sql.length; at++) {
          if (sql[at]!.toUpperCase() !== 'CHECK' || sql[at + 1] !== '(') continue;
          let end = at + 2;
          let depth = 1;
          const start = end;
          for (; end < sql.length && depth; end++) {
            if (sql[end] === '(') depth++;
            else if (sql[end] === ')') depth--;
          }
          if (depth) refuse('invalid stored CHECK expression');
          expressions.push(JSON.stringify(sql.slice(start, end - 1)));
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
