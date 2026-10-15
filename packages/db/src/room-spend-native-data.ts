import type Database from 'better-sqlite3';
import type { NativeCall, NativeEngine } from './room-spend-native-types.js';
export type { NativeCall, NativeEngine, Execution } from './room-spend-native-types.js';

export type ConstructionCustody = {
  wrappedDb?: object;
  relayConsumed: boolean;
  consumed: boolean;
  exposed: boolean;
  wrapped: boolean;
};

export type NativeMethodRecord = Record<'run' | 'get' | 'all', NativeCall>;

/** Fresh private DATA for the original module; no shared registration or native handle. */
export function createRoomSpendNativeData() {
  const opaqueMethods = new Set([
    'function',
    'aggregate',
    'table',
    'loadExtension',
    'unsafeMode',
    'defaultSafeIntegers',
    'backup',
  ]);
  const ordinaryMethods = new Set([
    'prepare',
    'transaction',
    'pragma',
    'exec',
    'close',
    'serialize',
  ]);
  const nativeGetters = new Set(['name', 'open', 'inTransaction', 'readonly', 'memory']);

  const ownedOperations = Object.freeze({
    mainDataVersion: { sql: 'PRAGMA main.data_version', method: 'get' as const },
    mainSchemaVersion: { sql: 'PRAGMA main.schema_version', method: 'get' as const },
    tempSchemaVersion: { sql: 'PRAGMA temp.schema_version', method: 'get' as const },
    spendTable: {
      sql: "SELECT sql FROM main.sqlite_master WHERE type='table' AND name='room_turn_spend'",
      method: 'all' as const,
    },
    spendTriggers: {
      sql: "SELECT name FROM main.sqlite_master WHERE type='trigger' AND tbl_name='room_turn_spend' UNION ALL SELECT name FROM temp.sqlite_master WHERE type='trigger' AND tbl_name='room_turn_spend'",
      method: 'all' as const,
    },
    databases: { sql: 'PRAGMA database_list', method: 'all' as const },
    foreignKeys: { sql: 'PRAGMA foreign_keys', method: 'get' as const },
    recursiveTriggers: { sql: 'PRAGMA recursive_triggers', method: 'get' as const },
    insertOrdinary: {
      sql: 'INSERT INTO main.room_turn_spend (room_id, at) VALUES (?, ?)',
      method: 'run' as const,
    },
    pruneExpired: { sql: 'DELETE FROM main.room_turn_spend WHERE at <= ?', method: 'run' as const },
    strictCounts: {
      sql: 'SELECT count(*) AS global, coalesce(sum(room_id = ?), 0) AS room FROM main.room_turn_spend WHERE at > ? AND at <= ?',
      method: 'get' as const,
    },
    receiptRows: {
      sql: `SELECT id, room_id AS roomId, at FROM main.room_turn_spend WHERE id IN (${Array(200).fill('?').join(',')}) AND at > ? AND at <= ?`,
      method: 'all' as const,
    },
  });
  return { opaqueMethods, ordinaryMethods, nativeGetters, ownedOperations };
}
export type RoomSpendNativeOperation = keyof ReturnType<
  typeof createRoomSpendNativeData
>['ownedOperations'];

/** Original one-shot construction flags; each call returns independent unregistered data. */
export function createConstructionCustody(): ConstructionCustody {
  return {
    relayConsumed: false,
    consumed: false,
    exposed: false,
    wrapped: false,
  };
}

/** One private cache over the constructor's already-captured native prepare binding. */
export function createFixedStatementReader(
  prepareNative: NativeEngine['prepare'],
  engine: NativeEngine,
  publicSelf: Database.Database
) {
  const fixed = new Map<string, Database.Statement>();
  return function statement(sql: string): Database.Statement {
    let result = fixed.get(sql);
    if (!result) {
      result = Reflect.apply(prepareNative, engine, [sql, publicSelf, false]) as Database.Statement;
      fixed.set(sql, result);
    }
    return result;
  };
}

/** Callback-free projection of the original room-limit statement result. */
export function projectRoomLimitData(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  const integer = (key: string): number | null => {
    const value = row[key];
    if (value === null) return null;
    if (!Number.isSafeInteger(value)) throw new Error('Invalid Room limit value');
    return value as number;
  };
  const enabled = integer('turnLimitsEnabled');
  return Object.freeze({
    turnLimitsEnabled: enabled === null ? null : enabled === 1,
    maxAgentDepth: integer('maxAgentDepth'),
    maxTurnsPerAgentPerCascade: integer('maxTurnsPerAgentPerCascade'),
    maxAutoTurnsPerHour: integer('maxAutoTurnsPerHour'),
  });
}
