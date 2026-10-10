/** Actual migration structure must equal the untouched official generated snapshot. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createDb, runMigrations } from '../index';

type Table = {
  columns: Record<
    string,
    { name: string; type: string; primaryKey: boolean; notNull: boolean; default?: unknown }
  >;
  compositePrimaryKeys: Record<string, { columns: string[] }>;
  foreignKeys: Record<
    string,
    {
      tableTo: string;
      columnsFrom: string[];
      columnsTo: string[];
      onDelete: string;
      onUpdate: string;
    }
  >;
  indexes: Record<string, { name: string; columns: string[]; isUnique: boolean; where?: string }>;
  checkConstraints: Record<string, { value: string }>;
};
const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../drizzle/meta/20261010100703_snapshot.json', import.meta.url)),
    'utf8'
  )
) as { id: string; prevId: string; tables: Record<string, Table> };
const tables = [
  'room_doc_admission_inputs',
  'room_doc_admissions',
  'room_doc_exhausted_lineages',
  'canvas_doc_room_pending_sources',
  'canvas_doc_channel_tokens',
  'canvas_doc_batches',
  'canvas_doc_channels',
  'canvas_doc_deliveries',
  'room_entries',
  'chat_agent_dms',
  'chat_messages',
  'chat_read_cursors',
];
const sorted = <T>(rows: T[]) =>
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
/** Preserve string literal contents while ignoring SQL whitespace and identifier quoting. */
function normalizeSql(sql: string): string {
  let out = '';
  for (let at = 0; at < sql.length; at++) {
    const ch = sql[at]!;
    if (ch === "'") {
      out += ch;
      for (at++; at < sql.length; at++) {
        out += sql[at];
        if (sql[at] === "'") {
          if (sql[at + 1] === "'") {
            out += sql[++at];
          } else break;
        }
      }
    } else if (ch !== '`' && ch !== '"' && !/\s/.test(ch)) out += ch;
  }
  return out;
}
/** Read balanced CHECK expressions from SQLite's real stored table definition. */
function storedChecks(sql: string): string[] {
  const result: string[] = [];
  for (let at = 0; at < sql.length; at++) {
    const match = /^CHECK\s*\(/i.exec(sql.slice(at));
    if (!match) continue;
    let end = at + match[0].length,
      depth = 1,
      quote = '';
    const start = end;
    for (; end < sql.length && depth; end++) {
      const ch = sql[end]!;
      if (quote) {
        if (ch === quote) {
          if (sql[end + 1] === quote) end++;
          else quote = '';
        }
      } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    expect(depth).toBe(0);
    result.push(normalizeSql(sql.slice(start, end - 1)));
    at = end - 1;
  }
  return result.sort();
}

it('migrates all nine Doc/Room structures and three shipped Chat structures to the official snapshot', () => {
  expect(snapshot.prevId).toBe('137a0ef5-e661-49d0-8474-189ce98028f8');
  expect(snapshot.id).not.toBe(snapshot.prevId);
  const db = createDb(':memory:');
  try {
    runMigrations(db);
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
    for (const name of tables) {
      const expected = snapshot.tables[name]!;
      expect(expected, name).toBeDefined();
      const primary =
        Object.values(expected.compositePrimaryKeys)[0]?.columns ??
        Object.values(expected.columns)
          .filter((column) => column.primaryKey)
          .map((column) => column.name);
      const cols = db.$client.prepare(`PRAGMA table_xinfo('${name}')`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
        hidden: number;
      }>;
      expect(
        sorted(
          cols.map((column) => ({
            name: column.name,
            type: column.type.toLowerCase(),
            notNull: !!column.notnull,
            default: column.dflt_value === null ? null : normalizeSql(column.dflt_value),
            primaryPosition: column.pk,
            hidden: column.hidden,
          }))
        ),
        name
      ).toEqual(
        sorted(
          Object.values(expected.columns).map((column) => ({
            name: column.name,
            type: column.type.toLowerCase(),
            notNull: column.notNull,
            default: column.default === undefined ? null : normalizeSql(String(column.default)),
            primaryPosition: primary.indexOf(column.name) + 1,
            hidden: 0,
          }))
        )
      );
      const fk = db.$client.prepare(`PRAGMA foreign_key_list('${name}')`).all() as Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_delete: string;
        on_update: string;
      }>;
      const groups = new Map<number, typeof fk>();
      for (const row of fk) groups.set(row.id, [...(groups.get(row.id) ?? []), row]);
      expect(
        sorted(
          [...groups.values()].map((rows) => {
            rows.sort((a, b) => a.seq - b.seq);
            return {
              table: rows[0]!.table,
              from: rows.map((row) => row.from),
              to: rows.map((row) => row.to),
              onDelete: rows[0]!.on_delete.toLowerCase(),
              onUpdate: rows[0]!.on_update.toLowerCase(),
            };
          })
        ),
        name
      ).toEqual(
        sorted(
          Object.values(expected.foreignKeys).map((row) => ({
            table: row.tableTo,
            from: row.columnsFrom,
            to: row.columnsTo,
            onDelete: row.onDelete.toLowerCase(),
            onUpdate: row.onUpdate.toLowerCase(),
          }))
        )
      );
      const indexes = db.$client.prepare(`PRAGMA index_list('${name}')`).all() as Array<{
        name: string;
        unique: number;
        origin: string;
      }>;
      expect(
        sorted(
          indexes
            .filter((index) => index.origin === 'c')
            .map((index) => {
              const cols = db.$client.prepare(`PRAGMA index_info('${index.name}')`).all() as Array<{
                seqno: number;
                name: string;
              }>;
              const definition = db.$client
                .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
                .get(index.name) as { sql: string };
              const where = /\bWHERE\s+([\s\S]*)$/i.exec(definition.sql)?.[1];
              return {
                name: index.name,
                columns: cols.sort((a, b) => a.seqno - b.seqno).map((column) => column.name),
                unique: !!index.unique,
                where: where ? normalizeSql(where) : null,
              };
            })
        ),
        name
      ).toEqual(
        sorted(
          Object.values(expected.indexes).map((index) => ({
            name: index.name,
            columns: index.columns,
            unique: index.isUnique,
            where: index.where ? normalizeSql(index.where) : null,
          }))
        )
      );
      const definition = db.$client
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(name) as { sql: string };
      expect(storedChecks(definition.sql), name).toEqual(
        Object.values(expected.checkConstraints)
          .map((constraint) => normalizeSql(constraint.value))
          .sort()
      );
    }
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db.$client.close();
  }
});
