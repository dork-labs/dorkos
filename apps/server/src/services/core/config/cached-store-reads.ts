/**
 * Read `config.json` from disk only when it changed (DOR-2898).
 *
 * `conf` reads, parses and schema-validates the whole file on EVERY read: each
 * `get`, `has` and `store` access. DorkOS reads settings at least twice per
 * request (the session gate, the host guard) and some routes far more, from
 * 238 call sites. Measured at about 60 µs per section read and 116 µs for the
 * whole config, all of it synchronous file I/O on the event loop.
 *
 * This keeps the last validated read and answers from it while the file is the
 * same file it was: same inode, size, modification and change time, checked
 * with one `statSync` per read. Every write through `conf` is an atomic rename, so it
 * lands as a new inode; so does `dorkos config set` from a terminal, and so do
 * most editors. A hand edit in place changes the size or the time. Any of those
 * and the next read goes to disk exactly as before, so out-of-process edits are
 * seen as soon as they ever were.
 *
 * Callers get a deep copy every time, the same as a fresh parse gave them, so a
 * caller that changes what it was handed cannot change the next caller's read.
 * The copy is only of what was asked for: a section, not the whole file.
 *
 * @module services/core/config/cached-store-reads
 */
import fs from 'node:fs';
import type Conf from 'conf';

interface CachedRead {
  ino: number;
  size: number;
  mtimeMs: number;
  /** Change time, which no tool can set back the way `cp -p` sets mtime. */
  ctimeMs: number;
  /** The last validated read. Never handed out except to `get` and `has`. */
  value: Record<string, unknown>;
}

/** What {@link cacheStoreReads} counts, for tests and diagnostics. */
export interface StoreReadStats {
  /** Reads answered from the cached copy. */
  hits: number;
  /** Reads that went to the file. */
  misses: number;
}

const stats = new WeakMap<object, StoreReadStats>();

/**
 * How a wrapped store's reads have gone so far.
 *
 * @param store - A store passed to {@link cacheStoreReads}.
 */
export function storeReadStats(store: object): StoreReadStats | undefined {
  return stats.get(store);
}

/**
 * Make `store` answer reads from memory while its file is unchanged.
 *
 * Wraps the instance's own `store` accessor, which every `conf` read and write
 * goes through, so nothing else about the store changes: writes, migrations,
 * `reset` and `clear` behave exactly as before and drop the cached copy.
 *
 * Copying the whole config is most of the cost of a read, so `get` and `has`
 * look things up in the cached copy itself and copy only the value they return.
 *
 * @param store - A freshly constructed store. Its migrations have already run.
 * @returns The same store.
 */
export function cacheStoreReads<T extends Record<string, unknown>>(store: Conf<T>): Conf<T> {
  const accessor = findStoreAccessor(store);
  if (!accessor?.get || !accessor.set) return store;
  const { get: readFile, set: writeFile } = accessor;
  const { get: lookUp, has: lookUpHas } = store;
  const counts: StoreReadStats = { hits: 0, misses: 0 };
  stats.set(store, counts);
  let cached: CachedRead | undefined;
  // While set, the accessor hands out the cached object itself rather than a
  // copy: only `get` and `has` below set it, and neither lets it escape.
  let lending = false;

  /** The current contents, cached when the file has not changed since the last read. */
  const current = (): Record<string, unknown> => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(store.path);
    } catch {
      cached = undefined;
      counts.misses += 1;
      return readFile.call(store) as Record<string, unknown>;
    }
    const same =
      cached?.ino === stat.ino &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.ctimeMs === stat.ctimeMs;
    if (cached && same) {
      counts.hits += 1;
      return cached.value;
    }
    counts.misses += 1;
    // A fresh read nobody else holds yet, so it is kept as it is.
    const value = readFile.call(store) as Record<string, unknown>;
    const { ino, size, mtimeMs, ctimeMs } = stat;
    cached = { ino, size, mtimeMs, ctimeMs, value };
    return value;
  };

  Object.defineProperty(store, 'store', {
    configurable: true,
    enumerable: accessor.enumerable ?? false,
    get(): T {
      const value = current();
      return (lending ? value : copyRoot(value)) as T;
    },
    set(value: T): void {
      cached = undefined;
      writeFile.call(store, value);
    },
  });
  store.get = function get(this: Conf<T>, ...args: Parameters<Conf<T>['get']>) {
    lending = true;
    let value: unknown;
    try {
      value = (lookUp as (...a: unknown[]) => unknown).apply(this, args);
    } finally {
      lending = false;
    }
    if (value === args[1]) return value as ReturnType<Conf<T>['get']>;
    // `get()` with no key is the whole config, top level and all.
    const held = cached;
    if (held && value === held.value) return copyRoot(held.value) as ReturnType<Conf<T>['get']>;
    return copy(value) as ReturnType<Conf<T>['get']>;
  } as Conf<T>['get'];
  store.has = function has(this: Conf<T>, key: Parameters<Conf<T>['has']>[0]) {
    lending = true;
    try {
      return lookUpHas.call(this, key);
    } finally {
      lending = false;
    }
  };
  return store;
}

/**
 * A deep copy of the whole config, with the prototype-free top level `conf`
 * gives it, so a lookup of `toString` still finds nothing.
 */
function copyRoot(value: Record<string, unknown>): Record<string, unknown> {
  return Object.assign(Object.create(null) as Record<string, unknown>, copy(value));
}

/** A deep copy of a JSON value: what a fresh parse of the file would have given. */
function copy<V>(value: V): V {
  return value !== null && typeof value === 'object'
    ? (JSON.parse(JSON.stringify(value)) as V)
    : value;
}

/** The `store` accessor `conf` defines on its prototype chain. */
function findStoreAccessor(target: object): PropertyDescriptor | undefined {
  for (let proto = Object.getPrototypeOf(target); proto; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'store');
    if (descriptor) return descriptor;
  }
  return undefined;
}
