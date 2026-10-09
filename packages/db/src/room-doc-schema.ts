/** Only complete unquoted Boolean SQL keywords are case-insensitive; literals/expressions stay exact. */
function normalizeBooleanDefault(value: string | null): string | null {
  const lower = value?.toLowerCase();
  return lower === 'true' || lower === 'false' ? lower : value;
}
/** Pure literal schema comparison. No database, callback or authority API. */
import { sourceSchema } from './room-doc-source-schema.js';
import { authoritySchema } from './room-doc-authority-schema.js';
import { admissionSchema } from './room-doc-admission-schema.js';
import { roomSchema } from './room-doc-room-schema.js';
export interface RoomDocExpectedTable {
  columns: readonly (readonly [string, string, number, number, string | null])[];
  foreignKeys: readonly (readonly [readonly string[], string, readonly string[], string, string])[];
  checks: readonly string[];
  indices: readonly (readonly [string, string])[];
}
function freezeLiteral<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeLiteral(child);
    Object.freeze(value);
  }
  return value;
}
export const roomDocExpectedSchema = freezeLiteral({
  ...sourceSchema,
  ...roomSchema,
  ...authoritySchema,
  ...admissionSchema,
});
export type RoomDocSchemaRows = Readonly<
  Record<
    string,
    {
      columns: readonly {
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: string | null;
        hidden: number;
      }[];
      foreignKeys: readonly {
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
      }[];
    }
  >
>;
export interface RoomDocSchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
function normalize(value: string): string {
  const outside = (part: string) =>
    part
      .replace(/[`"[\]]/g, '')
      .replace(/\b[a-z_]+\.(?=[a-z_])/gi, '')
      .replace(/\s+/g, '');
  let result = '',
    plain = '',
    index = 0;
  while (index < value.length) {
    if (value[index] !== "'") {
      plain += value[index++];
      continue;
    }
    result += outside(plain);
    plain = '';
    const start = index++;
    let closed = false;
    while (index < value.length) {
      if (value[index++] !== "'") continue;
      if (value[index] === "'") {
        index++;
        continue;
      }
      closed = true;
      break;
    }
    if (!closed) throw new Error('Unterminated SQL literal');
    result += value.slice(start, index);
  }
  return (result + outside(plain)).replace(/;$/, '');
}
function checks(sql: string): string[] {
  const result: string[] = [];
  let offset = 0;
  while (offset < sql.length) {
    const match = /\bCHECK\s*\(/gi;
    match.lastIndex = offset;
    const found = match.exec(sql);
    if (!found) break;
    let depth = 1,
      quoted = false,
      index = match.lastIndex;
    const start = index;
    while (depth && index < sql.length) {
      const value = sql[index++];
      if (value === "'") {
        if (quoted && sql[index] === "'") {
          index += 1;
          continue;
        }
        quoted = !quoted;
      }
      if (!quoted && value === '(') depth += 1;
      if (!quoted && value === ')') depth -= 1;
    }
    if (depth || quoted) throw new Error('Unrecognized Room schema expression');
    result.push(normalize(sql.slice(start, index - 1)));
    offset = index;
  }
  return result.sort();
}
/** All inputs are fixed native observations; reflected rows never grant source rights. */
function matches(
  objects: readonly RoomDocSchemaObject[],
  rows: RoomDocSchemaRows,
  inventory: Readonly<Record<string, RoomDocExpectedTable>>
): boolean {
  const names = Object.keys(inventory);
  const tableRows = objects.filter((row) => row.type === 'table');
  if (tableRows.length !== names.length) return false;
  for (const name of names) {
    const expected = inventory[name];
    const table = tableRows.find((row) => row.name === name && row.tbl_name === name);
    const observed = rows[name];
    if (
      !table?.sql ||
      !observed ||
      !/^CREATE TABLE\b/i.test(table.sql) ||
      /\b(?:COLLATE|WITHOUT ROWID|STRICT|GENERATED|VIRTUAL)\b/i.test(table.sql)
    )
      return false;
    const actual = observed.columns.map((row) => [
      row.name,
      row.type.toUpperCase(),
      row.notnull,
      row.pk,
      normalizeBooleanDefault(row.dflt_value),
    ]);
    if (
      observed.columns.some((row) => row.hidden !== 0) ||
      actual.length !== expected.columns.length ||
      expected.columns.some(
        (column) =>
          !actual.some(
            (row) =>
              JSON.stringify(row) ===
              JSON.stringify([...column.slice(0, 4), normalizeBooleanDefault(column[4])])
          )
      )
    )
      return false;
    const groups = new Map<number, (typeof observed.foreignKeys)[number][]>();
    for (const key of observed.foreignKeys) {
      const group = groups.get(key.id) ?? [];
      group.push(key);
      groups.set(key.id, group);
    }
    const actualKeys = [...groups.values()]
      .map((group) => {
        group.sort((left, right) => left.seq - right.seq);
        return [
          group.map((key) => key.from),
          group[0].table,
          group.map((key) => key.to),
          group[0].on_update,
          group[0].on_delete,
        ];
      })
      .map((key) => JSON.stringify(key))
      .sort();
    if (
      JSON.stringify(actualKeys) !==
        JSON.stringify(expected.foreignKeys.map((key) => JSON.stringify(key)).sort()) ||
      JSON.stringify(checks(table.sql)) !== JSON.stringify(expected.checks.map(normalize).sort())
    )
      return false;
    const indices = objects.filter(
      (row) => row.type === 'index' && row.tbl_name === name && row.sql !== null
    );
    if (
      indices.length !== expected.indices.length ||
      expected.indices.some(
        ([index, sql]) =>
          !indices.some(
            (row) => row.name === index && row.sql !== null && normalize(row.sql) === normalize(sql)
          )
      )
    )
      return false;
  }
  return true;
}

/** Compare the complete native Room schema with its expected shape. */
export function matchesRoomDocSchema(
  objects: readonly RoomDocSchemaObject[],
  rows: RoomDocSchemaRows
): boolean {
  return matches(objects, rows, roomDocExpectedSchema);
}

/** Exact native additions: absence compatibility never accepts a partial shape. */
export const nativeRoomColumnNames = Object.freeze([
  'delivery_kind',
  'room_admission_id',
  'room_source_attempt',
  'room_source_json',
  'room_source_hash',
  'room_spend_floor_ms',
]);

const extraReaderSchema: Readonly<Record<string, RoomDocExpectedTable>> = {
  user: {
    columns: [
      ['id', 'TEXT', 1, 1, null],
      ['name', 'TEXT', 1, 0, null],
      ['email', 'TEXT', 1, 0, null],
      ['email_verified', 'INTEGER', 1, 0, 'False'],
      ['image', 'TEXT', 0, 0, null],
      ['created_at', 'INTEGER', 1, 0, "cast(unixepoch('subsecond') * 1000 as integer)"],
      ['updated_at', 'INTEGER', 1, 0, "cast(unixepoch('subsecond') * 1000 as integer)"],
      ['role', 'TEXT', 0, 0, null],
    ],
    foreignKeys: [],
    checks: [],
    indices: [['user_email_unique', 'CREATE UNIQUE INDEX user_email_unique ON user (email)']],
  },
  canvas_doc_identity_intents: {
    columns: [
      ['intent_id', 'TEXT', 1, 1, null],
      ['document_id', 'TEXT', 1, 0, null],
      ['from_scope', 'TEXT', 1, 0, null],
      ['to_scope', 'TEXT', 1, 0, null],
      ['source_id', 'TEXT', 1, 0, null],
      ['source_generation', 'TEXT', 1, 0, null],
      ['evidence', 'TEXT', 1, 0, null],
      ['status', 'TEXT', 1, 0, null],
      ['error_code', 'TEXT', 0, 0, null],
      ['created_at', 'TEXT', 1, 0, null],
      ['updated_at', 'TEXT', 1, 0, null],
    ],
    foreignKeys: [
      [['document_id'], 'canvas_doc_channels', ['document_id'], 'NO ACTION', 'NO ACTION'],
    ],
    checks: [],
    indices: [
      [
        'canvas_doc_identity_intents_recovery_idx',
        'CREATE INDEX canvas_doc_identity_intents_recovery_idx ON canvas_doc_identity_intents (status,updated_at)',
      ],
    ],
  },
};
/** Compare the additional reader schema with its exact expected shape. */
export function matchesExtraRoomReaderSchema(
  objects: readonly RoomDocSchemaObject[],
  rows: RoomDocSchemaRows
): boolean {
  return matches(objects, rows, extraReaderSchema);
}

export const roomDocLegacyTables = Object.freeze([
  'canvas_doc_batches',
  'canvas_doc_deliveries',
  'canvas_doc_channels',
] as const);
/** Refuse triggers, attached databases or incompatible native pragma settings. */
export function assertRoomSchemaEnvironment(
  triggers: readonly unknown[],
  databases: readonly { name: string }[],
  fk: Record<string, number>,
  recursive: Record<string, number>
) {
  if (
    triggers.length ||
    databases.some((row) => row.name !== 'main' && row.name !== 'temp') ||
    Object.values(fk)[0] !== 1 ||
    Object.values(recursive)[0] !== 1
  )
    throw new Error('Unsupported Room native schema');
}

/** Refuse unsupported reader objects or triggers. */
export function assertExtraRoomReaderSchema(
  triggers: readonly unknown[],
  objects: readonly RoomDocSchemaObject[],
  rows: RoomDocSchemaRows
) {
  if (triggers.length || !matchesExtraRoomReaderSchema(objects, rows))
    throw new Error('Unsupported native Room reader schema');
}
/** Require the complete recognized native Room schema. */
export function assertRecognizedRoomDocSchema(
  unknown: boolean,
  objects: readonly RoomDocSchemaObject[],
  rows: RoomDocSchemaRows
) {
  if (unknown || !matchesRoomDocSchema(objects, rows))
    throw new Error('Unrecognized native Room schema');
}
