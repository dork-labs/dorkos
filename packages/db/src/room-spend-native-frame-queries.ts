import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema/index.js';
import type { NativeCall, NativeEngine, Execution } from './room-spend-native-types.js';

export interface OriginalFrameQueryContext {
  requireRoomFrame: (identity: object) => unknown;
  requireRelayFrame: (identity: object) => unknown;
  requireOriginalQueryMethods: () => void;
  nativeRaw: Database.Statement['raw'];
  prepareNative: NativeEngine['prepare'];
  engine: NativeEngine;
  publicSelf: Database.Database;
  nativePrototype: Record<'run' | 'get' | 'all', NativeCall>;
  nativeCalls: Readonly<{
    run: Database.Statement['run'];
    get: Database.Statement['get'];
    all: Database.Statement['all'];
  }>;
  getExecution: () => Execution | undefined;
  setExecution: (value: Execution | undefined) => void;
  taint: () => void;
  invalidate: () => void;
}
import { requireOriginalFrameQueryOwner } from './room-spend-native.js';

/** Synchronous original frame query facade; original frame and execution custody stay in the owner. */
export function withOriginalFrameQueries<T>(
  ownerKey: object,
  identity: object,
  family: 'room' | 'relay',
  work: (queryDb: object) => T
): T {
  const context = requireOriginalFrameQueryOwner(ownerKey);
  const {
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
  } = context;
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
          family === 'relay' ? /^(select|insert|update|delete)\s/i : /^(select|insert|update)\s/i
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
          if (context.getExecution() || nativePrototype[method] !== nativeCalls[method]) {
            taint();
            throw new Error('Reentrant or replaced original Room query');
          }
          const call = nativeCalls[method] as NativeCall;
          const allowance = { statement: target, method: call, traces: 0 };
          context.setExecution(allowance);
          let failed = false;
          let first: unknown;
          let result: unknown;
          try {
            result = Reflect.apply(call, target, bindings);
          } catch (cause) {
            failed = true;
            first = cause;
          } finally {
            context.setExecution(undefined);
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
