const nativeOwnDescriptor = Object.getOwnPropertyDescriptor;
const nativeOwnKeys = Reflect.ownKeys;
const nativePrototypeOf = Object.getPrototypeOf;
const nativeMapEntries = Map.prototype.entries;
const nativeMapGet = Map.prototype.get;
const nativeMapNext = nativePrototypeOf(new Map().entries()).next;
const nativeApply = Reflect.apply;
function eachNativeMap<K, V>(map: Map<K, V>, visit: (key: K, value: V) => void): void {
  const iterator = nativeApply(nativeMapEntries, map, []);
  for (;;) {
    const step = nativeApply(nativeMapNext, iterator, []) as IteratorResult<[K, V]>;
    if (step.done) return;
    visit(step.value[0], step.value[1]);
  }
}
function sameNativeDescriptor(
  before: PropertyDescriptor | undefined,
  current: PropertyDescriptor | undefined,
  nativeTransactionStatus = false
): boolean {
  if (!before || !current) return before === current;
  if (
    nativeTransactionStatus &&
    (typeof nativeOwnDescriptor(before, 'value')?.value !== 'boolean' ||
      typeof nativeOwnDescriptor(current, 'value')?.value !== 'boolean')
  )
    return false;
  const fields = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'];
  for (let index = 0; index < fields.length; index++) {
    const key = fields[index]!;
    if (nativeTransactionStatus && key === 'value') continue;
    if (nativeOwnDescriptor(before, key)?.value !== nativeOwnDescriptor(current, key)?.value)
      return false;
  }
  return true;
}
/** Private construction-owned protected native boundary; never root-exported. */
import Database from 'better-sqlite3';
import {
  relayDocStatements,
  copyRelayDocStatementBindings,
  type RelayDocNativeOperation,
} from './relay-doc-statements.js';
import { randomUUID } from 'node:crypto';
import {
  copyRoomDocStatementBindings,
  type RoomDocNativeFrameState as RoomFrame,
} from './room-doc-data.js';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sql, getTableColumns } from 'drizzle-orm';
import * as schema from './schema/index.js';
import { roomDocStatements, type RoomDocNativeOperation } from './room-doc-statements.js';

type ConstructionCustody = {
  wrappedDb?: object;
  relayConsumed: boolean;
  consumed: boolean;
  exposed: boolean;
  wrapped: boolean;
};
const constructions = new WeakMap<object, ConstructionCustody>();
/** Internal one-shot issuer consumption; no supplied engine can acquire custody. */
export function consumeRoomNativeConstruction(ticket: object): void {
  const custody = constructions.get(ticket);
  if (!custody || custody.consumed || custody.exposed || custody.wrapped)
    throw new Error('Unavailable native construction custody');
  custody.consumed = true;
}

/** Distinct sibling issuer, consumed before either Db/native handle is exposed. */
export function consumeRelayNativeConstruction(ticket: object): void {
  const own = constructions.get(ticket);
  if (!own || own.relayConsumed || own.exposed || own.wrapped)
    throw new Error('Unavailable original Relay native construction');
  own.relayConsumed = true;
}

/** Fixed exact wrapped Db recognition for the distinct construction sibling. */
export function requireRelayNativeDatabase(ticket: object, db: object): void {
  const own = constructions.get(ticket);
  if (!own || !own.relayConsumed || !own.wrapped || own.wrappedDb !== db)
    throw new Error('Original Relay SAME native database required');
}

type NativeCall = (...args: unknown[]) => unknown;
type NativeEngine = {
  prepare(sql: string, self: Database.Database, pragma: boolean): Database.Statement;
};
type Execution = { statement: Database.Statement; method: NativeCall; traces: number };
const opaqueMethods = new Set([
  'function',
  'aggregate',
  'table',
  'loadExtension',
  'unsafeMode',
  'defaultSafeIntegers',
  'backup',
]);
const ordinaryMethods = new Set(['prepare', 'transaction', 'pragma', 'exec', 'close', 'serialize']);
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
export type RoomSpendNativeOperation = keyof typeof ownedOperations;

/** Named internal Db shape preserves the exact schema and original native client type. */
export type OriginalProtectedRoomDb = BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
};
/** Original constructor-owned ticket; its named return does not mint or expose new custody. */
export interface ProtectedRoomNativeDatabase {
  readonly sqlite: Database.Database;
  readonly generation: number;
  readonly unknown: boolean;
  readonly open: boolean;
  readonly inTransaction: boolean;
  readonly roomEpoch: string;
  invalidate(): void;
  execute(operation: RoomSpendNativeOperation, args?: readonly unknown[]): unknown;
  executeDoc(operation: RoomDocNativeOperation, args?: Readonly<Record<string, unknown>>): unknown;
  readRoomLimitData(roomId: string): Readonly<{
    turnLimitsEnabled: boolean | null;
    maxAgentDepth: number | null;
    maxTurnsPerAgentPerCascade: number | null;
    maxAutoTurnsPerHour: number | null;
  }> | null;
  requireOriginalPublicQueryCustody(): void;
  beginRelayFrame(): Readonly<object>;
  requireRelayFrame(identity: object): RoomFrame & { family: 'room' | 'relay' };
  executeRelayFrame(
    identity: object,
    operation: Exclude<RelayDocNativeOperation, 'begin' | 'commit' | 'rollback'>,
    args?: Readonly<Record<string, unknown>>
  ): unknown;
  commitRelayFrame(identity: object): void;
  rollbackRelayFrame(identity: object): boolean;
  committedRelayFrame(identity: object): boolean;
  withRelayFrameQueries<T>(identity: object, work: (queryDb: object) => T): T;
  requireRelayFramesClosed(): void;
  beginRoomFrame(): Readonly<object>;
  withRoomFrameQueries<T>(identity: object, work: (queryDb: object) => T): T;
  requireRoomFrame(identity: object): RoomFrame & { family: 'room' | 'relay' };
  commitRoomFrame(identity: object): void;
  rollbackRoomFrame(identity: object): boolean;
  committedRoomFrame(identity: object): boolean;
  close(): void;
  wrap(): OriginalProtectedRoomDb;
}

/** Only this constructor creates a bound ticket; no raw handle or callback is accepted. */
export function openProtectedRoomNativeDatabase(
  dbPath: string
): Readonly<ProtectedRoomNativeDatabase> {
  let generation = 0;
  let unknown = false;
  let execution: Execution | undefined;
  let internalSymbolRead = false;
  const invalidate = () => {
    generation += 1;
  };
  const taint = () => {
    unknown = true;
    invalidate();
  };
  // No SQL text, logging, callbacks, native getters or mutable registration in this observer.
  const raw = new Database(dbPath, {
    verbose: () => {
      if (!execution || ++execution.traces !== 1) invalidate();
    },
  });
  let publicSelf: Database.Database;
  try {
    const symbols = Object.getOwnPropertySymbols(raw);
    if (symbols.length !== 1) throw new Error('Unsupported native database layout');
    const nativeSymbol = symbols[0];
    if (typeof nativeSymbol !== 'symbol') throw new Error('Unsupported native database identity');
    const engine = Reflect.get(raw, nativeSymbol) as NativeEngine;
    const prepareNative = engine.prepare;
    const originals = new Map<PropertyKey, unknown>();
    for (const key of [...ordinaryMethods, ...opaqueMethods]) {
      originals.set(key, Reflect.get(raw, key, raw));
    }
    // Capture native public method slots before wrapping/public exposure. A lazy
    // original child cannot accept a replacement as its constructor baseline.
    const publicMethodOwnSlots = new Map<PropertyKey, PropertyDescriptor | undefined>();
    for (const key of [...ordinaryMethods, ...opaqueMethods, ...nativeGetters])
      publicMethodOwnSlots.set(key, Object.getOwnPropertyDescriptor(raw, key));
    const nativeCustodyDescriptors = new Map<object, Map<PropertyKey, PropertyDescriptor>>();
    const nativeCustodyParents = new Map<object, object | null>();
    const nativeCustodyRoots = new Map<
      object,
      { parent: object | null; slots: Map<PropertyKey, PropertyDescriptor | undefined> }
    >();
    const captureNativeCustody = (value: object) => {
      const parent = nativePrototypeOf(value);
      const slots = new Map<PropertyKey, PropertyDescriptor | undefined>();
      for (const key of ['prepare', 'open', 'inTransaction', 'run', 'get', 'all', 'raw'])
        slots.set(key, nativeOwnDescriptor(value, key));
      nativeCustodyRoots.set(value, { parent, slots });
      let prototype = parent;
      while (prototype && prototype !== Object.prototype) {
        if (!nativeCustodyDescriptors.has(prototype)) {
          nativeCustodyDescriptors.set(
            prototype,
            new Map(
              Reflect.ownKeys(prototype).map((key) => [
                key,
                Object.getOwnPropertyDescriptor(prototype, key)!,
              ])
            )
          );
          nativeCustodyParents.set(prototype, Object.getPrototypeOf(prototype));
        }
        prototype = Object.getPrototypeOf(prototype);
      }
    };
    captureNativeCustody(raw);
    captureNativeCustody(engine);
    function requireOriginalPublicQueryCustody() {
      if (unknown) throw new Error('Original native database custody unavailable');
      eachNativeMap(nativeCustodyRoots, (root, before) => {
        if (nativePrototypeOf(root) !== before.parent)
          throw new Error('Original native database handle ancestry changed');
        eachNativeMap(before.slots, (key, descriptor) => {
          // BetterSQLite's private cpp handle exposes inTransaction as a V8
          // native data property: its boolean value changes on real BEGIN/END.
          // Only that exact private status value may change; descriptor shape,
          // raw JS getters, method identities and sticky public tamper refusal stay fixed.
          if (
            !sameNativeDescriptor(
              descriptor,
              nativeOwnDescriptor(root, key),
              root === engine && key === 'inTransaction'
            )
          )
            throw new Error('Original native database handle slot changed');
        });
      });
      eachNativeMap(publicMethodOwnSlots, (key, before) => {
        if (!sameNativeDescriptor(before, nativeOwnDescriptor(raw, key)))
          throw new Error('Original native database method shadowed');
      });
      eachNativeMap(nativeCustodyDescriptors, (prototype, slots) => {
        if (
          nativePrototypeOf(prototype) !==
            nativeApply(nativeMapGet, nativeCustodyParents, [prototype]) ||
          nativeOwnKeys(prototype).length !== slots.size
        )
          throw new Error('Original native database method ancestry changed');
        eachNativeMap(slots, (key, before) => {
          if (!sameNativeDescriptor(before, nativeOwnDescriptor(prototype, key)))
            throw new Error('Original native database class changed');
        });
      });
      if (!raw.open) throw new Error('Original native database custody unavailable');
    }
    const wrappers = new Map<PropertyKey, { method: unknown; wrapped: NativeCall }>();
    const statementWrappers = new WeakMap<Database.Statement, Database.Statement>();
    function protectStatement(statement: Database.Statement): Database.Statement {
      const prior = statementWrappers.get(statement);
      if (prior) return prior;
      const methods = new Map<PropertyKey, { method: unknown; wrapped: NativeCall }>();
      const proxy: Database.Statement = new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key, proxy);
          if (typeof value !== 'function' || key === 'constructor') return value;
          const cached = methods.get(key);
          if (cached && cached.method === value) return cached.wrapped;
          const wrapped: NativeCall = function (this: unknown, ...args: unknown[]) {
            if (this !== proxy) {
              taint();
              return Reflect.apply(value, this, args);
            }
            // Even read-only SQL can invoke callbacks. Public executions never qualify K.
            if (key === 'iterate') taint();
            else invalidate();
            const result = Reflect.apply(value, target, args);
            return result === target ? proxy : result;
          };
          methods.set(key, { method: value, wrapped });
          return wrapped;
        },
        set(target, key, value) {
          taint();
          return Reflect.set(target, key, value, target);
        },
        defineProperty(target, key, descriptor) {
          taint();
          return Reflect.defineProperty(target, key, descriptor);
        },
        deleteProperty(target, key) {
          taint();
          return Reflect.deleteProperty(target, key);
        },
        setPrototypeOf(target, prototype) {
          taint();
          return Reflect.setPrototypeOf(target, prototype);
        },
      });
      statementWrappers.set(statement, proxy);
      return proxy;
    }
    publicSelf = new Proxy(raw, {
      get(target, key) {
        if (key === nativeSymbol && !internalSymbolRead) taint();
        if (typeof key === 'symbol') return Reflect.get(target, key, target);
        if (nativeGetters.has(key)) return Reflect.get(target, key, target);
        if (key === 'constructor') return Reflect.get(target, key, publicSelf);
        const value = Reflect.get(target, key, publicSelf);
        if (typeof value !== 'function') return value;
        // Method replacement is compatible, but permanently loses witness availability.
        if (!originals.has(key) || value !== originals.get(key)) {
          taint();
          return value;
        }
        const cached = wrappers.get(key);
        if (cached && cached.method === value) return cached.wrapped;
        const wrapped: NativeCall = function (this: unknown, ...args: unknown[]) {
          if (this !== publicSelf) {
            taint();
            return Reflect.apply(value, this, args);
          }
          if (opaqueMethods.has(key)) taint();
          if (key === 'prepare') {
            return protectStatement(
              Reflect.apply(prepareNative, engine, [args[0], publicSelf, false])
            );
          }
          invalidate();
          if (key === 'transaction') {
            // The driver's constructor reads cppdb once and freezes database=publicSelf.
            // It does not invoke the supplied transaction callback here. Execution later
            // has no allowance, and its native BEGIN/COMMIT/ROLLBACK trace is unowned.
            internalSymbolRead = true;
            try {
              return Reflect.apply(value, publicSelf, args);
            } finally {
              internalSymbolRead = false;
            }
          }
          const result = Reflect.apply(value, target, args);
          return result === target ? publicSelf : result;
        };
        wrappers.set(key, { method: value, wrapped });
        return wrapped;
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === nativeSymbol) taint();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      set(target, key, value) {
        taint();
        return Reflect.set(target, key, value, target);
      },
      defineProperty(target, key, descriptor) {
        taint();
        return Reflect.defineProperty(target, key, descriptor);
      },
      deleteProperty(target, key) {
        taint();
        return Reflect.deleteProperty(target, key);
      },
      setPrototypeOf(target, prototype) {
        taint();
        return Reflect.setPrototypeOf(target, prototype);
      },
    });
    // Capture native execution before any statement/reference reaches public consumers.
    const probe = Reflect.apply(prepareNative, engine, [
      'SELECT 1',
      publicSelf,
      false,
    ]) as Database.Statement;
    captureNativeCustody(probe);
    const nativeCalls = Object.freeze({ run: probe.run, get: probe.get, all: probe.all });
    const nativeRaw = probe.raw;
    const nativePrototype = Object.getPrototypeOf(probe) as Record<
      'run' | 'get' | 'all',
      NativeCall
    >;
    const fixed = new Map<string, Database.Statement>();
    function statement(sql: string): Database.Statement {
      let result = fixed.get(sql);
      if (!result) {
        result = Reflect.apply(prepareNative, engine, [
          sql,
          publicSelf,
          false,
        ]) as Database.Statement;
        fixed.set(sql, result);
      }
      return result;
    }
    function executeFixed(
      definition: { sql: string; method: 'run' | 'get' | 'all' },
      args: readonly unknown[] | Readonly<Record<string, unknown>>
    ) {
      const { sql, method } = definition;
      if (execution) {
        taint();
        throw new Error('Reentrant native spend operation');
      }
      const target = statement(sql);
      if (nativePrototype[method] !== nativeCalls[method]) taint();
      const call = nativeCalls[method] as NativeCall;
      const frame = { statement: target, method: call, traces: 0 };
      execution = frame;
      try {
        return Reflect.apply(call, target, Array.isArray(args) ? args : [args]);
      } finally {
        execution = undefined;
        if (frame.traces !== 1) invalidate();
      }
    }
    function execute(operation: RoomSpendNativeOperation, args: readonly unknown[] = []) {
      if (!Object.hasOwn(ownedOperations, operation))
        throw new Error('Unknown native spend operation');
      return executeFixed(ownedOperations[operation], args);
    }
    function executeDoc(
      operation: RoomDocNativeOperation,
      args: Readonly<Record<string, unknown>> = {}
    ) {
      if (!Object.hasOwn(roomDocStatements, operation))
        throw new Error('Unknown private Room operation');
      const definition = roomDocStatements[operation];
      // Bound slots are copied primitive data, never getters/SQL/currentness callbacks.
      return executeFixed(definition, copyRoomDocStatementBindings(definition.sql, args));
    }
    function executeRelay(
      operation: RelayDocNativeOperation,
      args: Readonly<Record<string, unknown>> = {}
    ) {
      if (!Object.hasOwn(relayDocStatements, operation))
        throw new Error('Unknown private Relay operation');
      const definition = relayDocStatements[operation];
      return executeFixed(definition, copyRelayDocStatementBindings(definition.sql, args));
    }
    // Capture the actual query-class method descriptors before any public Drizzle wrapper exists.
    // Building these queries does not execute SQL or depend on migrated canvas tables.
    const originalQueryMethods = new Map<object, Map<PropertyKey, PropertyDescriptor>>();
    const originalQueryParents = new Map<object, object | null>();
    const captureQueryMethods = (value: object) => {
      let prototype = Object.getPrototypeOf(value);
      while (prototype && prototype !== Object.prototype) {
        if (!originalQueryMethods.has(prototype)) {
          const slots = new Map<PropertyKey, PropertyDescriptor>();
          for (const key of Reflect.ownKeys(prototype))
            slots.set(key, Object.getOwnPropertyDescriptor(prototype, key)!);
          originalQueryMethods.set(prototype, slots);
          originalQueryParents.set(prototype, Object.getPrototypeOf(prototype));
        }
        prototype = Object.getPrototypeOf(prototype);
      }
    };
    const originalQueryDb = drizzle(publicSelf, { schema });
    const scalar = sql`1`;
    const selectBuilder = originalQueryDb.select({ value: scalar });
    const selectQuery = selectBuilder.from(sql`(select 1)`);
    const selectPrepared = selectQuery.prepare();
    const updateBuilder = originalQueryDb.update(schema.canvasDocChannels);
    const updateQuery = updateBuilder.set({ nextDocSeq: 0 });
    const insertBuilder = originalQueryDb.insert(schema.canvasDocEvents);
    const insertQuery = insertBuilder.values({
      documentId: '',
    } as typeof schema.canvasDocEvents.$inferInsert);
    for (const value of [
      originalQueryDb,
      scalar,
      selectBuilder,
      selectQuery,
      selectPrepared,
      updateBuilder,
      updateQuery,
      insertBuilder,
      insertQuery,
    ])
      captureQueryMethods(value);
    // Session and dialect participate in statement preparation and result decoding.
    for (const object of [originalQueryDb, selectPrepared]) {
      for (const key of ['session', 'dialect', '_']) {
        const slot = Object.getOwnPropertyDescriptor(object, key);
        if (slot && 'value' in slot && slot.value && typeof slot.value === 'object') {
          captureQueryMethods(slot.value);
          const session = Object.getOwnPropertyDescriptor(slot.value, 'session');
          if (session && 'value' in session && session.value) captureQueryMethods(session.value);
        }
      }
    }
    const originalCodecSlots = new Map<object, Map<PropertyKey, PropertyDescriptor | undefined>>();
    const originalCodecParents = new Map<object, object | null>();
    const captureCodec = (codec: object) => {
      captureQueryMethods(codec);
      const slots = new Map<PropertyKey, PropertyDescriptor | undefined>();
      for (const key of ['mapFromDriverValue', 'mapToDriverValue'])
        slots.set(key, Object.getOwnPropertyDescriptor(codec, key));
      originalCodecSlots.set(codec, slots);
      originalCodecParents.set(codec, Object.getPrototypeOf(codec));
    };
    // These exact fields decode every finite original sender store read and encode its writes.
    for (const table of [
      schema.canvasDocChannels,
      schema.canvasDocEvents,
      schema.canvasDocDeliveries,
      schema.canvasDocBatches,
    ]) {
      for (const column of Object.values(getTableColumns(table))) captureCodec(column);
    }
    const scalarDecoder = Object.getOwnPropertyDescriptor(scalar, 'decoder');
    if (!scalarDecoder || !('value' in scalarDecoder) || !scalarDecoder.value)
      throw new Error('Original scalar decoder unavailable');
    captureCodec(scalarDecoder.value);
    // The four queried table graphs are module-owned SQL metadata. Retain exact
    // data descriptors too: a replaced column map/name can suppress or redirect
    // reads without changing a query method or its decoder identity.
    const originalMetadata = new Map<object, Map<PropertyKey, PropertyDescriptor>>();
    const originalMetadataParents = new Map<object, object | null>();
    const captureMetadata = (value: object) => {
      if (originalMetadata.has(value)) return;
      if (originalMetadata.size >= 4096) throw new Error('Original Room metadata frontier');
      const keys = Reflect.ownKeys(value);
      if (keys.length > 4096) throw new Error('Original Room metadata slot frontier');
      const slots = new Map<PropertyKey, PropertyDescriptor>();
      originalMetadata.set(value, slots);
      originalMetadataParents.set(value, Object.getPrototypeOf(value));
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        slots.set(key, descriptor);
        // Do not invoke getters or traverse function closures/prototypes.
        if ('value' in descriptor && descriptor.value && typeof descriptor.value === 'object')
          captureMetadata(descriptor.value);
      }
    };
    for (const table of [
      schema.canvasDocChannels,
      schema.canvasDocEvents,
      schema.canvasDocDeliveries,
      schema.canvasDocBatches,
    ])
      captureMetadata(table);
    function requireOriginalQueryMethods() {
      for (const [metadata, slots] of originalMetadata) {
        if (
          Object.getPrototypeOf(metadata) !== originalMetadataParents.get(metadata) ||
          Reflect.ownKeys(metadata).length !== slots.size
        )
          throw new Error('Original Room SQL metadata changed');
        for (const [key, before] of slots) {
          const current = Object.getOwnPropertyDescriptor(metadata, key);
          if (
            !current ||
            current.value !== before.value ||
            current.get !== before.get ||
            current.set !== before.set ||
            current.writable !== before.writable ||
            current.configurable !== before.configurable ||
            current.enumerable !== before.enumerable
          )
            throw new Error('Original Room SQL metadata descriptor changed');
        }
      }
      for (const [codec, slots] of originalCodecSlots) {
        if (Object.getPrototypeOf(codec) !== originalCodecParents.get(codec))
          throw new Error('Original Room field codec ancestry changed');
        for (const [key, before] of slots) {
          const current = Object.getOwnPropertyDescriptor(codec, key);
          if (!before && !current) continue;
          if (
            !before ||
            !current ||
            current.value !== before.value ||
            current.get !== before.get ||
            current.set !== before.set ||
            current.writable !== before.writable ||
            current.configurable !== before.configurable ||
            current.enumerable !== before.enumerable
          )
            throw new Error('Original Room field codec changed');
        }
      }
      for (const [prototype, slots] of originalQueryMethods) {
        if (Object.getPrototypeOf(prototype) !== originalQueryParents.get(prototype))
          throw new Error('Original Room query class ancestry changed');
        const keys = Reflect.ownKeys(prototype);
        if (keys.length !== slots.size) throw new Error('Original Room query class changed');
        for (const [key, before] of slots) {
          const current = Object.getOwnPropertyDescriptor(prototype, key);
          if (
            !current ||
            current.value !== before.value ||
            current.get !== before.get ||
            current.set !== before.set ||
            current.writable !== before.writable ||
            current.configurable !== before.configurable ||
            current.enumerable !== before.enumerable
          )
            throw new Error('Original Room query method changed');
        }
      }
    }
    const roomEpoch = randomUUID();

    type OriginalFrame = RoomFrame & { family: 'room' | 'relay' };
    let roomFrame: OriginalFrame | undefined;
    const roomFrames = new WeakMap<object, OriginalFrame>();
    const relayFrames = new WeakMap<object, OriginalFrame>();
    function requireRoomFrame(identity: object) {
      const frame = roomFrames.get(identity);
      if (
        !frame ||
        frame.family !== 'room' ||
        frame !== roomFrame ||
        frame.state !== 'open' ||
        unknown ||
        !raw.open ||
        !raw.inTransaction ||
        frame.generation !== generation
      )
        throw new Error('Lost native Room frame');
      return frame;
    }
    /** A fresh query facade exists only on the original frame's synchronous stack.
     * It never exposes the raw SQLite handle, transaction control or public execution allowance.
     */
    function withRoomFrameQueries<T>(identity: object, work: (queryDb: object) => T): T {
      return withOriginalFrameQueries(identity, 'room', work);
    }
    function withRelayFrameQueries<T>(identity: object, work: (queryDb: object) => T): T {
      return withOriginalFrameQueries(identity, 'relay', work);
    }
    // The family is selected only by these two original fixed wrappers, never a caller argument.
    function withOriginalFrameQueries<T>(
      identity: object,
      family: 'room' | 'relay',
      work: (queryDb: object) => T
    ): T {
      const requireFrame = () =>
        family === 'room' ? requireRoomFrame(identity) : requireRelayFrame(identity);
      requireFrame();
      requireOriginalQueryMethods();
      let active = true;
      const requireQuery = () => {
        if (!active) throw new Error('Original Room query facade retired');
        requireOriginalQueryMethods();
        requireFrame();
      };
      const rawCall = nativeRaw;
      const requireBindings = (args: unknown[]) => {
        const primitive = (value: unknown) =>
          value === null ||
          typeof value === 'string' ||
          typeof value === 'bigint' ||
          (typeof value === 'number' && Number.isFinite(value));
        return args.map((value) => {
          if (primitive(value)) return value;
          if (
            !Array.isArray(value) ||
            Object.getPrototypeOf(value) !== Array.prototype ||
            value.length > 10000
          )
            throw new Error('Non-data original Room query binding');
          const copy: unknown[] = [];
          for (let index = 0; index < value.length; index++) {
            const property = Object.getOwnPropertyDescriptor(value, String(index));
            if (!property || !('value' in property) || !primitive(property.value))
              throw new Error('Non-data original Room query binding');
            copy.push(property.value);
          }
          return copy;
        });
      };
      const client = Object.freeze({
        prepare(sql: string) {
          requireQuery();
          if (
            typeof sql !== 'string' ||
            sql.length > 1048576 ||
            !(
              family === 'relay'
                ? /^(select|insert|update|delete)\s/i
                : /^(select|insert|update)\s/i
            ).test(sql.trim())
          )
            throw new Error('Unsupported original Room query');
          const target = Reflect.apply(prepareNative, engine, [
            sql,
            publicSelf,
            false,
          ]) as Database.Statement;
          const query: Record<string, unknown> = Object.create(null);
          for (const method of ['run', 'get', 'all'] as const) {
            query[method] = (...args: unknown[]) => {
              requireQuery();
              const bindings = requireBindings(args);
              if (execution || nativePrototype[method] !== nativeCalls[method]) {
                taint();
                throw new Error('Reentrant or replaced original Room query');
              }
              const call = nativeCalls[method] as NativeCall;
              const allowance = { statement: target, method: call, traces: 0 };
              execution = allowance;
              let failed = false;
              let first: unknown;
              let result: unknown;
              try {
                result = Reflect.apply(call, target, bindings);
              } catch (cause) {
                failed = true;
                first = cause;
              } finally {
                execution = undefined;
                if (allowance.traces !== 1) invalidate();
                try {
                  requireQuery();
                } catch (cause) {
                  if (!failed) {
                    failed = true;
                    first = cause;
                  }
                }
              }
              if (failed) throw first;
              return result;
            };
          }
          query.raw = (enabled = true) => {
            requireQuery();
            if (typeof enabled !== 'boolean' || Object.getPrototypeOf(target).raw !== rawCall) {
              taint();
              throw new Error('Replaced original Room row-format method');
            }
            Reflect.apply(rawCall, target, [enabled]);
            return query;
          };
          return Object.freeze(query);
        },
      });
      try {
        const queryDb = drizzle(client as unknown as Database.Database, { schema });
        const result = work(queryDb);
        if (
          result &&
          (typeof result === 'object' || typeof result === 'function') &&
          'then' in result
        ) {
          void Promise.resolve(result).catch(() => {});
          throw new Error('Original Room queries must remain synchronous');
        }
        requireQuery();
        return result;
      } finally {
        active = false;
      }
    }
    function beginRoomFrame() {
      if (roomFrame || unknown || !raw.open || raw.inTransaction)
        throw new Error('Native Room frame unavailable');
      const identity = Object.freeze({}),
        frame: OriginalFrame = { generation, state: 'open', family: 'room' };
      roomFrame = frame;
      roomFrames.set(identity, frame);
      try {
        executeDoc('begin');
        requireRoomFrame(identity);
        return identity;
      } catch (error) {
        frame.state = 'unknown';
        throw error;
      }
    }
    function commitRoomFrame(identity: object) {
      const frame = requireRoomFrame(identity);
      frame.state = 'committing';
      try {
        executeDoc('commit');
        if (unknown || !raw.open || raw.inTransaction || generation !== frame.generation)
          throw new Error('Uncertain native Room COMMIT');
        frame.state = 'committed';
        roomFrame = undefined;
      } catch (error) {
        frame.state = 'unknown';
        throw error;
      }
    }
    function rollbackRoomFrame(identity: object): boolean {
      try {
        const frame = requireRoomFrame(identity);
        executeDoc('rollback');
        if (unknown || !raw.open || raw.inTransaction || generation !== frame.generation)
          return false;
        frame.state = 'rolled_back';
        roomFrame = undefined;
        return true;
      } catch {
        return false;
      }
    }
    function committedRoomFrame(identity: object): boolean {
      const frame = roomFrames.get(identity);
      return (
        frame?.family === 'room' &&
        frame.state === 'committed' &&
        frame.generation === generation &&
        !unknown &&
        raw.open &&
        !raw.inTransaction
      );
    }
    // Separate identity maps/family gates share only the original physical native arbiter.
    function requireRelayFrame(identity: object) {
      const frame = relayFrames.get(identity);
      if (
        !frame ||
        frame.family !== 'relay' ||
        frame !== roomFrame ||
        frame.state !== 'open' ||
        unknown ||
        !raw.open ||
        !raw.inTransaction ||
        frame.generation !== generation
      )
        throw new Error('Lost original native Relay frame');
      return frame;
    }
    function beginRelayFrame() {
      if (roomFrame || unknown || !raw.open || raw.inTransaction)
        throw new Error('Native Relay frame unavailable');
      const identity = Object.freeze({});
      const frame: OriginalFrame = { generation, state: 'open', family: 'relay' };
      roomFrame = frame;
      relayFrames.set(identity, frame);
      try {
        executeRelay('begin');
        requireRelayFrame(identity);
        return identity;
      } catch (cause) {
        frame.state = 'unknown';
        throw cause;
      }
    }
    function executeRelayFrame(
      identity: object,
      operation: Exclude<RelayDocNativeOperation, 'begin' | 'commit' | 'rollback'>,
      args: Readonly<Record<string, unknown>> = {}
    ) {
      requireRelayFrame(identity);
      requireOriginalQueryMethods();
      if (['begin', 'commit', 'rollback'].includes(operation))
        throw new Error('Relay statement cannot control frame');
      let failed = false;
      let first: unknown;
      let result: unknown;
      try {
        result = executeRelay(operation, args);
      } catch (cause) {
        failed = true;
        first = cause;
      }
      try {
        requireRelayFrame(identity);
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      if (failed) throw first;
      return result;
    }
    function commitRelayFrame(identity: object) {
      const frame = requireRelayFrame(identity);
      frame.state = 'committing';
      try {
        executeRelay('commit');
        if (unknown || !raw.open || raw.inTransaction || generation !== frame.generation)
          throw new Error('Uncertain original Relay COMMIT');
        frame.state = 'committed';
        roomFrame = undefined;
      } catch (cause) {
        frame.state = 'unknown';
        throw cause;
      }
    }
    function rollbackRelayFrame(identity: object): boolean {
      try {
        const frame = requireRelayFrame(identity);
        executeRelay('rollback');
        if (unknown || !raw.open || raw.inTransaction || generation !== frame.generation)
          return false;
        frame.state = 'rolled_back';
        roomFrame = undefined;
        return true;
      } catch {
        return false;
      }
    }
    function committedRelayFrame(identity: object): boolean {
      const frame = relayFrames.get(identity);
      return (
        frame?.family === 'relay' &&
        frame.state === 'committed' &&
        frame.generation === generation &&
        !unknown &&
        raw.open &&
        !raw.inTransaction
      );
    }
    const custody: ConstructionCustody = {
      relayConsumed: false,
      consumed: false,
      exposed: false,
      wrapped: false,
    };
    const ticket = Object.freeze({
      get sqlite() {
        custody.exposed = true;
        return publicSelf;
      },
      get generation() {
        return generation;
      },
      get unknown() {
        return unknown;
      },
      get open() {
        return raw.open;
      },
      get inTransaction() {
        return raw.inTransaction;
      },
      invalidate,
      execute,
      executeDoc,
      roomEpoch,
      readRoomLimitData(roomId: string) {
        if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > 4096)
          throw new Error('Invalid Room limit identity');
        const row = executeDoc('room-limit-data', { roomId }) as
          Record<string, unknown> | undefined;
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
      },
      requireOriginalPublicQueryCustody,
      beginRelayFrame,
      requireRelayFrame,
      executeRelayFrame,
      commitRelayFrame,
      rollbackRelayFrame,
      committedRelayFrame,
      withRelayFrameQueries,
      requireRelayFramesClosed() {
        if (roomFrame || unknown || !raw.open || raw.inTransaction)
          throw new Error('Original native Relay frame closure UNKNOWN');
        requireOriginalQueryMethods();
      },
      beginRoomFrame,
      withRoomFrameQueries,
      requireRoomFrame,
      commitRoomFrame,
      rollbackRoomFrame,
      committedRoomFrame,
      close() {
        raw.close();
      },
      wrap() {
        if (custody.wrapped) throw new Error('Database construction already completed');
        custody.wrapped = true;
        const db = drizzle(publicSelf, { schema });
        custody.wrappedDb = db;
        return db;
      },
    });
    constructions.set(ticket, custody);
    return ticket;
  } catch (error) {
    raw.close();
    throw error;
  }
}
