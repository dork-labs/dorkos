import * as NativeData from './room-spend-native-data.js';
export type { RoomSpendNativeOperation } from './room-spend-native-data.js';
import {
  nativeOwnDescriptor,
  nativeOwnKeys,
  nativePrototypeOf,
  nativeMapGet,
  nativeApply,
  eachNativeMap,
  sameNativeDescriptor,
} from './room-native-original-intrinsics.js';
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
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema/index.js';
import { roomDocStatements, type RoomDocNativeOperation } from './room-doc-statements.js';

import type { ProtectedRoomNativeDatabase } from './room-spend-native-types.js';
export type {
  OriginalProtectedRoomDb,
  ProtectedRoomNativeDatabase,
} from './room-spend-native-types.js';
import {
  type OriginalPublicCustodyContext,
  captureOriginalPublicCustody,
} from './room-spend-native-custody.js';
import {
  type OriginalPublicProxyContext,
  createOriginalPublicProxy,
} from './room-spend-native-public-proxy.js';
import { captureOriginalQueryCustody } from './room-spend-native-query-custody.js';
import {
  type OriginalFrameQueryContext,
  withOriginalFrameQueries as executeOriginalFrameQueries,
} from './room-spend-native-frame-queries.js';

const custodyOwners = new WeakMap<object, OriginalPublicCustodyContext>();
const proxyOwners = new WeakMap<object, OriginalPublicProxyContext>();
const queryOwners = new WeakMap<object, Database.Database>();
const frameQueryOwners = new WeakMap<object, OriginalFrameQueryContext>();
const privateOwnerGet = WeakMap.prototype.get;
const privateOwnerSet = WeakMap.prototype.set;
const privateOwnerApply = Reflect.apply;
function requirePrivateOwner<T>(owners: WeakMap<object, T>, key: object): T {
  const context = privateOwnerApply(privateOwnerGet, owners, [key]) as T | undefined;
  if (!context) throw new Error('Original protected native owner required');
  return context;
}
/** No registration or construction key is exported. */
export function requireOriginalCustodyOwner(key: object): OriginalPublicCustodyContext {
  return requirePrivateOwner(custodyOwners, key);
}
/** Require the private construction key for the original protected native proxy context. */
export function requireOriginalProxyOwner(key: object): OriginalPublicProxyContext {
  return requirePrivateOwner(proxyOwners, key);
}
/** Require the private construction key for the original query-custody database. */
export function requireOriginalQueryCustodyOwner(key: object): Database.Database {
  return requirePrivateOwner(queryOwners, key);
}
/** Require the private construction key for the original native frame-query context. */
export function requireOriginalFrameQueryOwner(key: object): OriginalFrameQueryContext {
  return requirePrivateOwner(frameQueryOwners, key);
}

const constructions = new WeakMap<object, NativeData.ConstructionCustody>();
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

const { opaqueMethods, ordinaryMethods, nativeGetters, ownedOperations } =
  NativeData.createRoomSpendNativeData();

/** Only this constructor creates a bound ticket; no raw handle or callback is accepted. */
export function openProtectedRoomNativeDatabase(
  dbPath: string
): Readonly<ProtectedRoomNativeDatabase> {
  let generation = 0;
  let unknown = false;
  let execution: NativeData.Execution | undefined;
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
    const engine = Reflect.get(raw, nativeSymbol) as NativeData.NativeEngine;
    const prepareNative = engine.prepare;
    const originals = new Map<PropertyKey, unknown>();
    for (const key of [...ordinaryMethods, ...opaqueMethods]) {
      originals.set(key, Reflect.get(raw, key, raw));
    }
    const custodyOwnerKey = {},
      proxyOwnerKey = {},
      queryOwnerKey = {},
      frameQueryOwnerKey = {};
    privateOwnerApply(privateOwnerSet, custodyOwners, [
      custodyOwnerKey,
      {
        raw,
        engine,
        ordinaryMethods,
        opaqueMethods,
        nativeGetters,
        isUnknown: () => unknown,
        intrinsics: {
          nativeOwnDescriptor,
          nativeOwnKeys,
          nativePrototypeOf,
          nativeMapGet,
          nativeApply,
          eachNativeMap,
          sameNativeDescriptor,
        },
      } satisfies OriginalPublicCustodyContext,
    ]);
    const { captureNativeCustody, requireOriginalPublicQueryCustody } =
      captureOriginalPublicCustody(custodyOwnerKey);
    privateOwnerApply(privateOwnerSet, proxyOwners, [
      proxyOwnerKey,
      {
        raw,
        engine,
        nativeSymbol,
        prepareNative,
        originals,
        opaqueMethods,
        nativeGetters,
        invalidate,
        taint,
        getInternalSymbolRead: () => internalSymbolRead,
        setInternalSymbolRead: (value: boolean) => {
          internalSymbolRead = value;
        },
      } satisfies OriginalPublicProxyContext,
    ]);
    publicSelf = createOriginalPublicProxy(proxyOwnerKey);
    // Capture native execution before any statement/reference reaches public consumers.
    const probe = Reflect.apply(prepareNative, engine, [
      'SELECT 1',
      publicSelf,
      false,
    ]) as Database.Statement;
    captureNativeCustody(probe);
    const nativeCalls = Object.freeze({ run: probe.run, get: probe.get, all: probe.all });
    const nativeRaw = probe.raw;
    const nativePrototype = Object.getPrototypeOf(probe) as NativeData.NativeMethodRecord;
    const statement = NativeData.createFixedStatementReader(prepareNative, engine, publicSelf);
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
      const call = nativeCalls[method] as NativeData.NativeCall;
      const frame = { statement: target, method: call, traces: 0 };
      execution = frame;
      try {
        return Reflect.apply(call, target, Array.isArray(args) ? args : [args]);
      } finally {
        execution = undefined;
        if (frame.traces !== 1) invalidate();
      }
    }
    function execute(
      operation: NativeData.RoomSpendNativeOperation,
      args: readonly unknown[] = []
    ) {
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
    privateOwnerApply(privateOwnerSet, queryOwners, [queryOwnerKey, publicSelf]);
    const requireOriginalQueryMethods = captureOriginalQueryCustody(queryOwnerKey);
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
    privateOwnerApply(privateOwnerSet, frameQueryOwners, [
      frameQueryOwnerKey,
      {
        requireRoomFrame,
        requireRelayFrame,
        requireOriginalQueryMethods,
        nativeRaw,
        prepareNative,
        engine,
        publicSelf,
        nativePrototype,
        nativeCalls,
        taint,
        invalidate,
        getExecution: () => execution,
        setExecution: (value: NativeData.Execution | undefined) => {
          execution = value;
        },
      } satisfies OriginalFrameQueryContext,
    ]);
    function withOriginalFrameQueries<T>(
      identity: object,
      family: 'room' | 'relay',
      work: (queryDb: object) => T
    ): T {
      return executeOriginalFrameQueries(frameQueryOwnerKey, identity, family, work);
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
    const custody = NativeData.createConstructionCustody();
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
        return NativeData.projectRoomLimitData(row);
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
