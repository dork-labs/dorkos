/** Transaction handles and query builders cannot outlive their synchronous callback. */
import type { Db, DbTransaction } from '@dorkos/db';

/** Reject promise-returning callbacks at the typed boundary as well as at runtime. */
export type SynchronousResult<T> = T extends PromiseLike<unknown> ? never : T;

/** Guard all methods on transaction/query handles, including previously captured methods. */
function scopedTransaction(tx: DbTransaction): { tx: DbTransaction; retire(): void } {
  let active = true;
  const proxies = new WeakMap<object, object>();
  const requireActive = () => {
    if (!active) throw new Error('Document channel transaction is no longer active.');
  };
  const wrap = (value: object): object => {
    const existing = proxies.get(value);
    if (existing) return existing;
    const proxy = new Proxy(value, {
      get(target, key) {
        requireActive();
        const member: unknown = Reflect.get(target, key, target);
        if (typeof member === 'function') {
          return (...args: unknown[]) => {
            requireActive();
            // A native nested transaction must not expose an unguarded child handle.
            if (key === 'transaction' && typeof args[0] === 'function') {
              const callback = args[0] as (nested: DbTransaction) => unknown;
              args[0] = (nested: DbTransaction) => executeDocumentWork(nested, callback);
            }
            const result: unknown = Reflect.apply(member, target, args);
            // Result rows remain ordinary data; class instances are executable handles.
            if (result instanceof Promise) return result;
            if (result && typeof result === 'object' && !Array.isArray(result)) {
              const prototype: unknown = Object.getPrototypeOf(result);
              if (prototype !== Object.prototype && prototype !== null) return wrap(result);
            }
            return result;
          };
        }
        // Includes tx.query's table map and native database/statement handles.
        if (member && typeof member === 'object') return wrap(member);
        return member;
      },
    });
    proxies.set(value, proxy);
    return proxy;
  };
  return {
    tx: wrap(tx) as DbTransaction,
    retire: () => {
      active = false;
    },
  };
}

/** Roll back promise-returning work and retire every escaped handle on all exit paths. */
export function executeDocumentWork<T>(native: DbTransaction, work: (tx: DbTransaction) => T): T {
  const scoped = scopedTransaction(native);
  try {
    const result = work(scoped.tx);
    if (
      result &&
      (typeof result === 'object' || typeof result === 'function') &&
      'then' in result
    ) {
      // Observe its rejection: the continuation will fail closed on retired handles.
      void Promise.resolve(result).catch(() => {});
      throw new Error('Document channel transactions must be synchronous.');
    }
    return result;
  } finally {
    scoped.retire();
  }
}

/** Execute only within the production SQLite transaction, retiring all nested handles. */
export function documentTransaction<T>(db: Db, work: (tx: DbTransaction) => T): T {
  return db.transaction((native) => executeDocumentWork(native, work));
}
