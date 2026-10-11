import type Database from 'better-sqlite3';
import type { NativeCall, NativeEngine } from './room-spend-native-types.js';

import { requireOriginalProxyOwner } from './room-spend-native.js';
export interface OriginalPublicProxyContext {
  raw: Database.Database;
  engine: NativeEngine;
  nativeSymbol: symbol;
  prepareNative: NativeEngine['prepare'];
  originals: ReadonlyMap<PropertyKey, unknown>;
  opaqueMethods: ReadonlySet<string>;
  nativeGetters: ReadonlySet<string>;
  invalidate: () => void;
  taint: () => void;
  getInternalSymbolRead: () => boolean;
  setInternalSymbolRead: (value: boolean) => void;
}
/** Original public proxy and statement wrappers; taint and generation remain constructor-owned. */
export function createOriginalPublicProxy(ownerKey: object): Database.Database {
  const {
    raw,
    engine,
    nativeSymbol,
    prepareNative,
    originals,
    opaqueMethods,
    nativeGetters,
    invalidate,
    taint,
    getInternalSymbolRead,
    setInternalSymbolRead,
  } = requireOriginalProxyOwner(ownerKey);
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
  const publicSelf: Database.Database = new Proxy(raw, {
    get(target, key) {
      if (key === nativeSymbol && !getInternalSymbolRead()) taint();
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
          setInternalSymbolRead(true);
          try {
            return Reflect.apply(value, publicSelf, args);
          } finally {
            setInternalSymbolRead(false);
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
  return publicSelf;
}
