import { constructOriginalRelayDocStorage } from './relay-doc-native.js';
const queryCustodyDescriptor = Object.getOwnPropertyDescriptor;
const queryCustodyGet = WeakMap.prototype.get;
const queryCustodyApply = Reflect.apply;
const originalServerQueryCustody = new WeakMap<object, () => void>();
/** Fixed constructor lookup; no existing engine or supplied checker can register. */
export function requireServerNativeDatabaseQueryCustody(db: object): void {
  const requireOriginal = queryCustodyApply(queryCustodyGet, originalServerQueryCustody, [db]) as
    (() => void) | undefined;
  if (!requireOriginal) throw new Error('Original server native database required');
  requireOriginal();
}
/** Native insertion lifetime evidence; deliberately no Doc claim or source authority. */
import type Database from 'better-sqlite3';
import {
  constructRoomDocStorage,
  type RoomDocFence,
  type RoomDocStorage,
} from './room-doc-storage.js';
import {
  copyOrdinarySpendInputs,
  validateSpendTime,
  validateSpendWindow,
} from './room-spend-input.js';
import {
  openProtectedRoomNativeDatabase,
  type RoomSpendNativeOperation,
  type OriginalProtectedRoomDb,
} from './room-spend-native.js';

/** Opaque process-local identity. Fields never authenticate a receipt. */
export interface NativeSpendReceipt {
  readonly kind: 'native-room-spend';
}
/** Fixed persistence operations. This port cannot authorize a turn or a source. */
export interface RoomSpendPersistence {
  readRoomLimitData(
    roomId: string
  ): ReturnType<ReturnType<typeof openProtectedRoomNativeDatabase>['readRoomLimitData']>;
  insertOrdinary(
    roomId: string,
    at: number,
    floor?: number
  ): { rowId: number | bigint; receipt?: NativeSpendReceipt; state?: 'refused-prepared' };
  readRoomDocPreparedFence(at: number, floor: number): RoomDocFence;
  pruneExpired(floor: number): void;
  readStrictCounts(roomId: string, floor: number, at: number): { global: number; room: number };
  overlapOfNativeReceipts(
    receipts: readonly NativeSpendReceipt[],
    roomId: string,
    floor: number,
    at: number
  ): { global: number; room: number };
}

/** Fixed capacity persistence only; neither principal nor SDK permission. */
export interface FixedRoomDocBudgetPersistence {
  prepare: (
    input: import('./room-doc-types.js').RoomDocClaimData
  ) => ReturnType<RoomDocStorage['prepareAcceptedBarrier']>;
  commit: (
    barrier: import('./room-doc-types.js').ConfirmedRoomBarrier,
    input: import('./room-doc-types.js').RoomDocClaimData
  ) => ReturnType<RoomDocStorage['commitPreparedRoomDoc']>;
  release: (
    barrier: import('./room-doc-types.js').ConfirmedRoomBarrier
  ) => ReturnType<RoomDocStorage['releaseKnownPreparedBarrier']>;
  readCommittedFact: (
    commit: import('./room-doc-types.js').NativeRoomDocCommit
  ) => ReturnType<RoomDocStorage['readCommittedFact']>;
  readRoomLimitData: (roomId: string) => ReturnType<RoomDocStorage['readRoomLimitData']>;
}
const docBudgetPorts = new WeakMap<object, FixedRoomDocBudgetPersistence>();
/** Internal server construction lookup; no supplied origin/SQL/engine registration. */
export function createRoomDocBudgetPersistence(
  exactDb: object
): FixedRoomDocBudgetPersistence | undefined {
  return docBudgetPorts.get(exactDb);
}
type ReceiptState = { id: number; roomId: string; at: number; generation: number };
const ports = new WeakMap<object, RoomSpendPersistence>();
const expectedTable =
  'create table room_turn_spend(id integer primary key autoincrement not null,' +
  'room_id text not null,at integer not null)';

/** Resolve only construction-owned provenance; never register a supplied handle. */
export function createRoomSpendPersistence(db: object): RoomSpendPersistence | undefined {
  return ports.get(db);
}

/** Named original server construction result; no additional public constructor capability. */
export interface ProtectedRoomDatabase {
  sqlite: Database.Database;
  roomDocStorage: ReturnType<typeof constructRoomDocStorage>['storage'];
  nativeOrigin: ReturnType<typeof constructRoomDocStorage>['nativeOrigin'];
  serverNativeRoomConstruction: ReturnType<
    typeof constructRoomDocStorage
  >['serverNativeRoomConstruction'];
  serverNativeRelayConstruction: ReturnType<
    typeof constructOriginalRelayDocStorage
  >['serverNativeRelayConstruction'];
  wrap(): OriginalProtectedRoomDb;
}

/**
 * Internal package constructor. wrap takes no handle/callback and performs genuine Drizzle
 * construction itself exactly once. Neither this constructor nor wrap is root-exported.
 */
export function openProtectedRoomDatabase(dbPath: string): ProtectedRoomDatabase {
  const native = openProtectedRoomNativeDatabase(dbPath);
  let foreignVersion: string | undefined;
  let prunedThrough = Number.NEGATIVE_INFINITY;
  const receipts = new WeakMap<NativeSpendReceipt, ReceiptState>();
  const execute = native.execute;
  try {
    function scalar(operation: RoomSpendNativeOperation): number {
      const row = execute(operation) as Record<string, unknown> | undefined;
      const value = row && Object.values(row)[0];
      if (!Number.isSafeInteger(value)) throw new Error('Invalid native database observation');
      return value as number;
    }
    function observe(): string {
      if (!native.open) throw new Error('Database connection is closed');
      const version = [
        scalar('mainDataVersion'),
        scalar('mainSchemaVersion'),
        scalar('tempSchemaVersion'),
      ].join(':');
      if (foreignVersion !== undefined && foreignVersion !== version) native.invalidate();
      foreignVersion = version;
      return version;
    }
    function safeSchema(): boolean {
      const rows = execute('spendTable') as { sql: string }[];
      const normalized = rows[0]?.sql
        .replace(/[`"[\]]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),])\s*/g, '$1')
        .trim();
      const triggers = execute('spendTriggers') as unknown[];
      const databases = execute('databases') as { name: string }[];
      return (
        rows.length === 1 &&
        normalized === expectedTable &&
        triggers.length === 0 &&
        databases.every((db) => db.name === 'main' || db.name === 'temp') &&
        scalar('foreignKeys') === 1 &&
        scalar('recursiveTriggers') === 1
      );
    }
    function overlap(
      input: readonly NativeSpendReceipt[],
      roomId: string,
      floor: number,
      at: number,
      frame?: object
    ) {
      validateSpendWindow(roomId, floor, at);
      if (frame) native.requireRoomFrame(frame);
      const copied = copyOrdinarySpendInputs(input);
      if (!copied) return { global: 0, room: 0 };
      const before = observe();
      if (native.unknown || (native.inTransaction && !frame) || !safeSchema())
        return { global: 0, room: 0 };
      const start = native.generation;
      const candidates: ReceiptState[] = [];
      const uniqueIds = new Set<number>();
      for (let index = 0; index < copied.length; index += 1) {
        const original = receipts.get(copied[index]);
        if (
          !original ||
          original.generation !== start ||
          original.at <= floor ||
          original.at <= prunedThrough ||
          original.at > at
        )
          continue;
        if (uniqueIds.has(original.id)) return { global: 0, room: 0 };
        uniqueIds.add(original.id);
        Object.defineProperty(candidates, candidates.length, {
          value: original,
          enumerable: true,
        });
      }
      let global = 0;
      let room = 0;
      for (let offset = 0; offset < candidates.length; offset += 200) {
        const chunk = candidates.slice(offset, offset + 200);
        const ids = chunk.map((r) => r.id);
        while (ids.length < 200) ids.push(-1);
        const rows = execute('receiptRows', [...ids, floor, at]) as {
          id: number;
          roomId: string;
          at: number;
        }[];
        for (const row of rows) {
          const original = chunk.find((r) => r.id === row.id);
          if (original && original.roomId === row.roomId && original.at === row.at) {
            global += 1;
            if (row.roomId === roomId) room += 1;
          }
        }
      }
      const after = observe();
      return native.unknown ||
        (native.inTransaction && !frame) ||
        native.generation !== start ||
        before !== after
        ? { global: 0, room: 0 }
        : { global, room };
    }
    const roomDoc = constructRoomDocStorage(native, {
      observe,
      overlap(frame, input, roomId, floor, at) {
        return overlap(input, roomId, floor, at, frame);
      },
      issue(frame, roomId, at, rowId) {
        if (!native.committedRoomFrame(frame))
          throw new Error('Unknown native Room spend lifetime');
        const receipt: NativeSpendReceipt = Object.freeze({ kind: 'native-room-spend' });
        receipts.set(receipt, { id: rowId, roomId, at, generation: native.generation });
        return receipt;
      },
    });
    const relayDoc = constructOriginalRelayDocStorage(native);
    let wrappedDb: object | undefined;
    const port: RoomSpendPersistence = Object.freeze<RoomSpendPersistence>({
      readRoomLimitData(roomId: string) {
        if (!wrappedDb) throw new Error('Unbound Room limit reader');
        return roomDoc.storage.readRoomLimitData(roomDoc.nativeOrigin, wrappedDb, roomId);
      },
      readRoomDocPreparedFence(at: number, floor: number) {
        validateSpendTime(at);
        validateSpendTime(floor);
        return roomDoc.potential(at, floor);
      },
      insertOrdinary(roomId: string, at: number, floor = at - 3_600_000) {
        validateSpendWindow(roomId, at, at);
        const before = observe();
        const eligible = !native.unknown && !native.inTransaction && safeSchema();
        const start = native.generation;
        const inserted = roomDoc.ordinaryInsert(roomId, at, floor);
        if (inserted.state === 'refused-prepared')
          return {
            rowId: inserted.result?.lastInsertRowid ?? 0,
            state: 'refused-prepared' as const,
          };
        const result = inserted.result;
        const after = observe();
        if (
          !eligible ||
          native.unknown ||
          native.inTransaction ||
          native.generation !== start ||
          before !== after ||
          result.changes !== 1 ||
          typeof result.lastInsertRowid !== 'number' ||
          !Number.isSafeInteger(result.lastInsertRowid) ||
          result.lastInsertRowid <= 0
        ) {
          return { rowId: result.lastInsertRowid };
        }
        const receipt: NativeSpendReceipt = Object.freeze({ kind: 'native-room-spend' });
        receipts.set(receipt, {
          id: result.lastInsertRowid,
          roomId,
          at,
          generation: native.generation,
        });
        return { rowId: result.lastInsertRowid, receipt };
      },
      pruneExpired(floor: number) {
        validateSpendTime(floor);
        // Never revive a pruned lifetime, including after wall-clock reversal.
        prunedThrough = Math.max(prunedThrough, floor);
        execute('pruneExpired', [floor]);
      },
      readStrictCounts(roomId: string, floor: number, at: number) {
        validateSpendWindow(roomId, floor, at);
        const before = observe();
        const start = native.generation;
        const row = execute('strictCounts', [roomId, floor, at]) as {
          global: number;
          room: number;
        };
        const after = observe();
        if (
          native.generation !== start ||
          before !== after ||
          !Number.isSafeInteger(row.global) ||
          !Number.isSafeInteger(row.room) ||
          row.global < 0 ||
          row.room < 0
        ) {
          throw new Error('Uncertain native spend count');
        }
        return { global: row.global, room: row.room };
      },
      overlapOfNativeReceipts(input, roomId, floor, at) {
        return overlap(input, roomId, floor, at);
      },
    });
    return {
      sqlite: native.sqlite,
      roomDocStorage: roomDoc.storage,
      nativeOrigin: roomDoc.nativeOrigin,
      serverNativeRoomConstruction: roomDoc.serverNativeRoomConstruction,
      serverNativeRelayConstruction: relayDoc.serverNativeRelayConstruction,
      wrap() {
        const db = roomDoc.wrap();
        relayDoc.bindOriginalWrappedDb(db);
        wrappedDb = db;
        const clientSlot = queryCustodyDescriptor(db, '$client');
        if (!clientSlot || !('value' in clientSlot) || clientSlot.value !== native.sqlite)
          throw new Error('Original server database client unavailable');
        originalServerQueryCustody.set(db, () => {
          const current = queryCustodyDescriptor(db, '$client');
          if (!current) throw new Error('Original server database client replaced');
          const fields = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'];
          for (let index = 0; index < fields.length; index++) {
            const key = fields[index]!;
            if (
              queryCustodyDescriptor(current, key)?.value !==
              queryCustodyDescriptor(clientSlot, key)?.value
            )
              throw new Error('Original server database client replaced');
          }
          native.requireOriginalPublicQueryCustody();
        });
        ports.set(db, port);
        docBudgetPorts.set(
          db,
          Object.freeze<FixedRoomDocBudgetPersistence>({
            prepare: (input) =>
              roomDoc.storage.prepareAcceptedBarrier(roomDoc.nativeOrigin, db, input),
            commit: (barrier, input) =>
              roomDoc.storage.commitPreparedRoomDoc(roomDoc.nativeOrigin, db, barrier, input),
            release: (barrier) =>
              roomDoc.storage.releaseKnownPreparedBarrier(roomDoc.nativeOrigin, db, barrier),
            readCommittedFact: (commit) =>
              roomDoc.storage.readCommittedFact(roomDoc.nativeOrigin, db, commit),
            readRoomLimitData: (roomId) =>
              roomDoc.storage.readRoomLimitData(roomDoc.nativeOrigin, db, roomId),
          })
        );
        return db;
      },
    };
  } catch (error) {
    native.close();
    throw error;
  }
}
