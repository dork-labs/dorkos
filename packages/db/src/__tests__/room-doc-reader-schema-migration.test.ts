import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations, type Db } from '../index.js';
import {
  assertExtraRoomReaderSchema,
  matchesExtraRoomReaderSchema,
  type RoomDocSchemaObject,
  type RoomDocSchemaRows,
} from '../room-doc-schema.js';

function read(db: Db) {
  const objects = db.$client
    .prepare(
      "SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE tbl_name IN ('user','canvas_doc_identity_intents')"
    )
    .all() as RoomDocSchemaObject[];
  const rows: RoomDocSchemaRows = {
    user: {
      columns: db.$client
        .prepare('PRAGMA main.table_xinfo(user)')
        .all() as RoomDocSchemaRows[string]['columns'],
      foreignKeys: db.$client
        .prepare('PRAGMA main.foreign_key_list(user)')
        .all() as RoomDocSchemaRows[string]['foreignKeys'],
    },
    canvas_doc_identity_intents: {
      columns: db.$client
        .prepare('PRAGMA main.table_xinfo(canvas_doc_identity_intents)')
        .all() as RoomDocSchemaRows[string]['columns'],
      foreignKeys: db.$client
        .prepare('PRAGMA main.foreign_key_list(canvas_doc_identity_intents)')
        .all() as RoomDocSchemaRows[string]['foreignKeys'],
    },
  };
  return { objects, rows };
}
it('recognizes the real migrated/reopened reader schema and still refuses altered defaults, columns, keys, indices and triggers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'room-reader-schema-'));
  const filename = join(directory, 'db.sqlite');
  let db: Db | undefined,
    closed = false,
    failed = false,
    first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  try {
    db = createDb(filename);
    runMigrations(db);
    const original = read(db);
    expect(original.rows.user!.columns.find((row) => row.name === 'created_at')?.dflt_value).toBe(
      "cast(unixepoch('subsecond') * 1000 as integer)"
    );
    expect(matchesExtraRoomReaderSchema(original.objects, original.rows)).toBe(true);
    db.$client.close();
    db = undefined;
    db = createDb(filename);
    runMigrations(db);
    const reopened = read(db);
    expect(reopened).toEqual(original);
    expect(() => assertExtraRoomReaderSchema([], reopened.objects, reopened.rows)).not.toThrow();
    const user = reopened.rows.user!;
    expect(
      matchesExtraRoomReaderSchema(reopened.objects, {
        ...reopened.rows,
        user: {
          ...user,
          columns: user.columns.map((row) =>
            row.name === 'created_at' ? { ...row, dflt_value: '0' } : row
          ),
        },
      })
    ).toBe(false);
    expect(
      matchesExtraRoomReaderSchema(reopened.objects, {
        ...reopened.rows,
        user: {
          ...user,
          columns: user.columns.map((row) => (row.name === 'email' ? { ...row, notnull: 0 } : row)),
        },
      })
    ).toBe(false);
    const alias = reopened.rows.canvas_doc_identity_intents!;
    expect(
      matchesExtraRoomReaderSchema(reopened.objects, {
        ...reopened.rows,
        canvas_doc_identity_intents: { ...alias, foreignKeys: [] },
      })
    ).toBe(false);
    expect(
      matchesExtraRoomReaderSchema(
        reopened.objects.filter((row) => row.name !== 'user_email_unique'),
        reopened.rows
      )
    ).toBe(false);
    expect(() =>
      assertExtraRoomReaderSchema([{ name: 'reader-trigger' }], reopened.objects, reopened.rows)
    ).toThrow('Unsupported native Room reader schema');
  } catch (cause) {
    remember(cause);
  } finally {
    if (db)
      try {
        db.$client.close();
        closed = true;
      } catch (cause) {
        remember(cause);
      }
    if (closed)
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch (cause) {
        remember(cause);
      }
  }
  if (failed) throw first;
});
